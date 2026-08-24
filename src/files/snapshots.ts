import fs from 'node:fs';
import path from 'node:path';
import BetterSqlite3 from 'better-sqlite3';
import { log } from '../core/logger.js';
import { hashContent } from './store.js';

const l = log('files');

export interface Snapshot {
  path: string;
  hash: string;
  content: string;
}

/**
 * What the watcher last saw in each file (§18.4). Derived data, so it lives in
 * `cache/` — but durable, because the two things it decides are worth surviving
 * a restart: whether a file actually changed (mtime lies), and which marker
 * lines are new rather than merely present.
 *
 * The store records its own writes here, which is what self-write suppression
 * is: the assistant's edit is already the snapshot by the time the watcher
 * looks, so it is not a change.
 */
export class SnapshotStore {
  private db: BetterSqlite3.Database | null = null;

  constructor(private readonly file: string) {}

  private open(): BetterSqlite3.Database {
    if (this.db) return this.db;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const db = new BetterSqlite3(this.file);
    db.pragma('journal_mode = WAL');
    db.exec(`
      CREATE TABLE IF NOT EXISTS snapshots (
        path    TEXT PRIMARY KEY,
        hash    TEXT NOT NULL,
        content TEXT NOT NULL,
        seen_at TEXT NOT NULL
      );
    `);
    this.db = db;
    return db;
  }

  get(rel: string): Snapshot | null {
    const row = this.open()
      .prepare(`SELECT path, hash, content FROM snapshots WHERE path = ?`)
      .get(rel) as Snapshot | undefined;
    return row ?? null;
  }

  record(rel: string, content: string, at: string): void {
    this.open()
      .prepare(
        `INSERT INTO snapshots (path, hash, content, seen_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(path) DO UPDATE SET hash = excluded.hash,
           content = excluded.content, seen_at = excluded.seen_at`,
      )
      .run(rel, hashContent(content), content, at);
  }

  forget(rel: string): void {
    this.open().prepare(`DELETE FROM snapshots WHERE path = ?`).run(rel);
  }

  paths(): string[] {
    return (this.open().prepare(`SELECT path FROM snapshots`).all() as { path: string }[]).map(
      (r) => r.path,
    );
  }

  close(): void {
    this.db?.close();
    this.db = null;
  }

  /** Drop everything; the next baseline re-reads the store from disk. */
  clear(): void {
    this.open().prepare(`DELETE FROM snapshots`).run();
    l.debug('file snapshots cleared');
  }
}
