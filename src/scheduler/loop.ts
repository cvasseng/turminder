// rrule ships CommonJS for Node (`main: dist/es5/rrule.js`), so the named ESM
// import resolves under a bundler but not at runtime. Take the default and
// destructure.
import rrule from 'rrule';

const { rrulestr } = rrule;
import { log } from '../core/logger.js';
import { errMessage } from '../core/errors.js';
import { msUntil, nowIso, parseIso } from '../core/time.js';
import type { Repos } from '../db/repos/index.js';
import type { ScheduleRow } from '../db/repos/schedules.js';
import type { EventIntake } from '../ingress/intake.js';

const l = log('scheduler');

export interface SchedulerOptions {
  /** Longest the loop will sleep between checks. */
  maxSleepMs?: number;
}

/**
 * The scheduler is a first-class event source (§6): a single timer loop turns
 * due schedules into `timer.fired` events and lets the normal ingress decide
 * what they mean. Nothing about scheduled work is special downstream.
 */
export class SchedulerLoop {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private readonly maxSleepMs: number;

  constructor(
    private readonly repos: Repos,
    private readonly intake: EventIntake,
    opts: SchedulerOptions = {},
  ) {
    this.maxSleepMs = opts.maxSleepMs ?? 30_000;
  }

  /** Catches up on anything missed while the process was down, then starts. */
  start(): void {
    if (this.running) return;
    this.running = true;
    this.recoverMissed();
    this.schedule(0);
  }

  stop(): void {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  /**
   * Missed schedules fire on startup if still inside their grace window;
   * otherwise they are marked missed and say so as an event (§6).
   */
  recoverMissed(): number {
    const now = Date.now();
    let missed = 0;
    for (const row of this.repos.schedules.due()) {
      const fireAt = parseIso(row.fire_at);
      if (!fireAt) continue;
      const lateBy = (now - fireAt.getTime()) / 1000;
      if (lateBy <= row.grace_s) continue; // the normal tick will fire it
      missed += 1;
      const next = nextOccurrence(row, new Date(now));
      if (next) {
        this.repos.schedules.markFired(row.id, nowIso(), next);
      } else {
        this.repos.schedules.setStatus(row.id, 'missed');
      }
      this.intake.submit({
        type: 'system.schedule_missed',
        source: 'system',
        payload: { schedule_id: row.id, fire_at: row.fire_at, note: row.note },
      });
      l.warn(
        { schedule: row.id, fire_at: row.fire_at, late_by_s: Math.round(lateBy) },
        'schedule missed its grace window',
      );
    }
    return missed;
  }

  /** Fires everything currently due. Returns how many events were emitted. */
  tick(): number {
    let fired = 0;
    for (const row of this.repos.schedules.due()) {
      try {
        this.fire(row);
        fired += 1;
      } catch (e) {
        l.error({ schedule: row.id, err: errMessage(e) }, 'failed to fire schedule');
        // Don't spin on a broken schedule.
        this.repos.schedules.setStatus(row.id, 'missed');
      }
    }
    return fired;
  }

  private fire(row: ScheduleRow): void {
    const firedAt = nowIso();
    // Provenance points at whatever asked for this (§6): the run that created
    // the schedule, and the event that run was handling.
    const creatorRun = row.created_by_run ? this.repos.runs.get(row.created_by_run) : null;
    const result = this.intake.submit({
      type: row.event_type,
      source: 'scheduler',
      payload: {
        schedule_id: row.id,
        note: row.note,
        data: this.repos.schedules.payloadOf(row),
      },
      serialization_key: row.id,
      // App. B: `<schedule_id>:<fire_at>` — a restart mid-fire cannot double up.
      idempotency_key: `${row.id}:${row.fire_at}`,
      caused_by: creatorRun?.event_id ?? null,
      emitted_by_run: row.created_by_run ?? null,
    });
    const next = nextOccurrence(row, new Date());
    this.repos.schedules.markFired(row.id, firedAt, next);
    l.info(
      { schedule: row.id, event: result.event.id, status: result.status, next },
      'schedule fired',
    );
  }

  private schedule(delayMs: number): void {
    if (!this.running) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      try {
        this.tick();
      } catch (e) {
        l.error({ err: errMessage(e) }, 'scheduler tick failed');
      }
      this.schedule(this.nextDelay());
    }, delayMs);
    this.timer.unref?.();
  }

  private nextDelay(): number {
    const next = this.repos.schedules.nextFireAt();
    if (!next) return this.maxSleepMs;
    return Math.max(50, Math.min(this.maxSleepMs, msUntil(next)));
  }
}

/** The next occurrence of a recurring schedule, or null for a one-shot. */
export function nextOccurrence(row: ScheduleRow, after: Date): string | null {
  if (!row.rrule) return null;
  const dtstart = parseIso(row.fire_at) ?? after;
  try {
    const rule = rrulestr(row.rrule, { dtstart });
    // Never return the occurrence we just fired.
    const from = after.getTime() > dtstart.getTime() ? after : dtstart;
    const next = rule.after(from, false);
    return next ? next.toISOString() : null;
  } catch (e) {
    l.warn({ schedule: row.id, rrule: row.rrule, err: errMessage(e) }, 'invalid rrule');
    return null;
  }
}
