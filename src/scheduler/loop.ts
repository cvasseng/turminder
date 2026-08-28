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

  /**
   * Starts the loop. There is deliberately no separate catch-up pass any more:
   * grace lives in `fire()` (§6.1), so the first tick handles everything the
   * downtime left behind by exactly the same rules a running service uses.
   */
  start(): void {
    if (this.running) return;
    this.running = true;
    this.schedule(0);
  }

  stop(): void {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  /**
   * Fires everything currently due. Returns how many `timer.fired` events were
   * emitted — a schedule that was skipped for being late is not one of them.
   */
  tick(now: Date = new Date()): number {
    let fired = 0;
    for (const row of this.repos.schedules.due(now.toISOString())) {
      try {
        if (this.fire(row, now)) fired += 1;
      } catch (e) {
        l.error({ schedule: row.id, err: errMessage(e) }, 'failed to fire schedule');
        // Don't spin on a broken schedule.
        this.repos.schedules.setStatus(row.id, 'missed');
      }
    }
    return fired;
  }

  /**
   * One occurrence, one door (§6.1).
   *
   * The grace check lives here rather than in a startup-only recovery pass,
   * because a laptop rebooted a day late and a laptop *suspended* a day and
   * resumed are the same physical situation and used to get opposite answers:
   * the restart marked yesterday's briefing missed, the resume fired it at
   * four in the afternoon as though nothing had happened.
   *
   * Returns whether an event was actually emitted.
   */
  private fire(row: ScheduleRow, now: Date = new Date()): boolean {
    const fireAt = parseIso(row.fire_at);
    const lateByS = fireAt
      ? Math.max(0, Math.round((now.getTime() - fireAt.getTime()) / 1000))
      : 0;
    if (fireAt && lateByS > row.grace_s) return this.missed(row, now, lateByS);

    const firedAt = nowIso();
    const result = this.emit(row, lateByS);
    const next = nextOccurrence(row, now);
    this.repos.schedules.markFired(row.id, firedAt, next);
    l.info(
      {
        schedule: row.id,
        event: result.event.id,
        status: result.status,
        late_by_s: lateByS,
        next,
      },
      'schedule fired',
    );
    return true;
  }

  /**
   * The event itself — one builder, so a punctual fire and a late one differ
   * only in the number they carry. Provenance points at whatever asked for
   * this (§6): the run that created the schedule, and the event that run was
   * handling.
   */
  private emit(row: ScheduleRow, lateByS: number): ReturnType<EventIntake['submit']> {
    const creatorRun = row.created_by_run ? this.repos.runs.get(row.created_by_run) : null;
    return this.intake.submit({
      type: row.event_type,
      source: 'scheduler',
      payload: {
        schedule_id: row.id,
        note: row.note,
        // The server knows how stale this is, so the server says so (App. B):
        // a digest can open with "this is yesterday's" instead of inferring
        // lateness from `time.now` and a hope.
        fire_at: row.fire_at,
        late_by_s: lateByS,
        data: this.repos.schedules.payloadOf(row),
      },
      serialization_key: row.id,
      // App. B: `<schedule_id>:<fire_at>` — a restart mid-fire cannot double up.
      idempotency_key: `${row.id}:${row.fire_at}`,
      caused_by: creatorRun?.event_id ?? null,
      emitted_by_run: row.created_by_run ?? null,
    });
  }

  /**
   * An occurrence found past its grace window. `fire_late` fires it anyway —
   * a reminder is still worth having, late — and `skip` does not, because
   * yesterday's digest is noise. Either way the miss is announced once (§6.1),
   * with how many occurrences went by, so a week away is one honest event
   * rather than silence or seven runs.
   */
  private missed(row: ScheduleRow, now: Date, lateByS: number): boolean {
    const skipped = countOccurrences(row, now);
    const next = nextOccurrence(row, now);
    this.intake.submit({
      type: 'system.schedule_missed',
      source: 'system',
      payload: {
        schedule_id: row.id,
        fire_at: row.fire_at,
        late_by_s: lateByS,
        note: row.note,
        on_miss: row.on_miss,
        skipped,
        next_fire_at: next,
      },
    });
    l.warn(
      {
        schedule: row.id,
        fire_at: row.fire_at,
        late_by_s: lateByS,
        on_miss: row.on_miss,
        skipped,
      },
      'schedule missed its grace window',
    );

    // Fired for the occurrence it was actually for — `fire_at` and `late_by_s`
    // say so — and then advanced past everything else that went by while
    // nobody was home. One fire, never N.
    if (row.on_miss === 'fire_late') this.emit(row, lateByS);

    if (next) this.repos.schedules.markFired(row.id, nowIso(), next);
    else this.repos.schedules.setStatus(row.id, 'missed');
    return row.on_miss === 'fire_late';
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

/**
 * How far the local clock moved between two instants, in milliseconds. Positive
 * when the second one is in daylight saving and the first is not — which is
 * exactly the amount an absolute-time recurrence has drifted off the wall
 * clock, and therefore the amount to take back out.
 */
function driftMs(from: Date, to: Date): number {
  return (to.getTimezoneOffset() - from.getTimezoneOffset()) * 60_000;
}

/**
 * How many occurrences of a recurring schedule went by unfired, counting the
 * one it is standing on. One-shots are one. Bounded, because a schedule left
 * alone for a year at one-minute cadence should produce a number, not a walk.
 */
export function countOccurrences(row: ScheduleRow, until: Date, cap = 1000): number {
  if (!row.rrule) return 1;
  const dtstart = parseIso(row.fire_at);
  if (!dtstart) return 1;
  try {
    const rule = rrulestr(row.rrule, { dtstart });
    // `between` is inclusive of dtstart, which is the occurrence that was due.
    return Math.min(rule.between(dtstart, until, true).length || 1, cap);
  } catch {
    return 1;
  }
}

/**
 * The next occurrence of a recurring schedule, or null for a one-shot.
 *
 * **Corrected for daylight saving** (§6.1). `rrulestr` works in absolute time,
 * so "every day at 08:00" created in March becomes 09:00 for good the morning
 * the clocks move — measured on Europe/Oslo, 2026-03-29, where a `FREQ=DAILY`
 * from 08:00 local produced 09:00 local for every occurrence after the
 * transition. A schedule keeps the wall clock of the machine it runs on, so
 * the difference in UTC offset between this occurrence and the last is taken
 * back out. The correction is self-cancelling: once `fire_at` has moved, the
 * two offsets agree again and nothing is adjusted.
 */
export function nextOccurrence(row: ScheduleRow, after: Date): string | null {
  if (!row.rrule) return null;
  const dtstart = parseIso(row.fire_at) ?? after;
  try {
    const rule = rrulestr(row.rrule, { dtstart });
    // Never return the occurrence we just fired.
    const from = after.getTime() > dtstart.getTime() ? after : dtstart;
    const raw = rule.after(from, false);
    const next = raw ? new Date(raw.getTime() + driftMs(dtstart, raw)) : null;
    return next ? next.toISOString() : null;
  } catch (e) {
    l.warn({ schedule: row.id, rrule: row.rrule, err: errMessage(e) }, 'invalid rrule');
    return null;
  }
}
