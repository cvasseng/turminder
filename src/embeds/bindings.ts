import fs from 'node:fs';
import path from 'node:path';
import matter from 'gray-matter';
import type { DataHome } from '../core/datadir.js';
import { log } from '../core/logger.js';

const l = log('embeds');

export interface HandlerBinding {
  /** Handler name, i.e. the filename without `.md`. */
  name: string;
  /** data-dir-relative path, for the git commit. */
  file: string;
  /** The embed id its frontmatter points at. */
  embedId: string;
}

/**
 * Every `embed:` binding on disk (§22.5, G.7).
 *
 * Deliberately reads the frontmatter directly rather than going through
 * `HandlerLoader`: the loader skips handlers that are disabled or fail
 * validation, and those are exactly the ones a lifecycle cascade must still
 * find. A dead handler nobody can load is still a dead handler in the way.
 */
export function handlerBindings(home: DataHome): HandlerBinding[] {
  const dir = home.handlersDir;
  if (!fs.existsSync(dir)) return [];
  const found: HandlerBinding[] = [];
  for (const entry of fs.readdirSync(dir).sort()) {
    if (!entry.endsWith('.md')) continue;
    let data: Record<string, unknown>;
    try {
      data = (matter(fs.readFileSync(path.join(dir, entry), 'utf8')).data ?? {}) as Record<
        string,
        unknown
      >;
    } catch (e) {
      l.warn(
        { file: `handlers/${entry}`, err: (e as Error).message },
        'unreadable frontmatter',
      );
      continue;
    }
    const embedId = data.embed;
    if (typeof embedId !== 'string' || !embedId) continue;
    found.push({
      name: entry.replace(/\.md$/, ''),
      file: `handlers/${entry}`,
      embedId,
    });
  }
  return found;
}

/** Bindings pointing at one embed. */
export function bindingsFor(home: DataHome, embedId: string): HandlerBinding[] {
  return handlerBindings(home).filter((b) => b.embedId === embedId);
}
