const $ = (id) => document.getElementById(id);
let lastProbe = null;

async function postJson(path, body) {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

/**
 * Model ids come from whatever endpoint was typed into the box, so they are
 * somebody else's text before they are ours. Escaped on the way into markup.
 */
function escapeHtml(text) {
  return String(text).replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );
}

/**
 * One model or a choice of them.
 *
 * An endpoint serving exactly one model has nothing to ask about — llama.cpp
 * is the whole reason the plain line exists. A hosted provider lists dozens in
 * no order anybody chose, and taking the first was how setup ended up
 * committed to whichever model happened to sort first. Changing the selection
 * re-probes, because the capability tags below belong to a model, not to an
 * address (§10.2) — showing one model's tools/JSON/vision answers above
 * another model's name would be a lie the commit then writes down.
 */
function modelRow(p) {
  const chosen = p.model_id ?? '';
  if (!p.models || p.models.length < 2) {
    return `<div><strong>${escapeHtml(chosen || 'unknown model')}</strong></div>`;
  }
  const options = p.models
    .map((m) => `<option${m === chosen ? ' selected' : ''}>${escapeHtml(m)}</option>`)
    .join('');
  return `<div><select id="model" aria-label="Model">${options}</select></div>`;
}

function check(label, ok) {
  return `<div class="check"><span>${label}</span><span class="${ok ? 'yes' : 'no'}">${
    ok ? 'yes' : 'no'
  }</span></div>`;
}

function render(p) {
  const notes = p.notes.map((n) => `<div class="note">! ${n}</div>`).join('');
  if (!p.reachable) {
    $('result').innerHTML = `<div class="card"><strong class="no">Unreachable.</strong>
      <div class="note">${p.error ?? ''}</div>${notes}</div>`;
    return;
  }
  $('result').innerHTML = `
    <div class="card">
      ${modelRow(p)}
      <div style="color:var(--dim)">${p.url} · context ${p.context_size ?? '?'} tokens</div>
      <div style="margin-top:10px">
        ${check('answers completions', p.checks.completion)}
        ${check('schema-constrained JSON', p.checks.json)}
        ${check('tool calling', p.checks.tools)}
        ${check('long context (32k+)', p.checks.long_context)}
      </div>
      ${p.smoke ? `<div style="margin-top:8px;color:var(--dim)">smoke test said: <code>${p.smoke}</code></div>` : ''}
      ${notes}
      ${
        p.checks.tools
          ? ''
          : '<div class="note">Without reliable tool calls this endpoint is fine for chat, but handlers will be limited.</div>'
      }
      <div class="row"><button id="save">Save and start</button></div>
    </div>`;
  $('save').onclick = save;
  // Re-measure against whatever was picked, rather than re-labelling the
  // answers already on screen.
  const picker = $('model');
  if (picker) picker.onchange = () => probe(picker.value);
}

/**
 * Ask the address whether it embeds, rather than consulting a list of who
 * usually does.
 *
 * The provider dropdown's `data-embeddings` attribute is a guess made when
 * that list was written, and §28.5 is explicit that the list is a convenience
 * and never an authority. So the guess sets the box before anyone probes, and
 * the probe overrules it after — in both directions. A vector came back or it
 * did not, and the width of it is the number the index would be built around.
 */
async function probeEmbeddings() {
  const note = $('embeddings-note');
  const box = $('embeddings');
  note.textContent = 'Checking whether this endpoint can embed…';
  try {
    const r = await postJson('/api/setup/probe', {
      url: $('url').value.trim(),
      api_key: $('apikey').value.trim() || undefined,
      kind: 'embedding',
      // Endpoints that serve more than one model require the field, and
      // answer a request without it with a 422 rather than a default.
      model: lastProbe?.model_id || undefined,
    });
    box.disabled = !r.reachable;
    box.checked = Boolean(r.reachable);
    note.textContent = r.reachable
      ? `Embeddings available — ${r.dimensions}-dimension vectors. Semantic search is on.`
      : // What the endpoint actually said, not just that it said no: "422
        // model field required" and "404 no such route" are different answers
        // and only one of them means this endpoint cannot embed.
        `No embeddings here — search will use keyword matching, and everything else works. ${r.error ?? ''}`.trim();
  } catch (e) {
    // A probe that could not run is not a verdict: leave the box where the
    // provider list put it and say why, rather than silently deciding.
    note.textContent = `Could not check for embeddings (${e.message}) — leaving this as it was.`;
  }
}

async function probe(model) {
  $('probe').disabled = true;
  $('result').innerHTML = model
    ? `<p>Probing ${escapeHtml(model)} — a cold model can take a minute…</p>`
    : '<p>Probing — a cold model can take a minute…</p>';
  try {
    lastProbe = await postJson('/api/setup/probe', {
      url: $('url').value.trim(),
      api_key: $('apikey').value.trim() || undefined,
      model: model || undefined,
    });
    render(lastProbe);
    // Only worth asking once the address answered at all, and only about the
    // endpoint — a model choice does not change whether the host embeds.
    if (lastProbe.reachable && !model) await probeEmbeddings();
  } catch (e) {
    $('result').innerHTML = `<div class="card"><strong class="no">Probe failed.</strong>
      <div class="note">${e.message}</div></div>`;
  } finally {
    $('probe').disabled = false;
  }
}

async function save() {
  $('save').disabled = true;
  try {
    const endpoint = {
      name: 'main',
      url: lastProbe.url,
      classes: ['fast', 'best'],
      caps: lastProbe.caps,
    };
    if (lastProbe.model_id) endpoint.model = lastProbe.model_id;
    if (lastProbe.context_size) endpoint.context_size = lastProbe.context_size;
    const apiKey = $('apikey').value.trim();
    if (apiKey) endpoint.api_key = apiKey;

    const useEmbeddings = $('embeddings').checked;
    const res = await postJson('/api/setup/commit', {
      endpoints: [endpoint],
      embedding: useEmbeddings,
    });
    // Only ever a fallback: connect.js has already stored a token if the
    // fragment carried one, which is how a shell-launched or scanned first run
    // arrives. This covers the plain-browser case, where the scaffold's
    // one-time token is the only one anybody has.
    if (res.ui_token) localStorage.setItem(TOKEN_KEY, res.ui_token);
    location.href = '/';
  } catch (e) {
    $('result').insertAdjacentHTML('beforeend', `<div class="note">${e.message}</div>`);
    $('save').disabled = false;
  }
}

/* ── the provider picker ─────────────────────────────────────────────────── */

/**
 * Choosing a provider only fills the URL box: the probe still has to pass
 * before anything is written, hosted or local. Nothing here is authoritative
 * about a provider — a base URL that has moved fails the probe visibly, which
 * is the whole reason the probe runs before the commit.
 */
const providerOption = () => $('provider').selectedOptions[0];

/** Which option, if any, claims the URL currently in the box. */
function optionForUrl(url) {
  const trimmed = url.trim().replace(/\/+$/, '');
  return [...$('provider').options].find(
    (o) => o.dataset.url && o.dataset.url.replace(/\/+$/, '') === trimmed,
  );
}

/**
 * Some providers have no embeddings API at all — Anthropic is the one people
 * will reach for first. Leaving the box checked there produces a setup that
 * commits and then cannot embed anything, so the box is cleared and the reason
 * is said out loud. Semantic search degrades to lexical and nothing else
 * breaks (§28.5), which is exactly what the note beside it already explains.
 */
function applyEmbeddingsSupport() {
  const option = providerOption();
  const unsupported = option?.dataset.embeddings === 'no';
  const box = $('embeddings');
  box.disabled = unsupported;
  if (unsupported) box.checked = false;
  $('embeddings-note').textContent = unsupported
    ? `${option.textContent.trim()} has no embeddings endpoint — search will use keyword matching. You can add a separate embedding endpoint later.`
    : '';
}

$('provider').onchange = () => {
  const url = providerOption()?.dataset.url;
  if (url) {
    $('url').value = url;
    $('url').focus();
  }
  applyEmbeddingsSupport();
};

// Typing over the URL means the dropdown no longer describes what is in the
// box; saying "OpenAI" above a hand-typed address would be a lie.
$('url').addEventListener('input', () => {
  const match = optionForUrl($('url').value);
  $('provider').value = match ? match.value : '';
  applyEmbeddingsSupport();
});

// Start in agreement with whatever the box was prefilled with.
const initial = optionForUrl($('url').value);
if (initial) $('provider').value = initial.value;
applyEmbeddingsSupport();

$('probe').onclick = () => probe();
$('url').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') probe();
});
