/**
 * The QR/shell connect hand-off (§24.3), on its own so that *every* page
 * served at `/` gets it.
 *
 * `#connect=<token>&device=<name>` is how a token reaches a browser without
 * anyone retyping 64 hex characters: a scanned QR, or the desktop shell
 * handing the window what it already holds (§28.2). It used to live in
 * `app.js`, which meant it ran on the chat UI and nowhere else — so an
 * unconfigured service, which serves `setup.html` at `/` instead, dropped the
 * token on the floor and then asked for one by hand at the end of setup. That
 * is the entire first run of a bundled install, and of any connect-mode shell
 * pointed at a service that has not been set up yet.
 *
 * Loaded before the page's own script, and it runs on load: everything
 * downstream can just read `localStorage`.
 *
 * The token rides the *fragment* because a fragment never leaves the browser —
 * no server log, no proxy, no referrer sees it. Consume it and strip it
 * immediately: a token left in the address bar is a token in the history and
 * in every screenshot.
 */
const TOKEN_KEY = 'turminder.token';

function consumeConnectFragment() {
  const hash = location.hash.startsWith('#') ? location.hash.slice(1) : '';
  if (!hash.includes('connect=')) return;
  const params = new URLSearchParams(hash);
  const scanned = (params.get('connect') || '').trim();
  history.replaceState(null, '', location.pathname + location.search);
  if (!scanned) return;
  localStorage.setItem(TOKEN_KEY, scanned);
}

consumeConnectFragment();
