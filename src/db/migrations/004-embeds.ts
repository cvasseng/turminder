import type { Migration } from './types.js';

/**
 * The embeds table (§22.1, App. C): metadata and the state pouch for
 * LLM-authored HTML artifacts. The HTML itself is a file on disk — this row is
 * what makes an embed addressable, revocable, and reapable.
 *
 * Nothing to backfill: an install upgrading into this has no embeds, and the
 * reaper's index is empty until one is created.
 */
export const migration: Migration = {
  version: 4,
  name: 'embeds',
  up(db) {
    db.exec(`
      CREATE TABLE embeds (
        id               TEXT PRIMARY KEY,
        title            TEXT NOT NULL,
        kind             TEXT NOT NULL DEFAULT 'ephemeral'
                         CHECK (kind IN ('ephemeral','persistent')),
        conversation_id  TEXT REFERENCES conversations(id),
        created_by_run   TEXT REFERENCES runs(id),
        created_at       TEXT NOT NULL,
        updated_at       TEXT NOT NULL,
        last_served_at   TEXT,
        token_generation INTEGER NOT NULL DEFAULT 1,
        state            TEXT NOT NULL DEFAULT '{}'
      );
      CREATE INDEX ix_embeds_reap ON embeds(kind, conversation_id, updated_at);
    `);
  },
};
