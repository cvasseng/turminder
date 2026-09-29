import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { appDir } from '../core/appdir.js';

/** Beside the code, never inside the build output — see `appDir` (§28.4). */
export const UI_DIR = appDir('ui', import.meta.dirname);

/**
 * Third-party browser assets served straight from node_modules — one source of
 * truth, no vendored copy to drift, and an explicit allowlist so nothing else
 * under node_modules is reachable.
 */
export const VENDOR_FILES: Record<string, string> = {
  'vendor/marked.umd.js': 'marked/lib/marked.umd.js',
};

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
  // The PWA shell (§9, U5): the manifest and its icons.
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.png': 'image/png',
};

export interface StaticFile {
  body: Buffer;
  contentType: string;
}

const NODE_MODULES = appDir('node_modules', import.meta.dirname);

/** Reads a UI asset by name, refusing anything outside ui/ (or the allowlist). */
export function readUiFile(name: string): StaticFile | null {
  const clean = name.replace(/^\/+/, '');
  if (!clean || clean.includes('..')) return null;
  const vendored = VENDOR_FILES[clean];
  if (vendored) {
    const abs = path.join(NODE_MODULES, vendored);
    if (!fs.existsSync(abs)) return null;
    return { body: fs.readFileSync(abs), contentType: TYPES['.js']! };
  }
  const abs = path.join(UI_DIR, clean);
  if (!abs.startsWith(UI_DIR + path.sep)) return null;
  if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) return null;
  return {
    body: fs.readFileSync(abs),
    contentType: TYPES[path.extname(abs).toLowerCase()] ?? 'application/octet-stream',
  };
}

/**
 * Exactly the files `ui/sw.js` precaches as the PWA shell (§9, U5) — kept as
 * one list so the version below and the service worker's own `PRECACHE`
 * cannot silently drift apart.
 */
export const SHELL_FILES = [
  'index.html',
  'vendor/marked.umd.js',
  'connect.js',
  'greeting.js',
  'preview.js',
  'verdict.js',
  'app.js',
  'style.css',
  'manifest.webmanifest',
  'icons/icon-128.png',
  'icons/icon-256.png',
  'icons/icon-512.png',
];

let shellVersionCache: string | null = null;

/**
 * A short hash of the shell's current bytes, computed once per process
 * rather than bumped by hand — there is no build step to bump it in. The
 * chat UI reads this off a response header (`x-turminder-ui-version`, set
 * where these files are served) and registers `sw.js` at a URL carrying it
 * (`/sw.js?v=<hash>`); a service worker registered at a new URL always goes
 * through the install/activate dance, so any edit to the shell — app.js,
 * style.css, an icon — replaces the cached generation on the next visit
 * without anyone maintaining a version number.
 */
export function shellVersion(): string {
  if (shellVersionCache) return shellVersionCache;
  const hash = crypto.createHash('sha256');
  for (const name of SHELL_FILES) {
    const file = readUiFile(name);
    if (file) hash.update(file.body);
  }
  shellVersionCache = hash.digest('hex').slice(0, 16);
  return shellVersionCache;
}
