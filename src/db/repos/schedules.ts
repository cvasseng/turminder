import type { Db } from '../index.js';
import { newId } from '../../core/ids.js';
import { nowIso } from '../../core/time.js';

export type ScheduleStatus = 'active' | 'done' | 'cancelled' | 'missed';

/** What to do with an occurrence found past its grace window (§6.1). */
export type OnMiss = 'fire_late' | 'skip';

export interface ScheduleRow {
  id: string;
  fire_at: string;
  rrule: string | null;
  grace_s: number;
  note: string;
  event_type: string;
  event_payload: string;
  created_by_run: string | null;
  status: ScheduleStatus;
  last_fired_at: string | null;
  on_miss: OnMiss;
}

export interface NewSchedule {
  fireAt: string;
  note: string;
  rrule?: string | null;
  graceS?: number;
  eventType?: string;
  eventPayload?: unknown;
  createdByRun?: string | null;
  /**
   * Defaults per kind, because the two kinds want opposite things (§6.1): a
   * missed reminder is still worth having, late; yesterday's digest is noise.
   */
  onMiss?: OnMiss;
}

export class SchedulesRepo {
  constructor(private readonly db: Db) {}

  create(input: NewSchedule): ScheduleRow {
    const row: ScheduleRow = {
      id: newId(),
      fire_at: input.fireAt,
      rrule: input.rrule ?? null,
      grace_s: input.graceS ?? 3600,
      note: input.note,
      event_type: input.eventType ?? 'timer.fired',
      event_payload: JSON.stringify(input.eventPayload ?? {}),
      created_by_run: input.createdByRun ?? null,
      status: 'active',
      last_fired_at: null,
      on_miss: input.onMiss ?? (input.rrule ? 'skip' : 'fire_late'),
    };
    this.db
      .prepare(
        `INSERT INTO schedules (id, fire_at, rrule, grace_s, note, event_type, event_payload,
           created_by_run, status, last_fired_at, on_miss)
         VALUES (@id, @fire_at, @rrule, @grace_s, @note, @event_type, @event_payload,
           @created_by_run, @status, @last_fired_at, @on_miss)`,
      )
      .run(row);
    return row;
  }

  get(id: string): ScheduleRow | null {
    return (
      (this.db.prepare(`SELECT * FROM schedules WHERE id = ?`).get(id) as ScheduleRow) ?? null
    );
  }

  list(opts: { includeDone?: boolean } = {}): ScheduleRow[] {
    const where = opts.includeDone ? '' : `WHERE status = 'active'`;
    return this.db
      .prepare(`SELECT * FROM schedules ${where} ORDER BY fire_at ASC`)
      .all() as ScheduleRow[];
  }

  /** Active schedules whose time has come. */
  due(now: string = nowIso()): ScheduleRow[] {
    return this.db
      .prepare(
        `SELECT * FROM schedules WHERE status = 'active' AND fire_at <= ? ORDER BY fire_at ASC`,
      )
      .all(now) as ScheduleRow[];
  }

  /** Next scheduled fire time, so the loop can sleep exactly long enough. */
  nextFireAt(): string | null {
    const row = this.db
      .prepare(`SELECT MIN(fire_at) AS at FROM schedules WHERE status = 'active'`)
      .get() as { at: string | null } | undefined;
    return row?.at ?? null;
  }

  markFired(id: string, firedAt: string, next: string | null): void {
    if (next) {
      this.db
        .prepare(`UPDATE schedules SET last_fired_at = ?, fire_at = ? WHERE id = ?`)
        .run(firedAt, next, id);
    } else {
      this.db
        .prepare(`UPDATE schedules SET last_fired_at = ?, status = 'done' WHERE id = ?`)
        .run(firedAt, id);
    }
  }

  setStatus(id: string, status: ScheduleStatus): boolean {
    return (
      this.db.prepare(`UPDATE schedules SET status = ? WHERE id = ?`).run(status, id).changes >
      0
    );
  }

  cancel(id: string): boolean {
    return (
      this.db
        .prepare(`UPDATE schedules SET status = 'cancelled' WHERE id = ? AND status = 'active'`)
        .run(id).changes > 0
    );
  }

  /**
   * Rewrite a schedule's payload. Used once, by watcher creation (§30.1): the
   * payload has to name the watcher, and the watcher row cannot exist before
   * the schedule it references.
   */
  setPayload(id: string, payload: unknown): void {
    this.db
      .prepare(`UPDATE schedules SET event_payload = ? WHERE id = ?`)
      .run(JSON.stringify(payload), id);
  }

  payloadOf(row: ScheduleRow): unknown {
    try {
      return JSON.parse(row.event_payload);
    } catch {
      return {};
    }
  }
}
