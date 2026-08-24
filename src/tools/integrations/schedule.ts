import { z } from 'zod';
// rrule ships CommonJS for Node (`main: dist/es5/rrule.js`), so the named ESM
// import resolves under a bundler but not at runtime. Take the default and
// destructure.
import rrule from 'rrule';

const { rrulestr } = rrule;
import { parseIso } from '../../core/time.js';
import type { Repos } from '../../db/repos/index.js';
import type { ToolContext, ToolDefinition } from '../types.js';

/**
 * The `schedule` integration (App. F.2). Creating a schedule is how the
 * assistant remembers to do something later; the firing itself goes through
 * the normal ingress (§6).
 */
export function scheduleTools(repos: Repos, defaultGraceS: number): ToolDefinition[] {
  return [
    {
      name: 'schedule.create',
      description:
        'Schedule an event for later — a reminder, a follow-up, a recurring check. fire_at is ISO 8601 UTC. Use rrule for repeats (RFC 5545, e.g. FREQ=WEEKLY;BYDAY=MO).',
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
      }),
      async execute(
        args: {
          fire_at: string;
          note: string;
          rrule?: string;
          data?: Record<string, unknown>;
          grace_s?: number;
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
        const row = repos.schedules.create({
          fireAt: when.toISOString(),
          note: args.note,
          rrule: args.rrule ?? null,
          graceS: args.grace_s ?? defaultGraceS,
          eventPayload: args.data ?? {},
          createdByRun: ctx.runId,
        });
        return { schedule_id: row.id, fire_at: row.fire_at, rrule: row.rrule };
      },
    },
    {
      name: 'schedule.list',
      description: 'List schedules you have created.',
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
