import type { Migration } from './types.js';

/**
 * Which project islands a conversation has loaded (§31.1, App. C) — the
 * `open_namespaces` pattern exactly: a JSON array on the conversation row,
 * load order preserved, surviving reconnects and restarts.
 *
 * `'[]'` is right for every existing conversation: nothing was ever loaded,
 * so they see the base layer and nothing else — which is what they have been
 * seeing all along.
 */
export const migration: Migration = {
  version: 10,
  name: 'conversation-loaded-projects',
  up(db) {
    db.exec(`ALTER TABLE conversations ADD COLUMN loaded_projects TEXT NOT NULL DEFAULT '[]'`);
  },
};
