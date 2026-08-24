/**
 * Pairing and settings (§29.5).
 *
 * Three things happen here and they happen in this order for a reason: ask for
 * the host permission (a browser will only grant one inside a click), prove the
 * token against `/api/whoami`, and only then store it. A token stored before it
 * is proven is a capture that fails later, in the popup, with the page already
 * gone.
 *
 * The way in is §24.4's pairing: this page asks the gateway to let it in, shows
 * the code it gets back, and a prompt on an already-linked device approves it —
 * so nobody carries a 64-character token between two browsers. The link and
 * token fields stay for the cases with no second screen to approve on.
 */
var $ = function (id) {
  return document.getElementById(id);
};

var DEFAULT_GATEWAY = 'http://localhost:7787';
/** App. A `pair_poll_interval_s`: how often a waiting device asks (§24.4). */
var PAIR_POLL_MS = 2000;

/** The ticket of the pairing in flight, and nothing else about it. */
var pairing = null;

function setStatus(text, kind) {
  var el = $('status');
  el.textContent = text;
  el.className = 'status' + (kind ? ' ' + kind : '');
  el.hidden = !text;
}

/**
 * `<base>/#connect=<token>&device=<name>` (§24.3), the same string the QR
 * encodes and the desktop shell parses.
 *
 * Hand-decoded rather than run through `URLSearchParams`, which reads a `+` as
 * a space — harmless for a hex token, wrong for a device someone named with
 * one, and a silent difference from `app/src-tauri/src/connect.rs` either way.
 */
function parseConnectUrl(input) {
  var parsed;
  try {
    parsed = new URL(String(input).trim());
  } catch {
    return null;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  var fragment = parsed.hash.replace(/^#/, '');
  if (!fragment) return null;

  var token = '';
  var device = '';
  fragment.split('&').forEach(function (pair) {
    var at = pair.indexOf('=');
    if (at === -1) return;
    var key = pair.slice(0, at);
    var value = pair.slice(at + 1);
    try {
      value = decodeURIComponent(value);
    } catch {
      /* a malformed escape is a value we take verbatim rather than lose */
    }
    if (key === 'connect') token = value;
    if (key === 'device') device = value;
  });
  if (!token) return null;
  // A device name is a label; the token is what authenticates, so a link
  // without one still connects.
  return { gatewayUrl: parsed.origin, token: token, device: device || 'browser' };
}

function originPattern(gatewayUrl) {
  return new URL(gatewayUrl).origin + '/*';
}

/** The pairing probe (§29.5): bearer in, `{device, label?}` back. */
function whoami(gatewayUrl, token, done) {
  fetch(gatewayUrl + '/api/whoami', { headers: { authorization: 'Bearer ' + token } })
    .then(function (res) {
      if (res.status === 401) return done({ error: 'unauthorized' });
      if (!res.ok) return done({ error: 'http_' + res.status });
      return res.json().then(function (body) {
        done({ identity: body });
      });
    })
    .catch(function () {
      done({ error: 'unreachable' });
    });
}

/** The gateway as typed, with the trailing slashes a person leaves behind. */
function gatewayValue() {
  return ($('gateway').value.trim() || DEFAULT_GATEWAY).replace(/\/+$/, '');
}

function showCode(code) {
  $('pair-value').textContent = code || '…';
  $('pair-code').hidden = !code;
}

function stopPairing() {
  if (pairing && pairing.timer) clearTimeout(pairing.timer);
  pairing = null;
  showCode('');
}

/**
 * Ask to be let in (§24.4). The host permission comes first and inside the
 * click, for the same reason it does in `connect()` — everything after it is a
 * fetch this origin is not allowed to make otherwise.
 */
function pair() {
  var gatewayUrl = gatewayValue();
  var pattern;
  try {
    pattern = originPattern(gatewayUrl);
  } catch {
    return setStatus('That gateway URL is not a URL.', 'bad');
  }
  stopPairing();
  setStatus('Asking for access to ' + gatewayUrl + '…');
  chrome.permissions.request({ origins: [pattern] }, function (granted) {
    if (!granted) {
      return setStatus(
        'Without access to ' + gatewayUrl + ' the extension cannot send anything there.',
        'bad',
      );
    }
    fetch(gatewayUrl + '/api/pair/request', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      // A category, not a name: the assistant writes what the prompt offers,
      // and whoever approves it has the last word (§24.4).
      body: JSON.stringify({ kind: 'browser' }),
    })
      .then(function (res) {
        return res.ok ? res.json() : { error: 'http_' + res.status };
      })
      .then(function (body) {
        if (body.error === 'nothing_linked') {
          return setStatus(
            'Nothing is linked to that assistant yet, so there is nobody to approve this — ' +
              'use a connect link instead.',
            'bad',
          );
        }
        if (body.error) {
          return setStatus(body.message || 'That did not work: ' + body.error, 'bad');
        }
        pairing = { ticket: body.ticket, timer: null, gatewayUrl: gatewayUrl };
        showCode(body.code);
        setStatus('Waiting for approval…');
        pollPairing();
      })
      .catch(function () {
        setStatus('Could not reach ' + gatewayUrl + ' — is the service running?', 'bad');
      });
  });
}

/** Poll for the answer. The ticket is what the token is delivered against. */
function pollPairing() {
  if (!pairing) return;
  var ticket = pairing.ticket;
  var gatewayUrl = pairing.gatewayUrl;
  pairing.timer = setTimeout(function () {
    if (!pairing || pairing.ticket !== ticket) return;
    fetch(gatewayUrl + '/api/pair/claim', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ticket: ticket }),
    })
      .then(function (res) {
        return res.ok ? res.json() : { status: 'pending' };
      })
      .then(function (body) {
        if (body.status === 'approved') {
          stopPairing();
          // Straight from the response to the store — never into the field on
          // this page. A token that arrived without anyone reading it should
          // not end up somewhere a screenshot can catch it (§24).
          // Proven first regardless (§29.5): arriving down a channel we trust
          // is not the same as knowing it works.
          setStatus('Checking the token…');
          store(gatewayUrl, body.token);
          return;
        }
        if (body.status === 'declined' || body.status === 'expired') {
          stopPairing();
          setStatus(
            body.status === 'declined'
              ? 'That request was declined on the other device.'
              : 'That code expired. Try again.',
            'bad',
          );
          return;
        }
        pollPairing();
      })
      // A blink is not a refusal: keep asking until the code itself runs out.
      .catch(function () {
        pollPairing();
      });
  }, PAIR_POLL_MS);
}

/** Prove a token, then keep it — the one path to stored credentials (§29.5). */
function store(gatewayUrl, token) {
  whoami(gatewayUrl, token, function (result) {
    if (result.error === 'unauthorized') {
      return setStatus('The assistant does not recognise that token.', 'bad');
    }
    if (result.error) {
      return setStatus('Could not reach ' + gatewayUrl + ' — is the service running?', 'bad');
    }
    var identity = result.identity || {};
    chrome.storage.local.set(
      { gateway_url: gatewayUrl, token: token, device: identity.device || '' },
      function () {
        setStatus(
          'Connected as ' + (identity.label || identity.device) + '. Capture away.',
          'ok',
        );
      },
    );
  });
}

function connect() {
  var pasted = $('connect').value.trim();
  if (pasted) {
    var parsed = parseConnectUrl(pasted);
    if (!parsed) {
      return setStatus(
        'That does not look like a connect link — it needs a #connect= token on the end.',
        'bad',
      );
    }
    $('gateway').value = parsed.gatewayUrl;
    $('token').value = parsed.token;
    $('connect').value = '';
  }

  var gatewayUrl = gatewayValue();
  var token = $('token').value.trim();
  if (!token) return setStatus('No token to connect with.', 'bad');

  var pattern;
  try {
    pattern = originPattern(gatewayUrl);
  } catch {
    return setStatus('That gateway URL is not a URL.', 'bad');
  }

  setStatus('Asking for access to ' + gatewayUrl + '…');
  // Must be the first thing in the click: browsers only grant an optional
  // permission while a user gesture is still on the stack, and an await or a
  // storage round-trip before this line loses it.
  chrome.permissions.request({ origins: [pattern] }, function (granted) {
    if (!granted) {
      return setStatus(
        'Without access to ' + gatewayUrl + ' the extension cannot send anything there.',
        'bad',
      );
    }
    setStatus('Checking the token…');
    store(gatewayUrl, token);
  });
}

function forget() {
  stopPairing();
  chrome.storage.local.remove(['gateway_url', 'token', 'device'], function () {
    $('token').value = '';
    // The host permission outlives the token unless it is handed back too —
    // a revoked device should not leave standing access to the origin behind.
    var gatewayUrl = $('gateway').value.trim();
    try {
      chrome.permissions.remove({ origins: [originPattern(gatewayUrl)] }, function () {});
    } catch {
      /* nothing stored, nothing to hand back */
    }
    setStatus('Forgotten. This browser can no longer send captures.', 'ok');
  });
}

chrome.storage.local.get(['gateway_url', 'token', 'device'], function (stored) {
  $('gateway').value = (stored && stored.gateway_url) || DEFAULT_GATEWAY;
  $('token').value = (stored && stored.token) || '';
  if (stored && stored.device) setStatus('Currently connected as ' + stored.device + '.');
});

$('pair-btn').addEventListener('click', pair);
$('pair-cancel').addEventListener('click', function () {
  stopPairing();
  setStatus('');
});
$('connect-btn').addEventListener('click', connect);
$('forget').addEventListener('click', forget);
