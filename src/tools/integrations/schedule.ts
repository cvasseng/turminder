import { z } from 'zod';
// rrule ships CommonJS for Node (`main: dist/es5/rrule.js`), so the named ESM
// import resolves under a bundler but not at runtime. Take the default and
// destructure.
import rrule from 'rrule';

const { rrulestr } = rrule;
import { parseIso } from '../../core/time.js';
import type { Repos } from '../../db/repos/index.js';
import { matches } from '../../exec/handlers.js';
import type { LoadedHandler } from '../../exec/handlers.js';
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
   */
  const consumersFor = (eventType: string): string[] =>
    deps
      .handlers()
      .filter((h) => matches(h.frontmatter, { type: eventType, source: 'scheduler' }))
      .map((h) => h.name);

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
          .describe('past grace; default fire_late one-shot, skip repeats'),
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
        const when = parseIso(args.fire_at);
        if (!when)
          return { error: 'invalid_arguments', detail: 'fire_at is not an ISO timestamp' };
        if (args.rrule) {
          try {
            rrulestr(args.rrule, { dtstart: when });
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
          fireAt: when.toISOString(),
          note: args.note,
          rrule: args.rrule ?? null,
          graceS: args.grace_s ?? deps.graceS,
          eventType,
          eventPayload: args.data ?? {},
          createdByRun: ctx.runId,
          ...(args.on_miss ? { onMiss: args.on_miss } : {}),
        });
        const consumers = consumersFor(row.event_type);
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
          consumers,
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
            .map((s) => ({
              id: s.id,
              fire_at: s.fire_at,
              rrule: s.rrule,
              note: s.note,
              status: s.status,
              grace_s: s.grace_s,
              on_miss: s.on_miss,
              last_fired_at: s.last_fired_at,
              event_type: s.event_type,
              // "Why didn't my digest run" is answerable from the tool the
              // question is about, without reading a trace (§6.2).
              consumers: consumersFor(s.event_type),
            })),
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
  ];
}
