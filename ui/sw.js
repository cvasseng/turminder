/**
 * The PWA shell's service worker (§9, U5). Its one job is to make the chat
 * UI's own transcript, composer and "connecting…" status survive a dropped
 * connection — never to give the assistant an offline brain. Everything
 * that talks to the service (`/api/*`, `/ws`, `/embed*`, uploads) is left
 * strictly alone: this file never calls `respondWith` for them, so they hit
 * the network exactly as if no service worker existed.
 *
 * `self.location.search` carries `?v=<hash>` — a hash of the shell's actual
 * bytes, computed server-side (`shellVersion()`, `net/static.ts`) and read by
 * `app.js` off a response header before it registers this script at that
 * URL. Registering a new URL is what makes a shell edit install a fresh
 * worker; there is no build step bumping a version by hand.
 */
const VERSION = new URL(self.location.href).searchParams.get('v') || 'dev';
const CACHE_NAME = `turminder-shell-${VERSION}`;

/** Exactly what `net/static.ts`'s `SHELL_FILES` lists — see the note there. */
const PRECACHE = [
  '/index.html',
  '/vendor/marked.umd.js',
  '/connect.js',
  '/greeting.js',
  '/preview.js',
  '/verdict.js',
  '/app.js',
  '/style.css',
  '/manifest.webmanifest',
  '/icons/icon-128.png',
  '/icons/icon-256.png',
  '/icons/icon-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE_NAME);
      await cache.addAll(PRECACHE);
      // Skip the wait: a chat tab is typically left open for hours, and the
      // whole point of a versioned cache name is that the new one is already
      // a separate, complete cache — there is nothing half-updated to protect
      // a still-open tab from.
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      // Sweep every earlier shell generation, never a cache this worker did
      // not create — there is only ever the one namespace.
      for (const name of await caches.keys()) {
        if (name.startsWith('turminder-shell-') && name !== CACHE_NAME) {
          await caches.delete(name);
        }
      }
      await self.clients.claim();
    })(),
  );
});

/** `GET /` and `GET /index.html` both stand in for `setup.html` before
 *  onboarding (App. E) — caching *that* response would freeze whichever page
 *  answered first. Only the shell's own `index.html`, fetched once by this
 *  worker itself during install, is ever put in the cache. */
function isShellRequest(url) {
  return url.origin === self.location.origin && PRECACHE.includes(url.pathname);
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  if (req.mode === 'navigate') {
    // Online: always the live page, so a still-unconfigured install keeps
    // seeing the setup page rather than a stale index.html. Offline: the
    // cached shell, which puts the reader on the ordinary "connecting…" /
    // "disconnected" status app.js already shows while a socket retries —
    // there is no separate offline page to keep in sync with that logic.
    event.respondWith(
      fetch(req).catch(async () => {
        const cached = await caches.match('/index.html', { cacheName: CACHE_NAME });
        return cached ?? Response.error();
      }),
    );
    return;
  }

  if (!isShellRequest(url)) return;

  // Network-first, falling back to the cache: an online reader always gets
  // what the server is serving right now, and the cache exists purely for
  // the moment there is no network to ask. Every successful fetch also
  // refreshes the cache entry, so the fallback stays as current as whatever
  // was last reachable.
  event.respondWith(
    fetch(req)
      .then((res) => {
        const copy = res.clone();
        void caches.open(CACHE_NAME).then((cache) => cache.put(req, copy));
        return res;
      })
      .catch(
        async () => (await caches.match(req, { cacheName: CACHE_NAME })) ?? Response.error(),
      ),
  );
});
