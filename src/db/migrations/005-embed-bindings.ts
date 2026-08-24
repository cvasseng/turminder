import type { Migration } from './types.js';

/**
 * Data bindings on embeds (§23.2, App. C). `bindings` is the frozen list of
 * read-only calls the model chose; `bound_data` is what those calls returned.
 * Two columns rather than one because they have different authors: the model
 * decides the bindings once, and deterministic code overwrites the data every
 * refresh.
 *
 * The defaults make every existing embed behave like one with no bindings —
 * which is what it is. Nothing to backfill: an embed authored before bindings
 * existed baked its numbers into its HTML, and re-binding it is an authoring
 * act, not a migration.
 */
export const migration: Migration = {
  version: 5,
  name: 'embed-bindings',
  up(db) {
    db.exec(`
      ALTER TABLE embeds ADD COLUMN bindings   TEXT NOT NULL DEFAULT '[]';
      ALTER TABLE embeds ADD COLUMN bound_data TEXT NOT NULL DEFAULT '{}';
    `);
  },
};
