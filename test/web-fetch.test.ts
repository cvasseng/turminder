import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS } from '../src/core/config.js';
import {
  checkFetchUrl,
  htmlToText,
  UrlRefused,
  webFetchTools,
} from '../src/tools/integrations/web-fetch.js';

const ctx = { runId: null, eventId: null };
const fetchTool = (over: Partial<typeof DEFAULT_SETTINGS> = {}) =>
  webFetchTools({ settings: { ...DEFAULT_SETTINGS, ...over } })[0]!;

describe('web.fetch url policy', () => {
  it('accepts ordinary http and https urls', () => {
    expect(checkFetchUrl('https://example.com/a?b=c', true).host).toBe('example.com');
    expect(checkFetchUrl('http://example.com', true).protocol).toBe('http:');
  });

  it('refuses non-http schemes, credentials, and cloud metadata', () => {
    expect(() => checkFetchUrl('file:///etc/passwd', true)).toThrowError(UrlRefused);
    expect(() => checkFetchUrl('ftp://example.com', true)).toThrowError(/scheme/);
    expect(() => checkFetchUrl('https://user:pw@example.com', true)).toThrowError(
      /credentials/,
    );
    expect(() => checkFetchUrl('http://169.254.169.254/latest/meta-data', true)).toThrowError(
      /refusing/,
    );
    expect(() => checkFetchUrl('not a url', true)).toThrowError(UrlRefused);
  });

  it('gates private addresses on the config flag', () => {
    for (const url of [
      'http://localhost:8080/x',
      'http://127.0.0.1/x',
      'http://192.168.1.1/x',
      'http://10.0.0.5/x',
      'http://172.20.0.1/x',
      'http://nas.local/x',
    ]) {
      expect(() => checkFetchUrl(url, false)).toThrowError(/private address/);
      expect(checkFetchUrl(url, true).toString()).toContain('http');
    }
  });
});

describe('html to text', () => {
  it('extracts a title and readable text, dropping scripts and styles', () => {
    const { title, text } = htmlToText(
      `<!doctype html><html><head><title>Oslo &amp; Bergen</title>
       <style>body{color:red}</style><script>alert('x')</script></head>
       <body><h1>Oslo</h1><p>Capital of&nbsp;Norway.</p><p>Rain in Bergen.</p>
       <ul><li>One</li><li>Two</li></ul></body></html>`,
    );
    expect(title).toBe('Oslo & Bergen');
    expect(text).toContain('Oslo');
    expect(text).toContain('Capital of Norway.');
    expect(text).toContain('Rain in Bergen.');
    expect(text).not.toContain('alert');
    expect(text).not.toContain('color:red');
  });

  it('decodes numeric entities', () => {
    expect(htmlToText('<p>caf&#233; &#x2014; open</p>').text).toBe('café — open');
  });
});

describe('web.fetch against a real server', () => {
  let server: http.Server;
  let base: string;

  beforeEach(async () => {
    server = http.createServer((req, res) => {
      if (req.url === '/page') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(
          '<html><head><title>A page</title></head><body><p>Hello there.</p></body></html>',
        );
      } else if (req.url === '/plain') {
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.end('just text');
      } else if (req.url === '/big') {
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end(`<body>${'x'.repeat(50_000)}</body>`);
      } else if (req.url === '/binary') {
        res.writeHead(200, { 'content-type': 'application/pdf' });
        res.end(Buffer.from([1, 2, 3]));
      } else if (req.url === '/gone') {
        res.writeHead(404, { 'content-type': 'text/html' });
        res.end('<h1>nope</h1>');
      } else if (req.url === '/redirect') {
        res.writeHead(302, { location: '/page' });
        res.end();
      } else {
        res.writeHead(500);
        res.end();
      }
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterEach(async () => {
    await new Promise<void>((r) => server.close(() => r()));
  });

  it('reads a page as text and marks it untrusted', async () => {
    const result = (await fetchTool().execute({ url: `${base}/page` }, ctx)) as any;
    expect(result.status).toBe(200);
    expect(result.title).toBe('A page');
    expect(result.content).toContain('Hello there.');
    expect(result.untrusted).toBe(true);
    expect(result.truncated).toBe(false);
  });

  it('returns raw markup when asked for html', async () => {
    const result = (await fetchTool().execute(
      { url: `${base}/page`, format: 'html' },
      ctx,
    )) as any;
    expect(result.content).toContain('<title>A page</title>');
  });

  it('passes plain text through untouched', async () => {
    const result = (await fetchTool().execute({ url: `${base}/plain` }, ctx)) as any;
    expect(result.content).toBe('just text');
  });

  it('truncates and says so', async () => {
    const result = (await fetchTool().execute(
      { url: `${base}/big`, max_chars: 500 },
      ctx,
    )) as any;
    expect(result.content.length).toBe(500);
    expect(result.truncated).toBe(true);
  });

  it('follows redirects and reports the final url', async () => {
    const result = (await fetchTool().execute({ url: `${base}/redirect` }, ctx)) as any;
    expect(result.content).toContain('Hello there.');
    expect(result.url).toContain('/page');
  });

  it('reports http errors and unsupported content as data', async () => {
    const missing = (await fetchTool().execute({ url: `${base}/gone` }, ctx)) as any;
    expect(missing.error).toBe('fetch_failed');
    expect(missing.message).toBe('HTTP 404');

    const pdf = (await fetchTool().execute({ url: `${base}/binary` }, ctx)) as any;
    expect(pdf.error).toBe('unsupported_content');
  });

  it('refuses a blocked url without making a request', async () => {
    const refused = (await fetchTool({ fetchAllowPrivateHosts: false }).execute(
      { url: `${base}/page` },
      ctx,
    )) as any;
    expect(refused.error).toBe('url_refused');
  });

  it('is read-only so it can auto-execute', () => {
    expect(fetchTool().tier).toBe('ro');
  });
});
