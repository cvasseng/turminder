import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The vendored client-lib registry (§23.3): pinned browser libraries served to
 * embeds from `node_modules`, at `/embed-vendor/<lib>/<file>`.
 *
 * An **exact-path allowlist**, not a directory mount. The keys are the whole
 * reachable surface — no traversal to defeat, no listing to leak, and adding a
 * file is a visible decision rather than a side effect of an npm install.
 *
 * v1 vendors reveal.js, and deliberately not one of its themes: §23.3's
 * consistency contract says the shipped theme owns colour and type, and
 * `reveal.css` is the layout half. Highcharts is *not* here on purpose — it
 * loads from its CDN so an exported embed survives being hosted elsewhere.
 */
export const EMBED_VENDOR_FILES: Record<string, string> = {
  'reveal.js/reveal.js': 'reveal.js/dist/reveal.js',
  'reveal.js/reveal.css': 'reveal.js/dist/reveal.css',
  'reveal.js/reset.css': 'reveal.js/dist/reset.css',
};

const NODE_MODULES = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'node_modules',
);

const TYPES: Record<string, string> = {
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
};

export interface VendorFile {
  body: Buffer;
  contentType: string;
}

/**
 * `name` is the path after `/embed-vendor/`. Anything not named in the
 * allowlist is a miss, which the caller answers 404 — including every form of
 * `..`, because nothing is ever joined onto caller input.
 */
export function readVendorFile(name: string): VendorFile | null {
  const target = EMBED_VENDOR_FILES[name.replace(/^\/+/, '')];
  if (!target) return null;
  const abs = path.join(NODE_MODULES, target);
  if (!fs.existsSync(abs)) return null;
  return {
    body: fs.readFileSync(abs),
    contentType: TYPES[path.extname(abs).toLowerCase()] ?? 'application/octet-stream',
  };
}
