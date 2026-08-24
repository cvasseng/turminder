import fs from 'node:fs';
import path from 'node:path';
import type { Config } from '../core/config.js';
import type { DataHome } from '../core/datadir.js';
import { newId } from '../core/ids.js';
import { log } from '../core/logger.js';
import type { EmbedKind, EmbedRow, EmbedsRepo } from '../db/repos/embeds.js';
import { bindingsFor, handlerBindings } from './bindings.js';
import { embedSecret, scopedToken } from './tokens.js';

const l = log('embeds');

/** App. A: the pouch is a whole-blob JSON value, capped (§22.4). */
export const EMBED_STATE_MAX_BYTES = 64 * 1024;

const EMBEDS_DIR = 'embeds';
const HANDLERS_DIR = 'handlers';

export interface EmbedError {
  error: string;
  message: string;
  detail?: string;
  /** Occurrence count on an exact-match-once refusal (App. F.13). */
  matches?: number;
  /** `similar_exists` only: what the new title collides with (App. F.13). */
  existing?: { embed_id: string; title: string; updated_at: string }[];
}

/**
 * "The same dashboard again" detection, deliberately dumb: normalized titles
 * where one contains the other. "NO5 energy dashboard" collides with
 * "NO5 Energy Dashboard v2" and not with "NO5 spot prices" — which is the
 * distinction that matters. Anything cleverer starts guessing.
 */
const normalizeTitle = (t: string): string =>
  t
    .toLowerCase()
    .replace(/[^a-z0-9æøåäöü]+/gi, ' ')
    .trim();

export function titlesCollide(a: string, b: string): boolean {
  const na = normalizeTitle(a);
  const nb = normalizeTitle(b);
  if (!na || !nb) return false;
  return na.includes(nb) || nb.includes(na);
}

const isError = (v: unknown): v is EmbedError =>
  typeof v === 'object' && v !== null && 'error' in v;

/**
 * References the CSP would dead-letter anyway (App. F.13). Rejecting them at
 * authoring time is the difference between the model learning "single file, no
 * assets" on the first try and the user staring at an empty box.
 *
 * Matched on attributes and CSS, never on prose: an embed that *mentions* a URL
 * in its text is fine, and refusing that would be maddening.
 */
const EXTERNAL_REFERENCES: { re: RegExp; what: string }[] = [
  {
    re: /\b(?:src|srcset|href|poster|data)\s*=\s*["']?\s*(?:https?:)?\/\//i,
    what: 'an attribute pointing at a remote URL',
  },
  { re: /@import\b/i, what: 'a CSS @import' },
  { re: /url\(\s*["']?\s*(?:https?:)?\/\//i, what: 'a remote url() in CSS' },
];

/**
 * The two sanctioned script sources (§23.3): the vendored client libs and the
 * Highcharts CDN — the latter so an exported embed keeps working when hosted
 * anywhere. Charting is Highcharts, exclusively; every other chart library's
 * CDN stays structurally rejected by not being on this list.
 */
const SANCTIONED_SCRIPT_SRC = /^(?:\/embed-vendor\/|https:\/\/code\.highcharts\.com\/)/i;

/**
 * A stylesheet may come from `/embed-vendor/` and nowhere else (§23.3) — that
 * is how a reveal.js deck gets its layout CSS. The Highcharts CDN is *not* on
 * this list: nothing there is a stylesheet, and a `<link>` to it would only
 * ever be a mistake.
 */
const SANCTIONED_LINK_HREF = /^\/embed-vendor\//i;

export function findExternalReference(html: string): string | null {
  // Script tags first, value by value: sanctioned sources pass, all else fails.
  const scriptSrc = /<script\b[^>]*\bsrc\s*=\s*["']?([^"'\s>]+)/gi;
  for (const m of html.matchAll(scriptSrc)) {
    if (!SANCTIONED_SCRIPT_SRC.test(m[1]!)) return `<script src="${m[1]}">`;
  }
  // Then link tags. A `<link>` with no href at all is nothing to fetch.
  const linkTag = /<link\b[^>]*>/gi;
  for (const tag of html.match(linkTag) ?? []) {
    const href = /\bhref\s*=\s*["']?([^"'\s>]+)/i.exec(tag)?.[1];
    if (href === undefined) continue;
    if (!SANCTIONED_LINK_HREF.test(href)) return `<link href="${href}">`;
  }
  // Neutralise sanctioned URLs so the generic remote-reference sweep below
  // does not re-flag what the script and link checks just allowed.
  const scrubbed = html.replace(
    /(["'(])https:\/\/code\.highcharts\.com\//gi,
    '$1/embed-vendor/',
  );
  for (const { re, what } of EXTERNAL_REFERENCES) if (re.test(scrubbed)) return what;
  return null;
}

export interface EmbedStoreDeps {
  home: DataHome;
  config: Config;
  repo: EmbedsRepo;
  /** Called after the handler cascade so the loader stops offering dead files. */
  onHandlersChanged?: () => void;
  /** Called when an edit makes what is on screen out of date (§22.6). */
  onChanged?: (id: string) => void;
}

/**
 * Embed storage and lifecycle (§22.1). One self-contained HTML file per embed;
 * `tmp/` for the ephemeral ones so scratch dashboards never enter the data
 * repo's history, and a git commit at every persistent mutation so a mini-app
 * the user came to rely on has history and rollback.
 */
export class EmbedStore {
  private readonly home: DataHome;
  private readonly config: Config;
  readonly repo: EmbedsRepo;

  constructor(private readonly deps: EmbedStoreDeps) {
    this.home = deps.home;
    this.config = deps.config;
    this.repo = deps.repo;
  }

  /** data-dir-relative, so it can go straight into a git commit. */
  relPath(row: Pick<EmbedRow, 'id' | 'kind'>): string {
    return row.kind === 'persistent' ? `embeds/${row.id}.html` : `embeds/tmp/${row.id}.html`;
  }

  absPath(row: Pick<EmbedRow, 'id' | 'kind'>): string {
    return this.home.path(...this.relPath(row).split('/'));
  }

  /** The freestanding URL, scoped token included (§22.3.3). */
  url(row: Pick<EmbedRow, 'id' | 'token_generation'>): string {
    const t = scopedToken(embedSecret(this.home, this.config), row.id, row.token_generation);
    return `/embed/${row.id}?t=${t}`;
  }

  marker(id: string): string {
    return `{{embed:${id}}}`;
  }

  /** The HTML as authored, or null when the file is gone from under the row. */
  html(row: EmbedRow): string | null {
    const abs = this.absPath(row);
    return fs.existsSync(abs) ? fs.readFileSync(abs, 'utf8') : null;
  }

  create(input: {
    title: string;
    html: string;
    kind?: EmbedKind;
    conversationId?: string | null;
    runId?: string | null;
    allowDuplicate?: boolean;
  }): { embed_id: string; url: string; marker: string } | EmbedError {
    const external = findExternalReference(input.html);
    if (external) {
      return {
        error: 'external_reference',
        message:
          'Embeds are a single self-contained file — with exactly two allowed script ' +
          'sources: https://code.highcharts.com/… (charts) and /embed-vendor/… ' +
          '(reveal.js). Everything else must be inlined.',
        detail: `found ${external}; inline the code and use data: URIs for images — Highcharts via its CDN is fine and stays allowed`,
      };
    }
    // The did-not-ask gate (§22.2, App. F.13): a second "NO5 energy dashboard"
    // is a duplicate the user has to disown, not a decision the model makes.
    // Deterministic, because the prompt-level rule was demonstrably skipped.
    if (!input.allowDuplicate) {
      const existing = this.repo
        .list({})
        .filter((r) => titlesCollide(r.title, input.title))
        .map((r) => ({ embed_id: r.id, title: r.title, updated_at: r.updated_at }));
      if (existing.length) {
        return {
          error: 'similar_exists',
          message:
            'an embed with a colliding title already exists. Ask the user first: summon ' +
            'setup.form with a choice field ("Continue existing" / "Start fresh") and ' +
            'embed_id set to the existing embed so they can see it. Continue → embeds.edit ' +
            'the existing one; start fresh → create again with allow_duplicate: true and a ' +
            'clearly distinct title.',
          existing,
        };
      }
    }
    const id = newId();
    const kind = input.kind ?? 'ephemeral';
    const rel = this.relPath({ id, kind });
    this.writeFile(rel, input.html);
    const row = this.repo.create({
      id,
      title: input.title,
      kind,
      conversationId: input.conversationId ?? null,
      createdByRun: input.runId ?? null,
    });
    // Directories, not the file: `git add` refuses an ignored path outright,
    // and `embeds/tmp/` is ignored on purpose (§22.1). Staging `embeds/` picks
    // up exactly the persistent half and stays quiet about the rest.
    if (kind === 'persistent') {
      this.home.git.commit(`embed: created ${input.title} (${id})`, [EMBEDS_DIR]);
    }
    l.info({ embed: id, kind }, 'embed created');
    return { embed_id: id, url: this.url(row), marker: this.marker(id) };
  }

  /**
   * Exact-match-once search-replace, like `files.edit` (App. F.13). The same
   * reason applies with more force here: a small model rewriting a whole
   * 30kb app to change one label loses half of it.
   */
  edit(
    id: string,
    find: string,
    replace: string,
  ): { embed_id: string; committed?: boolean } | EmbedError {
    const row = this.repo.get(id);
    if (!row) return notFound(id);
    const current = this.html(row);
    if (current === null) return missingFile(id);
    const occurrences = countOccurrences(current, find);
    if (occurrences === 0) {
      return {
        error: 'no_match',
        message: `that text does not appear in embed ${id}`,
        matches: 0,
      };
    }
    if (occurrences > 1) {
      return {
        error: 'multiple_matches',
        message: `that text appears ${occurrences} times in embed ${id}; include more surrounding text`,
        matches: occurrences,
      };
    }
    const next = current.replace(find, replace);
    const external = findExternalReference(next);
    if (external) {
      return {
        error: 'external_reference',
        message:
          'That edit would add an external reference the embed cannot load. ' +
          '(The Highcharts CDN and /embed-vendor/ scripts remain allowed.)',
        detail: `found ${external}`,
      };
    }
    this.writeFile(this.relPath(row), next);
    this.repo.touch(id);
    // Anyone looking at this embed right now is looking at the old one.
    this.deps.onChanged?.(id);
    // Ephemeral edits do not commit (§22.1) — they are not in the repo at all.
    const committed =
      row.kind === 'persistent'
        ? this.home.git.commit(`embed: edited ${row.title} (${id})`, [EMBEDS_DIR])
        : false;
    return row.kind === 'persistent' ? { embed_id: id, committed } : { embed_id: id };
  }

  read(
    id: string,
    opts: { offsetLines?: number; limitLines?: number } = {},
  ): { embed_id: string; content: string; truncated: boolean } | EmbedError {
    const row = this.repo.get(id);
    if (!row) return notFound(id);
    const content = this.html(row);
    if (content === null) return missingFile(id);
    if (opts.offsetLines === undefined && opts.limitLines === undefined) {
      return { embed_id: id, content, truncated: false };
    }
    const lines = content.split('\n');
    const from = Math.max(0, opts.offsetLines ?? 0);
    const to = opts.limitLines === undefined ? lines.length : from + opts.limitLines;
    return {
      embed_id: id,
      content: lines.slice(from, to).join('\n'),
      truncated: to < lines.length || from > 0,
    };
  }

  writeState(
    id: string,
    state: Record<string, unknown>,
  ): { embed_id: string; bytes: number } | EmbedError {
    if (!this.repo.get(id)) return notFound(id);
    const bytes = Buffer.byteLength(JSON.stringify(state), 'utf8');
    if (bytes > EMBED_STATE_MAX_BYTES) {
      return {
        error: 'state_too_large',
        message: `the state pouch holds at most ${EMBED_STATE_MAX_BYTES} bytes (this was ${bytes})`,
      };
    }
    return { embed_id: id, bytes: this.repo.setState(id, state) };
  }

  /**
   * Promotion moves the file out of `tmp/` and commits it — the git boundary
   * and a user act, never an inference (§22.1).
   */
  promote(id: string): { embed_id: string; kind: 'persistent' } | EmbedError {
    const row = this.repo.get(id);
    if (!row) return notFound(id);
    if (row.kind === 'persistent') return { embed_id: id, kind: 'persistent' };
    const content = this.html(row);
    if (content === null) return missingFile(id);
    const from = this.absPath(row);
    this.writeFile(this.relPath({ id, kind: 'persistent' }), content);
    fs.rmSync(from, { force: true });
    this.repo.promote(id);
    this.home.git.commit(`embed: keeping ${row.title} (${id})`, [EMBEDS_DIR]);
    l.info({ embed: id }, 'embed promoted');
    return { embed_id: id, kind: 'persistent' };
  }

  /**
   * Unkeep: back to ephemeral, file and all (§22.1).
   *
   * The mirror of `promote`, and deliberately not a delete — the view keeps
   * working and its link keeps resolving, because the scoped token hashes
   * against the id and generation rather than the path (§22.3.3). What changes
   * is that it stops being permanent: the file leaves the data repo for the
   * gitignored `tmp/`, so the commit records a removal, and the row is once
   * again something the reaper may take when its conversation has closed and
   * it has been quiet long enough.
   */
  demote(id: string): { embed_id: string; kind: 'ephemeral' } | EmbedError {
    const row = this.repo.get(id);
    if (!row) return notFound(id);
    if (row.kind === 'ephemeral') return { embed_id: id, kind: 'ephemeral' };
    const content = this.html(row);
    if (content === null) return missingFile(id);
    const from = this.absPath(row);
    this.writeFile(this.relPath({ id, kind: 'ephemeral' }), content);
    fs.rmSync(from, { force: true });
    this.repo.demote(id);
    // Names the removal for what it is: the history of a kept view ends here,
    // and `git log` is where someone will look for it.
    this.home.git.commit(`embed: no longer keeping ${row.title} (${id})`, [EMBEDS_DIR]);
    l.info({ embed: id }, 'embed demoted');
    return { embed_id: id, kind: 'ephemeral' };
  }

  /**
   * Delete the embed and every handler bound to it, in one commit naming both
   * (§22.5). Leaving the handlers behind is how a dead-handler graveyard
   * starts: they would fire for an embed that can never emit again.
   */
  delete(
    id: string,
  ): { embed_id: string; deleted: true; handlers_removed: string[] } | EmbedError {
    const row = this.repo.get(id);
    if (!row) return notFound(id);
    return { embed_id: id, deleted: true, handlers_removed: this.destroy(row, 'delete') };
  }

  /** Shared by `embeds.delete` and the reaper, so the cascade cannot diverge. */
  destroy(row: EmbedRow, reason: 'delete' | 'reap'): string[] {
    const bound = bindingsFor(this.home, row.id);
    fs.rmSync(this.absPath(row), { force: true });
    for (const binding of bound) {
      fs.rmSync(this.home.path(...binding.file.split('/')), { force: true });
    }
    this.repo.remove(row.id);
    const names = bound.map((b) => b.name);
    const suffix = names.length
      ? ` + ${names.length} bound handler${names.length === 1 ? '' : 's'}`
      : '';
    // One commit for both halves: a reader of the log should never find a
    // handler deletion whose reason lives in a different commit. Staged by
    // directory — an ephemeral embed's file was never tracked, and naming it
    // would make `git add` refuse the whole commit, handler deletion included.
    this.home.git.commit(
      `embed: ${reason === 'reap' ? 'reaped' : 'deleted'} ${row.title} (${row.id})${suffix}`,
      names.length ? [EMBEDS_DIR, HANDLERS_DIR] : [EMBEDS_DIR],
    );
    if (names.length) this.deps.onHandlersChanged?.();
    l.info({ embed: row.id, reason, handlers: names }, 'embed removed');
    return names;
  }

  /** Revokes every outstanding link by changing what they hash against. */
  rotate(id: string): { embed_id: string; token_generation: number; url: string } | EmbedError {
    const generation = this.repo.rotate(id);
    if (generation === null) return notFound(id);
    return {
      embed_id: id,
      token_generation: generation,
      url: this.url({ id, token_generation: generation }),
    };
  }

  /** Deletes handler bindings pointing at an embed that no longer exists (§22.5). */
  repairOrphanedBindings(): string[] {
    const live = new Set(this.repo.ids());
    const dead = handlerBindings(this.home).filter((b) => !live.has(b.embedId));
    if (!dead.length) return [];
    for (const binding of dead) {
      fs.rmSync(this.home.path(...binding.file.split('/')), { force: true });
    }
    this.home.git.commit(
      `embeds: removed ${dead.length} handler binding${dead.length === 1 ? '' : 's'} with no embed`,
      [HANDLERS_DIR],
    );
    this.deps.onHandlersChanged?.();
    l.warn({ handlers: dead.map((b) => b.name) }, 'removed orphaned embed handler bindings');
    return dead.map((b) => b.name);
  }

  private writeFile(rel: string, content: string): void {
    const abs = this.home.path(...rel.split('/'));
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content, 'utf8');
  }
}

function notFound(id: string): EmbedError {
  return { error: 'not_found', message: `no embed with id ${id}` };
}

function missingFile(id: string): EmbedError {
  return {
    error: 'content_missing',
    message: `embed ${id} has a record but no file — it was removed outside Turminder`,
  };
}

function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  let from = 0;
  for (;;) {
    const at = haystack.indexOf(needle, from);
    if (at === -1) return count;
    count += 1;
    from = at + needle.length;
  }
}

export { isError as isEmbedError };
