import type { Migration } from './types.js';

/**
 * The device that speaks a conversation (§33.1, App. C): each voice device
 * owns one open conversation at a time, and this column names which one is
 * whose. NULL for every conversation anyone has ever typed — which is exactly
 * right, because a typed conversation has no mouth and D.2's derived
 * `mode: "voice"` must not start claiming otherwise.
 *
 * A column rather than a new `mode` value: SQLite cannot widen a CHECK
 * constraint without rebuilding the table, and the device name is the fact
 * worth keeping — "which one is the kitchen listening to" is a question
 * `mode: 'voice'` could not answer.
 */
export const migration: Migration = {
  version: 13,
  name: 'conversation-voice-device',
  up(db) {
    db.exec(`ALTER TABLE conversations ADD COLUMN voice_device TEXT`);
  },
};
