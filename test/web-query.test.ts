import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS } from '../src/core/config.js';
import { PageCache, webFetchTools } from '../src/tools/integrations/web-fetch.js';
import { webQueryTools } from '../src/tools/integrations/web-query.js';

const ctx = { runId: null, eventId: null };
const URL_UNDER_TEST = 'https://example.com/prices';

/** A shop page shaped like the real thing: chrome, prose, a table, scripts. */
const PRICES = `<!doctype html>
<html><head><title>Nordic Widgets — Prices</title>
<script type="application/ld+json">{"@type":"Product","price":"1499.00"}</script>
<style>.price{color:green}</style></head>
<body>
<nav><a href="/">Home</a><a href="/prices">Prices</a><a href="/about">About</a></nav>
<main>
  <h1>Widget prices</h1>
  <p class="lede">Updated hourly. The current price of the Mk II is
     <span id="price">1 499 kr</span> including VAT.</p>
  <table class="prices">
    <thead><tr><th>Model</th><th>Price</th><th>Stock</th></tr></thead>
    <tbody>
      <tr><td>Mk I</td><td>999 kr</td><td>12</td></tr>
      <tr><td>Mk II</td><td>1 499 kr</td><td>3</td></tr>
      <tr><td>Mk III</td><td>2 099 kr</td><td>0</td></tr>
    </tbody>
  </table>
  <script>const analytics = "do not read me";</script>
</main>
<footer><p>Prices exclude shipping.</p></footer>
</body></html>`;

interface Upstream {
  fetch: typeof globalThis.fetch;
  calls: () => number;
  urls: string[];
}

/** An upstream that counts, so "one download, two queries" is assertable. */
function serving(html: string, contentType = 'text/html; charset=utf-8'): Upstream {
  const urls: string[] = [];
  const fetch = (async (input: URL | string) => {
    urls.push(String(input));
    return new Response(html, { status: 200, headers: { 'content-type': contentType } });
  }) as unknown as typeof globalThis.fetch;
  return { fetch, calls: () => urls.length, urls };
}

function queryTool(up: Upstream, pages?: PageCache) {
  return webQueryTools({
    settings: DEFAULT_SETTINGS,
    fetch: up.fetch,
    ...(pages ? { pages } : {}),
  })[0]!;
}

const query = (up: Upstream, args: Record<string, unknown>, pages?: PageCache) =>
  queryTool(up, pages).execute(args, ctx) as Promise<{
    url: string;
    matches: (string | { rows: string[][] })[];
    match_count: number;
    truncated: boolean;
    untrusted: boolean;
    error?: string;
    message?: string;
  }>;

describe('web.query selection (App. F.5)', () => {
  it('returns the text of what the selector matched, and nothing else', async () => {
    const up = serving(PRICES);
    const result = await query(up, { url: URL_UNDER_TEST, selector: '#price' });
    expect(result.matches).toEqual(['1 499 kr']);
    expect(result.match_count).toBe(1);
    expect(result.truncated).toBe(false);
    expect(result.untrusted).toBe(true);
    expect(result.url).toBe(URL_UNDER_TEST);
  });

  it('serialises a matched table as rows, header row first', async () => {
    const up = serving(PRICES);
    const result = await query(up, { url: URL_UNDER_TEST, selector: 'table.prices' });
    expect(result.match_count).toBe(1);
    expect(result.matches[0]).toEqual({
      rows: [
        ['Model', 'Price', 'Stock'],
        ['Mk I', '999 kr', '12'],
        ['Mk II', '1 499 kr', '3'],
        ['Mk III', '2 099 kr', '0'],
      ],
    });
  });

  it('returns an attribute instead of text when asked for one', async () => {
    const up = serving(PRICES);
    const result = await query(up, { url: URL_UNDER_TEST, selector: 'nav a', attr: 'href' });
    expect(result.matches).toEqual(['/', '/prices', '/about']);
    expect(result.match_count).toBe(3);
  });

  it('skips elements that do not carry the attribute at all', async () => {
    const up = serving('<body><a href="/one">one</a><a name="anchor">two</a></body>');
    const result = await query(up, { url: URL_UNDER_TEST, selector: 'a', attr: 'href' });
    expect(result.matches).toEqual(['/one']);
    expect(result.match_count).toBe(1);
  });

  it('greps the whole page with find, one window per hit', async () => {
    const up = serving(PRICES);
    const result = await query(up, { url: URL_UNDER_TEST, find: 'Mk II' });
    // Plain substring search, so the lede, the Mk II row and the Mk III row
    // all count — three hits is the honest answer, not two.
    expect(result.match_count).toBe(3);
    for (const match of result.matches) expect(String(match)).toContain('Mk II');
    expect(String(result.matches[0])).toContain('including VAT');
  });

  it('composes: the selector scopes, find filters within it', async () => {
    const up = serving(PRICES);
    const scoped = await query(up, {
      url: URL_UNDER_TEST,
      selector: 'table.prices tr',
      find: 'Mk III',
    });
    expect(scoped.match_count).toBe(1);
    expect(String(scoped.matches[0])).toContain('2 099 kr');
    expect(String(scoped.matches[0])).not.toContain('including VAT');
  });

  it('is case-insensitive about what it is looking for', async () => {
    const up = serving(PRICES);
    const result = await query(up, { url: URL_UNDER_TEST, find: 'WIDGET PRICES' });
    expect(result.match_count).toBe(1);
    expect(String(result.matches[0])).toContain('Widget prices');
  });

  it('gives a find hit the text around it, and marks where it was cut', async () => {
    const up = serving(`<body><p>${'a'.repeat(500)}NEEDLE${'b'.repeat(500)}</p></body>`);
    const result = await query(up, { url: URL_UNDER_TEST, find: 'NEEDLE' });
    const window = String(result.matches[0]);
    // ±200 characters (App. A), plus the ellipsis that says there was more.
    expect(window.startsWith('…')).toBe(true);
    expect(window.endsWith('…')).toBe(true);
    expect(window).toBe(`…${'a'.repeat(200)}NEEDLE${'b'.repeat(200)}…`);
  });

  it('leaves scripts and styles out of an element’s text', async () => {
    const up = serving(PRICES);
    const main = await query(up, { url: URL_UNDER_TEST, selector: 'main' });
    expect(String(main.matches[0])).toContain('Widget prices');
    expect(String(main.matches[0])).not.toContain('analytics');

    // But a script asked for by name is still handed over — the shortest route
    // to a price is often the JSON-LD block behind it.
    const ld = await query(up, {
      url: URL_UNDER_TEST,
      selector: 'script[type="application/ld+json"]',
    });
    expect(String(ld.matches[0])).toContain('"price":"1499.00"');
  });
});

describe('web.query honesty (App. F.5)', () => {
  it('counts every match even when only some come back', async () => {
    const up = serving(PRICES);
    const result = await query(up, { url: URL_UNDER_TEST, selector: 'a', max_matches: 2 });
    expect(result.matches).toHaveLength(2);
    expect(result.match_count).toBe(3);
    expect(result.truncated).toBe(true);
  });

  it('caps one match and says the result is short', async () => {
    const up = serving(`<body><p>${'x'.repeat(5000)}</p></body>`);
    const result = await query(up, { url: URL_UNDER_TEST, selector: 'p' });
    expect(String(result.matches[0])).toHaveLength(2000);
    expect(result.match_count).toBe(1);
    expect(result.truncated).toBe(true);
  });

  it('drops whole rows rather than truncate a table into invalid json', async () => {
    const rows = Array.from(
      { length: 60 },
      (_, i) => `<tr><td>row ${i}</td><td>${'y'.repeat(60)}</td></tr>`,
    ).join('');
    const up = serving(`<body><table>${rows}</table></body>`);
    const result = await query(up, { url: URL_UNDER_TEST, selector: 'table' });
    const match = result.matches[0] as { rows: string[][] };
    expect(JSON.stringify(match.rows).length).toBeLessThanOrEqual(2000);
    expect(match.rows.length).toBeGreaterThan(0);
    expect(match.rows.length).toBeLessThan(60);
    expect(match.rows[0]).toEqual(['row 0', 'y'.repeat(60)]);
    expect(result.truncated).toBe(true);
  });

  it('reports an honest nothing for a page whose content is javascript-rendered', async () => {
    // §16 keeps rendered-DOM querying for the chromium path; v1 says so plainly
    // rather than pretending the shell was the page.
    const up = serving(
      '<!doctype html><html><body><div id="root"></div>' +
        '<script src="/app.js"></script></body></html>',
    );
    const result = await query(up, { url: URL_UNDER_TEST, find: 'price' });
    expect(result.match_count).toBe(0);
    expect(result.matches).toEqual([]);
    expect(result.truncated).toBe(false);
  });
});

describe('web.query arguments', () => {
  it('insists on something to select or search for', async () => {
    const up = serving(PRICES);
    const result = await query(up, { url: URL_UNDER_TEST });
    expect(result.error).toBe('bad_args');
    expect(up.calls()).toBe(0);
  });

  it('refuses attr without a selector, because it has nothing to read from', async () => {
    const up = serving(PRICES);
    const result = await query(up, { url: URL_UNDER_TEST, attr: 'href' });
    expect(result.error).toBe('bad_args');
    expect(up.calls()).toBe(0);
  });

  it('reports a broken selector as data, not as an exception', async () => {
    const up = serving(PRICES);
    const result = await query(up, { url: URL_UNDER_TEST, selector: 'div[[[' });
    expect(result.error).toBe('bad_selector');
    expect(result.message).toBeTruthy();
  });

  it('is read-only, so it auto-executes and can be bound to an embed', async () => {
    expect(queryTool(serving(PRICES)).tier).toBe('ro');
  });
});

describe('the page cache the two readers share (App. F.5)', () => {
  it('downloads once for a query, a refined query, and a fetch', async () => {
    const up = serving(PRICES);
    const pages = new PageCache();
    const [fetchTool] = webFetchTools({
      settings: DEFAULT_SETTINGS,
      fetch: up.fetch,
      pages,
    });

    const wide = await query(up, { url: URL_UNDER_TEST, selector: 'td' }, pages);
    expect(wide.match_count).toBe(9);
    const narrow = await query(up, { url: URL_UNDER_TEST, selector: '#price' }, pages);
    expect(narrow.matches).toEqual(['1 499 kr']);
    const read = (await fetchTool!.execute({ url: URL_UNDER_TEST }, ctx)) as {
      content: string;
    };
    expect(read.content).toContain('Widget prices');

    expect(up.calls()).toBe(1);
  });

  it('goes upstream again once the sixty seconds are up', async () => {
    const up = serving(PRICES);
    let clock = 1_000_000;
    const pages = new PageCache(() => clock);
    await query(up, { url: URL_UNDER_TEST, selector: '#price' }, pages);
    clock += 59_000;
    await query(up, { url: URL_UNDER_TEST, selector: '#price' }, pages);
    expect(up.calls()).toBe(1);
    clock += 2_000;
    await query(up, { url: URL_UNDER_TEST, selector: '#price' }, pages);
    expect(up.calls()).toBe(2);
  });

  it('does not answer a hungrier caller from a page that was cut short', async () => {
    const up = serving(`<body><p>${'z'.repeat(400_000)}</p></body>`);
    const pages = new PageCache();
    const [fetchTool] = webFetchTools({
      settings: DEFAULT_SETTINGS,
      fetch: up.fetch,
      pages,
    });
    // web.fetch keeps 200k of markup by default; the query wants the lot.
    await fetchTool!.execute({ url: URL_UNDER_TEST }, ctx);
    const result = await query(up, { url: URL_UNDER_TEST, selector: 'p' }, pages);
    expect(up.calls()).toBe(2);
    expect(result.match_count).toBe(1);
  });
});

describe('web.query url policy — the same door as web.fetch', () => {
  const refused = ['file:///etc/passwd', 'https://user:pw@example.com/', 'not a url'];

  it('refuses exactly what web.fetch refuses, without a request', async () => {
    for (const url of [...refused, 'http://169.254.169.254/latest/meta-data']) {
      const up = serving(PRICES);
      const [fetchTool] = webFetchTools({ settings: DEFAULT_SETTINGS, fetch: up.fetch });
      const queried = await query(up, { url, selector: 'p' });
      const fetched = (await fetchTool!.execute({ url }, ctx)) as { error: string };
      expect(queried.error, url).toBe('url_refused');
      expect(fetched.error, url).toBe('url_refused');
      expect(up.calls()).toBe(0);
    }
  });

  it('gates private hosts on the same setting', async () => {
    const up = serving(PRICES);
    const tool = webQueryTools({
      settings: { ...DEFAULT_SETTINGS, fetchAllowPrivateHosts: false },
      fetch: up.fetch,
    })[0]!;
    const result = (await tool.execute(
      { url: 'http://192.168.1.10/status', selector: 'p' },
      ctx,
    )) as { error: string };
    expect(result.error).toBe('url_refused');
    expect(up.calls()).toBe(0);
  });

  it('passes an upstream failure through as data', async () => {
    const dead = (async () =>
      new Response('nope', { status: 503 })) as unknown as typeof globalThis.fetch;
    const tool = webQueryTools({ settings: DEFAULT_SETTINGS, fetch: dead })[0]!;
    const result = (await tool.execute({ url: URL_UNDER_TEST, selector: 'p' }, ctx)) as {
      error: string;
      message: string;
    };
    expect(result.error).toBe('fetch_failed');
    expect(result.message).toBe('HTTP 503');
  });
});

describe('why the tool exists (phase 19 exit criteria)', () => {
  it('answers a price question in a fraction of what reading the page costs', async () => {
    const padding = Array.from(
      { length: 300 },
      (_, i) => `<li><a href="/product/${i}">Widget accessory number ${i}, in stock</a></li>`,
    ).join('\n');
    const up = serving(PRICES.replace('<footer>', `<ul>${padding}</ul><footer>`));
    const pages = new PageCache();
    const [fetchTool] = webFetchTools({
      settings: DEFAULT_SETTINGS,
      fetch: up.fetch,
      pages,
    });

    const read = (await fetchTool!.execute({ url: URL_UNDER_TEST }, ctx)) as {
      content: string;
    };
    const asked = await query(up, { url: URL_UNDER_TEST, selector: '#price' }, pages);

    expect(read.content.length).toBeGreaterThan(10_000);
    expect(JSON.stringify(asked).length).toBeLessThan(2000);
    expect(asked.matches).toEqual(['1 499 kr']);
  });
});
