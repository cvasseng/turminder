import type { Migration } from './types.js';

/**
 * The chat reasoning-effort override (§10.6, App. C): the level this
 * conversation asks for, or NULL for "whatever the endpoint does by default".
 *
 * NULL is what every existing conversation should have: absent an override the
 * parameter is never sent at all, which is exactly the behaviour they have had
 * since the beginning — the endpoint's own default, unguessed.
 */
export const migration: Migration = {
  version: 9,
  name: 'conversation-effort-override',
  up(db) {
    db.exec(`ALTER TABLE conversations ADD COLUMN effort_override TEXT`);
  },
};
