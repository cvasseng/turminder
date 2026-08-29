/**
 * The whole chat client. Deliberately plain: one socket, one message list, no
 * build step. Streaming deltas are transient — history is refetched on connect.
 */
const $ = (id) => document.getElementById(id);

/**
 * Chrome is icons rather than labels. Inline SVG paths, drawn in currentColor,
 * so there is nothing to fetch and nothing to keep in sync with a font.
 */
const ICONS = {
  plus: '<path d="M12 5v14M5 12h14"/>',
  archive:
    '<rect x="3" y="4" width="18" height="4" rx="1"/><path d="M5 8v11a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8"/><path d="M10 12h4"/>',
  eye: '<path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/>',
  'eye-off':
    '<path d="M9.9 4.24A9.1 9.1 0 0 1 12 4c6.4 0 10 8 10 8a18.5 18.5 0 0 1-2.2 3.2M6.6 6.6A18.5 18.5 0 0 0 2 12s3.6 8 10 8a9.1 9.1 0 0 0 4.2-1"/><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2"/><path d="M2 2l20 20"/>',
  folder:
    '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"/>',
  key: '<circle cx="7.5" cy="15.5" r="4.5"/><path d="M10.7 12.3 21 2"/><path d="m16.5 6.5 3 3 2.5-2.5-3-3"/>',
  'panel-close':
    '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M9 4v16"/><path d="m16.5 15-3-3 3-3"/>',
  'panel-open':
    '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M9 4v16"/><path d="m13.5 9 3 3-3 3"/>',
  refresh: '<path d="M21 12a9 9 0 1 1-9-9c2.4 0 4.7 1 6.4 2.6L21 8"/><path d="M21 3v5h-5"/>',
  x: '<path d="M18 6 6 18M6 6l12 12"/>',
  pencil: '<path d="M12 20h9"/><path d="M16.4 3.6a2.1 2.1 0 0 1 3 3L7.5 18.5 3 20l1.5-4.5Z"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  'arrow-left': '<path d="M19 12H5"/><path d="m12 19-7-7 7-7"/>',
  send: '<path d="M22 2 11 13"/><path d="M22 2l-7 20-4-9-9-4Z"/>',
  trash:
    '<path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M18.5 6 17.6 20a1 1 0 0 1-1 1H7.4a1 1 0 0 1-1-1L5.5 6"/><path d="M10 11v6M14 11v6"/>',
  chevron: '<path d="m9 18 6-6-6-6"/>',
  activity: '<path d="M3 12h4l3 8 4-16 3 8h4"/>',
  layout:
    '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18"/><path d="M9 21V9"/>',
  expand:
    '<path d="M15 3h6v6"/><path d="M9 21H3v-6"/><path d="M21 3l-7 7"/><path d="M3 21l7-7"/>',
  collapse:
    '<path d="M4 14h6v6"/><path d="M20 10h-6V4"/><path d="M14 10l7-7"/><path d="M3 21l7-7"/>',
  paperclip:
    '<path d="M21.4 11.05 12.25 20.2a5.5 5.5 0 0 1-7.78-7.78l9.2-9.2a3.67 3.67 0 1 1 5.18 5.19l-9.2 9.19a1.83 1.83 0 1 1-2.6-2.6l8.5-8.48"/>',
  logout:
    '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="m16 17 5-5-5-5"/><path d="M21 12H9"/>',
};

function iconSvg(name) {
  return (
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" ' +
    'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">' +
    (ICONS[name] || '') +
    '</svg>'
  );
}

function paintIcon(el, name) {
  el.dataset.icon = name;
  el.innerHTML = iconSvg(name);
}

/** Fill every [data-icon] placeholder in the page markup. */
function paintIcons() {
  for (const el of document.querySelectorAll('[data-icon]')) paintIcon(el, el.dataset.icon);
}

/* TOKEN_KEY and the fragment hand-off live in connect.js, which every page
   served at `/` loads — see the note there. */
const CONV_KEY = 'turminder.conversation';
const COLLAPSED_KEY = 'turminder.sidebarCollapsed';
const ARCHIVED_KEY = 'turminder.showArchived';
/** Which of the drawer's tabs is showing (§9.1); '' is closed. */
const DRAWER_KEY = 'turminder.drawer';

/** App. A `pair_poll_interval_s` — the waiting gate's claim poll (§24.4). */
const PAIR_POLL_MS = 2000;

/** Frames this page needs the server to understand. */
const REQUIRED_FRAMES = [
  'event.list',
  'chat.send',
  'chat.history',
  'conversation.list',
  'conversation.close',
  'conversation.delete',
  'form.submit',
  'form.cancel',
  'token.list',
  'token.create',
  'token.revoke',
  'models.list',
  'conversation.model',
];

/** Frames this page renders and would quietly miss if the server were older. */
const EXPECTED_FROM_SERVER = [
  'event.list.result',
  'event.status',
  'chat.activity',
  'chat.retract',
  'chat.usage',
  'conversation.titled',
  'form.request',
  'token.list.result',
  'token.reveal',
];

const state = {
  socket: null,
  instanceName: 'assistant',
  // From `welcome`; null until onboarding has written an identity (§9).
  userName: null,
  // Last settled usage, plus a running estimate while tokens are streaming.
  usage: null,
  streamedChars: 0,
  /**
   * Reasoning is billed output the reader never sees stream (§20.1), and on a
   * thinking model it is most of it — measured at ~68% of billed output tokens
   * on the install this was written against. Counting only the visible deltas
   * made the live figure under-report by a factor of three and then jump when
   * the turn settled, which reads exactly like the counter being wrong.
   */
  reasoningChars: 0,
  turnTokensIn: 0,
  turnTokensOut: 0,
  // Cache accounting for the run in flight (§21.1), accumulated only over the
  // turns whose endpoint actually reported `timings`.
  runEvaluated: 0,
  runBilledTimed: 0,
  conversationId: localStorage.getItem(CONV_KEY) || null,
  mode: 'normal',
  streaming: null,
  // Set once the server answers a connection with welcome: proof the token is
  // good, and the difference between "reconnect" and "ask for a new token".
  authed: false,
  // Set once the socket opens at all. A refused upgrade never gets this far,
  // which is what separates a bad token from a server that went quiet.
  opened: false,
  greetTimer: null,
  // Sticky once a socket opens and is never greeted: without it the diagnosis
  // is overwritten by the retry a frame later and nobody ever reads it.
  ungreeted: false,
  // The activity block for the turn in flight: a collapsed header with every
  // tool call and the reasoning behind it.
  group: null,
  // Whether the transcript follows new output. True while the reader is at the
  // bottom; the scroll handler owns it, so our own jumps re-affirm it and a
  // scroll up turns it off (see scrollMessages).
  follow: true,
  /** Pending rAF for the scroll handler; one recompute per frame is plenty. */
  jumpTick: null,
  /** Pending rAF for the bottom-pinning loop (see keepPinned). */
  pinTick: null,
  /** When the reader last touched the transcript — wheel, drag, key, touch. */
  gestureAt: 0,
  /** Messages that arrived while the reader was reading something else. */
  unseen: 0,
  conversations: [],
  // form_id -> the rendered element, so a re-sent form replaces rather than stacks.
  forms: new Map(),
  files: { entries: [], path: null, content: null, editing: false },
  // Embeds (§22.6): `inChat` is what *this* transcript references, in the order
  // the markers appear — built from the embed.resolve round-trips the slots
  // already make, so the panel needs no list of its own. `entries` is the kept
  // shelf. `pending` holds slots awaiting a resolve, keyed by id because one
  // embed may appear in the conversation twice.
  embeds: { entries: [], inChat: new Map(), pending: new Map() },
  /**
   * The activity panel (§4.2.1). `rows` is a live window over the event
   * lifecycle keyed by event id, filled by `event.list` and kept true by
   * `event.status` pushes — never the source of truth, always re-derivable.
   */
  activity: { rows: new Map(), deliveries: [] },
  /**
   * Which of the drawer's three tabs is showing (§9.1), or null for closed —
   * one value where there used to be three booleans, because the layout only
   * ever honoured one of them at a time anyway.
   */
  drawer: null,
  showArchived: localStorage.getItem(ARCHIVED_KEY) === '1',
  devices: [],
  /** Uploads waiting to be sent with the next message (§26.2). */
  pending: [],
  /** Endpoints and this conversation's override (§10.6). */
  models: { endpoints: [], override: null, effort: null, pending: null },
  retryMs: 500,
};

function token() {
  const t = localStorage.getItem(TOKEN_KEY);
  return t && t.trim();
}

/**
 * An embed URL, or null if it is not one this page will point at.
 *
 * Every `url` the UI renders comes from the service — `embed.resolve.result`
 * builds it from the origin it is serving on plus a scoped token (App. D) —
 * so today nothing hostile arrives here. That is a fact about the current
 * server, though, not a property of this function's input, and the two places
 * it lands are `href` and an iframe `src`, which are exactly where a
 * `javascript:` URL stops being data and starts being code running in this
 * origin with this page's token in localStorage. Same-origin http(s) is the
 * whole of what an embed can legitimately be; anything else is refused here
 * rather than trusted to have come from a friend.
 */
function embedUrl(raw) {
  if (typeof raw !== 'string' || !raw) return null;
  let parsed;
  try {
    parsed = new URL(raw, location.href);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  if (parsed.origin !== location.origin) return null;
  return parsed.href;
}

/* ── asking the user something ────────────────────────────────────────────── */

let askResolve = null;

/**
 * An in-app yes/no. Native confirm() cannot be styled, blocks the event loop,
 * and is suppressed outright in some embeddings — which would quietly turn
 * "delete this conversation" into a click that does nothing. A <dialog> gets
 * the focus trap, the Esc key and the top layer for free.
 */
function confirmDialog({ title, body, confirm = 'OK', danger = false }) {
  const dialog = $('ask');
  $('ask-title').textContent = title;
  $('ask-body').textContent = body || '';
  $('ask-body').style.display = body ? '' : 'none';
  $('ask-ok').textContent = confirm;
  $('ask-ok').classList.toggle('danger', danger);
  return new Promise((resolve) => {
    // A second ask while one is open would strand the first promise.
    if (askResolve) askResolve(false);
    askResolve = resolve;
    dialog.showModal();
    // Cancel takes focus: Enter on a reflex should never be the destructive one.
    $('ask-cancel').focus();
  });
}

$('ask').addEventListener('close', () => {
  const resolve = askResolve;
  askResolve = null;
  resolve?.($('ask').returnValue === 'ok');
});

// A click that lands on the dialog itself landed on the backdrop.
$('ask').addEventListener('click', (e) => {
  if (e.target === $('ask')) $('ask').close('cancel');
});

/* ── the token gate: the whole page until this browser is trusted ─────────── */

/**
 * Which way in the gate leads with. Scanning a QR the assistant shows on a
 * device that is already linked is *the* way in (§24.3); telling a phone to go
 * find a terminal is telling it to give up. The one exception is an install
 * where no device holds a token at all — there is no assistant to ask there,
 * and the CLI is the only door. /healthz answers which (App. E `linked`), being
 * the one route a browser with no credential may call.
 */
async function noDeviceIsLinked() {
  try {
    const res = await fetch('/healthz', { cache: 'no-store' });
    if (!res.ok) return false;
    const body = await res.json();
    return body.linked === false;
  } catch {
    // Anything short of a straight "nothing is linked" keeps the scan: a hiccup
    // must never be the reason someone is sent to a terminal.
    return false;
  }
}

function paintGate(firstRun) {
  $('gate-pair').hidden = firstRun;
  $('gate-pair-start').hidden = false;
  $('gate-pair-hint').hidden = false;
  $('gate-code-box').hidden = true;
  $('gate-manual').hidden = false;
  $('gate-entry').hidden = !firstRun;
  $('gate-cli-hint').hidden = !firstRun;
  // The keyboard is welcome when typing is the only way in, and in the way when
  // what the reader needs is the instructions it would cover.
  if (firstRun) $('gate-token').focus();
}

function openGate(message) {
  document.body.classList.add('locked');
  $('gate-error').textContent = message || '';
  $('gate-token').value = '';
  stopPairing();
  // Paint the common case now and correct it if the probe disagrees — one-way,
  // so an answer that arrives after a click never folds the box away again.
  paintGate(false);
  void noDeviceIsLinked().then((firstRun) => {
    if (firstRun) paintGate(true);
  });
}

function closeGate() {
  stopPairing();
  document.body.classList.remove('locked');
}

/* ── pairing: the gate asks, a linked device approves (§24.4) ─────────────── */

/**
 * The ticket lives here and only here — never on screen, never in storage. It
 * is what makes this browser the only thing that can collect the token the
 * approval mints; the code on screen is for a human to read out, and on its
 * own it unlocks nothing.
 */
let pairing = null;

function stopPairing() {
  if (pairing) clearTimeout(pairing.timer);
  pairing = null;
}

async function startPairing() {
  const res = await fetch('/api/pair/request', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    // The kind is what the approval dialog names the device after (§24.4). A
    // category, not a name: the server writes the word, and whoever approves
    // it gets the last say anyway.
    body: JSON.stringify({ kind: 'phone' }),
  }).catch(() => null);
  const body = res && res.ok ? await res.json().catch(() => null) : null;
  if (!body) {
    $('gate-error').textContent = 'could not reach the assistant to ask';
    return;
  }
  if (body.error) {
    $('gate-error').textContent = body.message || body.error;
    return;
  }
  pairing = { ticket: body.ticket, timer: null };
  $('gate-error').textContent = '';
  $('gate-code').textContent = body.code;
  $('gate-wait').textContent = 'Waiting for approval…';
  $('gate-pair-start').hidden = true;
  $('gate-pair-hint').hidden = true;
  $('gate-code-box').hidden = false;
  pollPairing();
}

/**
 * Poll rather than push: this is the one surface with no socket, because having
 * no token is the entire reason it is on screen (§24.4). The poll dies with the
 * ticket — an expired pairing says so rather than spinning forever.
 */
function pollPairing() {
  if (!pairing) return;
  const ticket = pairing.ticket;
  pairing.timer = setTimeout(async () => {
    if (!pairing || pairing.ticket !== ticket) return;
    const res = await fetch('/api/pair/claim', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ticket }),
    }).catch(() => null);
    const body = res && res.ok ? await res.json().catch(() => null) : null;
    // A server that blinked is not an expired pairing: keep waiting.
    if (!body) return pollPairing();
    if (body.status === 'approved') {
      stopPairing();
      localStorage.setItem(TOKEN_KEY, body.token);
      closeGate();
      setStatus('connecting…', false);
      state.retryMs = 500;
      connect();
      return;
    }
    // Declined and expired both end the wait; saying which is the difference
    // between "try again" and "somebody said no to this".
    if (body.status === 'declined' || body.status === 'expired') {
      stopPairing();
      $('gate-wait').textContent =
        body.status === 'declined' ? 'That request was declined.' : 'That code expired.';
      $('gate-pair-start').hidden = false;
      $('gate-pair-start').textContent = 'Get a new code';
      return;
    }
    pollPairing();
  }, PAIR_POLL_MS);
}

/**
 * A refused upgrade and an unreachable server both reach the browser as a bare
 * 1006, so ask the health endpoint — which needs no token — which one it was.
 * Getting this wrong either hides a dead server behind "bad token" or leaves
 * someone reconnecting forever against a token that will never be accepted.
 */
async function serverIsUp() {
  try {
    const res = await fetch('/healthz', { cache: 'no-store' });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Connection state is a dot on the right of the top row, and when all is well
 * that is the whole message. Anything else still spells itself out — nobody
 * finds "disconnected (bad token?)" by hovering a tooltip.
 */
function setStatus(text, live) {
  $('status-text').textContent = live ? '' : text;
  $('status-dot').title = text;
  $('status').classList.toggle('live', Boolean(live));
}

/** Who said it, in the user's terms rather than the protocol's. */
function speakerLabel(role) {
  if (role === 'assistant') return state.instanceName || 'assistant';
  if (role === 'user') return 'Me';
  return role;
}

/**
 * A v4 UUID for frame ids. crypto.randomUUID() is secure-context only: it
 * exists on https and on localhost, and is undefined when the UI is served
 * over plain http to the LAN. Calling it there throws inside onopen, so hello
 * never goes out, the server never answers with welcome, and the page sits on
 * "connecting…" forever. getRandomValues has no such restriction.
 */
function uuid() {
  if (crypto.randomUUID) return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const hex = [...b].map((n) => n.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * How close to the bottom still counts as "at the bottom". Wide enough to
 * absorb a re-render that changes the transcript's height by a line, narrow
 * enough that a deliberate scroll up of one message drops follow mode.
 */
const FOLLOW_SLACK_PX = 48;

/**
 * How long a gesture keeps ownership of the scroll position.
 *
 * This is the load-bearing idea in here: **only the reader may leave the
 * bottom.** The browser fires the same `scroll` event for a wheel, for its own
 * scroll-anchoring correction when content above grows, and for our pinning —
 * and treating those alike is how the transcript came to abandon a run
 * mid-stream. Expanding the activity block grows the page by a few hundred
 * pixels; the correction that follows is not somebody asking to read history.
 */
const GESTURE_MS = 500;

function atBottom(box, slack = FOLLOW_SLACK_PX) {
  return box.scrollHeight - box.scrollTop - box.clientHeight <= slack;
}

function readerIsDriving() {
  return performance.now() - state.gestureAt < GESTURE_MS;
}

/**
 * Keep the newest text in view — but only while the reader is actually at the
 * bottom. Scrolling up during a run is the one thing the transcript must not
 * fight: the model can stream for a minute, and yanking the viewport back on
 * every delta makes reading what it already said impossible.
 *
 * `force` is for the two moments the user has said where they want to be:
 * sending a message, and pressing the jump badge.
 */
function scrollMessages(force) {
  const box = $('messages');
  if (!force && !state.follow) {
    refreshJump();
    return;
  }
  state.follow = true;
  state.unseen = 0;
  box.scrollTop = box.scrollHeight;
  refreshJump();
  keepPinned();
}

/**
 * Hold the bottom through height changes that arrive without any new frame:
 * the activity block animating open (a 180ms grid transition), a markdown
 * re-render, an embed frame taking its space. Pinning only when a delta lands
 * leaves the view stranded halfway up for as long as the gap between tokens —
 * which reads exactly like output having stopped.
 *
 * Runs only while a run is in flight and only while following, and gives up
 * once the height has been still for a while, so it cannot outlive its reason.
 */
function keepPinned() {
  if (state.pinTick) return;
  const box = $('messages');
  let lastHeight = box.scrollHeight;
  let still = 0;
  const step = () => {
    state.pinTick = null;
    if (!state.follow) return;
    // Hands off while the reader has hold of it. Without this the loop wins
    // every wheel tick — it re-pins in the same frame, the position never
    // actually moves, and scrolling up during a run becomes impossible.
    if (readerIsDriving()) {
      state.pinTick = requestAnimationFrame(step);
      return;
    }
    if (box.scrollHeight !== lastHeight) {
      lastHeight = box.scrollHeight;
      still = 0;
    } else {
      still += 1;
    }
    box.scrollTop = box.scrollHeight;
    // A run that has finished and settled needs no pinning; a still transcript
    // needs none either, whatever the run is doing.
    if ((state.streaming || state.group) && still < 45) {
      state.pinTick = requestAnimationFrame(step);
    }
  };
  state.pinTick = requestAnimationFrame(step);
}

/**
 * Counted on arrival rather than measured off the DOM, because "new" has to
 * mean *new*: everything below the fold would also count the history the reader
 * deliberately scrolled up into, and a badge that calls a message from ten
 * minutes ago new is a badge nobody trusts.
 */
function countUnseen() {
  if (state.follow) return;
  state.unseen += 1;
  refreshJump();
}

/**
 * The badge exists only while the reader is somewhere other than the bottom,
 * and says the most specific true thing available: what has arrived since they
 * left, or failing that, that the model is still talking down there.
 */
function refreshJump() {
  const button = $('jump');
  const box = $('messages');
  const away =
    !state.follow && box.scrollHeight - box.scrollTop - box.clientHeight > FOLLOW_SLACK_PX;
  if (!away) {
    button.hidden = true;
    return;
  }
  const text = state.unseen
    ? `${state.unseen} new message${state.unseen === 1 ? '' : 's'}`
    : // A run between two messages — running tools — is still a run in flight;
      // the streaming message is sealed at every block, so it cannot answer
      // this on its own (see openGroup).
      state.streaming || state.group
      ? 'still writing…'
      : 'Jump to latest';
  // Rebuilt only when it would say something different: this runs on every
  // scroll event, and a pinned run produces one of those per frame.
  if (button.dataset.label !== text) {
    button.dataset.label = text;
    button.textContent = '';
    const arrow = document.createElement('span');
    arrow.className = 'arrow';
    arrow.textContent = '↓';
    const label = document.createElement('span');
    label.textContent = text;
    button.append(arrow, label);
  }
  button.hidden = false;
}

function escapeHtml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Render assistant text as markdown. The source is escaped *before* parsing, so
 * the only HTML in the result is what marked itself produced — the assistant
 * relays untrusted content (web pages, mail), and this page holds a device
 * token. Links are then filtered to safe schemes as a second line of defence.
 */
function renderMarkdown(target, text) {
  if (typeof marked === 'undefined') {
    target.textContent = text;
    return;
  }
  target.innerHTML = marked.parse(escapeHtml(text), { gfm: true, breaks: true });
  for (const el of target.querySelectorAll('*')) {
    for (const attr of [...el.attributes]) {
      if (attr.name.toLowerCase().startsWith('on')) el.removeAttribute(attr.name);
    }
  }
  for (const a of target.querySelectorAll('a[href]')) {
    const href = a.getAttribute('href') || '';
    if (!/^(https?:|mailto:|#)/i.test(href)) {
      a.removeAttribute('href');
    } else {
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
    }
  }
  sliceEmbedMarkers(target);
}

function addMessage(role, text, cls, attachments) {
  const el = document.createElement('div');
  el.className = `msg ${cls ?? role}`;
  const who = document.createElement('div');
  who.className = 'who';
  who.textContent = speakerLabel(cls ?? role);
  const body = document.createElement('div');
  body.className = 'body';
  if (role === 'assistant') {
    body.dataset.raw = text;
    renderMarkdown(body, text);
  } else {
    body.textContent = text;
  }
  el.append(who, body);
  // What the message carried, under what it said (§26.2).
  if (attachments?.length) {
    const strip = document.createElement('div');
    strip.className = 'msg-attachments';
    for (const a of attachments) {
      const img = document.createElement('img');
      img.alt = a.name ?? '';
      img.title = a.name ?? '';
      void showUpload(img, a.upload_id);
      strip.append(img);
    }
    el.append(strip);
  }
  $('messages').append(el);
  countUnseen();
  scrollMessages();
  return body;
}

/** Streaming: keep the raw text and re-render, so markdown closes properly. */
function appendAssistantText(body, chunk) {
  body.dataset.raw = (body.dataset.raw || '') + chunk;
  renderMarkdown(body, body.dataset.raw);
}

/**
 * The empty transcript says hello (§9).
 *
 * Only for a conversation that does not exist yet: an existing one always has
 * turns, and an onboarding conversation opens with the assistant's own
 * introduction (§3c), which this must not talk over.
 */
function showGreeting() {
  const box = $('messages');
  // Nothing to greet over: a transcript with content keeps it.
  if (box.firstElementChild && !box.querySelector('.greeting')) return;
  box.querySelector('.greeting')?.remove();
  const el = document.createElement('div');
  el.className = 'greeting';
  el.textContent = greetingLine(new Date().getHours(), state.userName);
  box.append(el);
}

function clearMessages() {
  $('messages').innerHTML = '';
  // A different conversation is not a place the reader chose to be scrolled
  // away from.
  state.follow = true;
  state.unseen = 0;
  refreshJump();
  state.forms.clear();
  state.embeds.pending.clear();
  // The panel follows the transcript: switching conversation empties it, and
  // the resolves for the newly mounted markers fill it again.
  state.embeds.inChat.clear();
  renderEmbedList();
  refreshEmbedsTab();
  if (state.group) clearInterval(state.group.tick);
  state.group = null;
  // A conversation with no id is one that does not exist yet — the New button,
  // an archived or deleted conversation, or a first visit.
  if (!state.conversationId) showGreeting();
  state.usage = null;
  state.streamedChars = 0;
  state.reasoningChars = 0;
  state.turnTokensIn = 0;
  state.turnTokensOut = 0;
  state.runEvaluated = 0;
  state.runBilledTimed = 0;
  const usageBox = document.getElementById('usage');
  if (usageBox) usageBox.innerHTML = '';
}

/**
 * What the assistant is doing between "sent" and "answered": which turn it is
 * on, what tool it is calling, what came back. Transient by design — the
 * durable record is the trace, not this.
 */
function activityLine(a) {
  switch (a.kind) {
    case 'queued':
      return 'waiting for the model — it is busy with something else';
    case 'thinking':
      return a.turn > 1 ? `thinking (turn ${a.turn})…` : 'thinking…';
    case 'recalled':
      return `recalled ${a.count} memor${a.count === 1 ? 'y' : 'ies'} (${a.mode})`;
    case 'tool_call':
      return `calling ${a.tool} ${summariseArgs(a.args)}`;
    case 'tool_result':
      return `${a.tool} ${a.ok ? '→' : 'failed:'} ${truncate(a.summary, 120)}`;
    case 'stopped':
      return `stopped: ${a.reason}`;
    default:
      return a.kind;
  }
}

function summariseArgs(args) {
  if (!args || typeof args !== 'object') return '';
  const text = Object.entries(args)
    .map(([k, v]) => `${k}=${truncate(typeof v === 'string' ? v : JSON.stringify(v), 60)}`)
    .join(' ');
  return truncate(text, 140);
}

function truncate(text, max) {
  const s = String(text ?? '');
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

/** The tail of a long line, which is the interesting end of streamed reasoning. */
function tail(text, max) {
  const s = String(text ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  return s.length > max ? `…${s.slice(-max)}` : s;
}

function elapsed(since) {
  const s = (performance.now() - since) / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  return `${Math.floor(s / 60)}m${String(Math.floor(s % 60)).padStart(2, '0')}s`;
}

/**
 * All of that is folded into one block per turn, collapsed by default: the
 * header says what is happening now and how long it has been going, and the
 * steps are behind it for the turns where you want them. The spinner and the
 * running clock are the point — a collapsed block still has to look alive.
 */
function startGroup() {
  const el = document.createElement('div');
  el.className = 'act-group running';

  const head = document.createElement('button');
  head.type = 'button';
  head.className = 'act-head';
  head.setAttribute('aria-expanded', 'false');

  const caret = document.createElement('span');
  caret.className = 'act-caret';
  caret.innerHTML = iconSvg('chevron');
  const pulse = document.createElement('span');
  pulse.className = 'act-pulse';
  const summary = document.createElement('span');
  summary.className = 'act-summary';
  summary.textContent = 'working…';
  const timer = document.createElement('span');
  timer.className = 'act-timer';
  head.append(caret, pulse, summary, timer);

  const wrap = document.createElement('div');
  wrap.className = 'act-wrap';
  const body = document.createElement('div');
  body.className = 'act-body';
  const lines = document.createElement('div');
  lines.className = 'act-lines';
  body.append(lines);
  wrap.append(body);

  head.onclick = () => {
    const open = el.classList.toggle('open');
    head.setAttribute('aria-expanded', open ? 'true' : 'false');
  };

  el.append(head, wrap);
  $('messages').append(el);

  const group = {
    el,
    lines,
    summary,
    timer,
    steps: 0,
    tools: [],
    reasoningEl: null,
    reasoningNode: null,
    reasoningTail: '',
    reasoningPinned: true,
    started: performance.now(),
    tick: null,
  };
  group.timer.textContent = elapsed(group.started);
  group.tick = setInterval(() => {
    group.timer.textContent = elapsed(group.started);
  }, 200);
  return group;
}

/**
 * A block belongs *above* the text it produced. Whatever has streamed so far is
 * finished — the model stopped talking and went back to tools — so seal that
 * message and let the next delta open a new one below the block. Without this
 * every block after the first lands under an answer the tools had not produced
 * yet, which reads exactly backwards.
 */
function openGroup() {
  if (!state.group) {
    sealStreaming();
    state.group = startGroup();
  }
  return state.group;
}

/**
 * The streaming message will not grow or re-render again — which is the moment
 * its embed markers can safely become iframes (see mountEmbeds).
 */
function sealStreaming() {
  if (!state.streaming) return;
  mountEmbeds(state.streaming);
  state.streaming = null;
}

/**
 * The message a delta lands in. A run that went back to tools mid-answer
 * continues into a second message below the block; naming the speaker again
 * there would read as a second answer, so a continuation drops the label.
 */
function openAssistantMessage() {
  let prev = $('messages').lastElementChild;
  while (prev && prev.classList.contains('act-group')) prev = prev.previousElementSibling;
  const continues = Boolean(prev && prev.classList.contains('assistant'));
  const unseen = state.unseen;
  const body = addMessage('assistant', '');
  if (continues) {
    // The same answer arriving in two halves is one message to a reader who is
    // scrolled away: it neither re-announces the speaker nor counts again.
    body.parentElement.querySelector('.who').remove();
    state.unseen = unseen;
    refreshJump();
  }
  return body;
}

function groupLine(group, text, cls) {
  const line = document.createElement('div');
  line.className = `act-line${cls ? ` ${cls}` : ''}`;
  line.textContent = text;
  group.lines.append(line);
  group.steps += 1;
  return line;
}

function showActivity(a) {
  const group = openGroup();
  const line = activityLine(a);
  if (a.kind === 'tool_call' && a.tool && !group.tools.includes(a.tool))
    group.tools.push(a.tool);
  groupLine(group, line, a.kind === 'stopped' || a.ok === false ? 'bad' : '');
  group.summary.textContent = truncate(line, 110);
  scrollMessages();
}

/**
 * How much of the reasoning tail is kept as a *string*, and it is kept for the
 * collapsed header alone. The body is never capped — it lives in the DOM, the
 * only place it is needed — but re-collapsing whitespace over a quarter of a
 * million characters once per delta is its own kind of slow. Enough raw
 * characters that the 96 the header shows survive the collapse.
 */
const REASONING_TAIL_CAP = 320;

/**
 * Close enough to the bottom of the reasoning box to still count as reading the
 * live end. Much tighter than the transcript's slack: the box is a few hundred
 * pixels tall, and scrolling up a line inside it is a decision, not a wobble.
 */
const REASONING_SLACK_PX = 8;

/**
 * Reasoning arrives delta by delta and accumulates into one line of the block.
 *
 * Appended into a text node rather than reassigned, because reassigning the
 * whole accumulated string on every delta is quadratic — which is why the text
 * used to be capped at 8000 characters and the beginning of a long think
 * scrolled out of existence. Nothing is discarded now: the *box* is bounded
 * (style.css), not the text, and it holds its own bottom while the model talks
 * unless the reader has scrolled back into the chain.
 */
function showReasoning(text) {
  const group = openGroup();
  if (!group.reasoningEl) {
    group.reasoningEl = groupLine(group, '', 'reasoning');
    group.reasoningNode = group.reasoningEl.appendChild(document.createTextNode(''));
    // The box is its own scroller, and `scroll` does not bubble — so reading
    // back through the chain never reaches the transcript's follow logic, and
    // `overscroll-behavior: contain` stops a wheel that runs off the end from
    // chaining into it either. That fight is documented at scrollMessages;
    // this is it staying won.
    group.reasoningEl.addEventListener(
      'scroll',
      () => {
        group.reasoningPinned = atBottom(group.reasoningEl, REASONING_SLACK_PX);
      },
      { passive: true },
    );
  }
  group.reasoningNode.appendData(text);
  group.reasoningTail = (group.reasoningTail + text).slice(-REASONING_TAIL_CAP);
  group.summary.textContent = `reasoning: ${tail(group.reasoningTail, 96)}`;
  if (group.reasoningPinned) group.reasoningEl.scrollTop = group.reasoningEl.scrollHeight;
  scrollMessages();
}

/** The turn moved on: stop the clock and leave a one-line record of what ran. */
function settleGroup() {
  const group = state.group;
  if (!group) return;
  state.group = null;
  clearInterval(group.tick);
  if (!group.steps) {
    group.el.remove();
    return;
  }
  group.timer.textContent = elapsed(group.started);
  group.el.classList.replace('running', 'done');
  group.summary.textContent = group.tools.length
    ? group.tools.join(', ')
    : `${group.steps} step${group.steps === 1 ? '' : 's'}`;
}

function compact(n) {
  if (n === null || n === undefined) return '?';
  if (n < 1000) return String(n);
  return `${(n / 1000).toFixed(n < 10000 ? 1 : 0)}k`;
}

function bar(fraction) {
  const pct = Math.max(0, Math.min(100, Math.round(fraction * 100)));
  const cls = pct >= 90 ? 'bar full' : pct >= 70 ? 'bar warn' : 'bar';
  return `<span class="${cls}"><span style="width:${pct}%"></span></span>`;
}

/**
 * The strip under the input. The headline is context *pressure* — the largest
 * single prompt of the run against the endpoint's window (§21.1) — because that
 * is the number that decides whether the next message fits. Cumulative billing
 * is real work done and stays visible, but as the secondary figure: a 16-turn
 * run bills the same prompt sixteen times, and showing that against the window
 * makes a healthy conversation look about to burst.
 *
 * While a turn is in flight the output figure is an estimate from characters
 * seen (~4 per token), reasoning included — it is billed like any other output
 * and on a thinking model it is most of it. The real count replaces it when the
 * turn settles.
 */
function renderUsage() {
  const box = $('usage');
  const u = state.usage;
  const parts = [];
  const part = (key, html) => parts.push({ key, html });

  // Reasoning counts here even though it never streams into the transcript:
  // it is billed output, and on a thinking model it is most of it (§20.1).
  const streamedNow = state.streamedChars + state.reasoningChars;
  if (state.streaming || state.turnTokensOut || streamedNow) {
    // An estimate for as long as the figure is derived from characters. A turn
    // that has settled resets both counters, so this goes false on its own.
    const estimating = Boolean(state.streaming) || streamedNow > 0;
    const out = estimating ? Math.round(streamedNow / 4) : state.turnTokensOut;
    const inTokens = state.turnTokensIn || u?.context_used || 0;
    const ctx = u?.context_size ?? null;
    // Pressure, never billing (§21.1): the peak single prompt is what has to
    // fit in the window. The output in flight is not in any prompt yet, and
    // adding it here re-counted every earlier turn's output — already inside
    // that peak — which is what made an ordinary run look near the ceiling.
    if (ctx)
      part('context', `context ${bar(inTokens / ctx)} ${compact(inTokens)}/${compact(ctx)}`);
    const live = cacheHit({
      prompt_evaluated: state.runEvaluated,
      billed_with_timings: state.runBilledTimed,
    });
    if (live !== null) part('cache', `cache ${live}%`);
    part(
      'turn',
      `<span class="${estimating ? 'live' : ''}">turn ${compact(inTokens)} in / ` +
        `${estimating ? '~' : ''}${compact(out)} out${estimating ? ' …' : ''}</span>`,
    );
  } else if (u) {
    // The peak single prompt, and nothing added to it (§21.1). This line used
    // to add the run's cumulative output, which is already inside that peak
    // from turn two onwards: measured at +97% on a 16-call run — 19,325 real
    // tokens reported as 38,105 against a 98k window.
    const used = u.context_used ?? u.tokens_in;
    if (u.context_size) {
      part(
        'context',
        `context ${bar(used / u.context_size)} ${compact(used)}/${compact(u.context_size)}`,
      );
    }
    const cache = cacheHit(u);
    if (cache !== null) part('cache', `cache ${cache}%`);
    part('billed', `billed ${compact(u.tokens_in)} in / ${compact(u.tokens_out)} out`);
    part(
      'conversation',
      `conversation ${compact(u.conversation_tokens_in + u.conversation_tokens_out)}`,
    );
    part(
      'duration',
      `${(u.duration_ms / 1000).toFixed(1)}s${u.turns > 1 ? ` · ${u.turns} turns` : ''}`,
    );
    // "est." because it is arithmetic over configured prices, never a bill
    // (§10.5). A costless endpoint says nothing here rather than "0.00".
    if (u.cost) {
      part(
        'cost',
        `est. ${money(u.cost.run, u.cost.currency)} · ${money(u.cost.conversation, u.cost.currency)} total`,
      );
    }
    if (u.model) part('model', u.model);
  }

  const shown = usageForWidth(parts);
  const more = shown.length < parts.length ? '<span class="usage-more">…</span>' : '';
  box.innerHTML = shown.map((p) => p.html).join('<span style="opacity:.4">·</span> ') + more;
}

/**
 * Seven figures do not fit a phone (§9.1): the full strip is about 640px wide
 * and a 390px screen used to clip it mid-number, which reads as broken rather
 * than as abbreviated. Collapsed, the phone gets the two that answer "can I
 * send another message" and "what did that cost" — the live counter while a
 * turn is running, the money once it has settled — in their original order.
 * Tapping the strip renders the lot; so does widening the window.
 */
const PHONE_PRIORITY = ['context', 'turn', 'cost', 'billed'];
const PHONE_PARTS = 2;

function usageForWidth(parts) {
  if (!COMPACT.matches || document.body.classList.contains('usage-open')) return parts;
  const keep = new Set();
  for (const key of PHONE_PRIORITY) {
    if (keep.size >= PHONE_PARTS) break;
    if (parts.some((p) => p.key === key)) keep.add(key);
  }
  return parts.filter((p) => keep.has(p.key));
}

/** Small amounts need their cents; large ones do not need four decimals. */
function money(amount, currency) {
  const digits = amount < 1 ? 4 : 2;
  return `${amount.toFixed(digits)} ${currency}`;
}

/**
 * Share of prompt tokens llama.cpp served from its KV cache rather than
 * evaluating (§21.1). Null when the endpoint sent no `timings` — most of them
 * do not, and a made-up 0% would read as a broken cache rather than as silence.
 */
function cacheHit(u) {
  if (typeof u.prompt_evaluated !== 'number' || !u.billed_with_timings) return null;
  const cached = u.billed_with_timings - u.prompt_evaluated;
  return Math.max(0, Math.min(100, Math.round((cached / u.billed_with_timings) * 100)));
}

function send(type, payload) {
  if (!state.socket || state.socket.readyState !== WebSocket.OPEN) return false;
  state.socket.send(JSON.stringify({ id: uuid(), type, payload: payload || {} }));
  return true;
}

function refreshConversations() {
  send('conversation.list', { include_archived: state.showArchived });
}

function renderConversations() {
  const box = $('conversations');
  box.innerHTML = '';
  for (const c of state.conversations) {
    const el = document.createElement('div');
    const classes = ['conv'];
    if (c.id === state.conversationId) classes.push('active');
    if (c.status === 'closed') classes.push('archived');
    el.className = classes.join(' ');

    const label = document.createElement('div');
    label.className = 'label';
    const title = document.createElement('span');
    title.className = 'title';
    title.textContent =
      (c.title || (c.mode === 'onboarding' ? 'onboarding' : c.id.slice(-8))) +
      (c.status === 'closed' ? ' · archived' : '');
    const when = document.createElement('span');
    when.className = 'when';
    when.textContent = new Date(c.last_activity_at).toLocaleString();
    label.append(title, when);
    label.onclick = () => {
      selectConversation(c.id);
      // Tapped from the sidebar, which on a narrow screen is covering the
      // conversation it just opened (§9.1). On the gesture rather than inside
      // `selectConversation`, because a reconnect also re-selects and must not
      // close a sheet the reader deliberately opened.
      dismissSheets();
    };

    // Archiving and deleting are per-conversation, so they live on the row
    // rather than in a footer that acts on whatever happens to be selected.
    const actions = document.createElement('div');
    actions.className = 'conv-actions';

    if (c.status !== 'closed') {
      const archive = document.createElement('button');
      archive.className = 'conv-btn';
      archive.innerHTML = iconSvg('archive');
      archive.title = 'Archive this conversation (keeps it, hides it)';
      archive.setAttribute('aria-label', 'Archive this conversation');
      archive.onclick = (e) => {
        e.stopPropagation();
        archiveConversation(c.id);
      };
      actions.append(archive);
    }

    const remove = document.createElement('button');
    remove.className = 'conv-btn delete';
    remove.innerHTML = iconSvg('trash');
    remove.title = 'Delete this conversation for good';
    remove.setAttribute('aria-label', 'Delete this conversation');
    remove.onclick = async (e) => {
      e.stopPropagation();
      const name = c.title || c.id.slice(-8);
      const ok = await confirmDialog({
        title: 'Delete this conversation?',
        body: `"${name}" and its transcript go for good.`,
        confirm: 'Delete',
        danger: true,
      });
      if (ok) send('conversation.delete', { conversation_id: c.id });
    };
    actions.append(remove);

    el.append(label, actions);
    box.append(el);
  }
}

function selectConversation(id) {
  // The override is per conversation, so the selector follows the switch — and
  // a pick made while composing a *new* conversation does not follow it here.
  state.models.pending = null;
  setTimeout(() => send('models.list', { conversation_id: id }), 0);
  state.conversationId = id;
  localStorage.setItem(CONV_KEY, id);
  clearMessages();
  send('chat.history', { conversation_id: id, limit: 100 });
  renderConversations();
}

function connect() {
  if (state.socket) return;
  const t = token();
  if (!t) {
    setStatus('no device token', false);
    openGate();
    return;
  }
  state.authed = false;
  state.opened = false;
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const socket = new WebSocket(`${proto}://${location.host}/ws?token=${encodeURIComponent(t)}`);
  state.socket = socket;
  setStatus(state.ungreeted ? 'server is up but not answering' : 'connecting…', false);

  socket.onopen = () => {
    state.opened = true;
    state.retryMs = 500;
    // An open socket that never gets a welcome is indistinguishable from a
    // working one until you notice nothing arrives. Give it a deadline.
    clearTimeout(state.greetTimer);
    state.greetTimer = setTimeout(() => {
      if (state.authed) return;
      state.ungreeted = true;
      socket.close();
    }, 10000);
    // notify.actions as well as chat: approve/deny requests should be
    // answerable here, not only on a desktop with a daemon running.
    send('hello', {
      device: 'ui',
      capabilities: ['chat', 'notify.actions', 'forms', 'files'],
      last_seen: 0,
    });
  };

  socket.onclose = async () => {
    state.socket = null;
    clearTimeout(state.greetTimer);
    // The upgrade itself was refused, with the server plainly up: the token is
    // the problem, and retrying it forever helps nobody. A socket that opened
    // and then dropped is a different story — never blame the token for that.
    if (!state.opened && (await serverIsUp())) {
      localStorage.removeItem(TOKEN_KEY);
      setStatus('token rejected', false);
      openGate('That token was not accepted — it was probably revoked or replaced.');
      return;
    }
    setStatus(state.ungreeted ? 'server is up but not answering' : 'disconnected', false);
    setTimeout(connect, state.retryMs);
    state.retryMs = Math.min(state.retryMs * 2, 10000);
  };

  socket.onmessage = (ev) => {
    let frame;
    try {
      frame = JSON.parse(ev.data);
    } catch {
      return;
    }
    handle(frame);
  };
}

function handle(frame) {
  const p = frame.payload || {};
  switch (frame.type) {
    case 'welcome': {
      // A page served from disk can be newer than the process serving it; say
      // so plainly instead of failing later on an unknown frame.
      const supported = p.frames;
      const emitted = p.emits;
      const missing = Array.isArray(supported)
        ? REQUIRED_FRAMES.filter((f) => !supported.includes(f)).concat(
            Array.isArray(emitted)
              ? EXPECTED_FROM_SERVER.filter((f) => !emitted.includes(f))
              : [],
          )
        : ['(this server does not report which frames it supports)'];
      if (missing.length) {
        addMessage(
          'system',
          `the service is running older code than this page - restart it (missing: ${missing.join(', ')})`,
          'error',
        );
      }
      state.authed = true;
      state.ungreeted = false;
      clearTimeout(state.greetTimer);
      closeGate();
      state.instanceName = p.instance_name || 'assistant';
      state.userName = p.user_name || null;
      // The greeting is drawn before `welcome` arrives, when the name is not
      // known yet; redraw now that it is.
      if (!state.conversationId) showGreeting();
      $('instance').textContent = p.instance_name || 'unnamed';
      setStatus(p.configured ? 'connected' : 'no model configured', p.configured);
      $('badge').textContent = p.onboarding ? 'onboarding' : '';
      refreshConversations();
      // The selector is only worth showing when there is a choice (§10.6).
      send('models.list', { conversation_id: state.conversationId });
      // The drawer can be remembered open from a previous visit, in which case
      // its boot-time list went out before this socket existed.
      if (state.drawer === 'files') send('files.list', {});
      // Unconditional, unlike the file tree: this list is what the activity
      // tab's count is made of, and a count that only became true once you
      // opened the panel would answer the question after you had given up
      // asking it. On a reconnect it is also how the panel re-derives, because
      // `event.status` is transient and missed pushes are not replayed
      // (§4.2.1).
      send('event.list', {});
      // Cheap, and it is what tells the views tab whether there is a kept
      // shelf to reach when the current conversation has no views of its own.
      send('embed.list', { kind: 'persistent' });
      if (state.conversationId) selectConversation(state.conversationId);
      break;
    }

    case 'conversation.list.result':
      state.conversations = p.conversations || [];
      renderConversations();
      if (!state.conversationId && state.conversations.length) {
        selectConversation(state.conversations[0].id);
      }
      break;

    case 'conversation.deleted':
      if (p.conversation_id === state.conversationId) {
        state.conversationId = null;
        localStorage.removeItem(CONV_KEY);
        clearMessages();
      }
      refreshConversations();
      break;

    case 'chat.history.result':
      if (p.conversation_id !== state.conversationId) break;
      clearMessages();
      for (const turn of p.turns || []) {
        addMessage(turn.role, turn.text, undefined, turn.attachments);
      }
      // History is settled text, so its embeds can mount immediately.
      mountEmbeds();
      break;

    case 'chat.accepted': {
      // If the server put the turn somewhere other than where we thought,
      // reload rather than keep showing a transcript that is no longer ours.
      const moved = state.conversationId && state.conversationId !== p.conversation_id;
      state.conversationId = p.conversation_id;
      localStorage.setItem(CONV_KEY, p.conversation_id);
      // A model or effort picked before this conversation existed (§10.6).
      if (state.models.pending) {
        send('conversation.model', {
          conversation_id: p.conversation_id,
          ...state.models.pending,
        });
        state.models.pending = null;
      }
      state.streaming = null;
      if (moved) {
        addMessage('system', 'continued in another conversation - reloading', 'system');
        selectConversation(p.conversation_id);
      }
      refreshConversations();
      break;
    }

    case 'chat.activity': {
      if (p.conversation_id !== state.conversationId) break;
      const activity = p.activity || {};
      if (activity.kind === 'reasoning') {
        // Live reasoning from a thinking model. Never persisted, never re-fed
        // to the model (§20.1) — the activity block is where it appears.
        state.reasoningChars += (activity.text || '').length;
        showReasoning(activity.text);
        renderUsage();
        break;
      }
      if (activity.kind === 'usage') {
        // A turn settled: replace the estimate with the real numbers.
        state.turnTokensIn = activity.tokens_in;
        state.turnTokensOut += activity.tokens_out;
        state.streamedChars = 0;
        state.reasoningChars = 0;
        if (typeof activity.prompt_evaluated === 'number') {
          state.runEvaluated += activity.prompt_evaluated;
          state.runBilledTimed += activity.tokens_in;
        }
        if (activity.context_size && state.usage) {
          state.usage.context_size = activity.context_size;
        } else if (activity.context_size) {
          state.usage = {
            context_used: activity.tokens_in,
            prompt_evaluated: null,
            billed_with_timings: 0,
            tokens_in: activity.tokens_in,
            tokens_out: activity.tokens_out,
            context_size: activity.context_size,
            conversation_tokens_in: 0,
            conversation_tokens_out: 0,
            duration_ms: activity.duration_ms,
            turns: activity.turn,
            model: '',
          };
        }
        renderUsage();
        break;
      }
      showActivity(activity);
      break;
    }

    case 'chat.usage':
      if (p.conversation_id !== state.conversationId) break;
      state.usage = p;
      state.turnTokensIn = 0;
      state.turnTokensOut = 0;
      state.streamedChars = 0;
      state.reasoningChars = 0;
      state.runEvaluated = 0;
      state.runBilledTimed = 0;
      renderUsage();
      break;

    case 'conversation.titled':
      for (const c of state.conversations) {
        if (c.id === p.conversation_id) c.title = p.title;
      }
      renderConversations();
      break;

    case 'chat.delta':
      if (p.conversation_id !== state.conversationId) break;
      settleGroup();
      if (!state.streaming) state.streaming = openAssistantMessage();
      state.streamedChars += (p.text || '').length;
      appendAssistantText(state.streaming, p.text);
      renderUsage();
      scrollMessages();
      break;

    /**
     * The service is unsaying the turn in flight (§20.8): it rejected what it
     * had already begun streaming. Drop it whole — the replacement arrives as
     * ordinary deltas, and appending it to the offending text is exactly the
     * "two answers, one with internal markers in it" that this frame exists to
     * stop.
     */
    case 'chat.retract':
      if (p.conversation_id !== state.conversationId) break;
      // `state.streaming` is the message *body*; the turn being unsaid is the
      // whole message, label and all, or a bare speaker line is left behind.
      if (state.streaming) {
        (state.streaming.parentElement ?? state.streaming).remove();
        state.streaming = null;
      }
      // `streamedChars` is deliberately left alone: those tokens were
      // generated and billed, and the usage line is about what the turn cost,
      // not about what survived it.
      refreshJump();
      break;

    case 'chat.done':
      if (p.conversation_id !== state.conversationId) break;
      settleGroup();
      // Only now: the marker is complete and the text will not re-render.
      sealStreaming();
      // "still writing…" stops being true the moment the run ends.
      refreshJump();
      renderUsage();
      $('send').disabled = false;
      refreshConversations();
      break;

    case 'chat.error':
      if (p.conversation_id && p.conversation_id !== state.conversationId) break;
      settleGroup();
      state.streaming = null;
      $('send').disabled = false;
      addMessage('error', p.message || 'something went wrong', 'error');
      break;

    case 'delivery':
      showDelivery(p);
      break;

    case 'form.request':
      if (p.conversation_id && p.conversation_id !== state.conversationId) break;
      showForm(p);
      break;

    case 'embed.resolve.result': {
      const waiting = state.embeds.pending.get(p.embed_id) || [];
      state.embeds.pending.delete(p.embed_id);
      for (const slot of waiting) fillEmbedSlot(slot, p);
      // A preview inside a form is part of the question being asked, not one of
      // the conversation's views: it vanishes when the form is answered or
      // re-sent, so listing it would leave a row whose "scroll to it" goes
      // nowhere. Only slots standing in the transcript itself count.
      if (waiting.some((slot) => !slot.closest('form'))) {
        // Insertion order is transcript order, because slots resolve as they
        // mount. A second marker for the same embed updates rather than repeats.
        state.embeds.inChat.set(p.embed_id, p);
        renderEmbedList();
        refreshEmbedsTab();
      }
      // Where the numbers came from (§23.2). Asked for after the frame is up,
      // because most embeds have no bindings and the answer decides whether
      // the affordance exists at all.
      send('embed.manifest', { embed_id: p.embed_id });
      scrollMessages();
      break;
    }

    case 'embed.manifest.result':
      showEmbedManifest(p.embed_id, p.bindings || []);
      break;

    case 'embed.list.result':
      state.embeds.entries = p.embeds || [];
      renderEmbedList();
      refreshEmbedsTab();
      break;

    case 'embed.promoted':
    case 'embed.demoted':
      // Re-resolve rather than patch: either move relocates the file, and the
      // URL and kind both come from the server.
      remountEmbed(p.embed_id);
      if (state.drawer === 'embeds') send('embed.list', { kind: 'persistent' });
      break;

    // The activity panel's read and its live half (§4.2.1). The list is the
    // truth on arrival; every push after it moves one row.
    case 'event.list.result':
      state.activity.rows.clear();
      for (const row of p.events || []) state.activity.rows.set(row.id, row);
      state.activity.deliveries = p.deliveries || [];
      renderActivity();
      refreshActivityTab();
      break;

    case 'event.status':
      applyEventStatus(p);
      break;

    // The assistant iterated on a view that is on screen (§22.6). Everything
    // rendered from it is a version behind, including in older turns.
    case 'embed.changed':
      remountEmbed(p.embed_id);
      break;

    case 'files.list.result':
      state.files.entries = p.entries || [];
      renderFileList();
      break;

    case 'files.read.result':
      state.files.path = p.path;
      state.files.content = p.binary ? null : p.content;
      state.files.editing = false;
      renderFileView(p);
      break;

    case 'files.saved':
      setFileStatus(p.committed ? 'saved and committed' : 'saved');
      state.files.editing = false;
      send('files.read', { path: p.path });
      break;

    case 'files.changed':
      // Somebody else moved the file under us: the assistant, or another editor.
      if (state.drawer === 'files') send('files.list', {});
      if (state.files.path === p.path && !state.files.editing) {
        if (p.change === 'deleted') closeFile();
        else send('files.read', { path: p.path });
      }
      break;

    case 'form.accepted': {
      const entry = state.forms.get(p.form_id);
      if (entry) entry.settle('sent');
      break;
    }

    case 'conversation.mode':
      if (p.conversation_id === state.conversationId) {
        state.mode = p.mode;
        $('badge').textContent = p.mode === 'onboarding' ? 'onboarding' : '';
      }
      break;

    case 'conversation.closed':
      if (p.conversation_id === state.conversationId) {
        addMessage('system', 'conversation archived', 'system');
      }
      refreshConversations();
      break;

    case 'models.list.result':
      state.models = {
        endpoints: p.endpoints || [],
        override: p.override ?? null,
        effort: p.effort ?? null,
      };
      renderModelSelector();
      break;

    case 'conversation.model.set':
      if (p.conversation_id !== state.conversationId) break;
      state.models.override = p.endpoint ?? null;
      state.models.effort = p.effort ?? null;
      // Re-ask rather than patch: the server knows which endpoint would serve
      // this conversation now, and that is the label the selector shows.
      send('models.list', { conversation_id: state.conversationId });
      break;

    case 'token.list.result':
      state.devices = p.devices || [];
      renderDevices();
      break;

    case 'token.revoked':
      // Our own device is already being disconnected; anything else just
      // leaves the list one row shorter.
      send('token.list', {});
      break;

    case 'token.reveal':
      showReveal(p);
      send('token.list', {});
      break;

    case 'error': {
      // A rejected submit must hand the form back, or the user is stuck looking
      // at disabled inputs with no way to fix what was wrong.
      const pendingForm = [...state.forms.values()].find((f) => f.awaiting);
      if (pendingForm) pendingForm.reject(p.message || p.code);
      else if ($('devices').open) $('device-error').textContent = p.message || p.code;
      else addMessage('error', `${p.code}: ${p.message}`, 'error');
      $('send').disabled = false;
      break;
    }
  }
}

/* ── embeds (§22) ─────────────────────────────────────────────────────────── */

const EMBED_MARKER = /\{\{embed:([0-9A-Za-z]{1,64})\}\}/g;

/**
 * Turn `{{embed:<id>}}` in rendered text into an empty slot. The slot is not the
 * embed: mounting happens later, once the turn has settled, because
 * `renderMarkdown` re-runs on every streamed delta and re-parenting an iframe
 * reloads it.
 */
function sliceEmbedMarkers(target) {
  const walker = document.createTreeWalker(target, NodeFilter.SHOW_TEXT);
  const hits = [];
  while (walker.nextNode()) {
    EMBED_MARKER.lastIndex = 0;
    if (EMBED_MARKER.test(walker.currentNode.nodeValue || '')) hits.push(walker.currentNode);
  }
  for (const node of hits) {
    const text = node.nodeValue || '';
    const fragment = document.createDocumentFragment();
    let at = 0;
    EMBED_MARKER.lastIndex = 0;
    for (let m = EMBED_MARKER.exec(text); m; m = EMBED_MARKER.exec(text)) {
      if (m.index > at) fragment.append(document.createTextNode(text.slice(at, m.index)));
      const slot = document.createElement('span');
      slot.className = 'embed-slot';
      slot.dataset.embedId = m[1];
      // A span rather than a div: the marker usually lands inside a <p>, and a
      // block-level child there is invalid HTML the parser would move.
      slot.textContent = 'view…';
      fragment.append(slot);
      at = m.index + m[0].length;
    }
    if (at < text.length) fragment.append(document.createTextNode(text.slice(at)));
    node.parentNode.replaceChild(fragment, node);
  }
}

/**
 * Ask the server to resolve every unmounted slot. The URL — scoped token and
 * all — is computed server-side: the client never sees the signing secret, and
 * the device token never travels the other way (§22.3.2/.5).
 */
function mountEmbeds(root) {
  const scope = root || $('messages');
  for (const slot of scope.querySelectorAll('.embed-slot:not(.mounted)')) {
    slot.classList.add('mounted');
    const id = slot.dataset.embedId;
    const waiting = state.embeds.pending.get(id) || [];
    waiting.push(slot);
    state.embeds.pending.set(id, waiting);
    if (!send('embed.resolve', { embed_id: id })) {
      slot.textContent = 'view unavailable — not connected';
    }
  }
}

/**
 * Throw away every rendering of one embed and resolve it again.
 *
 * A fresh iframe rather than a reload: the frame is on an opaque origin, so
 * `contentWindow.location.reload()` is not ours to call, and the URL may itself
 * have changed (promotion, a rotated token). The served page is `no-store`, so
 * a new mount really does re-fetch. It costs whatever in-page state the embed
 * was holding, which is the right trade for an edit — the point is to stop
 * showing the old version.
 */
function remountEmbed(id) {
  const slots = $('messages').querySelectorAll(`.embed-slot[data-embed-id="${id}"]`);
  if (!slots.length) return;
  for (const slot of slots) {
    slot.classList.remove('mounted', 'ready');
    slot.textContent = 'view…';
  }
  mountEmbeds();
}

/**
 * The iframe. `sandbox="allow-scripts"` **without** `allow-same-origin`, which
 * is the whole security model: the page runs in an opaque origin, so it cannot
 * reach this document, its localStorage, or the device token in it (§22.3.1).
 */
function fillEmbedSlot(slot, info) {
  slot.textContent = '';
  slot.classList.add('ready');

  const bar = document.createElement('div');
  bar.className = 'embed-bar';
  const title = document.createElement('span');
  title.className = 'embed-title';
  title.textContent = info.title || 'view';
  bar.append(title);

  if (info.kind === 'ephemeral') {
    const keep = document.createElement('button');
    keep.className = 'embed-keep';
    keep.textContent = 'Keep';
    keep.title = 'Keep this permanently: git history and a lasting link';
    keep.onclick = async () => {
      const ok = await confirmDialog({
        title: 'Keep this view?',
        body: 'It stops expiring, gets a permanent link, and enters the data repo with history.',
        confirm: 'Keep',
      });
      if (ok) send('embed.promote', { embed_id: info.embed_id });
    };
    bar.append(keep);
  }

  const expand = document.createElement('button');
  expand.className = 'icon embed-expand';
  paintIcon(expand, 'expand');
  expand.title = 'Expand';
  expand.onclick = () => {
    const expanded = slot.classList.toggle('expanded');
    paintIcon(expand, expanded ? 'collapse' : 'expand');
    expand.title = expanded ? 'Collapse' : 'Expand';
  };
  bar.append(expand);

  const open = document.createElement('a');
  open.className = 'embed-open';
  // Refused rather than rendered: a link with no href is a dead affordance,
  // which is the honest thing to show for an embed we would not open.
  const href = embedUrl(info.url);
  if (href) open.href = href;
  open.target = '_blank';
  open.rel = 'noopener noreferrer';
  open.textContent = 'open';
  bar.append(open);

  const frame = document.createElement('iframe');
  frame.className = 'embed-frame';
  frame.setAttribute('sandbox', 'allow-scripts');
  frame.setAttribute('referrerpolicy', 'no-referrer');
  frame.setAttribute('loading', 'lazy');
  frame.title = info.title || 'embedded view';
  const src = embedUrl(info.url);
  if (src) frame.src = src;

  slot.append(bar, frame);
}

/**
 * The "data ⓘ" affordance (§23.2): one line per binding saying which tool
 * produced it, with what arguments, when, and whether the last fetch worked.
 * It exists so a framing error — the right number from the wrong query — is
 * auditable in seconds rather than invisible forever.
 */
function showEmbedManifest(embedId, bindings) {
  if (!bindings.length) return;
  for (const slot of $('messages').querySelectorAll(
    `.embed-slot.ready[data-embed-id="${embedId}"]`,
  )) {
    if (slot.querySelector('.embed-data')) continue;
    const bar = slot.querySelector('.embed-bar');
    if (!bar) continue;

    const panel = document.createElement('div');
    panel.className = 'embed-manifest';
    for (const b of bindings) {
      const row = document.createElement('div');
      row.className = 'embed-binding';
      const name = document.createElement('span');
      name.className = 'embed-binding-name';
      name.textContent = b.name;
      const call = document.createElement('span');
      call.className = 'embed-binding-call';
      call.textContent = `${b.tool}(${JSON.stringify(b.args || {})})`;
      const when = document.createElement('span');
      when.className = b.ok ? 'embed-binding-when' : 'embed-binding-when stale';
      when.textContent = b.ok
        ? `fetched ${shortTime(b.fetched_at)}`
        : `stale since ${shortTime(b.fetched_at)}${b.error ? ` — ${b.error}` : ''}`;
      row.append(name, call, when);
      panel.append(row);
    }

    const toggle = document.createElement('button');
    toggle.className = 'embed-keep embed-data';
    toggle.textContent = 'data ⓘ';
    toggle.title = 'Where the numbers on this page came from';
    toggle.onclick = () => {
      panel.classList.toggle('open');
    };
    // Before the expand/open controls, so the row reads title → data → chrome.
    bar.insertBefore(toggle, bar.querySelector('.embed-expand'));
    bar.after(panel);
  }
}

function shortTime(iso) {
  if (!iso) return 'never';
  const at = new Date(iso);
  return Number.isNaN(at.getTime()) ? iso : at.toLocaleString();
}

/**
 * One row: the title, what kind of view it is, and a link to the standalone
 * page. Rows for views in this conversation also scroll the transcript to them,
 * which is what the panel is for — long conversations bury a chart fast.
 */
function embedRow(info, jumpable) {
  const entry = document.createElement('div');
  entry.className = jumpable ? 'file-entry embed-entry jumpable' : 'file-entry embed-entry';
  const name = document.createElement('span');
  name.className = 'file-path';
  name.textContent = info.title || 'untitled view';
  const kind = document.createElement('span');
  kind.className = 'embed-kind';
  kind.textContent = info.kind === 'persistent' ? 'kept' : '';
  const link = document.createElement('a');
  link.className = 'embed-open';
  const openHref = embedUrl(info.url);
  if (openHref) link.href = openHref;
  link.target = '_blank';
  link.rel = 'noopener noreferrer';
  link.textContent = 'open';
  // The link is inside a clickable row; without this, opening it also jumps.
  link.onclick = (e) => e.stopPropagation();
  if (jumpable) {
    entry.title = 'Scroll to it in the conversation';
    entry.onclick = () => jumpToEmbed(info.embed_id);
  }
  entry.append(name, kind, link);
  // Unkeeping belongs here rather than on the embed's own toolbar (§22.6):
  // the panel is where you decide what is worth keeping, the toolbar is where
  // you act on a view you are looking at.
  if (info.kind === 'persistent') entry.append(unkeepButton(info));
  return entry;
}

/**
 * The mirror of the toolbar's "Keep" (§22.1). Not a delete, and the wording has
 * to earn that distinction — the view and its link survive; what it loses is
 * permanence, and with it a place in the data repo's history.
 */
function unkeepButton(info) {
  const unkeep = document.createElement('button');
  unkeep.className = 'embed-unkeep';
  unkeep.textContent = 'unkeep';
  unkeep.title = 'Stop keeping this view permanently';
  unkeep.onclick = async (e) => {
    // Inside a row that may itself be clickable.
    e.stopPropagation();
    const ok = await confirmDialog({
      title: `Stop keeping “${info.title || 'this view'}”?`,
      body:
        'It keeps working and its link keeps working. What changes is that it ' +
        'leaves the data repo, so it stops gaining history, and it can be ' +
        'cleaned up again once this conversation is closed and it has been ' +
        'unused for a while.',
      confirm: 'Unkeep',
    });
    if (ok) send('embed.demote', { embed_id: info.embed_id });
  };
  return unkeep;
}

function embedGroup(label) {
  const head = document.createElement('div');
  head.className = 'embed-group';
  head.textContent = label;
  return head;
}

/**
 * The views panel (§22.6): what this conversation shows, then the kept shelf.
 * The first group is the point of the panel — a reference list for the chat you
 * are reading; the second is the small set of views that outlive it.
 */
function renderEmbedList() {
  const box = $('embed-list');
  box.innerHTML = '';
  const inChat = [...state.embeds.inChat.values()];
  const here = new Set(state.embeds.inChat.keys());
  // Anything already listed above is not repeated below, however it got there.
  const kept = state.embeds.entries.filter((row) => !here.has(row.id));

  if (inChat.length) {
    box.append(embedGroup('in this conversation'));
    for (const info of inChat) box.append(embedRow(info, true));
  }
  if (kept.length) {
    box.append(embedGroup('kept'));
    for (const row of kept) {
      box.append(embedRow({ ...row, embed_id: row.id }, false));
    }
  }
  if (!inChat.length && !kept.length) {
    const empty = document.createElement('div');
    empty.className = 'file-empty';
    empty.textContent = 'no views yet';
    box.append(empty);
  }
}

/** Scroll a view into the middle of the transcript and say which one it was. */
function jumpToEmbed(id) {
  // The transcript's own copy, never a form's preview: a panel row exists
  // because the view is in the conversation, and a form's preview is on its way
  // out as soon as the question is answered.
  const slot = [...$('messages').querySelectorAll(`.embed-slot[data-embed-id="${id}"]`)].find(
    (candidate) => !candidate.closest('form'),
  );
  if (!slot) return;
  slot.scrollIntoView({ block: 'center', behavior: 'smooth' });
  slot.classList.add('flash');
  setTimeout(() => slot.classList.remove('flash'), 1200);
}

/** Is there anything behind the toggle: views in this chat, or a kept shelf? */
function embedsAvailable() {
  return state.embeds.inChat.size > 0 || state.embeds.entries.length > 0;
}

/**
 * On screen only when the user wants it *and* there is something in it. Two
 * conditions rather than one, because a conversation switch empties the panel
 * before the new transcript's markers have resolved: turning the preference off
 * there would mean the panel shuts on every switch and never comes back.
 */
/**
 * The tab is only reachable when there is something behind it. Nothing to show
 * is a disabled tab rather than an empty panel.
 */
function refreshEmbedsTab() {
  const button = $('tab-embeds');
  const count = state.embeds.inChat.size;
  button.disabled = !embedsAvailable();
  const label = count
    ? `${count} view${count === 1 ? '' : 's'} in this conversation`
    : embedsAvailable()
      ? 'Show kept views'
      : 'No views yet';
  button.title = label;
  button.setAttribute('aria-label', label);
  applyDrawer();
}

/* ── the activity panel (§4.2.1) ─────────────────────────────────────────── */

/**
 * How a lifecycle status reads to somebody who did not write the lifecycle,
 * and which of three moods the row is in. `waiting` is the one that earns its
 * own colour: an event retrying on a backoff is not broken, and an event
 * nobody has picked up yet is not running.
 */
const ACTIVITY_STATES = {
  received: { label: 'queued', mood: 'waiting' },
  matched: { label: 'matched', mood: 'waiting' },
  processing: { label: 'running', mood: 'running' },
  failed: { label: 'retrying', mood: 'waiting' },
  dead_letter: { label: 'gave up', mood: 'dead' },
  done: { label: 'done', mood: '' },
  rejected: { label: 'refused', mood: 'dead' },
};

/**
 * How many outcomes the system still owes, on the tab itself.
 *
 * The point of the badge is that "is it doing the thing I asked" is answerable
 * without opening anything — which is the question a phone asks most and the
 * one the panel used to be furthest from. A pending approval counts too: it is
 * the row that owes *you* something rather than the other way round.
 */
function refreshActivityTab() {
  const rows = [...state.activity.rows.values()];
  const owed = state.activity.deliveries.length;
  const count = rows.length + owed;
  const button = $('tab-activity');
  if (!count) {
    delete button.dataset.count;
    delete button.dataset.mood;
  } else {
    // Capped in the badge, not in the count: three digits in a 14px circle is
    // a badge nobody can read, and past a handful the number is not the point.
    button.dataset.count = count > 9 ? '9+' : String(count);
    button.dataset.mood = rows.some((row) => row.status === 'dead_letter')
      ? 'dead'
      : owed || rows.some((row) => row.status === 'failed')
        ? 'waiting'
        : '';
  }
  const label = count
    ? `What the assistant is working on — ${count} outstanding`
    : 'What the assistant is working on';
  button.title = label;
  button.setAttribute('aria-label', label);
}

/** Absolute where it is far away, relative where the distance is the point. */
function whenText(iso) {
  const at = iso ? new Date(iso) : null;
  if (!at || Number.isNaN(at.getTime())) return '';
  const seconds = Math.round((Date.now() - at.getTime()) / 1000);
  if (Math.abs(seconds) < 60) return seconds >= 0 ? 'just now' : 'in a moment';
  if (Math.abs(seconds) < 3600) {
    const m = Math.round(Math.abs(seconds) / 60);
    return seconds >= 0 ? `${m}m ago` : `in ${m}m`;
  }
  return at.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function activityRow(row) {
  const el = document.createElement('div');
  const state_ = ACTIVITY_STATES[row.status] ?? { label: row.status, mood: '' };
  el.className = `act-row${state_.mood ? ` ${state_.mood}` : ''}`;

  const what = document.createElement('div');
  what.className = 'what';
  // The ingress-written summary if there is one, the type if there is not.
  // Never the payload: that is untrusted content (§1.1) and is not sent here.
  what.textContent = row.summary || row.type;
  el.append(what);

  const meta = document.createElement('div');
  meta.className = 'meta';
  const badge = document.createElement('span');
  badge.className = 'state';
  badge.textContent = state_.label;
  meta.append(badge);
  const where = document.createElement('span');
  where.textContent = `${row.type} · ${row.source}`;
  meta.append(where);
  const when = document.createElement('span');
  // A retry says when it will next try; everything else says when it arrived.
  when.textContent =
    row.status === 'failed' && row.next_attempt_at
      ? `retry ${whenText(row.next_attempt_at)}`
      : whenText(row.received_at);
  meta.append(when);
  if (row.attempts > 0) {
    const tries = document.createElement('span');
    tries.textContent = `attempt ${row.attempts}`;
    meta.append(tries);
  }
  el.append(meta);

  // A dead letter that does not say why is the silence this panel exists to
  // break (§4.2.1).
  if (row.status === 'dead_letter' && row.last_error) {
    const why = document.createElement('div');
    why.className = 'why';
    why.textContent = row.last_error;
    el.append(why);
  }
  return el;
}

function deliveryRow(delivery) {
  const el = document.createElement('div');
  el.className = 'act-row waiting';
  const what = document.createElement('div');
  what.className = 'what';
  what.textContent = delivery.title;
  const meta = document.createElement('div');
  meta.className = 'meta';
  const badge = document.createElement('span');
  badge.className = 'state';
  badge.textContent = delivery.intent === 'confirm' ? 'your say-so' : 'unread';
  const when = document.createElement('span');
  when.textContent = expiryNote(delivery.expires_at);
  meta.append(badge, when);
  el.append(what, meta);
  return el;
}

/**
 * Newest first, with what owes *you* something at the top: an approval waiting
 * on a click outranks a handler quietly getting on with its work.
 */
function renderActivity() {
  const list = $('activity-list');
  list.textContent = '';
  const rows = [...state.activity.rows.values()].sort((a, b) => (a.id < b.id ? 1 : -1));
  for (const delivery of state.activity.deliveries) list.append(deliveryRow(delivery));
  for (const row of rows) list.append(activityRow(row));
  if (!rows.length && !state.activity.deliveries.length) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.textContent = 'Nothing in flight.';
    list.append(empty);
  }
}

/**
 * A push moved one event. Terminal rows leave the window — this is a live view
 * of what is outstanding, not a log — except a dead letter, which stays until
 * the reader has seen it, because a capture that died in silence is exactly
 * the case where silence is the bug (§4.2.1).
 */
function applyEventStatus(row) {
  const settled = row.status === 'done' || row.status === 'rejected';
  if (settled) state.activity.rows.delete(row.id);
  else state.activity.rows.set(row.id, row);
  refreshActivityTab();
  if (state.drawer === 'activity') renderActivity();
}

/** When an unanswered approval turns into a deny, said in the reader's clock. */
function expiryNote(iso) {
  const at = iso ? new Date(iso) : null;
  if (!at || Number.isNaN(at.getTime())) return 'No answer counts as Deny.';
  const time = at.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return `No answer by ${time} counts as Deny.`;
}

/**
 * A delivery, rendered inline: a notification to read, or an approve/deny
 * request gating a tool call (§7.3). Clicking sends the action back as an
 * event, which is what releases the waiting run.
 */
function showDelivery(frame) {
  const payload = frame.payload || {};
  const el = document.createElement('div');
  el.className = `msg delivery ${frame.intent === 'confirm' ? 'confirm' : 'notify'}`;

  const who = document.createElement('div');
  who.className = 'who';
  who.textContent = frame.intent === 'confirm' ? 'needs your approval' : 'notification';

  const title = document.createElement('div');
  title.className = 'delivery-title';
  title.textContent = payload.title || '(untitled)';

  el.append(who, title);

  // A confirm carries the argument lines the server composed (App. D.3); its
  // `body` is the same content flattened for a notifier with no DOM, so
  // rendering both would say everything twice.
  const details = Array.isArray(payload.details) ? payload.details : [];
  if (details.length) {
    const list = document.createElement('dl');
    list.className = 'delivery-details';
    for (const detail of details) {
      const label = document.createElement('dt');
      label.textContent = String(detail.label ?? '');
      const value = document.createElement('dd');
      value.textContent = String(detail.value ?? '');
      list.append(label, value);
    }
    el.append(list);
  } else {
    const body = document.createElement('div');
    body.className = 'body';
    body.textContent = payload.body || '';
    el.append(body);
  }

  // Silence is an answer here, and nothing on screen used to say so: an
  // unanswered confirm becomes a deny when the delivery expires (App. A).
  if (frame.intent === 'confirm') {
    const deadline = document.createElement('div');
    deadline.className = 'delivery-deadline';
    deadline.textContent = expiryNote(frame.expires_at);
    el.append(deadline);
  }

  const actions = payload.actions || [];
  if (actions.length) {
    const row = document.createElement('div');
    row.className = 'delivery-actions';
    for (const action of actions) {
      const button = document.createElement('button');
      button.textContent = action.label || action.id;
      button.onclick = () => {
        send('event', {
          type: 'notification.action',
          payload: {
            delivery_id: frame.delivery_id,
            action: action.id,
            ...(payload.run_id ? { run_id: payload.run_id } : {}),
          },
        });
        send('ack', { delivery_id: frame.delivery_id });
        row.remove();
        const chosen = document.createElement('div');
        chosen.className = 'activity sticky';
        chosen.textContent = `you chose: ${action.label || action.id}`;
        el.append(chosen);
      };
      row.append(button);
    }
    el.append(row);
  } else {
    send('ack', { delivery_id: frame.delivery_id });
  }

  $('messages').append(el);
  countUnseen();
  scrollMessages();
}

/**
 * A form the assistant summoned (§19.1), rendered inline. Secret fields are
 * masked and their values go out in the form.submit frame only — they are never
 * put in the transcript, and the run gets back a reference, not the value.
 */
function showForm(frame) {
  const existing = state.forms.get(frame.form_id);
  if (existing) existing.el.remove();

  const el = document.createElement('form');
  el.className = 'msg form';

  const who = document.createElement('div');
  who.className = 'who';
  who.textContent = 'needs your input';

  const title = document.createElement('div');
  title.className = 'form-title';
  title.textContent = frame.title || '(untitled form)';

  el.append(who, title);
  if (frame.description) {
    // Prose, not markdown: this is the assistant explaining what it is asking
    // for, and a decision the user has to be able to read at a glance.
    const description = document.createElement('div');
    description.className = 'form-description';
    description.textContent = frame.description;
    el.append(description);
  }
  if (frame.template) {
    const tpl = document.createElement('div');
    tpl.className = 'form-template';
    tpl.textContent = frame.template;
    el.append(tpl);
  }
  if (frame.embed_id) {
    // The thing the question is about, rendered inside the question — an
    // ordinary embed slot, so the existing resolve/mount pipeline serves it.
    const preview = document.createElement('div');
    preview.className = 'embed-slot form-embed-preview';
    preview.dataset.embedId = frame.embed_id;
    el.append(preview);
  }

  const inputs = new Map();
  const choices = new Map();
  const choiceButtons = [];
  for (const field of frame.fields || []) {
    if (field.type === 'choice') {
      // A button row: one click answers. The value lands in `choices` and the
      // form submits itself when the click completes it.
      const row = document.createElement('div');
      row.className = 'form-field form-choice';
      const label = document.createElement('span');
      label.className = 'form-label';
      label.textContent = field.label || field.name;
      const buttons = document.createElement('div');
      buttons.className = 'form-actions';
      for (const option of field.options || []) {
        const button = document.createElement('button');
        button.type = 'button';
        button.textContent = option;
        button.addEventListener('click', () => {
          choices.set(field.name, option);
          el.requestSubmit();
        });
        choiceButtons.push(button);
        buttons.append(button);
      }
      row.append(label, buttons);
      el.append(row);
      continue;
    }
    const row = document.createElement('label');
    row.className = `form-field${field.type === 'secret' ? ' secret' : ''}`;

    const label = document.createElement('span');
    label.className = 'form-label';
    label.textContent = field.label || field.name;
    if (field.required === false) label.textContent += ' (optional)';

    let input;
    if (field.type === 'select') {
      input = document.createElement('select');
      for (const option of field.options || []) {
        const el2 = document.createElement('option');
        el2.value = option;
        el2.textContent = option;
        input.append(el2);
      }
      if (field.value !== undefined) input.value = field.value;
    } else {
      input = document.createElement('input');
      input.type =
        field.type === 'secret' ? 'password' : field.type === 'number' ? 'number' : 'text';
      if (field.type === 'secret') input.autocomplete = 'new-password';
      if (field.value !== undefined) input.value = field.value;
    }
    input.name = field.name;
    inputs.set(field.name, input);

    row.append(label, input);
    if (field.type === 'secret') {
      const note = document.createElement('span');
      note.className = 'form-note';
      note.textContent = 'goes straight to the secret store — the assistant sees a reference';
      row.append(note);
    }
    el.append(row);
  }

  const status = document.createElement('div');
  status.className = 'form-status';

  const actions = document.createElement('div');
  actions.className = 'form-actions';
  const submit = document.createElement('button');
  submit.type = 'submit';
  submit.textContent = 'Submit';
  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.className = 'secondary';
  cancel.textContent = 'Cancel';
  actions.append(submit, cancel);
  el.append(status, actions);

  const entry = {
    el,
    awaiting: false,
    settle(text) {
      entry.awaiting = false;
      state.forms.delete(frame.form_id);
      el.innerHTML = '';
      el.append(who, title);
      const done = document.createElement('div');
      done.className = 'form-status';
      done.textContent = text;
      el.append(done);
    },
    reject(message) {
      entry.awaiting = false;
      status.textContent = message;
      status.classList.add('bad');
      for (const input of inputs.values()) input.disabled = false;
      for (const button of choiceButtons) button.disabled = false;
      submit.disabled = false;
      cancel.disabled = false;
    },
  };
  state.forms.set(frame.form_id, entry);

  const freeze = () => {
    entry.awaiting = true;
    status.textContent = '';
    status.classList.remove('bad');
    for (const input of inputs.values()) input.disabled = true;
    for (const button of choiceButtons) button.disabled = true;
    submit.disabled = true;
    cancel.disabled = true;
  };

  el.onsubmit = (e) => {
    e.preventDefault();
    const values = {};
    for (const [name, input] of inputs) values[name] = input.value;
    for (const [name, picked] of choices) values[name] = picked;
    freeze();
    if (!send('form.submit', { form_id: frame.form_id, values })) {
      entry.reject('not connected');
    }
  };
  cancel.onclick = () => {
    freeze();
    if (!send('form.cancel', { form_id: frame.form_id })) entry.reject('not connected');
  };

  // A pure button-row form has nothing to type and nothing else to submit:
  // the buttons ARE the submit, and a second "Submit" would ask twice.
  if ((frame.fields || []).length && (frame.fields || []).every((f) => f.type === 'choice')) {
    submit.style.display = 'none';
  }

  $('messages').append(el);
  if (frame.embed_id) mountEmbeds(el);
  countUnseen();
  scrollMessages();
  inputs.values().next().value?.focus();
}

/* ── attachments (§26.2) ──────────────────────────────────────────────────── */

/**
 * Upload now, reference later. The bytes go straight to `POST /api/uploads`
 * over HTTP — never through a WS frame — and the message that follows carries
 * ids only. That is the same anti-telephone rule the server side keeps: the
 * picture is moved by the parts of the system that move bytes, and named by
 * the parts that name things.
 */
async function uploadFile(file) {
  const res = await fetch('/api/uploads', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token()}`,
      'content-type': file.type || 'application/octet-stream',
      'x-upload-name': encodeURIComponent(file.name || 'image'),
    },
    body: file,
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.message || body.error || `HTTP ${res.status}`);
  return { ...body, name: file.name || 'image' };
}

async function attachFiles(files) {
  for (const file of files) {
    if (!file.type.startsWith('image/')) {
      addMessage('error', `${file.name}: chat attachments are images only`, 'error');
      continue;
    }
    try {
      const uploaded = await uploadFile(file);
      state.pending.push(uploaded);
      renderPending();
    } catch (e) {
      addMessage('error', `${file.name}: ${e.message}`, 'error');
    }
  }
}

function renderPending() {
  const box = $('attachments');
  box.innerHTML = '';
  box.hidden = state.pending.length === 0;
  for (const item of state.pending) {
    const chip = document.createElement('div');
    chip.className = 'attachment';
    const img = document.createElement('img');
    void showUpload(img, item.upload_id);
    const drop = document.createElement('button');
    drop.type = 'button';
    drop.className = 'attachment-remove';
    drop.textContent = '×';
    drop.title = `Remove ${item.name}`;
    drop.onclick = () => {
      state.pending = state.pending.filter((p) => p !== item);
      renderPending();
    };
    const name = document.createElement('span');
    name.textContent = item.name;
    chip.append(img, name, drop);
    box.append(chip);
  }
}

/**
 * Point an `<img>` at an upload. The GET route needs the bearer token and an
 * `<img src>` cannot carry a header, so the bytes are fetched and object-URL'd
 * — the same trick the file panel uses (§18.5). An upload that has been reaped
 * 404s, and the placeholder says so rather than showing a broken image.
 */
async function showUpload(img, uploadId) {
  try {
    const res = await fetch(`/api/uploads/${encodeURIComponent(uploadId)}`, {
      headers: { authorization: `Bearer ${token()}` },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    img.src = URL.createObjectURL(await res.blob());
  } catch {
    img.replaceWith(
      Object.assign(document.createElement('span'), {
        className: 'attachment-gone',
        textContent: '(image no longer stored)',
      }),
    );
  }
}

$('attach').onclick = () => $('attach-input').click();
$('attach-input').onchange = async (e) => {
  await attachFiles([...e.target.files]);
  e.target.value = '';
};

// Drag and drop anywhere over the transcript: the composer is small and the
// thing people aim at is the conversation.
for (const type of ['dragover', 'drop']) {
  $('messages').addEventListener(type, (e) => {
    e.preventDefault();
    if (type === 'drop') void attachFiles([...(e.dataTransfer?.files ?? [])]);
  });
}

$('composer').onsubmit = (e) => {
  e.preventDefault();
  const text = $('input').value.trim();
  if (!text) return;
  const attachments = state.pending.map((p) => p.upload_id);
  if (
    !send('chat.send', {
      conversation_id: state.conversationId,
      text,
      ...(attachments.length ? { attachments } : {}),
    })
  ) {
    addMessage('error', 'not connected', 'error');
    return;
  }
  addMessage('user', text, undefined, state.pending);
  state.pending = [];
  renderPending();
  // Asking a question means you want to watch the answer, wherever you had
  // scrolled to before.
  scrollMessages(true);
  $('input').value = '';
  sizeInput();
  $('send').disabled = true;
  state.streamedChars = 0;
  state.reasoningChars = 0;
  state.turnTokensIn = 0;
  state.turnTokensOut = 0;
  showActivity({ kind: 'thinking', turn: 1 });
  renderUsage();
};

$('input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    $('composer').requestSubmit();
  }
});

$('new').onclick = () => {
  state.conversationId = null;
  localStorage.removeItem(CONV_KEY);
  clearMessages();
  renderConversations();
  // The button lives in the sidebar's footer, so on a narrow screen the thing
  // it just made is underneath the sheet you pressed it from.
  dismissSheets();
  $('input').focus();
};

function archiveConversation(id) {
  send('conversation.close', { conversation_id: id });
  // Archiving means "I am done with this" - if it was the open one, start
  // clean rather than reopening it with the next message.
  if (id !== state.conversationId) return;
  state.conversationId = null;
  localStorage.removeItem(CONV_KEY);
  clearMessages();
}

function renderArchivedToggle() {
  const button = $('show-archived');
  button.setAttribute('aria-pressed', state.showArchived ? 'true' : 'false');
  paintIcon(button, state.showArchived ? 'eye' : 'eye-off');
  button.title = state.showArchived
    ? 'Hide archived conversations'
    : 'Show archived conversations';
}

$('show-archived').onclick = () => {
  state.showArchived = !state.showArchived;
  localStorage.setItem(ARCHIVED_KEY, state.showArchived ? '1' : '0');
  renderArchivedToggle();
  refreshConversations();
};

/* ── the drawer (§9.1) ─────────────────────────────────────────────────────
   Files (§18.5), views (§22.6) and activity (§4.2.1) are one pane on the right
   with three tabs, and `state.drawer` — a tab key, or null for closed — is the
   whole of its state. They were never simultaneously reachable: below
   `ui_sheet_max` the layout allowed exactly one, so three toggles were
   describing a state nothing honoured. The rail is a `tablist` for the same
   reason it is one control: what it selects is one of three, and the arrow
   keys that come with the role are what make it a single tab stop.

   Each tab's `refresh` is the frame that re-derives it, which is also what the
   shared header's refresh button sends and what a reconnect replays. */

const DRAWER_TABS = {
  files: { title: 'Files', refresh: () => send('files.list', {}) },
  embeds: { title: 'Views', refresh: () => send('embed.list', { kind: 'persistent' }) },
  activity: { title: 'Activity', refresh: () => send('event.list', {}) },
};

/**
 * The tab the drawer is actually showing, which is not always the one chosen.
 *
 * `embeds` stays *selected* while it has nothing to show rather than being
 * deselected: switching conversation empties the shelf before the new
 * transcript's markers have resolved, and dropping the choice there would shut
 * the panel on every switch and never bring it back.
 */
function drawerTab() {
  if (state.drawer === 'embeds' && !embedsAvailable()) return null;
  return state.drawer;
}

function applyDrawer() {
  const showing = drawerTab();
  document.body.classList.toggle('drawer-open', showing !== null);
  for (const key of Object.keys(DRAWER_TABS)) {
    // Selected is what is *showing*, not what is chosen: `state.drawer` keeps
    // the preference through a momentarily empty shelf, but announcing a tab
    // as selected while its panel is not on screen is a lie to a reader who
    // cannot see either.
    $(`tab-${key}`).setAttribute('aria-selected', showing === key ? 'true' : 'false');
    $(`tab-${key}`).tabIndex = -1;
    $(`panel-${key}`).hidden = showing !== key;
  }
  // Roving tabindex: the rail is one stop on the Tab order and the arrows move
  // inside it. The stop is the showing tab, or — with none showing, or a
  // selection that went disabled underneath it — the first that can take it.
  const stop =
    (showing && !$(`tab-${showing}`).disabled && $(`tab-${showing}`)) ||
    document.querySelector('#drawer-tabs [role="tab"]:not([disabled])');
  if (stop) stop.tabIndex = 0;
  if (showing) $('drawer-title').textContent = DRAWER_TABS[showing].title;
  applySheets();
}

/** `persist: false` moves the drawer without overwriting the wide preference. */
function setDrawer(tab, persist = true) {
  const next = tab && Object.hasOwn(DRAWER_TABS, tab) ? tab : null;
  state.drawer = next;
  if (persist) localStorage.setItem(DRAWER_KEY, next ?? '');
  applyDrawer();
  if (!next) return;
  soloPane('drawer');
  DRAWER_TABS[next].refresh();
  // The server half is on its way; the half already in hand draws now.
  if (next === 'embeds') renderEmbedList();
  if (next === 'activity') renderActivity();
}

/* ── the shell on a narrow screen (§9.1, App. A) ──────────────────────────
   Below the sheet threshold the side panes stop being columns and overlay the
   transcript instead. The body classes stay the single source of state; what
   this code does is decide, on every crossing, whether the saved preference
   applies (wide) or whether everything starts closed (sheets), and keep the
   sidebar and the drawer from ever landing on top of each other.

   The stored values are the *wide* preference. Sheet mode moves the same
   classes with `persist: false`, so narrowing the window does not quietly
   rewrite what you chose for the big screen. */

const SHEET_MODE = window.matchMedia('(max-width: 1099.98px)');

function anyPaneOpen() {
  return !document.body.classList.contains('sidebar-collapsed') || drawerTab() !== null;
}

/** The scrim exists exactly when a sheet is over the transcript. */
function applySheets() {
  document.body.classList.toggle('sheet-open', SHEET_MODE.matches && anyPaneOpen());
}

/**
 * Opening a pane closes the one it would otherwise cover. Only sheet mode has
 * that problem now: as columns the sidebar and the drawer leave 500px of
 * transcript at `ui_sheet_max`, which is the width the layout is built around.
 */
function soloPane(which) {
  if (!SHEET_MODE.matches) return;
  if (which !== 'sidebar') setCollapsed(true, false);
  if (which !== 'drawer' && state.drawer) setDrawer(null, false);
}

function closeAllPanes() {
  setCollapsed(true, false);
  setDrawer(null, false);
}

/**
 * Put the sheets away, but only where they were covering something (§9.1).
 *
 * In sheet mode a pane sits *over* the transcript, so an action taken inside
 * one that changes what the transcript shows has to dismiss it — otherwise you
 * tap New and the empty conversation you asked for is behind the sidebar you
 * asked from. On a wide screen the sidebar is a column, nothing is covered,
 * and collapsing it would be a preference you did not express.
 */
function dismissSheets() {
  if (SHEET_MODE.matches) closeAllPanes();
}

function restorePanes() {
  setCollapsed(localStorage.getItem(COLLAPSED_KEY) === '1', false);
  // An unknown key — a stale preference, a hand-edited store — reads as closed
  // rather than putting the drawer in a state with no tab to leave it by.
  setDrawer(localStorage.getItem(DRAWER_KEY), false);
}

function applyLayout() {
  if (SHEET_MODE.matches) closeAllPanes();
  else restorePanes();
  applySheets();
}

SHEET_MODE.addEventListener('change', applyLayout);

$('scrim').onclick = closeAllPanes;

document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  // A <dialog> handles its own Escape; closing the sheets underneath it too
  // would dismiss two things for one keypress.
  if (document.querySelector('dialog[open]')) return;
  if (!document.body.classList.contains('sheet-open')) return;
  closeAllPanes();
});

/**
 * The composer grows with what is in it, from one line to a cap, rather than
 * standing at a fixed height that is too tall for a sentence and too short for
 * a paragraph. The cap is in viewport units because the thing it must not do
 * is push the transcript off a phone.
 */
const INPUT_MIN_H = 44;

function sizeInput() {
  const el = $('input');
  // An empty textarea still reports its *placeholder* in scrollHeight, so
  // measuring one would boot the composer three lines tall on a phone.
  // Measured against what is visible, not `innerHeight`: with a keyboard open
  // those are different numbers, and the layout one grows the box behind it.
  const cap = Math.round(visibleHeight() * 0.4);
  if (!el.value) {
    el.style.height = `${INPUT_MIN_H}px`;
    el.style.overflowY = 'hidden';
    return;
  }
  el.style.height = 'auto';
  const wanted = Math.max(INPUT_MIN_H, Math.min(el.scrollHeight, cap));
  el.style.height = `${wanted}px`;
  // A box that grows to fit its content has nothing to scroll; the bar only
  // earns its place once the cap stops the growing.
  el.style.overflowY = wanted >= cap ? 'auto' : 'hidden';
}

$('input').addEventListener('input', sizeInput);

/* The desktop placeholder teaches a keyboard shortcut that a phone does not
   have, in three lines of a one-line box. Compact gets the short version. */
const COMPACT = window.matchMedia('(max-width: 639.98px)');

function applyPlaceholder() {
  $('input').placeholder = COMPACT.matches
    ? 'Say something…'
    : 'Say something. Enter sends, shift+enter for a newline.';
}

COMPACT.addEventListener('change', applyPlaceholder);
// Crossing the breakpoint changes how many figures the strip carries, and a
// window that just got wider should not keep a phone's abbreviation.
COMPACT.addEventListener('change', () => {
  document.body.classList.remove('usage-open');
  renderUsage();
});

/* The usage strip is one line on a phone (§9.1) and this is how you see the
   rest of it. A re-render, not just a wrap: the collapsed line carries two of
   the figures, so opening it has to build the others (see usageForWidth). */
$('usage').onclick = () => {
  document.body.classList.toggle('usage-open');
  renderUsage();
};

/**
 * `persist: false` is how sheet mode moves the panes without overwriting the
 * wide-layout preference — you closed the sidebar because the window got
 * narrow, not because you wanted it closed forever (§9.1).
 */
function setCollapsed(collapsed, persist = true) {
  document.body.classList.toggle('sidebar-collapsed', collapsed);
  if (persist) localStorage.setItem(COLLAPSED_KEY, collapsed ? '1' : '0');
  applySheets();
}

$('collapse').onclick = () => setCollapsed(true);
$('expand').onclick = () => {
  setCollapsed(false);
  soloPane('sidebar');
};

$('gate-pair-start').onclick = () => void startPairing();

$('gate-pair-cancel').onclick = () => {
  stopPairing();
  paintGate(false);
};

$('gate-manual').onclick = () => {
  // "Nothing to type" stops being true directly above a field to type in.
  $('gate-pair-hint').hidden = true;
  $('gate-manual').hidden = true;
  $('gate-entry').hidden = false;
  $('gate-token').focus();
};

$('gate-form').onsubmit = (e) => {
  e.preventDefault();
  const value = $('gate-token').value.trim();
  if (!value) {
    $('gate-error').textContent = 'enter the token first';
    return;
  }
  localStorage.setItem(TOKEN_KEY, value);
  $('gate-token').value = '';
  closeGate();
  setStatus('connecting…', false);
  state.retryMs = 500;
  connect();
};

$('gate-reveal').onclick = () => {
  const input = $('gate-token');
  const shown = input.type === 'text';
  input.type = shown ? 'password' : 'text';
  paintIcon($('gate-reveal'), shown ? 'eye' : 'eye-off');
  $('gate-reveal').title = shown ? 'Show the token' : 'Hide the token';
  input.focus();
};

$('forget-token').onclick = async () => {
  const ok = await confirmDialog({
    title: 'Sign out?',
    body: 'This browser will need the device token again before it can connect.',
    confirm: 'Sign out',
  });
  if (!ok) return;
  localStorage.removeItem(TOKEN_KEY);
  location.reload();
};

/* ── the model selector (§10.6) ───────────────────────────────────────────── */

/**
 * Shown only when there is more than one endpoint: a selector with one option
 * is furniture. Endpoints without the `tools` cap are labelled rather than
 * hidden — the user forcing a model is allowed to force a limited one, they
 * just should not be surprised by it.
 *
 * The effort control (§10.6) has its own condition: the endpoint that would
 * serve this conversation has to declare levels. A single-endpoint install
 * that declares them still gets the control; an install whose model never
 * claimed to understand the knob never sees it.
 */
function renderModelSelector() {
  const box = $('model-selector');
  const endpoints = state.models.endpoints;
  const servingEndpoint = endpoints.find((e) => e.serves_this_conversation);
  const efforts = servingEndpoint?.efforts ?? [];
  box.innerHTML = '';
  box.hidden = endpoints.length < 2 && !efforts.length;
  if (box.hidden) return;
  if (endpoints.length >= 2) renderModelPick(box, endpoints);
  if (efforts.length) renderEffortPick(box, efforts);
}

function renderModelPick(box, endpoints) {
  const select = document.createElement('select');
  select.id = 'model-pick';
  const auto = document.createElement('option');
  auto.value = '';
  const serving = endpoints.find((e) => e.serves_this_conversation);
  auto.textContent = `auto${serving && !state.models.override ? ` (${serving.name})` : ''}`;
  select.append(auto);
  for (const endpoint of endpoints) {
    const option = document.createElement('option');
    option.value = endpoint.name;
    const bits = [endpoint.name];
    if (!endpoint.caps?.includes('tools')) bits.push('no tools');
    if (endpoint.cost)
      bits.push(
        `${endpoint.cost.in_per_mtok}/${endpoint.cost.out_per_mtok} ${endpoint.cost.currency}`,
      );
    else bits.push('local');
    option.textContent = bits.join(' · ');
    option.selected = state.models.override === endpoint.name;
    select.append(option);
  }
  select.onchange = () => chooseModel({ endpoint: select.value || null });
  box.append(select);
}

/**
 * Both controls write the same way (§10.6). Before the first message there is
 * no conversation to pin, so the choice is held and applied to the one that
 * message creates — a control that silently does nothing is worse than no
 * control at all.
 */
function chooseModel(patch) {
  if (state.conversationId) {
    send('conversation.model', { conversation_id: state.conversationId, ...patch });
    return;
  }
  state.models.pending = { ...(state.models.pending ?? {}), ...patch };
  if ('endpoint' in patch) state.models.override = patch.endpoint;
  if ('effort' in patch) state.models.effort = patch.effort;
}

/**
 * The reasoning level. "default" is not a level — it is the absence of the
 * parameter, which is what the endpoint's own configuration then decides.
 */
function renderEffortPick(box, efforts) {
  const select = document.createElement('select');
  select.id = 'effort-pick';
  select.title = 'Reasoning effort';
  const auto = document.createElement('option');
  auto.value = '';
  auto.textContent = 'effort: default';
  select.append(auto);
  for (const level of efforts) {
    const option = document.createElement('option');
    option.value = level;
    option.textContent = `effort: ${level}`;
    option.selected = state.models.effort === level;
    select.append(option);
  }
  select.onchange = () => chooseModel({ effort: select.value || null });
  box.append(select);
}

/* ── devices and access tokens (§24) ──────────────────────────────────────── */

/**
 * The device list. There is nothing to hide here because there is nothing to
 * show: the server keeps only hashes, so a listing is metadata by construction
 * rather than by redaction (§24.1). `last_seen` is the highest delivery the
 * device ever acked — the only honest answer to "is this thing still alive".
 */
function renderDevices() {
  const box = $('device-list');
  box.innerHTML = '';
  if (!state.devices.length) {
    const empty = document.createElement('div');
    empty.className = 'device-empty';
    empty.textContent = 'no devices';
    box.append(empty);
    return;
  }
  for (const d of state.devices) {
    const row = document.createElement('div');
    row.className = 'device';

    const label = document.createElement('div');
    label.className = 'label';
    const name = document.createElement('span');
    name.className = 'title';
    name.textContent = d.label ? `${d.label} (${d.device})` : d.device;
    const when = document.createElement('span');
    when.className = 'when';
    const created = d.created_at ? new Date(d.created_at).toLocaleDateString() : 'unknown date';
    when.textContent = `${created} · last seen ${d.last_seen || 'never'}`;
    label.append(name, when);

    const revoke = document.createElement('button');
    revoke.className = 'device-revoke';
    revoke.textContent = 'Revoke';
    revoke.title = `Revoke ${d.device} — it will be disconnected immediately`;
    revoke.onclick = async () => {
      const ok = await confirmDialog({
        title: `Revoke ${d.device}?`,
        body: 'That device is disconnected at once and will need a new token to return.',
        confirm: 'Revoke',
        danger: true,
      });
      if (ok) send('token.revoke', { device: d.device });
    };

    row.append(label, revoke);
    box.append(row);
  }
}

function openDevices() {
  $('device-error').textContent = '';
  $('device-reveal').hidden = true;
  send('token.list', {});
  $('devices').showModal();
}

$('devices-toggle').onclick = openDevices;
$('devices-close').onclick = () => $('devices').close();
$('devices').addEventListener('click', (e) => {
  if (e.target === $('devices')) $('devices').close();
});

$('device-add').onsubmit = (e) => {
  e.preventDefault();
  const device = $('device-name').value.trim();
  const label = $('device-label').value.trim();
  if (!device) {
    $('device-error').textContent = 'name the device first';
    return;
  }
  $('device-error').textContent = '';
  send('token.create', { device, ...(label ? { label } : {}) });
};

$('reveal-copy').onclick = async () => {
  try {
    await navigator.clipboard.writeText($('reveal-token').textContent || '');
    $('reveal-copy').textContent = 'Copied';
    setTimeout(() => ($('reveal-copy').textContent = 'Copy'), 1500);
  } catch {
    // Clipboard permission refused, or an insecure origin: the value is on
    // screen and selectable, which is the fallback that always works.
    $('reveal-copy').textContent = 'Select it';
  }
};

/**
 * The one moment a token value exists (§24.2). Nothing here is stored: no
 * localStorage, no state field that outlives the dialog — closing it is how
 * the value leaves the browser, and the server never had it to give again.
 */
function showReveal(p) {
  $('reveal-title').textContent = p.label ? `${p.label} (${p.device})` : p.device;
  $('reveal-qr').innerHTML = '';
  if (typeof p.qr_svg === 'string') {
    // Server-rendered SVG from our own qrcode encoder, not page-supplied
    // markup. Parsed inert and re-adopted rather than assigned to innerHTML:
    // a QR code is paths and rectangles, so the parse costs nothing, and it
    // means the one place this UI takes markup from a frame cannot become the
    // place a frame runs script in this origin. Anything that is not an <svg>
    // root is simply not drawn — a missing QR sends the user to the token
    // underneath it, which is the same fallback a scan failure gives them.
    const doc = new DOMParser().parseFromString(p.qr_svg, 'image/svg+xml');
    const svg = doc.querySelector('parsererror') ? null : doc.documentElement;
    if (svg && svg.nodeName.toLowerCase() === 'svg') {
      const holder = document.createElement('div');
      holder.append(document.importNode(svg, true));
      $('reveal-qr').append(holder);
    }
  }
  $('reveal-token').textContent = p.token || '';
  $('reveal-copy').textContent = 'Copy';
  $('reveal-hint').textContent = p.base_url_guessed
    ? `Scan to connect: ${p.connect_url} — that address was guessed from this machine's interfaces; set gateway.public_url if the scan cannot reach it.`
    : `Scan to connect: ${p.connect_url}`;
  $('device-reveal').hidden = false;
  $('device-name').value = '';
  $('device-label').value = '';
  if (!$('devices').open) $('devices').showModal();
}

/* ── the file panel (§18.5): a tree, rendered markdown, and a textarea ─────── */

function setFileStatus(text) {
  $('file-status').textContent = text || '';
}

/**
 * The list and the open file are two views of the same panel rather than two
 * squeezed halves of it — with a hundred files, half a panel each is no use to
 * anyone, and there has to be a way back out of a file.
 */
function setFileViewing(viewing) {
  $('panel-files').classList.toggle('viewing', viewing);
}

function closeFile() {
  state.files.path = null;
  state.files.content = null;
  state.files.editing = false;
  revokePreview();
  setFileViewing(false);
  setFileStatus('');
  $('file-name').textContent = '';
  $('file-body').innerHTML = '';
  $('file-editor').value = '';
  renderFileActions(false);
  renderFileList();
}

function renderFileList() {
  const box = $('file-list');
  box.innerHTML = '';
  if (!state.files.entries.length) {
    const empty = document.createElement('div');
    empty.className = 'file-empty';
    empty.textContent = 'nothing here yet';
    box.append(empty);
    return;
  }
  for (const entry of state.files.entries) {
    const el = document.createElement('div');
    el.className = `file-entry${entry.path === state.files.path ? ' active' : ''}`;
    const name = document.createElement('span');
    name.className = 'file-path';
    name.textContent = entry.path;
    const meta = document.createElement('span');
    meta.className = 'file-meta';
    meta.textContent = entry.binary
      ? 'binary'
      : `${Math.max(1, Math.round(entry.size / 1024))}k`;
    el.append(name, meta);
    el.onclick = () => {
      setFileStatus('');
      send('files.read', { path: entry.path });
    };
    box.append(el);
  }
}

function renderFileActions(hasText) {
  $('file-edit').style.display = hasText && !state.files.editing ? '' : 'none';
  $('file-save').style.display = state.files.editing ? '' : 'none';
  $('file-cancel').style.display = state.files.editing ? '' : 'none';
  // Spelled out rather than '': the stylesheet hides the editor by default, so
  // clearing the inline style would leave it hidden and editing impossible.
  $('file-editor').style.display = state.files.editing ? 'block' : 'none';
  $('file-body').style.display = state.files.editing ? 'none' : '';
}

function renderFileView(file) {
  setFileViewing(true);
  $('file-name').textContent = file.path;
  const body = $('file-body');
  body.innerHTML = '';
  revokePreview();
  // What the file *is* decides the renderer, not whether the store could read
  // it as text (§18.5): a PDF is a PDF either way.
  const kind = previewKind(file.mime);
  if (kind) {
    showPreview(body, file, kind);
    renderFileActions(false);
    renderFileList();
    return;
  }
  if (file.binary) {
    const note = document.createElement('div');
    note.className = 'file-empty';
    note.textContent = `${file.mime}, ${file.size} bytes — binary files are stored but not read`;
    body.append(note);
    renderFileActions(false);
    renderFileList();
    return;
  }
  $('file-editor').value = file.content;
  if (/\.(md|markdown)$/i.test(file.path)) renderChecklist(body, file);
  else {
    const pre = document.createElement('pre');
    pre.textContent = file.content;
    body.append(pre);
  }
  renderFileActions(true);
  renderFileList();
}

/**
 * Images and PDFs preview through the browser's own renderers (§18.5), fed by
 * the authenticated raw route. A media element's `src` cannot carry an
 * Authorization header, so the bytes are fetched with one and handed over as a
 * blob URL — which is also why the URL has to be revoked when the panel moves
 * on, or a session of browsing a folder leaks every file it looked at.
 */
let previewUrl = null;

function revokePreview() {
  if (!previewUrl) return;
  URL.revokeObjectURL(previewUrl);
  previewUrl = null;
}

async function showPreview(body, file, kind) {
  const note = document.createElement('div');
  note.className = 'file-empty';
  note.textContent = `${file.mime} — loading preview…`;
  body.append(note);
  let blob;
  try {
    const res = await fetch(`/api/files/raw?path=${encodeURIComponent(file.path)}`, {
      headers: { authorization: `Bearer ${token()}` },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    blob = await res.blob();
  } catch (e) {
    note.textContent = `${file.mime} — preview failed: ${e.message}`;
    return;
  }
  // The panel may have moved on while the bytes were in flight.
  if (state.files.path !== file.path) return;
  revokePreview();
  previewUrl = URL.createObjectURL(blob);
  const element = document.createElement(kind === 'pdf' ? 'embed' : 'img');
  element.className = kind === 'pdf' ? 'file-pdf' : 'file-image';
  element.src = previewUrl;
  if (kind === 'pdf') element.type = 'application/pdf';
  else element.alt = file.path;
  note.replaceWith(element);
}

/**
 * Markdown with live checkboxes. Toggling one writes through files.edit with the
 * whole line as the match, so the commit says exactly what changed and nothing
 * else in the file can be disturbed (§18.5).
 */
function renderChecklist(body, file) {
  const rendered = document.createElement('div');
  rendered.className = 'file-markdown';
  renderMarkdown(rendered, file.content);
  body.append(rendered);

  const lines = file.content.split('\n');
  const boxes = [...rendered.querySelectorAll('input[type=checkbox]')];
  const todoLines = lines
    .map((line, i) => ({ line, i }))
    .filter(({ line }) => /^\s*[-*+]\s*\[[ xX]\]/.test(line));

  boxes.forEach((box, n) => {
    const target = todoLines[n];
    box.disabled = !target;
    if (!target) return;
    box.onclick = (e) => {
      e.preventDefault();
      const done = /\[[xX]\]/.test(target.line);
      const next = target.line.replace(/\[[ xX]\]/, done ? '[ ]' : '[x]');
      setFileStatus(done ? 'unticking…' : 'ticking…');
      send('files.edit', {
        path: file.path,
        find: target.line,
        replace: next,
        message: `${done ? 'untick' : 'tick'}: ${target.line.trim().slice(0, 60)}`,
      });
    };
  });
}

/**
 * What the reader does with their hands. Recorded rather than inferred: a
 * `scroll` event says the position changed, never who changed it, and the
 * difference decides whether leaving the bottom was a decision or a side effect
 * of the page growing (see GESTURE_MS).
 */
for (const type of ['wheel', 'touchstart', 'touchmove', 'keydown']) {
  $('messages').addEventListener(
    type,
    () => {
      state.gestureAt = performance.now();
    },
    { passive: true },
  );
}

/**
 * A press counts only when it lands on the scrollbar. Dragging that is
 * scrolling; clicking inside the transcript is not — and treating the click
 * that expands the activity block as a scroll gesture would stop the pinning
 * for exactly as long as the block takes to animate open, which is the drift
 * this whole mechanism exists to prevent.
 */
$('messages').addEventListener(
  'mousedown',
  (e) => {
    const box = $('messages');
    if (e.clientX - box.getBoundingClientRect().left > box.clientWidth) {
      state.gestureAt = performance.now();
    }
  },
  { passive: true },
);

/**
 * Follow mode, resolved once per frame. Landing at the bottom always re-engages
 * it — however you got there — but leaving it only counts while the reader is
 * driving. Everything else that moves this scroller (our own pinning, the
 * browser's anchoring correction when the activity block expands) is the page
 * settling, not a request to read history.
 */
$('messages').addEventListener(
  'scroll',
  () => {
    if (state.jumpTick) return;
    // One check per frame: a fast scroll fires this dozens of times.
    state.jumpTick = requestAnimationFrame(() => {
      state.jumpTick = null;
      if (atBottom($('messages'))) {
        state.follow = true;
        state.unseen = 0;
      } else if (readerIsDriving()) {
        state.follow = false;
      }
      refreshJump();
    });
  },
  { passive: true },
);

// A window resize changes what is below the fold without any scrolling.
window.addEventListener('resize', () => refreshJump());

/**
 * Below this, the gap between the layout viewport and the visible one is a
 * scrollbar, a rounding error or a browser chrome animation — not a keyboard.
 */
const KEYBOARD_MIN_PX = 60;

/** What the reader can actually see, which is what the layout gets to own. */
function visibleHeight() {
  const vv = window.visualViewport;
  return vv && vv.scale <= 1.01 ? vv.height : window.innerHeight;
}

/**
 * The on-screen keyboard is the one thing that changes the viewport without
 * changing the *layout* viewport (§9.1). `interactive-widget=resizes-content`
 * (index.html) makes Chrome shrink `dvh` for it and needs nothing else; Safari
 * implements neither that nor a `dvh` that moves, so on iOS the composer — the
 * last thing in a full-height column — sits behind the keyboard unless
 * something measures. `visualViewport` is that something.
 *
 * Two properties come out of it: the height the shell may occupy, and how much
 * of the layout viewport is occluded at the bottom. The second is what stops
 * the home-indicator allowance being added on top of a keyboard that already
 * covers the indicator.
 *
 * Both are **removed** when nothing is occluding, so every other screen — and
 * every desktop window — resolves to the `100dvh` the stylesheet had before.
 */
function trackVisibleViewport() {
  const vv = window.visualViewport;
  if (!vv) return;
  const root = document.documentElement;
  let tick = null;
  const measure = () => {
    tick = null;
    // Pinch-zoom shrinks the visual viewport too, and shrinking the shell to
    // match would fight the reader's own zoom. Only an unzoomed viewport
    // describes the layout; while zoomed, the last honest measurement stands.
    if (vv.scale > 1.01) return;
    const occluded = Math.max(0, Math.round(window.innerHeight - vv.height - vv.offsetTop));
    if (occluded < KEYBOARD_MIN_PX) {
      root.style.removeProperty('--visible-height');
      root.style.removeProperty('--keyboard-inset');
    } else {
      root.style.setProperty('--visible-height', `${Math.round(vv.height)}px`);
      root.style.setProperty('--keyboard-inset', `${occluded}px`);
      // iOS scrolls the layout viewport to reveal a focused field before it
      // tells us the viewport moved. The shell has just been shortened to sit
      // on the keyboard, so that scroll is a gap at the top and nothing else.
      if (window.scrollY !== 0) window.scrollTo(0, 0);
    }
    // The composer's ceiling is a fraction of a number that just changed, and
    // the transcript's bottom moved with it. Follow mode decides whether we
    // chase it — the keyboard opening is not the reader asking to leave.
    sizeInput();
    scrollMessages();
  };
  // One measurement per frame: `scroll` fires continuously while a keyboard
  // animates in, and each one writes two properties that relayout the shell.
  const schedule = () => {
    if (tick === null) tick = requestAnimationFrame(measure);
  };
  vv.addEventListener('resize', schedule);
  vv.addEventListener('scroll', schedule);
  measure();
}

$('jump').onclick = () => {
  // Back to the bottom, and following again — which is the whole point of the
  // badge: one press to stop reading history and rejoin the live output.
  scrollMessages(true);
  $('jump').hidden = true;
};

/* Pressing the selected tab again closes the drawer. A tablist normally always
   has a selection; this one may have none, because the rail is the opener too
   and a drawer with no way to shut it would cover the transcript on a phone
   until you found the scrim. */
for (const tab of document.querySelectorAll('#drawer-tabs [role="tab"]')) {
  tab.onclick = () => setDrawer(state.drawer === tab.dataset.tab ? null : tab.dataset.tab);
}

/* Arrows move within the rail, which is what makes three buttons one stop on
   the Tab order. Activation follows focus — the ARIA pattern's expensive case
   is a panel that has to be fetched, and each of these is one small list frame
   over a socket that is already open. */
$('drawer-tabs').addEventListener('keydown', (e) => {
  const steps = { ArrowLeft: -1, ArrowRight: 1, Home: 'first', End: 'last' };
  if (!Object.hasOwn(steps, e.key)) return;
  const tabs = [...document.querySelectorAll('#drawer-tabs [role="tab"]:not([disabled])')];
  if (!tabs.length) return;
  const step = steps[e.key];
  const at = Math.max(tabs.indexOf(document.activeElement), 0);
  const next =
    step === 'first'
      ? tabs[0]
      : step === 'last'
        ? tabs[tabs.length - 1]
        : tabs[(at + step + tabs.length) % tabs.length];
  e.preventDefault();
  next.focus();
  setDrawer(next.dataset.tab);
});

$('drawer-close').onclick = () => setDrawer(null);
/* One refresh for three panels: what it re-derives is whatever tab is showing,
   which is the same frame the tab sends when you select it. */
$('drawer-refresh').onclick = () => {
  const showing = drawerTab();
  if (showing) DRAWER_TABS[showing].refresh();
};
$('file-back').onclick = () => closeFile();
$('file-edit').onclick = () => {
  state.files.editing = true;
  renderFileActions(true);
  $('file-editor').focus();
};
$('file-cancel').onclick = () => {
  state.files.editing = false;
  $('file-editor').value = state.files.content ?? '';
  renderFileActions(true);
  setFileStatus('');
};
$('file-save').onclick = () => {
  if (!state.files.path) return;
  setFileStatus('saving…');
  send('files.save', { path: state.files.path, content: $('file-editor').value });
};

paintIcons();
applyLayout();
trackVisibleViewport();
applyPlaceholder();
sizeInput();
setFileViewing(false);
renderFileActions(false);
renderArchivedToggle();
connect();
