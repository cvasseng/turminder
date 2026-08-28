import type { Migration } from './types.js';

/**
 * What to do with a schedule found past its grace window (§6.1, App. C).
 *
 * `fire_late` is the default because it is what every existing row has been
 * getting: before this column, a schedule found late on a *running* service
 * fired regardless of how late it was — only the startup path checked grace at
 * all. So existing rows behave exactly as they always have, and the new
 * behaviour is opt-in per schedule. `schedule.create` picks the honest default
 * per kind (one-shot `fire_late`, recurring `skip`) for rows written from now
 * on; a migration that reached back and changed what an existing digest does
 * would be the sort of surprise a migration must never be.
 */
export const migration: Migration = {
  version: 11,
  name: 'schedule-on-miss',
  up(db) {
    db.exec(`
      ALTER TABLE schedules ADD COLUMN on_miss TEXT NOT NULL DEFAULT 'fire_late'
        CHECK (on_miss IN ('fire_late','skip'))
    `);
  },
};
