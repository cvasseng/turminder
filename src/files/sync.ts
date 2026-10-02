import fs from 'node:fs';
import path from 'node:path';
import { PathRejected } from '../tools/paths.js';
import { FileStoreError, hashBytes, type FileStore } from './store.js';

/**
 * The server half of desktop sync (§18.6): the manifest, and compare-and-swap
 * writes and deletes over the store. Versions are the sha256 of the bytes; the
 * server computes every one, so the client needs no hashing crate.
 *
 * A synced change is a *user edit* — it goes through the store's user-edit
 * methods, which commit but skip `onWrite`, so the §18.4 watcher settles it.
 * Only the conflict copy is a self-write (the ordinary write path).
 */

export interface SyncDeps {
  store: FileStore;
  /** Read at call time: a config reload takes effect. */
  maxBytes(): number;
  /** The instance name, or `the server` before onboarding. */
  instanceName(): string;
  /** Queue the one `notify` a conflict raises. */
  notify(title: string, body: string): void;
  now?(): Date;
}

export interface ManifestEntry {
  path: string;
  sha256: string;
  size: number;
  mtime: string;
}

export type PutResult =
  | {
      status: 200;
      body: {
        path: string;
        sha256: string;
        action: 'created' | 'modified' | 'unchanged';
        committed: boolean;
      };
    }
  | { status: 403; body: { error: 'path_rejected' } }
  | { status: 422; body: { error: 'ignored' } }
  | { status: 413; body: { error: 'too_large'; max_bytes: number } }
  | { status: 422; body: { error: 'unwritable'; message: string } }
  | {
      status: 409;
      body: { error: 'conflict'; path: string; conflict_path: string; sha256: string };
    };

export type DeleteResult =
  | { status: 200; body: { path: string; deleted: true; committed: boolean } }
  | { status: 403; body: { error: 'path_rejected' } }
  | { status: 422; body: { error: 'ignored' } }
  | { status: 422; body: { error: 'unwritable'; message: string } }
  | { status: 404; body: { error: 'not_found' } }
  | { status: 409; body: { error: 'conflict'; path: string; sha256: string } };

/** A disk failure (EACCES, ENOSPC, ENAMETOOLONG, …) is an expected refusal, not a bug (§18.6). */
function unwritable(
  e: unknown,
  rel: string,
): { status: 422; body: { error: 'unwritable'; message: string } } | null {
  const code = (e as NodeJS.ErrnoException | null)?.code;
  if (typeof code !== 'string' || !/^E[A-Z0-9]+$/.test(code)) return null;
  return {
    status: 422,
    body: { error: 'unwritable', message: `the server could not write ${rel} (${code})` },
  };
}

const pad = (n: number): string => String(n).padStart(2, '0');

/** `YYYY-MM-DD HHmm`, local time (§18.6). */
export function conflictStamp(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}${pad(d.getMinutes())}`;
}

export class FileSync {
  private readonly cache = new Map<string, { mtimeMs: number; size: number; sha256: string }>();

  constructor(private readonly deps: SyncDeps) {}

  get maxBytes(): number {
    return this.deps.maxBytes();
  }

  /** Every syncable file — the `files.list` set, over-limit files included. */
  manifest(): ManifestEntry[] {
    const store = this.deps.store;
    const out: ManifestEntry[] = [];
    const seen = new Set<string>();
    for (const entry of store.list({ includeIgnored: false })) {
      const abs = store.resolve(entry.path);
      let stat: fs.Stats;
      try {
        stat = fs.statSync(abs);
      } catch {
        continue; // vanished between the walk and the stat
      }
      seen.add(entry.path);
      const hit = this.cache.get(entry.path);
      let sha256: string;
      if (hit && hit.mtimeMs === stat.mtimeMs && hit.size === stat.size) {
        sha256 = hit.sha256;
      } else {
        try {
          sha256 = hashBytes(fs.readFileSync(abs));
        } catch {
          continue;
        }
        this.cache.set(entry.path, { mtimeMs: stat.mtimeMs, size: stat.size, sha256 });
      }
      out.push({
        path: entry.path,
        sha256,
        size: stat.size,
        mtime: new Date(stat.mtimeMs).toISOString(),
      });
    }
    for (const key of this.cache.keys()) if (!seen.has(key)) this.cache.delete(key);
    return out;
  }

  /** Current bytes of a path, or null when absent. Fresh, never memoised: CAS must not trust a stale mtime. */
  private current(abs: string): { bytes: Buffer; sha256: string } | null {
    try {
      if (!fs.statSync(abs).isFile()) return null;
      const bytes = fs.readFileSync(abs);
      return { bytes, sha256: hashBytes(bytes) };
    } catch {
      return null;
    }
  }

  /** Path gate shared by PUT and DELETE: F.8 rules → 403, a directory → 403. */
  private gate(rel: string): { rel: string; abs: string } | null {
    try {
      const located = this.deps.store.locate(rel);
      if (fs.existsSync(located.abs) && fs.statSync(located.abs).isDirectory()) return null;
      // A path that runs through a file (`todo.md/x.md`) can never be written.
      const root = this.deps.store.root;
      for (
        let dir = path.dirname(located.abs);
        dir.length > root.length;
        dir = path.dirname(dir)
      ) {
        if (fs.existsSync(dir) && !fs.statSync(dir).isDirectory()) return null;
      }
      return located;
    } catch (e) {
      if (e instanceof PathRejected) return null;
      throw e;
    }
  }

  /** The first two steps of §18.6's PUT order, so a route can refuse before it reads the body. */
  precheck(rawRel: string): Extract<PutResult, { status: 403 | 422 }> | null {
    const located = this.gate(rawRel);
    if (!located) return { status: 403, body: { error: 'path_rejected' } };
    if (this.deps.store.ignored(located.rel))
      return { status: 422, body: { error: 'ignored' } };
    return null;
  }

  put(rawRel: string, bytes: Buffer, base: string, device: string): PutResult {
    const store = this.deps.store;
    const refused = this.precheck(rawRel);
    if (refused) return refused;
    const { rel, abs } = this.gate(rawRel)!;
    const max = this.deps.maxBytes();
    if (bytes.length > max)
      return { status: 413, body: { error: 'too_large', max_bytes: max } };

    const cur = this.current(abs);
    const sha = hashBytes(bytes);
    if (cur && cur.sha256 === sha) {
      return {
        status: 200,
        body: { path: rel, sha256: sha, action: 'unchanged', committed: false },
      };
    }
    // An absent file is recreated whatever the base said (edit beats delete).
    const matches = !cur || cur.sha256 === base;
    if (matches) {
      const message = `${cur ? 'Edited' : 'Added'} on ${device}: ${rel}`;
      let written: ReturnType<typeof store.writeUserBytes>;
      try {
        written = store.writeUserBytes(rel, bytes, message);
      } catch (e) {
        const refusal = unwritable(e, rel);
        if (refusal) return refusal;
        throw e;
      }
      return {
        status: 200,
        body: {
          path: rel,
          sha256: sha,
          action: written.existed ? 'modified' : 'created',
          committed: written.committed,
        },
      };
    }

    const conflictPath = this.conflictName(rel, device);
    const message = `Conflict copy from ${device}: ${conflictPath}`;
    try {
      if (!bytes.includes(0) && Buffer.from(bytes.toString('utf8'), 'utf8').equals(bytes)) {
        store.write(conflictPath, bytes.toString('utf8'), message);
      } else {
        store.writeBinary(conflictPath, bytes, message);
      }
    } catch (e) {
      const refusal = unwritable(e, conflictPath);
      if (refusal) return refusal;
      throw e;
    }
    const instance = this.deps.instanceName();
    this.deps.notify(
      `Sync conflict: ${rel}`,
      `${device} and ${instance} both changed ${rel}. ${instance}'s version stayed; ${device}'s is in ${conflictPath}.`,
    );
    return {
      status: 409,
      body: {
        error: 'conflict',
        path: rel,
        conflict_path: conflictPath,
        sha256: cur!.sha256,
      },
    };
  }

  delete(rawRel: string, base: string, device: string): DeleteResult {
    const refused = this.precheck(rawRel);
    if (refused) return refused;
    const { rel, abs } = this.gate(rawRel)!;
    const cur = this.current(abs);
    if (!cur) return { status: 404, body: { error: 'not_found' } };
    if (cur.sha256 !== base) {
      return { status: 409, body: { error: 'conflict', path: rel, sha256: cur.sha256 } };
    }
    try {
      const done = this.deps.store.deleteUser(rel, `Deleted on ${device}: ${rel}`);
      return { status: 200, body: { path: rel, deleted: true, committed: done.committed } };
    } catch (e) {
      if (e instanceof FileStoreError && e.code === 'not_found') {
        return { status: 404, body: { error: 'not_found' } };
      }
      const refusal = unwritable(e, rel);
      if (refusal) return refusal;
      throw e;
    }
  }

  /** `<dir>/<stem> (conflict from <device> <stamp>)<ext>`, ` 2`, ` 3`… inside the parenthesis on collision. */
  private conflictName(rel: string, device: string): string {
    const parsed = path.posix.parse(rel);
    const stamp = conflictStamp((this.deps.now ?? (() => new Date()))());
    for (let n = 1; ; n += 1) {
      const suffix = n === 1 ? '' : ` ${n}`;
      const name = `${parsed.name} (conflict from ${device} ${stamp}${suffix})${parsed.ext}`;
      const candidate = parsed.dir ? `${parsed.dir}/${name}` : name;
      if (!this.deps.store.exists(candidate)) return candidate;
    }
  }
}
