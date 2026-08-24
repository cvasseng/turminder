import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { log } from '../core/logger.js';
import type { GitRepo } from '../core/git.js';
import { globMatch } from '../core/glob.js';
import { PathRejected, resolveInside } from '../tools/paths.js';
import { IgnoreRules } from './ignore.js';

const l = log('files');

export interface FileEntry {
  path: string;
  size: number;
  mtime: string;
  binary: boolean;
}

export interface TextFile {
  path: string;
  content: string;
  hash: string;
}

export interface BinaryInfo {
  path: string;
  binary: true;
  size: number;
  mime: string;
}

export type ReadResult =
  | { path: string; content: string; truncated: boolean; binary: false; mime: string }
  | BinaryInfo;

export type FileChange = 'created' | 'modified' | 'deleted';

/** Where the store's commits go, and where the store sits inside that repo. */
export interface StoreGit {
  repo: GitRepo;
  /** Repo-relative prefix of the store root; `''` when the store is the repo. */
  prefix: string;
}

export interface FileStoreOptions {
  root: string;
  git?: StoreGit | null;
  /**
   * Called after every write with the content that was written. Self-write
   * suppression (§18.4): the watcher compares against the snapshot this
   * records, so the store's own edits never look like a user's.
   */
  onWrite?(rel: string, content: string | null, change: FileChange): void;
}

const IGNORE_FILE = '.turminderignore';

/** Enough to be useful in a metadata-only read; not a mime database. */
const MIME_BY_EXT: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.pdf': 'application/pdf',
  '.zip': 'application/zip',
  '.mp3': 'audio/mpeg',
  '.mp4': 'video/mp4',
  '.ods': 'application/vnd.oasis.opendocument.spreadsheet',
  '.odt': 'application/vnd.oasis.opendocument.text',
};

/**
 * The Content-Type for a store path — one door, shared by the metadata read
 * (F.8) and the raw-serving route (App. E). Unknown extensions are
 * `application/octet-stream`: a guess here is a guess the browser acts on.
 */
export function mimeForPath(rel: string): string {
  return MIME_BY_EXT[path.extname(rel).toLowerCase()] ?? 'application/octet-stream';
}

export function hashContent(content: string): string {
  return crypto.createHash('sha256').update(content, 'utf8').digest('hex');
}

/** A NUL byte is the same heuristic `grep -I` uses, and it is good enough. */
export function looksBinary(buf: Buffer): boolean {
  return buf.subarray(0, 8192).includes(0);
}

export class FileStoreError extends Error {
  constructor(
    readonly code: 'not_found' | 'is_directory' | 'binary' | 'ignored',
    message: string,
  ) {
    super(message);
    this.name = 'FileStoreError';
  }
}

/**
 * The shared workspace (§18.2). Files are the user's, not the assistant's:
 * real paths, real names, edited by whatever editor they like. Every assistant
 * write is a commit, so "what did you change in my todo list" is `git log -p`.
 *
 * Nothing here is ever auto-injected into a prompt — that firewall (§18.1) is
 * upstream, in what the tools and the watcher choose to hand to a run.
 */
export class FileStore {
  readonly root: string;
  private readonly git: StoreGit | null;
  private ignoreCache: { mtimeMs: number; rules: IgnoreRules } | null = null;

  constructor(private readonly opts: FileStoreOptions) {
    this.root = path.resolve(opts.root);
    this.git = opts.git ?? null;
  }

  get committing(): boolean {
    return this.git !== null;
  }

  ensure(): void {
    fs.mkdirSync(this.root, { recursive: true });
  }

  /** Reloaded when the file changes: editing the ignore list should take effect. */
  ignore(): IgnoreRules {
    const file = path.join(this.root, IGNORE_FILE);
    let mtimeMs: number;
    try {
      mtimeMs = fs.statSync(file).mtimeMs;
    } catch {
      this.ignoreCache = null;
      return IgnoreRules.empty();
    }
    if (this.ignoreCache?.mtimeMs === mtimeMs) return this.ignoreCache.rules;
    const rules = IgnoreRules.parse(fs.readFileSync(file, 'utf8'));
    this.ignoreCache = { mtimeMs, rules };
    return rules;
  }

  ignored(rel: string, isDir = false): boolean {
    if (rel === IGNORE_FILE) return true;
    if (rel.split('/')[0] === '.git') return true;
    return this.ignore().ignores(rel, isDir);
  }

  /** Store-relative path → absolute, with the App. F.6 containment rules. */
  resolve(rel: string): string {
    return resolveInside(this.root, rel).abs;
  }

  private file(rel: string): { abs: string; rel: string } {
    const resolved = resolveInside(this.root, rel);
    if (!resolved.segments.length) throw new PathRejected('path must name a file');
    return { abs: resolved.abs, rel: resolved.rel };
  }

  /** Repo path of a store path, for `git add`. */
  private repoPath(rel: string): string {
    if (!this.git) return rel;
    return this.git.prefix ? `${this.git.prefix}/${rel}` : rel;
  }

  private commit(message: string, rel: string): boolean {
    if (!this.git) return false;
    return this.git.repo.commit(message, [this.repoPath(rel)]);
  }

  list(opts: { dir?: string; glob?: string; includeIgnored?: boolean } = {}): FileEntry[] {
    const base = resolveInside(this.root, opts.dir ?? '');
    if (!fs.existsSync(base.abs)) return [];
    const out: FileEntry[] = [];

    const walk = (abs: string, rel: string): void => {
      for (const entry of fs
        .readdirSync(abs, { withFileTypes: true })
        .sort((a, b) => a.name.localeCompare(b.name))) {
        const childRel = rel ? `${rel}/${entry.name}` : entry.name;
        if (entry.isSymbolicLink()) continue;
        if (!opts.includeIgnored && this.ignored(childRel, entry.isDirectory())) continue;
        if (entry.isDirectory()) {
          walk(path.join(abs, entry.name), childRel);
          continue;
        }
        if (!entry.isFile()) continue;
        if (opts.glob && !globMatch(opts.glob, childRel) && !globMatch(opts.glob, entry.name)) {
          continue;
        }
        const stat = fs.statSync(path.join(abs, entry.name));
        out.push({
          path: childRel,
          size: stat.size,
          mtime: new Date(stat.mtimeMs).toISOString(),
          binary: this.isBinary(path.join(abs, entry.name)),
        });
      }
    };
    walk(base.abs, base.rel);
    return out;
  }

  exists(rel: string): boolean {
    try {
      return fs.existsSync(this.file(rel).abs);
    } catch {
      return false;
    }
  }

  isBinary(abs: string): boolean {
    try {
      const fd = fs.openSync(abs, 'r');
      try {
        const buf = Buffer.alloc(8192);
        const read = fs.readSync(fd, buf, 0, 8192, 0);
        return looksBinary(buf.subarray(0, read));
      } finally {
        fs.closeSync(fd);
      }
    } catch {
      return false;
    }
  }

  /**
   * Read a text file, or a binary file's metadata. Binary content is stored and
   * listed but never read into context in v1 (§18.2) — the deferred extraction
   * story (§16) plugs in here.
   */
  read(rel: string, opts: { offsetLines?: number; limitLines?: number } = {}): ReadResult {
    const { abs, rel: clean } = this.file(rel);
    if (!fs.existsSync(abs)) throw new FileStoreError('not_found', `no such file: ${clean}`);
    if (fs.statSync(abs).isDirectory()) {
      throw new FileStoreError('is_directory', `${clean} is a directory`);
    }
    if (this.isBinary(abs)) {
      return {
        path: clean,
        binary: true,
        size: fs.statSync(abs).size,
        mime: mimeForPath(clean),
      };
    }
    const content = fs.readFileSync(abs, 'utf8');
    // `mime` rides every read, not only the binary ones: the file panel decides
    // what to render from what the file *is* (§18.5), and the NUL-byte
    // heuristic that decides `binary` is about extraction, not about format —
    // a PDF with no NUL in it is still a PDF.
    const mime = mimeForPath(clean);
    if (opts.offsetLines === undefined && opts.limitLines === undefined) {
      return { path: clean, content, truncated: false, binary: false, mime };
    }
    const lines = content.split('\n');
    const from = Math.max(0, opts.offsetLines ?? 0);
    const to = opts.limitLines === undefined ? lines.length : from + opts.limitLines;
    return {
      path: clean,
      content: lines.slice(from, to).join('\n'),
      truncated: to < lines.length || from > 0,
      binary: false,
      mime,
    };
  }

  /** Text content of a file, or null when it is missing or binary. */
  readText(rel: string): TextFile | null {
    try {
      const result = this.read(rel);
      if ('binary' in result && result.binary) return null;
      return { path: result.path, content: result.content, hash: hashContent(result.content) };
    } catch {
      return null;
    }
  }

  write(
    rel: string,
    content: string,
    message: string,
  ): { path: string; committed: boolean; action: 'created' | 'overwritten' } {
    const { abs, rel: clean } = this.file(rel);
    assertText(content);
    const existed = fs.existsSync(abs);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content, 'utf8');
    const committed = this.commit(message, clean);
    this.opts.onWrite?.(clean, content, existed ? 'modified' : 'created');
    l.info(
      { path: clean, committed, action: existed ? 'overwritten' : 'created' },
      'file written',
    );
    return { path: clean, committed, action: existed ? 'overwritten' : 'created' };
  }

  /**
   * A file the store did not compose: a printed PDF (§23.4) arrives as bytes
   * from a subprocess. Committed like any other write, but `onWrite` is told
   * there is no text — a binary file has no half the index or the marker scan
   * can do anything with, and pretending otherwise would index gibberish.
   */
  writeBinary(
    rel: string,
    data: Buffer,
    message: string,
  ): { path: string; committed: boolean; bytes: number } {
    const { abs, rel: clean } = this.file(rel);
    const existed = fs.existsSync(abs);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, data);
    const committed = this.commit(message, clean);
    this.opts.onWrite?.(clean, null, existed ? 'modified' : 'created');
    l.info({ path: clean, committed, bytes: data.length }, 'binary file written');
    return { path: clean, committed, bytes: data.length };
  }

  append(rel: string, content: string, message: string): { path: string; committed: boolean } {
    const { abs, rel: clean } = this.file(rel);
    assertText(content);
    const before = fs.existsSync(abs) ? fs.readFileSync(abs, 'utf8') : '';
    // Appending to a file that does not end in a newline should not join lines.
    const glue = before && !before.endsWith('\n') ? '\n' : '';
    const next = `${before}${glue}${content}`;
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, next, 'utf8');
    const committed = this.commit(message, clean);
    this.opts.onWrite?.(clean, next, before ? 'modified' : 'created');
    l.info({ path: clean, committed }, 'file appended');
    return { path: clean, committed };
  }

  /**
   * Exact-match-once search and replace (§18.3). Deliberately not a whole-file
   * rewrite: small models lose content when asked to reproduce a file, and the
   * difference between a collaborator and a hazard is right here.
   */
  edit(
    rel: string,
    find: string,
    replace: string,
    message: string,
  ):
    | { path: string; committed: boolean }
    | { error: 'no_match' | 'multiple_matches'; matches: number; path: string } {
    const { abs, rel: clean } = this.file(rel);
    if (!fs.existsSync(abs)) throw new FileStoreError('not_found', `no such file: ${clean}`);
    if (this.isBinary(abs)) {
      throw new FileStoreError('binary', `${clean} is binary; text tools do not apply`);
    }
    assertText(replace);
    const before = fs.readFileSync(abs, 'utf8');
    const matches = countOccurrences(before, find);
    if (matches === 0) return { error: 'no_match', matches: 0, path: clean };
    if (matches > 1) return { error: 'multiple_matches', matches, path: clean };

    const next = before.replace(find, replace);
    fs.writeFileSync(abs, next, 'utf8');
    const committed = this.commit(message, clean);
    this.opts.onWrite?.(clean, next, 'modified');
    l.info({ path: clean, committed }, 'file edited');
    return { path: clean, committed };
  }

  delete(rel: string, message: string): { path: string; deleted: boolean } {
    const { abs, rel: clean } = this.file(rel);
    if (!fs.existsSync(abs)) throw new FileStoreError('not_found', `no such file: ${clean}`);
    fs.rmSync(abs);
    this.commit(message, clean);
    this.opts.onWrite?.(clean, null, 'deleted');
    l.info({ path: clean }, 'file deleted');
    return { path: clean, deleted: true };
  }
}

function assertText(content: string): void {
  if (typeof content !== 'string') throw new FileStoreError('binary', 'content must be text');
  if (content.includes('\0')) {
    throw new FileStoreError(
      'binary',
      'content contains a null byte; the text tools are text-only',
    );
  }
}

function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  let from = 0;
  for (;;) {
    const at = haystack.indexOf(needle, from);
    if (at < 0) return count;
    count += 1;
    from = at + needle.length;
  }
}
