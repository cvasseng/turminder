/**
 * Serving an embed (§22.3–22.4). Everything here exists to keep LLM-authored
 * code in an opaque origin with exactly three ways to talk back.
 */

/** Ids and tokens are interpolated into a script literal; verify their shape. */
const ID_RE = /^[0-9A-Za-z]{1,64}$/;
const TOKEN_RE = /^[0-9a-f]{64}$/;

export function isSafeEmbedId(id: string): boolean {
  return ID_RE.test(id);
}

/**
 * The exact policy from §22.3.3. Two directives carry the weight: the `sandbox`
 * directive means even a freestanding top-level open runs with an opaque origin
 * (the iframe attribute only covers the in-chat case), and `connect-src`
 * confines the page's network reach to its own API path — a leaked scoped token
 * cannot even be *sent* anywhere else from inside the embed.
 */
export function embedCsp(origin: string, id: string): string {
  return [
    'sandbox allow-scripts',
    "default-src 'none'",
    // Two script sources beyond inline (§23.3): `/embed-vendor/`, which serves
    // the pinned client libs out of node_modules, and code.highcharts.com —
    // charting is Highcharts, and the CDN keeps exported embeds portable.
    // connect-src stays locked either way: a script tag is the whole widening.
    `script-src 'unsafe-inline' ${origin}/embed-vendor/ https://code.highcharts.com`,
    `style-src 'unsafe-inline' ${origin}/embed-vendor/`,
    'img-src data:',
    `connect-src ${origin}/embed-api/${id}/`,
  ].join('; ');
}

/**
 * A transient print document (§23.4) has no embed-api to reach, so its policy
 * is the embed policy minus the one directive that would let it talk: nothing
 * to connect to, and no scoped token in the page at all.
 */
export function printCsp(origin: string): string {
  return [
    'sandbox allow-scripts',
    "default-src 'none'",
    `script-src 'unsafe-inline' ${origin}/embed-vendor/ https://code.highcharts.com`,
    `style-src 'unsafe-inline' ${origin}/embed-vendor/`,
    'img-src data:',
    "connect-src 'none'",
  ].join('; ');
}

/**
 * The shipped theme (§23.3): one look across every embed, deck and printed
 * PDF. Tokens as CSS custom properties, and a Highcharts theme applied via a
 * setter trap the moment the CDN script assigns `window.Highcharts` — before
 * any author code can build a chart, regardless of how that code is timed.
 * Versioned here in the service: restyling the system is one change,
 * everywhere.
 */
const LIGHT_PALETTE = [
  '#4f6df5',
  '#e8618c',
  '#12a594',
  '#f5a623',
  '#8f6ff0',
  '#2ea3f2',
  '#5b8c5a',
  '#d0605e',
];

/** Same hues, lifted for dark surfaces — series keep their identity across modes. */
const DARK_PALETTE = [
  '#7c93ff',
  '#ff85ab',
  '#2ec4b0',
  '#ffc55c',
  '#b39bff',
  '#5cbcff',
  '#8fc48d',
  '#ff8b88',
];

const chartTokens = (palette: readonly string[]): string =>
  palette.map((c, i) => `  --t-chart-${i + 1}: ${c};`).join('\n');

/**
 * Standards mode, deliberately. An embed is a fragment, not a document, so
 * without this every served page lands in quirks mode — where percentage
 * heights and viewport units quietly mean something else, and a reveal.js deck
 * prints as one blank page instead of one page per slide (§23.3–23.4).
 */
const DOCTYPE = `<!doctype html>\n<meta charset="utf-8">\n`;

function themeBlock(): string {
  return `<style>
/* House tokens (§23.3). Dark mode is a token swap, nothing else: everything
   downstream — page, charts, decks — styles against the variables, so the
   scheme change is one media query and zero authored code. */
:root {
  color-scheme: light dark;
  --t-font: system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif;
  --t-mono: ui-monospace, 'JetBrains Mono', Menlo, Consolas, monospace;
  --t-bg: #ffffff;
  --t-surface: #f6f7f9;
  --t-fg: #1c2330;
  --t-muted: #5c6675;
  --t-border: #dde2ea;
  --t-grid: #eef1f5;
  --t-accent: ${LIGHT_PALETTE[0]};
  --t-radius: 6px;
  --t-gap: 12px;
${chartTokens(LIGHT_PALETTE)}
}
@media (prefers-color-scheme: dark) {
  :root {
    --t-bg: #12151c;
    --t-surface: #1a1f29;
    --t-fg: #e6e9f0;
    --t-muted: #98a2b3;
    --t-border: #2a3140;
    --t-grid: #232a38;
    --t-accent: ${DARK_PALETTE[0]};
${chartTokens(DARK_PALETTE)}
  }
}
body {
  font-family: var(--t-font);
  background: var(--t-bg);
  color: var(--t-fg);
  margin: var(--t-gap);
}
/* A deck is an embed (§23.3), and reveal.js is served without one of its own
   themes on purpose: its variables are wired to the house tokens here, so a
   presentation looks like the dashboard it was cut from. A deck also owns the
   whole viewport — enforced here, not left to the authored markup. */
html:has(.reveal), body:has(.reveal) {
  height: 100%;
  margin: 0;
  overflow: hidden;
}
.reveal-viewport {
  width: 100%;
  height: 100%;
  --r-background-color: var(--t-bg);
  --r-main-font: var(--t-font);
  --r-main-font-size: 34px;
  --r-main-color: var(--t-fg);
  --r-heading-font: var(--t-font);
  --r-heading-color: var(--t-fg);
  --r-heading-line-height: 1.2;
  --r-heading-text-transform: none;
  --r-heading1-size: 2.2em;
  --r-heading2-size: 1.6em;
  --r-heading3-size: 1.3em;
  --r-heading4-size: 1em;
  --r-code-font: var(--t-mono);
  --r-link-color: var(--t-accent);
  --r-link-color-hover: var(--t-accent);
  --r-selection-color: var(--t-bg);
  --r-selection-background-color: var(--t-accent);
  background: var(--t-bg);
  color: var(--t-fg);
}
</style>
<script>
(function () {
  /* The Highcharts theme is BUILT FROM the CSS tokens above, so light/dark is
     one source of truth: read the variables, hand Highcharts the result. */
  function tok(name) {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  }
  function palette() {
    var out = [], i, c;
    for (i = 1; i <= 8; i++) { c = tok('--t-chart-' + i); if (c) out.push(c); }
    return out;
  }
  function theme() {
    return {
      colors: palette(),
      chart: { backgroundColor: 'transparent', style: { fontFamily: tok('--t-font') } },
      title: { style: { color: tok('--t-fg'), fontSize: '16px', fontWeight: '600' } },
      subtitle: { style: { color: tok('--t-muted') } },
      xAxis: { lineColor: tok('--t-border'), tickColor: tok('--t-border'), labels: { style: { color: tok('--t-muted') } }, title: { style: { color: tok('--t-muted') } } },
      yAxis: { gridLineColor: tok('--t-grid'), labels: { style: { color: tok('--t-muted') } }, title: { style: { color: tok('--t-muted') } } },
      legend: { itemStyle: { color: tok('--t-fg') }, itemHoverStyle: { color: tok('--t-fg') } },
      tooltip: { backgroundColor: tok('--t-fg'), style: { color: tok('--t-bg') } },
      credits: { enabled: false }
    };
  }

  var hc;
  Object.defineProperty(window, 'Highcharts', {
    configurable: true,
    get: function () { return hc; },
    set: function (v) {
      hc = v;
      try { if (v && v.setOptions) v.setOptions(theme()); } catch (e) { /* best-effort */ }
    }
  });

  /* Scheme change restyles LIVE charts, not just future ones: re-derive the
     theme from the swapped tokens and push it into every existing chart. */
  function restyle() {
    if (!hc || !hc.setOptions) return;
    var t = theme();
    try { hc.setOptions(t); } catch (e) { return; }
    (hc.charts || []).slice().forEach(function (c) {
      if (!c) return;
      try {
        c.update({ colors: t.colors, chart: t.chart, title: t.title, subtitle: t.subtitle,
                   legend: t.legend, tooltip: t.tooltip }, false);
        (c.xAxis || []).forEach(function (a) { a.update(t.xAxis, false); });
        (c.yAxis || []).forEach(function (a) { a.update(t.yAxis, false); });
        c.redraw(false);
      } catch (e) { /* one stubborn chart must not stop the rest */ }
    });
  }
  try {
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', restyle);
  } catch (e) { /* older matchMedia — theme still correct at load */ }

  /* Decks (§23.3): house behavior enforced around Reveal, not requested from
     the authored code. The trap wraps initialize() to supply the defaults —
     animated transitions, fixed logical size, no URL-hash pollution — and
     wires slide entry to chart replay: a chart built on a hidden slide has
     zero size and a spent animation, so on entry it is rebuilt from its own
     userOptions, which sizes it to the now-visible container and plays the
     load animation the audience is looking at. Opt out per container with
     data-no-replay. */
  function replayCharts(slide) {
    if (!hc || !slide) return;
    (hc.charts || []).slice().forEach(function (c) {
      if (!c || !c.renderTo || !slide.contains(c.renderTo)) return;
      if (c.renderTo.hasAttribute && c.renderTo.hasAttribute('data-no-replay')) return;
      var el = c.renderTo, opts = c.userOptions;
      try { c.destroy(); hc.chart(el, opts); } catch (e) { /* keep the old chart */ }
    });
  }

  var rv;
  Object.defineProperty(window, 'Reveal', {
    configurable: true,
    get: function () { return rv; },
    set: function (v) {
      rv = v;
      if (!v || typeof v.initialize !== 'function') return;
      var realInit = v.initialize.bind(v);
      v.initialize = function (opts) {
        var merged = Object.assign({
          transition: 'slide',
          backgroundTransition: 'fade',
          controls: true,
          progress: true,
          hash: false,
          width: 1280,
          height: 720,
          margin: 0.05
        }, opts || {});
        // Animated transitions are the house style; 'none' is not on offer.
        if (merged.transition === 'none') merged.transition = 'slide';
        var done = realInit(merged);
        var after = done && done.then ? done : Promise.resolve();
        after.then(function () {
          try {
            replayCharts(v.getCurrentSlide());
            v.on('slidechanged', function (e) { replayCharts(e.currentSlide); });
          } catch (e) { /* deck still works without replay */ }
        });
        return done;
      };
    }
  });
})();
</script>
`;
}

/**
 * The `window.turminder` shim (§22.4). The scoped token is closed over rather
 * than hung off the object: an embed's own code can still use it, and a
 * misbehaving snippet cannot read it back out of a global to put it somewhere
 * else.
 *
 * `text/plain` on the writes is deliberate — it keeps them CORS-simple, so the
 * common case never spends a preflight round-trip from an opaque origin.
 */
function runtimeScript(id: string, token: string, data: Record<string, unknown>): string {
  return `<script>
(function () {
  var base = '/embed-api/${id}/';
  var t = '${token}';
  var bound = ${scriptJson(data)};
  function freeze(v) {
    if (v && typeof v === 'object') { Object.keys(v).forEach(function (k) { freeze(v[k]); }); Object.freeze(v); }
    return v;
  }
  function send(path, method, body) {
    return fetch(base + path + '?t=' + t, {
      method: method,
      headers: { 'content-type': 'text/plain;charset=utf-8' },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
  }
  window.turminder = {
    event: function (action, data) {
      return send('event', 'POST', { action: action, data: data })
        .then(function (r) { return r.json(); })
        .catch(function () { return { accepted: false }; });
    },
    getState: function () {
      return fetch(base + 'state?t=' + t)
        .then(function (r) { return r.json(); })
        .then(function (b) { return b && b.state ? b.state : {}; })
        .catch(function () { return {}; });
    },
    setState: function (obj) {
      return send('state', 'PUT', obj)
        .then(function (r) { return r.json(); })
        .catch(function () { return { accepted: false }; });
    },
    // Bound data (§23.2), read-only and already here: the numbers arrived with
    // the page, not through the model. An empty object when nothing is bound.
    data: freeze(bound)
  };
})();
</script>
`;
}

/**
 * The served document: theme, then runtime, then the authored HTML verbatim.
 * Prepending matters twice over — an embed that calls `turminder.getState()`
 * in a script at the top of its own body must find the shim already there,
 * and the Highcharts setter trap must be installed before the CDN script tag
 * in the authored HTML can assign the global. Authored CSS comes after the
 * theme block, so an embed can still override a token deliberately — the
 * skill says not to, the mechanism does not have to.
 */
export function renderPrintDoc(html: string): string {
  // The theme, and nothing else: no runtime shim, because a print document has
  // no state and no events — and no token to leak into one.
  return `${DOCTYPE}${themeBlock()}${html}`;
}

export function renderEmbed(
  html: string,
  id: string,
  token: string,
  data: Record<string, unknown> = {},
): string {
  if (!ID_RE.test(id)) throw new Error(`refusing to serve an embed with a suspect id: ${id}`);
  if (!TOKEN_RE.test(token)) throw new Error('refusing to serve an embed with a suspect token');
  return (
    `${DOCTYPE}${themeBlock()}${runtimeScript(id, token, data)}` + substituteData(html, data)
  );
}

/* ── data placement (§23.2) ─────────────────────────────────────────────── */

const DATA_PLACEHOLDER = /\{\{data:([A-Za-z0-9_-]+)((?:\.[A-Za-z0-9_-]+)*)\}\}/g;

/**
 * `{{data:name}}` / `{{data:name.path}}` → the bound value, HTML-escaped
 * (§23.2). The model wrote the placeholder; the value never went near it.
 *
 * An unresolvable placeholder is left standing, deliberately. The alternative —
 * substituting nothing — turns a mis-named binding into a page with a blank
 * where a number should be, which is indistinguishable from a zero. A visible
 * `{{data:revneue}}` names its own bug.
 */
export function substituteData(html: string, data: Record<string, unknown>): string {
  return html.replace(DATA_PLACEHOLDER, (whole, name: string, path: string) => {
    const resolved = resolvePath(data[name], path ? path.slice(1).split('.') : []);
    return resolved === undefined || resolved === null
      ? whole
      : escapeHtml(renderValue(resolved));
  });
}

function resolvePath(value: unknown, segments: readonly string[]): unknown {
  let current = value;
  for (const segment of segments) {
    if (current === null || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

function renderValue(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  // An object in a text position is a placeholder pointed at the wrong depth;
  // showing its JSON is more use to whoever has to fix it than showing nothing.
  return JSON.stringify(value);
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * JSON safe to sit inside a `<script>` block: `</script>` in a bound string
 * would otherwise end the shim early and hand the rest of the value to the
 * HTML parser.
 */
function scriptJson(value: unknown): string {
  return JSON.stringify(value ?? {})
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}
