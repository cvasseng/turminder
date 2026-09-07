import fs from 'node:fs';
import path from 'node:path';
import { loadMarkdownFile } from '../core/config.js';
import { HandlerFrontmatterSchema, type HandlerFrontmatter } from '../core/config-schemas.js';
import type { AssetInvalidReporter, DataHome } from '../core/datadir.js';
import { globMatchAny } from '../core/glob.js';
import { log } from '../core/logger.js';
import type { EventRecord } from '../db/repos/events.js';

const l = log('handlers');

export interface LoadedHandler {
  name: string;
  description: string;
  frontmatter: HandlerFrontmatter;
  /** The instructions given to the executing agent. */
  body: string;
  /** data-dir-relative path. */
  file: string;
}

export interface HandlerLoadError {
  file: string;
  message: string;
}

/**
 * Loads `data/handlers/*.md` (§5.1). The matcher here is deliberately
 * impoverished (§5.2): envelope globs only, and it may only ever *exclude*.
 * False positives cost one cheap model check; false negatives are the only sin.
 */
export class HandlerLoader {
  private cache: LoadedHandler[] | null = null;
  private loadErrors: HandlerLoadError[] = [];
  /** Files already reported this process, so a reload storm stays quiet. */
  private readonly reported = new Set<string>();

  constructor(
    private readonly home: DataHome,
    /**
     * Where a load failure goes when there is an event loop to put it on
     * (§12.3). Absent for the CLI loaders, which print the errors themselves.
     */
    private readonly onInvalid?: AssetInvalidReporter,
  ) {}

  reload(): void {
    this.cache = null;
  }

  all(): LoadedHandler[] {
    if (this.cache) return this.cache;
    const dir = this.home.handlersDir;
    const handlers: LoadedHandler[] = [];
    this.loadErrors = [];
    if (fs.existsSync(dir)) {
      for (const entry of fs.readdirSync(dir).sort()) {
        if (!entry.endsWith('.md')) continue;
        const rel = `handlers/${entry}`;
        try {
          const doc = loadMarkdownFile(path.join(dir, entry), rel, HandlerFrontmatterSchema);
          if (!doc) continue;
          const expected = entry.replace(/\.md$/, '');
          if (doc.frontmatter.name !== expected) {
            throw new Error(
              `frontmatter name "${doc.frontmatter.name}" must match the filename "${expected}"`,
            );
          }
          if (!doc.body.trim()) throw new Error('handler body is empty — nothing to instruct');
          if (!doc.frontmatter.enabled) {
            l.debug({ file: rel }, 'handler disabled, skipping');
            continue;
          }
          handlers.push({
            name: doc.frontmatter.name,
            description: doc.frontmatter.description,
            frontmatter: doc.frontmatter,
            body: doc.body,
            file: rel,
          });
        } catch (e) {
          // A broken handler is reported and skipped: the rest still run. Keep
          // the ConfigError detail — it names the offending key.
          const detail = (e as { detail?: string }).detail;
          const message = detail ? `${(e as Error).message} (${detail})` : (e as Error).message;
          this.loadErrors.push({ file: rel, message });
          l.error({ file: rel, err: message }, 'handler failed to load');
          this.report(rel, message);
        }
      }
    }
    this.cache = handlers;
    return handlers;
  }

  errors(): HandlerLoadError[] {
    this.all();
    return [...this.loadErrors];
  }

  /**
   * A broken handler is an event, not a log line (§12.3). The intake dedupes
   * on the App. B key, so this is belt-and-braces against the *cost* of a
   * reload storm rather than against duplicate events.
   */
  private report(file: string, message: string): void {
    if (!this.onInvalid) return;
    const key = `${file}\u0000${message}`;
    if (this.reported.has(key)) return;
    this.reported.add(key);
    this.onInvalid({
      category: 'handlers',
      file,
      message,
      shipped: this.home.shippedHashes()[file] !== undefined,
    });
  }

  get(name: string): LoadedHandler | null {
    return this.all().find((h) => h.name === name) ?? null;
  }

  /**
   * Path globs handlers have subscribed to (§18.4 tier 3). The watcher asks per
   * change, so adding a `watch:` key takes effect on the next save.
   */
  watchPatterns(): string[] {
    return [...new Set(this.all().flatMap((h) => h.frontmatter.watch))];
  }

  /**
   * The handlers whose matchers do not exclude this event. No `match` block
   * means "offer me everything" (§5.2).
   */
  offeredFor(event: EventRecord): LoadedHandler[] {
    return this.all().filter((h) => matches(h.frontmatter, event));
  }
}

/** The implied match an `embed:` binding carries when it declares none (§22.5). */
export function impliedEmbedMatch(embedId: string): { types: string[]; sources: string[] } {
  return { types: ['embed.action'], sources: [`embed.${embedId}`] };
}

export function matches(frontmatter: HandlerFrontmatter, event: EventRecord): boolean {
  // A bound handler with no matcher of its own is scoped to its own embed, not
  // offered everything: a mini-app's handler firing on the morning email would
  // be a surprising way to learn what `embed:` means (§22.5).
  const match =
    frontmatter.match ?? (frontmatter.embed ? impliedEmbedMatch(frontmatter.embed) : undefined);
  if (!match) return true;
  if (match.types?.length && !globMatchAny(match.types, event.type)) return false;
  if (match.sources?.length && !globMatchAny(match.sources, event.source)) return false;
  return true;
}
