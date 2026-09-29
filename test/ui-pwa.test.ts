import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { readUiFile, SHELL_FILES, shellVersion } from '../src/net/static.js';

/**
 * The installable shell (§9, U5), guarded from the only side a vitest suite
 * can reach: the source. There is no browser here, so this makes no claim
 * about an actual install prompt or an actual offline load — the by-hand
 * checklist owns that. What it stops is the two failures that would quietly
 * defeat the feature: a service worker that reaches past the shell into
 * `/api/*`/`/ws`/`/embed*`/uploads, and a cache name that never changes so an
 * old install serves a stale shell forever.
 */
const root = path.resolve(import.meta.dirname, '..');
const read = (rel: string): string => fs.readFileSync(path.join(root, rel), 'utf8');

const html = read('ui/index.html');
const js = read('ui/app.js');
const sw = read('ui/sw.js');
const manifest = JSON.parse(read('ui/manifest.webmanifest')) as {
  start_url: string;
  icons: { src: string }[];
};
const spec = read('spec.md');

describe('the MIME table serves the shell it now has to (§9, U5)', () => {
  it('serves the manifest as application/manifest+json', () => {
    const file = readUiFile('manifest.webmanifest');
    expect(file, 'ui/manifest.webmanifest should be readable').not.toBeNull();
    expect(file?.contentType).toContain('application/manifest+json');
  });

  it('serves the icons as image/png', () => {
    for (const rel of ['icons/icon-128.png', 'icons/icon-256.png', 'icons/icon-512.png']) {
      const file = readUiFile(rel);
      expect(file, rel).not.toBeNull();
      expect(file?.contentType).toBe('image/png');
    }
  });

  it('serves the service worker as javascript, unregistrable outside its own scope', () => {
    // No `Service-Worker-Allowed` header is written anywhere: `sw.js` sits at
    // the root, whose default scope is already everything under it.
    const file = readUiFile('sw.js');
    expect(file?.contentType).toContain('text/javascript');
  });
});

describe('every icon the manifest names actually exists (§9, U5)', () => {
  it('resolves every icons[].src through readUiFile', () => {
    expect(manifest.icons.length).toBeGreaterThan(0);
    for (const icon of manifest.icons) {
      expect(readUiFile(icon.src), icon.src).not.toBeNull();
    }
  });

  it('starts at the page every device serves, not a page of its own', () => {
    expect(manifest.start_url).toBe('/');
  });
});

describe('the shell and the service worker precache the same files (§9, U5)', () => {
  it('keeps net/static.ts SHELL_FILES and sw.js PRECACHE in agreement', () => {
    const precache = [...sw.matchAll(/^\s*'(\/[^']+)',?$/gm)]
      .map((m) => m[1])
      .filter((p): p is string => Boolean(p));
    expect(precache.length).toBeGreaterThan(0);
    expect(precache.sort()).toEqual(SHELL_FILES.map((f) => `/${f}`).sort());
  });

  it('precaches every script and stylesheet the page loads', () => {
    // The offline fallback serves the cached index.html; any script it loads
    // that is not cached fails, and the page it leaves is half an app —
    // verdict.js sits on the reconnect path. So the page's own tags are the
    // list the shell must cover, checked rather than remembered.
    const page = readUiFile('index.html')!.body.toString('utf8');
    const loaded = [...page.matchAll(/<(?:script src|link rel="stylesheet" href)="\/([^"]+)"/g)]
      .map((m) => m[1])
      .filter((p): p is string => Boolean(p));
    expect(loaded.length).toBeGreaterThan(1);
    for (const asset of loaded) expect(SHELL_FILES).toContain(asset);
  });

  it('computes a version from the real shell bytes, not a hand-bumped literal', () => {
    // A hex digest with real length — not an empty string, not a small
    // literal like '1' that would suggest someone is bumping it by hand.
    expect(shellVersion()).toMatch(/^[0-9a-f]{16}$/);
  });
});

describe('the service worker never reaches past the shell (§9, U5)', () => {
  it('never mentions the routes it must leave to the network outside a comment', () => {
    // The doc comment at the top names these routes to explain why the code
    // never touches them — this is the code itself, with comments stripped,
    // the same way the §27 secrets guard reads its own source.
    const code = sw
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n')
      .map((line) => line.replace(/\/\/.*$/, ''))
      .join('\n');
    for (const forbidden of ['/api/', '/ws', '/embed']) {
      expect(code, `sw.js should not mention ${forbidden} outside a comment`).not.toContain(
        forbidden,
      );
    }
  });

  it("never precaches '/' itself — only index.html, fetched by the worker", () => {
    // GET / stands in for setup.html until onboarded (App. E); caching that
    // response would freeze whichever page answered first the SW installed.
    const precache = sw.slice(
      sw.indexOf('const PRECACHE'),
      sw.indexOf('];', sw.indexOf('const PRECACHE')),
    );
    expect(precache).not.toMatch(/'\/'\s*,/);
    expect(precache).toContain("'/index.html'");
  });

  it('falls back to the cached shell only on a navigation, and only when offline', () => {
    const fetchHandler = sw.slice(sw.indexOf("addEventListener('fetch'"));
    expect(fetchHandler).toContain("req.mode === 'navigate'");
    expect(fetchHandler).toMatch(/fetch\(req\)\.catch\(/);
    expect(fetchHandler).toContain("caches.match('/index.html'");
  });

  it('answers a shell asset network-first, never cache-first', () => {
    const fetchHandler = sw.slice(sw.indexOf("addEventListener('fetch'"));
    const order = fetchHandler.indexOf('fetch(req)');
    const cacheFallback = fetchHandler.indexOf('caches.match(req');
    expect(order).toBeGreaterThan(-1);
    expect(cacheFallback).toBeGreaterThan(order);
  });

  it('replaces an earlier shell generation instead of piling caches up', () => {
    expect(sw).toMatch(/caches\.delete\(name\)/);
    expect(sw).toContain("name.startsWith('turminder-shell-')");
  });
});

describe('registration is guarded like every other secure-context-only API (§9, §24.4, U5)', () => {
  it('never registers outside a secure context', () => {
    const reg = js.slice(js.indexOf("'serviceWorker' in navigator"));
    const guardLine = reg.slice(0, reg.indexOf('\n'));
    expect(guardLine).toContain('isSecureContext');
    const body = reg.slice(0, reg.indexOf('\n}'));
    expect(body).toContain('navigator.serviceWorker.register(');
  });

  it('reads the version off a response header rather than a literal', () => {
    const reg = js.slice(js.indexOf("'serviceWorker' in navigator"));
    expect(reg).toContain("headers.get('x-turminder-ui-version')");
    expect(reg).toMatch(/register\(`\/sw\.js\?v=\$\{/);
  });

  it('links the manifest from the page every device serves', () => {
    expect(html).toContain('rel="manifest"');
    expect(html).toContain('href="/manifest.webmanifest"');
  });
});

describe('§9 documents the secure-context restriction plainly (U5)', () => {
  it('says plain-HTTP LAN is not installable, the way §24.4 already does for the mic', () => {
    const section9 = spec.slice(spec.indexOf('## 9. Chat'), spec.indexOf('### 9.1'));
    expect(section9).toMatch(/secure context/);
    expect(section9).toContain('§24.4');
  });
});
