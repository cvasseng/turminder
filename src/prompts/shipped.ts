import fs from 'node:fs';
import matter from 'gray-matter';
import type { DataHome } from '../core/datadir.js';
import { log } from '../core/logger.js';
import { readLibrary } from './library.js';

const l = log('shipped');

/**
 * Documents Turminder ships into the data dir. They are installed only when
 * absent, so the user's edits always win; deleting one brings it back on the
 * next start, which is the trade for keeping them current.
 *
 * The content lives in `library/{skills,handlers}/<name>.md` — one file per
 * asset, no registry: the directory is the manifest, and a file's category
 * is the data-dir directory it installs into.
 */
export interface ShippedAsset {
  path: string;
  content: string;
}

const CATEGORIES = ['skills', 'handlers'] as const;

function load(): ShippedAsset[] {
  const assets: ShippedAsset[] = [];
  for (const category of CATEGORIES) {
    for (const file of readLibrary(category)) {
      // The loaders in the data dir silently ignore files with bad
      // frontmatter — for user files that is forgiving, for shipped ones it
      // would mean we shipped a no-op. Fail the build/startup instead.
      const fm = matter(file.content).data as { name?: unknown; description?: unknown };
      if (fm.name !== file.name || typeof fm.description !== 'string' || !fm.description) {
        throw new Error(
          `library/${category}/${file.name}.md: frontmatter must carry name: ${file.name} ` +
            `and a non-empty description`,
        );
      }
      assets.push({ path: `${category}/${file.name}.md`, content: file.content });
    }
  }
  return assets;
}

export const SHIPPED_ASSETS: ShippedAsset[] = load();

/** Returns the paths that were newly written. */
export function installShippedAssets(home: DataHome): string[] {
  const written: string[] = [];
  for (const asset of SHIPPED_ASSETS) {
    const abs = home.path(asset.path);
    if (fs.existsSync(abs)) continue;
    fs.writeFileSync(abs, asset.content, 'utf8');
    written.push(asset.path);
  }
  if (written.length) l.info({ written }, 'installed shipped assets');
  return written;
}
