import type { Migration } from './types.js';

/**
 * §7.1: a `notify` that reaches its TTL still `queued` — shown on no channel
 * at all — is `missed`, not `expired`. That is a new status, and SQLite cannot
 * widen a CHECK in place, so the table is rebuilt (the rebuild 013 avoided by
 * choosing a column; a status is what this one is).
 *
 * Rows are copied verbatim, `seq` included, and the AUTOINCREMENT high-water
 * mark is carried across explicitly: `seq` is every device's `last_seen`
 * cursor (§7.3), and a new table that handed out a seq already used would hide
 * a fresh delivery behind an old ack. Nothing references `deliveries`, so the
 * drop is safe with foreign keys on.
 *
 * Existing `expired` rows stay `expired`. Which of them were never delivered
 * is on record (`delivered_at` NULL), but reclassifying history is a decision,
 * not a default — a migration must leave the system correct without one.
 */
export const migration: Migration = {
  version: 14,
  name: 'delivery-missed',
  up(db) {
    const highWater = db
      .prepare(`SELECT seq FROM sqlite_sequence WHERE name = 'deliveries'`)
      .get() as { seq: number } | undefined;
    db.exec(`
      CREATE TABLE deliveries_new (
        seq            INTEGER PRIMARY KEY AUTOINCREMENT,
        id             TEXT UNIQUE NOT NULL,
        intent         TEXT NOT NULL CHECK (intent IN ('notify','confirm')),
        payload        TEXT NOT NULL,
        created_at     TEXT NOT NULL,
        expires_at     TEXT NOT NULL,
        created_by_run TEXT REFERENCES runs(id),
        status         TEXT NOT NULL DEFAULT 'queued'
                       CHECK (status IN ('queued','delivered','acked','expired','missed')),
        delivered_at   TEXT,
        acked_at       TEXT,
        acked_by       TEXT
      );
      INSERT INTO deliveries_new
        (seq, id, intent, payload, created_at, expires_at, created_by_run,
         status, delivered_at, acked_at, acked_by)
      SELECT seq, id, intent, payload, created_at, expires_at, created_by_run,
             status, delivered_at, acked_at, acked_by
        FROM deliveries;
      DROP TABLE deliveries;
      ALTER TABLE deliveries_new RENAME TO deliveries;
      CREATE INDEX ix_deliveries_status ON deliveries(status, expires_at);
    `);
    if (highWater) {
      // The copy leaves the new table's mark at MAX(seq); an old one can be
      // higher when the newest rows were ever removed.
      db.prepare(`UPDATE sqlite_sequence SET seq = MAX(seq, ?) WHERE name = 'deliveries'`).run(
        highWater.seq,
      );
      db.prepare(
        `INSERT INTO sqlite_sequence (name, seq)
         SELECT 'deliveries', ? WHERE NOT EXISTS
           (SELECT 1 FROM sqlite_sequence WHERE name = 'deliveries')`,
      ).run(highWater.seq);
    }
  },
};
