import type { Migration } from './types.js';

/**
 * Going idle no longer archives a conversation — archiving is a user action
 * (§9) — but it still triggers the distillation pass, so the pass needs a
 * high-water mark of its own. `distilled_at` holds the `last_activity_at` it
 * last ran against: turns landing after it make the conversation eligible
 * again, and nothing else re-runs it.
 */
export const migration: Migration = {
  version: 2,
  name: 'conversation-distilled-at',
  up(db) {
    db.exec(`ALTER TABLE conversations ADD COLUMN distilled_at TEXT`);
  },
};
