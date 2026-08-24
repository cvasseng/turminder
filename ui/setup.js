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
      <div><strong>${p.model_id ?? 'unknown model'}</strong></div>
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
}

async function probe() {
  $('probe').disabled = true;
  $('result').innerHTML = '<p>Probing — a cold model can take a minute…</p>';
  try {
    lastProbe = await postJson('/api/setup/probe', {
      url: $('url').value.trim(),
      api_key: $('apikey').value.trim() || undefined,
    });
    render(lastProbe);
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

$('probe').onclick = probe;
$('url').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') probe();
});
