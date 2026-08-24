import BetterSqlite3 from 'better-sqlite3';
import { UserFacingError } from '../core/errors.js';
import { log } from '../core/logger.js';
import { DB_VERSION, MIGRATIONS } from './migrations/index.js';

const l = log('db');

export type Db = BetterSqlite3.Database;

export interface OpenDbOptions {
  /** Read-only connections skip migrations; used by inspection CLI commands. */
  readonly?: boolean;
}

/**
 * The one database (App. C): WAL, foreign keys on, single writer process (§12.2).
 * Migrations run on open, keyed off meta.db_version.
 */
export function openDb(dbPath: string, opts: OpenDbOptions = {}): Db {
  const db = new BetterSqlite3(dbPath, opts.readonly ? { readonly: true } : {});
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  if (!opts.readonly) migrate(db);
  return db;
}

function tableExists(db: Db, name: string): boolean {
  const row = db
    .prepare(`SELECT 1 AS ok FROM sqlite_master WHERE type='table' AND name=?`)
    .get(name) as { ok: number } | undefined;
  return Boolean(row);
}

export function getMeta(db: Db, key: string): string | null {
  if (!tableExists(db, 'meta')) return null;
  const row = db.prepare(`SELECT value FROM meta WHERE key=?`).get(key) as
    { value: string } | undefined;
  return row?.value ?? null;
}

export function setMeta(db: Db, key: string, value: string): void {
  db.prepare(
    `INSERT INTO meta (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).run(key, value);
}

export function dbVersion(db: Db): number {
  const v = getMeta(db, 'db_version');
  return v === null ? 0 : Number(v);
}

/** Applies pending migrations; refuses a database newer than this build. */
export function migrate(db: Db): number {
  const current = dbVersion(db);
  if (current > DB_VERSION) {
    throw new UserFacingError(
      'db_from_the_future',
      `events.db is at schema version ${current}, but this build knows ${DB_VERSION}`,
      'upgrade Turminder before opening this data dir.',
    );
  }
  if (current === DB_VERSION) return current;

  for (const m of MIGRATIONS.filter((m) => m.version > current).sort(
    (a, b) => a.version - b.version,
  )) {
    l.info({ version: m.version, name: m.name }, 'applying migration');
    db.transaction(() => {
      m.up(db);
      setMeta(db, 'db_version', String(m.version));
    })();
  }
  return DB_VERSION;
}

export { DB_VERSION };
