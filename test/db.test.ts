import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DB_VERSION, dbVersion, migrate, openDb, setMeta } from '../src/db/index.js';
import { createRepos } from '../src/db/repos/index.js';
import { UserFacingError } from '../src/core/errors.js';
import { tmpDir } from './helpers.js';

const TABLES = [
  'meta',
  'events',
  'runs',
  'trace',
  'deliveries',
  'schedules',
  'conversations',
  'turns',
];

describe('database bootstrap', () => {
  let t: { dir: string; cleanup: () => void };
  beforeEach(() => {
    t = tmpDir();
  });
  afterEach(() => t.cleanup());

  const dbFile = () => path.join(t.dir, 'events.db');

  it('creates the schema, WAL mode, and foreign keys', () => {
    const db = openDb(dbFile());
    expect(db.pragma('journal_mode', { simple: true })).toBe('wal');
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
    const names = (
      db.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all() as {
        name: string;
      }[]
    ).map((r) => r.name);
    for (const table of TABLES) expect(names).toContain(table);
    expect(dbVersion(db)).toBe(DB_VERSION);
    db.close();
  });

  it('is idempotent across reopens', () => {
    const db1 = openDb(dbFile());
    db1.close();
    const db2 = openDb(dbFile());
    expect(dbVersion(db2)).toBe(DB_VERSION);
    expect(migrate(db2)).toBe(DB_VERSION);
    db2.close();
  });

  it('adds open_namespaces to a database that already has conversations', () => {
    // Build the v2 shape by hand — a real installed database, mid-upgrade.
    const db = openDb(dbFile());
    // A real v2 database has none of the later tables either — and none of the
    // later columns on the tables it does have.
    db.exec(
      `DROP TABLE watchers; DROP TABLE turns; DROP TABLE conversations; ` +
        `DROP TABLE embeds; DROP TABLE uploads`,
    );
    db.exec(`ALTER TABLE schedules DROP COLUMN on_miss`);
    db.exec(`CREATE TABLE conversations (
      id TEXT PRIMARY KEY, title TEXT, mode TEXT NOT NULL DEFAULT 'normal',
      status TEXT NOT NULL DEFAULT 'open', created_at TEXT NOT NULL,
      last_activity_at TEXT NOT NULL, distilled_at TEXT)`);
    db.prepare(
      `INSERT INTO conversations (id, created_at, last_activity_at)
       VALUES ('01OLD', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
    ).run();
    setMeta(db, 'db_version', '2');

    expect(migrate(db)).toBe(DB_VERSION);
    // The pre-existing row behaves like a new conversation: core namespaces
    // only, nothing paged in yet (§21.2.5).
    const row = db
      .prepare(`SELECT open_namespaces FROM conversations WHERE id = '01OLD'`)
      .get() as { open_namespaces: string };
    expect(row.open_namespaces).toBe('[]');
    db.close();
  });

  it('adds the binding columns to a database that already has embeds', () => {
    // The v4 shape by hand: an install that has embeds but no bindings yet,
    // and none of the later tables or columns either.
    const db = openDb(dbFile());
    db.exec(`DROP TABLE watchers; DROP TABLE embeds; DROP TABLE uploads`);
    db.exec(`ALTER TABLE conversations DROP COLUMN model_override`);
    db.exec(`ALTER TABLE conversations DROP COLUMN effort_override`);
    db.exec(`ALTER TABLE conversations DROP COLUMN loaded_projects`);
    db.exec(`ALTER TABLE schedules DROP COLUMN on_miss`);
    db.exec(`CREATE TABLE embeds (
      id TEXT PRIMARY KEY, title TEXT NOT NULL,
      kind TEXT NOT NULL DEFAULT 'ephemeral',
      conversation_id TEXT, created_by_run TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL, last_served_at TEXT,
      token_generation INTEGER NOT NULL DEFAULT 1,
      state TEXT NOT NULL DEFAULT '{}')`);
    db.prepare(
      `INSERT INTO embeds (id, title, created_at, updated_at)
       VALUES ('01EMBED', 'Old chart', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
    ).run();
    setMeta(db, 'db_version', '4');

    expect(migrate(db)).toBe(DB_VERSION);
    // An embed authored before bindings existed is an embed with no bindings —
    // which is exactly what it is, so nothing needed backfilling (§23.2).
    const row = db
      .prepare(`SELECT bindings, bound_data FROM embeds WHERE id = '01EMBED'`)
      .get() as { bindings: string; bound_data: string };
    expect(row).toEqual({ bindings: '[]', bound_data: '{}' });
    db.close();
  });

  it('refuses a database from the future', () => {
    const db = openDb(dbFile());
    setMeta(db, 'db_version', String(DB_VERSION + 5));
    expect(() => migrate(db)).toThrowError(UserFacingError);
    try {
      migrate(db);
    } catch (e) {
      expect((e as UserFacingError).code).toBe('db_from_the_future');
    }
    db.close();
  });

  it('enforces the events status check constraint', () => {
    const db = openDb(dbFile());
    const insert = db.prepare(
      `INSERT INTO events (id, type, source, received_at, payload, status)
       VALUES (?, 'x.y', 'test', '2026-01-01T00:00:00.000Z', '{}', ?)`,
    );
    insert.run('01AAA', 'received');
    expect(() => insert.run('01BBB', 'nonsense')).toThrow();
    db.close();
  });

  it('keeps what a run spent when it ends without carrying the totals', () => {
    // §21.1's conversation figure sums `runs`, and only the success path was
    // passing totals to `finish`. An exception out of the agent loop therefore
    // zeroed tokens that had been spent and traced — measured on the live
    // install as 28 failed runs and 522k input tokens gone missing.
    const db = openDb(dbFile());
    const repos = createRepos(db);
    const runId = repos.runs.create({ kind: 'chat' });
    const trace = repos.trace.sink({ runId });
    trace.append('llm_call', { model: 'main', tokens_in: 900, tokens_out: 40 });
    trace.append('llm_call', { model: 'main', tokens_in: 1100, tokens_out: 60 });

    repos.runs.finish(runId, { status: 'failed', error: 'boom' });

    const row = repos.runs.get(runId)!;
    expect(row.status).toBe('failed');
    expect(row.tokens_in).toBe(2000);
    expect(row.tokens_out).toBe(100);
    db.close();
  });

  it('prefers the totals a caller does supply, including a real zero', () => {
    const db = openDb(dbFile());
    const repos = createRepos(db);
    const runId = repos.runs.create({ kind: 'chat' });
    repos.trace.sink({ runId }).append('llm_call', { tokens_in: 900, tokens_out: 40 });

    // The agent loop's own count wins: it knows about turns the trace does
    // not, and a caller passing 0 means 0 rather than "work it out".
    repos.runs.finish(runId, { status: 'done', turns: 1, tokensIn: 0, tokensOut: 0 });
    expect(repos.runs.get(runId)!.tokens_in).toBe(0);
    db.close();
  });

  it('gives an orphaned run its spending back on restart', () => {
    const db = openDb(dbFile());
    const repos = createRepos(db);
    const runId = repos.runs.create({ kind: 'chat' });
    repos.trace.sink({ runId }).append('llm_call', { tokens_in: 700, tokens_out: 25 });

    expect(repos.runs.failOrphaned()).toBe(1);
    const row = repos.runs.get(runId)!;
    expect(row.status).toBe('failed');
    expect(row.tokens_in).toBe(700);
    expect(row.tokens_out).toBe(25);
    db.close();
  });

  it('dedupes on (source, idempotency_key) but allows repeated NULLs', () => {
    const db = openDb(dbFile());
    const insert = db.prepare(
      `INSERT INTO events (id, type, source, received_at, payload, idempotency_key)
       VALUES (?, 'email.received', 'imap.x', '2026-01-01T00:00:00.000Z', '{}', ?)`,
    );
    insert.run('01A', 'msg-1');
    expect(() => insert.run('01B', 'msg-1')).toThrow();
    insert.run('01C', null);
    insert.run('01D', null);
    db.close();
  });
});
