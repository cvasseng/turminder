import type { Migration } from './types.js';

/**
 * The chat model override (§10.6, App. C): the endpoint a conversation is
 * pinned to, or NULL for "resolve it normally".
 *
 * NULL is exactly right for every existing conversation — nobody has chosen
 * yet, and the kind default (`chat → best`) is what they have been getting all
 * along.
 */
export const migration: Migration = {
  version: 8,
  name: 'conversation-model-override',
  up(db) {
    db.exec(`ALTER TABLE conversations ADD COLUMN model_override TEXT`);
  },
};
