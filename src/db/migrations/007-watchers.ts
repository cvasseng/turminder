import type { Migration } from './types.js';

/**
 * Watchers (§30, App. C): a frozen read-only call, a status path, and a
 * cadence. The row is the machine's bookkeeping half — `last_status`, the
 * poll clock, the failure counter — while the human-facing half is a file in
 * the store (§30.4).
 *
 * Nothing to backfill: an install upgrading into this has no watchers, and
 * `schedule_id` is required because a watcher without a cadence is not a
 * watcher — the two rows are created and cancelled together.
 */
export const migration: Migration = {
  version: 7,
  name: 'watchers',
  up(db) {
    db.exec(`
      CREATE TABLE watchers (
        id                   TEXT PRIMARY KEY,
        note                 TEXT NOT NULL,
        tool                 TEXT NOT NULL,
        args                 TEXT NOT NULL,
        status_path          TEXT NOT NULL,
        terminal_values      TEXT,
        state_file           TEXT NOT NULL,
        schedule_id          TEXT NOT NULL REFERENCES schedules(id),
        last_status          TEXT,
        last_polled_at       TEXT,
        changed_at           TEXT,
        consecutive_failures INTEGER NOT NULL DEFAULT 0,
        status               TEXT NOT NULL DEFAULT 'active'
                             CHECK (status IN ('active','done','cancelled')),
        created_by_run       TEXT REFERENCES runs(id),
        created_at           TEXT NOT NULL
      );
      CREATE INDEX ix_watchers_status ON watchers(status);
    `);
  },
};
