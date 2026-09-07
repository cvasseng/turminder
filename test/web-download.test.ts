import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, type Settings } from '../src/core/config.js';
import { openDataHome, type DataHome } from '../src/core/datadir.js';
import { FileStore } from '../src/files/store.js';
import { downloadPath, webFetchTools } from '../src/tools/integrations/web-fetch.js';
import type { ToolDefinition } from '../src/tools/types.js';
import { buildDocx, para, run } from './docx-fixture.js';
import { buildPdf } from './pdf-fixture.js';
import { bootService, type ServiceHarness } from './service-harness.js';
import { tmpDir } from './helpers.js';

const ctx = { runId: null, eventId: null };

let t: { dir: string; cleanup: () => void };
let home: DataHome;
let store: FileStore;

beforeEach(() => {
  t = tmpDir('turminder-download-');
  home = openDataHome(path.join(t.dir, 'home')).home;
  store = new FileStore({ root: home.filesDir, git: { repo: home.git, prefix: 'files' } });
});
afterEach(() => t.cleanup());

/** A response the injected fetch hands back, with the headers that matter. */
const serve = (
  body: Buffer,
  contentType: string,
  over: { contentLength?: string | null; status?: number } = {},
): typeof globalThis.fetch => {
  const headers: Record<string, string> = { 'content-type': contentType };
  const declared = over.contentLength === undefined ? String(body.length) : over.contentLength;
  if (declared !== null) headers['content-length'] = declared;
  return (async () =>
    new Response(new Uint8Array(body), {
      status: over.status ?? 200,
      headers,
    })) as unknown as typeof globalThis.fetch;
};

const tools = (
  doFetch: typeof globalThis.fetch,
  over: Partial<Settings> = {},
): ToolDefinition[] =>
  webFetchTools({
    settings: { ...DEFAULT_SETTINGS, ...over },
    files: store,
    fetch: doFetch,
  });

const download = (doFetch: typeof globalThis.fetch, over: Partial<Settings> = {}) =>
  tools(doFetch, over).find((d) => d.name === 'web.download')!;

const storeFiles = (): string[] => store.list().map((e) => e.path);

describe('web.download (§23.6, F.5)', () => {
  it('writes a PDF into the store under a name taken from the URL', async () => {
    const pdf = buildPdf(['Section one, on the first page.', 'Section three begins here.']);
    const tool = download(serve(pdf, 'application/pdf'));

    const out = (await tool.execute(
      { url: 'https://example.com/reports/q3-results.pdf' },
      ctx,
    )) as any;
    expect(out.error).toBeUndefined();
    expect(out.path).toBe('downloads/q3-results.pdf');
    expect(out.content_type).toBe('application/pdf');
    expect(out.bytes).toBe(pdf.length);
    expect(fs.readFileSync(path.join(home.filesDir, out.path)).equals(pdf)).toBe(true);
  });

  it('refuses by Content-Length, and leaves nothing behind', async () => {
    const big = Buffer.alloc(64, 7);
    const tool = download(serve(big, 'application/pdf', { contentLength: '99999999' }), {
      downloadMaxMb: 0.001,
    });

    const out = (await tool.execute({ url: 'https://example.com/huge.pdf' }, ctx)) as any;
    expect(out.error).toBe('too_large');
    expect(out.limit_mb).toBe(0.001);
    expect(storeFiles()).toEqual([]);
  });

  it('refuses by the bytes actually read, because a header is a claim', async () => {
    // The lying server: it says 10 bytes and sends 4 KB. The cap has to hold
    // against the body or a disk can be filled by understating one number.
    const big = Buffer.alloc(4096, 3);
    const tool = download(serve(big, 'application/pdf', { contentLength: '10' }), {
      downloadMaxMb: 0.001,
    });

    const out = (await tool.execute({ url: 'https://example.com/liar.pdf' }, ctx)) as any;
    expect(out.error).toBe('too_large');
    expect(out.message).toMatch(/nothing was saved/);
    expect(storeFiles()).toEqual([]);
  });

  it('refuses by the body when no Content-Length is sent at all', async () => {
    const big = Buffer.alloc(4096, 3);
    const tool = download(serve(big, 'application/pdf', { contentLength: null }), {
      downloadMaxMb: 0.001,
    });

    const out = (await tool.execute({ url: 'https://example.com/chunked.pdf' }, ctx)) as any;
    expect(out.error).toBe('too_large');
    expect(storeFiles()).toEqual([]);
  });

  it('goes through the same URL door as web.fetch — one door, never two', async () => {
    const tool = download(serve(Buffer.from('x'), 'application/pdf'));
    for (const url of [
      'file:///etc/passwd',
      'ftp://example.com/x.pdf',
      'https://user:pw@example.com/x.pdf',
      'http://169.254.169.254/latest/meta-data',
      'not a url',
    ]) {
      const out = (await tool.execute({ url }, ctx)) as any;
      expect(out.error, url).toBe('url_refused');
    }
    // And the private-host gate is the same flag, not a second policy.
    const gated = download(serve(Buffer.from('x'), 'application/pdf'), {
      fetchAllowPrivateHosts: false,
    });
    expect(((await gated.execute({ url: 'http://127.0.0.1/x.pdf' }, ctx)) as any).error).toBe(
      'url_refused',
    );
    expect(storeFiles()).toEqual([]);
  });

  it('reports an HTTP failure as a value, never a throw', async () => {
    const tool = download(serve(Buffer.from('nope'), 'text/html', { status: 404 }));
    const out = (await tool.execute({ url: 'https://example.com/gone.pdf' }, ctx)) as any;
    expect(out.error).toBe('fetch_failed');
    expect(out.message).toBe('HTTP 404');
    expect(storeFiles()).toEqual([]);
  });

  it('honours an explicit path, and normalises it through the store', async () => {
    const pdf = buildPdf(['one']);
    const tool = download(serve(pdf, 'application/pdf'));
    const out = (await tool.execute(
      { url: 'https://example.com/x.pdf', path: 'invoices/2026/september.pdf' },
      ctx,
    )) as any;
    expect(out.path).toBe('invoices/2026/september.pdf');

    // Escaping the store is the store's refusal, and it is a value here.
    const escaped = (await tool.execute(
      { url: 'https://example.com/x.pdf', path: '../../etc/passwd' },
      ctx,
    )) as any;
    expect(escaped.error).toBe('write_failed');
  });

  it('names the file from the URL and the extension from the content type', () => {
    const dir = 'downloads/';
    expect(
      downloadPath(new URL('https://example.com/a/b/report.pdf'), 'application/pdf', dir),
    ).toBe('downloads/report.pdf');
    // The URL lies about the type; the served type wins.
    expect(
      downloadPath(new URL('https://example.com/download?id=9'), 'application/pdf', dir),
    ).toBe('downloads/download.pdf');
    expect(
      downloadPath(
        new URL('https://example.com/minutes.doc'),
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        dir,
      ),
    ).toBe('downloads/minutes.docx');
    // A type we have no extension for keeps whatever the URL gave it rather
    // than inventing a fact about the bytes.
    expect(
      downloadPath(new URL('https://example.com/thing.bin'), 'application/x-weird', dir),
    ).toBe('downloads/thing.bin');
    // A dot is not an extension unless it looks like one: arXiv URLs end
    // `/pdf/1706.03762`, and `1706.pdf` loses the half that identifies it.
    expect(
      downloadPath(new URL('https://arxiv.org/pdf/1706.03762'), 'application/pdf', dir),
    ).toBe('downloads/1706.03762.pdf');
    // Nothing to go on at all still produces a name.
    expect(downloadPath(new URL('https://example.com/'), 'application/x-weird', dir)).toBe(
      'downloads/example.com',
    );
  });

  it('is not offered at all when there is no store to write to', () => {
    const none = webFetchTools({ settings: DEFAULT_SETTINGS });
    expect(none.map((d) => d.name)).not.toContain('web.download');
  });
});

describe('web.fetch reads text and refuses documents (§23.6)', () => {
  const fetchTool = (doFetch: typeof globalThis.fetch) =>
    tools(doFetch).find((d) => d.name === 'web.fetch')!;

  const body = (contentType: string, payload: Buffer | string) =>
    (async () =>
      new Response(typeof payload === 'string' ? payload : new Uint8Array(payload), {
        headers: { 'content-type': contentType },
      })) as unknown as typeof globalThis.fetch;

  it('reads every allowlisted type', async () => {
    const cases: [string, string, string][] = [
      ['text/plain; charset=utf-8', 'a plain note', 'a plain note'],
      ['text/html', '<html><body><p>hello there</p></body></html>', 'hello there'],
      ['text/csv', 'a,b\n1,2', 'a,b'],
      ['application/json', '{"ok":true}', '{"ok":true}'],
      ['application/xml', '<r><v>7</v></r>', '7'],
      ['application/ld+json', '{"@id":"x"}', '{"@id":"x"}'],
      ['application/atom+xml', '<feed><title>News</title></feed>', 'News'],
    ];
    for (const [type, payload, expected] of cases) {
      const out = (await fetchTool(body(type, payload)).execute(
        { url: 'https://example.com/thing' },
        ctx,
      )) as any;
      expect(out.error, type).toBeUndefined();
      expect(out.content, type).toContain(expected);
    }
  });

  it('reads a response that states no content type at all', async () => {
    const out = (await fetchTool(
      (async () => new Response('bare bytes, no header')) as never,
    ).execute({ url: 'https://example.com/bare' }, ctx)) as any;
    expect(out.content).toContain('bare bytes');
  });

  /**
   * The regression that names the actual bug. `.docx` was not on the old
   * blocklist, so a zip container came back as a *successful page*: 1,708
   * characters of `PK\x03\x04…` decoded as UTF-8, `complete: true`, handed to
   * a model as the document's text.
   */
  it('refuses a .docx instead of decoding a zip container as text', async () => {
    const docx = buildDocx({ body: [para(run('Quarterly numbers'))] });
    const type = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
    const out = (await fetchTool(body(type, docx)).execute(
      { url: 'https://example.com/report.docx' },
      ctx,
    )) as any;
    expect(out.error).toBe('unsupported_content');
    expect(out.content).toBeUndefined();
    expect(out.content_type).toBe(type);
  });

  it('refuses every other document and binary type, naming the next step', async () => {
    for (const type of [
      'application/pdf',
      'application/zip',
      'application/octet-stream',
      'application/vnd.ms-excel',
      'application/epub+zip',
      'image/png',
      'audio/mpeg',
      'video/mp4',
      'font/woff2',
    ]) {
      const out = (await fetchTool(body(type, Buffer.from([0, 1, 2]))).execute(
        { url: 'https://example.com/thing' },
        ctx,
      )) as any;
      expect(out.error, type).toBe('unsupported_content');
      expect(out.message, type).toMatch(/web\.download/);
      expect(out.message, type).toMatch(/docs\.outline/);
    }
  });
});

/**
 * The hop, in the real service: one test end to end, because the point of
 * §23.6 is the *hop* and not either half. A PDF at a URL was unreadable —
 * `web.fetch` refused it before reading a byte and `docs.read` resolves store
 * paths only, so the parser that was installed, working and tested had no way
 * to be handed the bytes.
 */
describe('a PDF at a URL becomes a document you can read (§23.6)', () => {
  let h: ServiceHarness;
  afterEach(async () => {
    await h?.cleanup();
  });

  it('downloads it, outlines it, reads a page, and leaves the file there', async () => {
    const pdf = buildPdf([
      'Section one, on the first page.',
      'Section two, on the second.',
      'Section three begins here and says the thing.',
    ]);
    h = await bootService({
      onboarded: true,
      watchFiles: false,
      runScheduler: false,
      fetch: serve(pdf, 'application/pdf'),
    });
    h.service.files.ensure();

    const saved = (await h.service.tools
      .get('web.download')!
      .call({ url: 'https://example.com/reports/annual.pdf' }, ctx)) as any;
    expect(saved.ok).toBe(true);
    expect(saved.output.path).toBe('downloads/annual.pdf');

    const outline = (await h.service.tools
      .get('docs.outline')!
      .call({ path: saved.output.path }, ctx)) as any;
    expect(outline.output.error).toBeUndefined();
    expect(outline.output.pages).toBe(3);

    const read = (await h.service.tools
      .get('docs.read')!
      .call({ path: saved.output.path, pages: '3' }, ctx)) as any;
    expect(JSON.stringify(read.output)).toContain('Section three');

    // Still there tomorrow to print: kept in the store, not scratched into
    // `cache/` (§23.6, §34.4).
    expect(h.service.files.list().map((e) => e.path)).toContain('downloads/annual.pdf');
  });
});
