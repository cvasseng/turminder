import { z } from 'zod';
// rrule ships CommonJS for Node (`main: dist/es5/rrule.js`), so the named ESM
// import resolves under a bundler but not at runtime. Take the default and
// destructure.
import rrule from 'rrule';

const { rrulestr } = rrule;
import type { Config } from '../../core/config.js';
import { nowIso, parseIso } from '../../core/time.js';
import type { Repos } from '../../db/repos/index.js';
import { matches, namesType } from '../../exec/handlers.js';
import type { LoadedHandler } from '../../exec/handlers.js';
import type { EventIntake } from '../../ingress/intake.js';
import { scheduleFirePayload } from '../../scheduler/loop.js';
import type { ScheduleRow } from '../../db/repos/schedules.js';
import { localParts, pad } from './time.js';
import type { ToolContext, ToolDefinition } from '../types.js';

/**
 * A schedule-defined `event_type` is a *label* for routing (§6.2) — it may not
 * claim a namespace App. B has already spoken for, because the trust class,
 * payload and both keys of those belong to the sources that emit them and
 * nothing a model names can earn a `user_fields` entry.
 */
const RESERVED_PREFIXES = [
  'system.',
  'chat.',
  'watch.',
  'file.',
  'email.',
  'embed.',
  'page.',
  'integration.',
] as const;

const EVENT_TYPE = /^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/;

export interface ScheduleDeps {
  repos: Repos;
  /** App. A `schedule_grace_s`. */
  graceS: number;
  /**
   * The handlers on disk *right now* (§5.1). A function, not a snapshot: a
   * handler the assistant writes during the conversation has to count in the
   * very next `schedule.list`, without a restart.
   */
  handlers: () => LoadedHandler[];
  /** Where `schedule.trigger` puts the event it fires by hand (§6.2, F.2). */
  intake: EventIntake;
  /** `identity().frontmatter.timezone` is the one clock this install has (§6.1). */
  config: Config;
  /** Overridden in tests; production reads the wall clock. */
  now?: () => Date;
}

/**
 * How long a grace window reads out loud: whole hours or minutes where they
 * divide evenly, seconds otherwise. Matches how a human would say it back
 * ("grace 1h"), not how the tool stored it.
 */
function graceHuman(graceS: number): string {
  if (graceS > 0 && graceS % 3600 === 0) return `${graceS / 3600}h`;
  if (graceS > 0 && graceS % 60 === 0) return `${graceS / 60}m`;
  return `${graceS}s`;
}

const MONTH_SHORT = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
];

/**
 * "30 Sep" in the given zone, with the year appended only when it isn't
 * `now`'s. A fixed table rather than `Intl`'s own month name: `en-GB` reads
 * September back as "Sept", a fourth letter that would make the sentence's
 * wording depend on ICU data instead of on this file.
 */
function dateHuman(at: Date, timezone: string, now: Date): string {
  const { year, month, day } = localParts(at, timezone);
  const thisYear = localParts(now, timezone).year;
  const monthShort = MONTH_SHORT[month - 1] ?? String(month);
  return year === thisYear ? `${day} ${monthShort}` : `${day} ${monthShort} ${year}`;
}

/**
 * The recurrence in a couple of words. `toText()` reads the cadence off the
 * rule fine ("every day", "every 2 weeks on Monday") but formats `UNTIL`/
 * `COUNT` in whatever zone the process happens to be in — wrong for a
 * server-rendered sentence that promises the identity's own zone (§6.1). So
 * `UNTIL`/`COUNT` are stripped before asking for the words, and rendered
 * separately, in the right zone, by the caller.
 */
function frequencyPhrase(rruleStr: string, dtstart: Date): string {
  const bare = rruleStr
    .split(';')
    .filter((part) => !/^(UNTIL|COUNT)=/i.test(part))
    .join(';');
  const text = rrulestr(bare, { dtstart }).toText();
  const short: Record<string, string> = {
    'every day': 'daily',
    'every week': 'weekly',
    'every month': 'monthly',
    'every year': 'yearly',
  };
  return short[text] ?? text;
}

/**
 * The server-rendered sentence `schedule.create`/`.list`/`.trigger` hand back
 * (§6.2 S2) — the model quotes it rather than converting `fire_at` (UTC) and
 * `on_miss`/`grace_s` into prose itself, which is the telephone problem this
 * closes: a booked 07:00 Oslo reminder was once relayed back as "08:00,
 * 4h grace", right values, wrong sentence.
 */
export function renderWhen(
  row: Pick<ScheduleRow, 'fire_at' | 'rrule' | 'grace_s' | 'on_miss'>,
  timezone: string,
  now: Date,
): string {
  const fireAt = parseIso(row.fire_at) ?? now;
  const { hour, minute } = localParts(fireAt, timezone);
  const hhmm = `${pad(hour)}:${pad(minute)}`;
  // fire_late on a *recurring* schedule fires the one occurrence it is
  // standing on, late (§6.1) — it is not a promise to catch every miss.
  const missPhrase = row.on_miss === 'skip' ? 'skipped' : 'fires late';
  const grace = graceHuman(row.grace_s);

  if (!row.rrule) {
    const date = dateHuman(fireAt, timezone, now);
    return `once at ${hhmm} ${timezone} on ${date}; if missed: ${missPhrase} (grace ${grace})`;
  }

  let freq = 'repeating';
  let until: string | null = null;
  try {
    freq = frequencyPhrase(row.rrule, fireAt);
    const untilAt = rrulestr(row.rrule, { dtstart: fireAt }).options.until;
    if (untilAt) until = dateHuman(untilAt, timezone, now);
  } catch {
    // Rejected at `schedule.create` time; defensive only.
  }
  const untilPart = until ? ` until ${until}` : '';
  return `${freq} at ${hhmm} ${timezone}${untilPart}; if missed: ${missPhrase} (grace ${grace})`;
}

/**
 * The `schedule` integration (App. F.2). Creating a schedule is how the
 * assistant remembers to do something later; the firing itself goes through
 * the normal ingress (§6).
 */
export function scheduleTools(deps: ScheduleDeps): ToolDefinition[] {
  const { repos } = deps;

  /**
   * Who will run the event this schedule emits (§6.2) — the §5.2 envelope
   * matcher over a synthetic envelope, which is deterministic and free. No
   * model call: if you find yourself asking the ingress agent, you have taken
   * the wrong turn. It is a fact about the handlers on disk now, and nothing
   * re-checks it later — a handler deleted after creation makes the schedule
   * inert again, which is the §5.1 contract and not a wrong to right here.
   *
   * `consumers` and `catch_all` are a further split of the same offered set
   * (§6.2 S4): a handler with no `match` block used to read as a consumer of
   * every schedule in existence, which made `consumers: []` never happen and
   * defeated the empty-list `warning` below. Only a handler whose `match`
   * names this type, explicitly, via a `types` glob, counts as a consumer;
   * the rest — still offered, at routing time, exactly as before — are named
   * in `catch_all` instead, so nothing about them is hidden, only relabelled.
   */
  const routingFor = (eventType: string): { consumers: string[]; catchAll: string[] } => {
    const offered = deps
      .handlers()
      .filter((h) => matches(h.frontmatter, { type: eventType, source: 'scheduler' }));
    return {
      consumers: offered.filter((h) => namesType(h.frontmatter, eventType)).map((h) => h.name),
      catchAll: offered.filter((h) => !namesType(h.frontmatter, eventType)).map((h) => h.name),
    };
  };

  /** The identity's own zone (§6.1) — the one clock this install has. */
  const timezone = () => deps.config.identity()?.frontmatter.timezone ?? 'UTC';
  const clock = () => (deps.now ?? (() => new Date()))();
  const whenFor = (row: Pick<ScheduleRow, 'fire_at' | 'rrule' | 'grace_s' | 'on_miss'>) =>
    renderWhen(row, timezone(), clock());

  return [
    {
      name: 'schedule.create',
      description:
        'Schedule an event for later — a reminder, a follow-up, a recurring check. fire_at is ISO 8601 UTC. Use rrule for repeats (RFC 5545, e.g. FREQ=WEEKLY;BYDAY=MO). The reply names who will run it.',
      tier: 'se',
      args: z.object({
        // The format is in the description; repeating it here bills twice (§21.4).
        fire_at: z.string(),
        note: z.string().min(1).describe('what this is for, in one line'),
        rrule: z.string().optional().describe('without DTSTART'),
        data: z.record(z.string(), z.unknown()).optional().describe('carried to the event'),
        grace_s: z
          .number()
          .int()
          .nonnegative()
          .optional()
          .describe('how late it may still fire'),
        // The *why* of each value is a skill's job, not a per-request cost
        // (§21.4). This says what the knob does and what it defaults to.
        on_miss: z
          .enum(['fire_late', 'skip'])
          .optional()
          .describe(
            'past grace; default fire_late one-shot, skip repeats; ' +
              "on a repeat, fire_late means yesterday's, late",
          ),
        event_type: z
          .string()
          .optional()
          .describe('default timer.fired; your own (digest.due) is owned by one handler'),
      }),
      async execute(
        args: {
          fire_at: string;
          note: string;
          rrule?: string;
          data?: Record<string, unknown>;
          grace_s?: number;
          on_miss?: 'fire_late' | 'skip';
          event_type?: string;
        },
        ctx: ToolContext,
      ) {
        const fireAt = parseIso(args.fire_at);
        if (!fireAt)
          return { error: 'invalid_arguments', detail: 'fire_at is not an ISO timestamp' };
        if (args.rrule) {
          try {
            rrulestr(args.rrule, { dtstart: fireAt });
          } catch (e) {
            return { error: 'invalid_arguments', detail: `rrule: ${(e as Error).message}` };
          }
        }
        const eventType = args.event_type ?? 'timer.fired';
        if (!EVENT_TYPE.test(eventType)) {
          return {
            error: 'invalid_arguments',
            detail: `event_type must look like "digest.due" (${EVENT_TYPE.source})`,
          };
        }
        const reserved = RESERVED_PREFIXES.find((p) => eventType.startsWith(p));
        if (reserved) {
          return {
            error: 'reserved_event_type',
            prefix: reserved,
            message: `"${reserved}" is reserved for events the system itself emits (App. B) — pick your own namespace, like "digest.due".`,
          };
        }

        const row = repos.schedules.create({
          fireAt: fireAt.toISOString(),
          note: args.note,
          rrule: args.rrule ?? null,
          graceS: args.grace_s ?? deps.graceS,
          eventType,
          eventPayload: args.data ?? {},
          createdByRun: ctx.runId,
          ...(args.on_miss ? { onMiss: args.on_miss } : {}),
        });
        const { consumers, catchAll } = routingFor(row.event_type);
        // `on_miss` comes back whether or not it was asked for: "what happens
        // if I close the lid" should be answerable from the reply (§6.1). And
        // an empty consumer list is a warning rather than a silence, because
        // the scheduler emits and never acts (§6.2) — a row is a promise to
        // put an event on the rail, and nothing more.
        return {
          schedule_id: row.id,
          fire_at: row.fire_at,
          rrule: row.rrule,
          grace_s: row.grace_s,
          on_miss: row.on_miss,
          event_type: row.event_type,
          // A server-rendered sentence in the identity's own zone (§6.2 S2) —
          // the model quotes it back rather than converting fire_at itself,
          // which is the telephone problem this closes.
          when: whenFor(row),
          consumers,
          catch_all: catchAll,
          ...(consumers.length
            ? {}
            : {
                warning: `No handler matches ${row.event_type}, so this will fire and nothing will run — write a handler for it (the authoring-handlers skill says how) or leave event_type at timer.fired, which the shipped scheduled-task handler picks up.`,
              }),
        };
      },
    },
    {
      name: 'schedule.list',
      description:
        'List schedules you have created, with when each next fires, what happens if ' +
        'the machine is off when it does, and who will run it.',
      tier: 'ro',
      args: z.object({ include_done: z.boolean().optional() }),
      async execute(args: { include_done?: boolean }) {
        return {
          schedules: repos.schedules
            .list({ includeDone: args.include_done ?? false })
            .map((s) => {
              const { consumers, catchAll } = routingFor(s.event_type);
              return {
                id: s.id,
                fire_at: s.fire_at,
                rrule: s.rrule,
                note: s.note,
                status: s.status,
                grace_s: s.grace_s,
                on_miss: s.on_miss,
                last_fired_at: s.last_fired_at,
                event_type: s.event_type,
                when: whenFor(s),
                // "Why didn't my digest run" is answerable from the tool the
                // question is about, without reading a trace (§6.2).
                consumers,
                catch_all: catchAll,
              };
            }),
        };
      },
    },
    {
      name: 'schedule.cancel',
      description: 'Cancel a schedule by id.',
      tier: 'se',
      args: z.object({ schedule_id: z.string().min(1) }),
      async execute(args: { schedule_id: string }) {
        const cancelled = repos.schedules.cancel(args.schedule_id);
        if (!cancelled) {
          const existing = repos.schedules.get(args.schedule_id);
          return existing
            ? { error: 'not_active', status: existing.status, schedule_id: args.schedule_id }
            : { error: 'not_found', schedule_id: args.schedule_id };
        }
        return { schedule_id: args.schedule_id, cancelled: true };
      },
    },
    {
      name: 'schedule.trigger',
      description:
        'Run a schedule now, exactly as its own time arriving would. Use for "do the digest now" or to test a schedule you just wrote. Does not consume the booking: the next occurrence still happens.',
      tier: 'se',
      args: z.object({ schedule_id: z.string().min(1) }),
      async execute(args: { schedule_id: string }, ctx: ToolContext) {
        const row = repos.schedules.get(args.schedule_id);
        if (!row) return { error: 'not_found', schedule_id: args.schedule_id };
        if (row.status !== 'active') {
          return {
            error: 'not_active',
            status: row.status,
            schedule_id: args.schedule_id,
            message: `this schedule is ${row.status}; create a new one rather than firing a finished booking`,
          };
        }

        const firedAt = nowIso();
        const result = deps.intake.submit({
          type: row.event_type,
          source: 'scheduler',
          // Identical to the loop's, by construction (§6.2): a handler must not
          // be able to tell which one woke it. `fire_at` is now and lateness is
          // zero, because a schedule fired by hand is not a late alarm — it is
          // this moment, on purpose, and saying otherwise would have a digest
          // announce itself as yesterday's.
          payload: scheduleFirePayload(row, repos.schedules.payloadOf(row), {
            fireAt: firedAt,
            lateByS: 0,
            manual: true,
          }),
          serialization_key: row.id,
          // Never the loop's `<id>:<fire_at>` key: colliding with it would make
          // a hand-fire swallow the real occurrence, or be swallowed by it.
          idempotency_key: `${row.id}:manual:${firedAt}`,
          // Provenance is this run's, not the schedule creator's (§5.5). The
          // clock has no caller; this does, and the depth guard only works if
          // the chain says who pulled the trigger — a handler that fires a
          // schedule that runs that handler must hit MAX_DEPTH, not spin.
          caused_by: ctx.eventId,
          emitted_by_run: ctx.runId,
        });
        if (result.status === 'rejected') {
          return { error: 'loop_rejected', reason: result.reason, schedule_id: row.id };
        }

        // Deliberately nothing else: no `markFired`, no advance, no status
        // change. Triggering is not consuming, and a user who wants the
        // booking gone has `schedule.cancel` one call away.
        const { consumers, catchAll } = routingFor(row.event_type);
        return {
          schedule_id: row.id,
          event_id: result.event.id,
          event_type: row.event_type,
          fired_at: firedAt,
          next_fire_at: row.fire_at,
          // The booking's own sentence, unchanged by triggering it by hand
          // (§6.2 S2) — `next_fire_at` above already says the booking itself
          // did not move.
          when: whenFor(row),
          consumers,
          catch_all: catchAll,
          ...(consumers.length
            ? {}
            : {
                warning: `No handler matches ${row.event_type}, so this fired and nothing will run — the same as it would at its booked time.`,
              }),
        };
      },
    },
  ];
}
