import type { Migration } from './types.js';

/**
 * Chat attachments (§26.1, App. C). The bytes live in `uploads/` — content
 * addressed, gitignored, TTL-pruned — and this row is what makes one
 * addressable, attributable to a conversation, and reapable.
 *
 * Nothing to backfill: an install upgrading into this has no uploads, and
 * `conversation_id` is NULL until a `chat.send` references the upload, which
 * is exactly the state a freshly-uploaded-but-unsent file is in.
 */
export const migration: Migration = {
  version: 6,
  name: 'uploads',
  up(db) {
    db.exec(`
      CREATE TABLE uploads (
        id              TEXT PRIMARY KEY,
        sha256          TEXT NOT NULL,
        name            TEXT NOT NULL,
        mime            TEXT NOT NULL,
        bytes           INTEGER NOT NULL,
        conversation_id TEXT REFERENCES conversations(id),
        created_at      TEXT NOT NULL
      );
      CREATE INDEX ix_uploads_created ON uploads(created_at);
    `);
  },
};
