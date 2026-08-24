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
