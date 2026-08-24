import type { Migration } from './types.js';

/**
 * Tool paging (§21.2.5): which namespaces this conversation has opened. The
 * set is monotonic and written through on every open, so a conversation about
 * lights keeps its Home Assistant tools across messages while a conversation
 * about the calendar never pays the tokens for them.
 *
 * `'[]'` for existing rows is exactly right: they start at the core set, like
 * a new conversation, and re-open whatever they need on the next message.
 */
export const migration: Migration = {
  version: 3,
  name: 'conversation-open-namespaces',
  up(db) {
    db.exec(`ALTER TABLE conversations ADD COLUMN open_namespaces TEXT NOT NULL DEFAULT '[]'`);
  },
};
