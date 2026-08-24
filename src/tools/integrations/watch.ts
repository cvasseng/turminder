import { z } from 'zod';
import type { ToolContext, ToolDefinition } from '../types.js';
import type { RunGrants } from '../run-grants.js';
import type { WatchersRepo } from '../../db/repos/watchers.js';
import type { WatcherEngine } from '../../watchers/engine.js';
import { WATCH_MIN_INTERVAL_S } from '../../watchers/engine.js';

export interface WatchDeps {
  engine: WatcherEngine;
  repo: WatchersRepo;
  /** The creating run's authority, exactly as bindings use it (§23.2). */
  runGrants: RunGrants;
  /** The schedule row's next fire time, for the create's answer. */
  nextPollAt: (scheduleId: string) => string | null;
}

const scalar = z.union([z.string(), z.number(), z.boolean()]);

/**
 * The `watch` integration (App. F.16, §30). Four tools over one idea: freeze a
 * read-only call, extract one scalar, and let deterministic code do the
 * looking.
 *
 * The model's part is choosing what to watch and saying what "done" means. It
 * is deliberately not part of the polling: a status check that woke the model
 * would cost a turn per look on a box that serializes inference, which is the
 * whole reason this layer exists.
 */
export function watchTools(deps: WatchDeps): ToolDefinition[] {
  return [
    {
      name: 'watch.create',
      description:
        'Watch something whose status changes over time — a package, a build, an application. Give a read-only tool call to repeat and the path to the status value in its result; you are told only when the value changes. Prefer args_from: true right after calling the tool yourself, so the exact arguments are frozen rather than retyped.',
      tier: 'se',
      args: z.object({
        note: z.string().min(1).describe('what is being watched, in a few words'),
        tool: z.string().min(1).describe('a read-only tool you may already call'),
        args: z.record(z.string(), z.unknown()).optional(),
        args_from: z
          .literal(true)
          .optional()
          .describe('freeze the args of your most recent call to this tool'),
        status_path: z
          .string()
          .min(1)
          .describe('dotted path to a scalar in the result, e.g. "shipment.status"'),
        terminal_values: z
          .array(scalar)
          .optional()
          .describe('values that end the watch, e.g. ["delivered"]'),
        every_s: z.number().int().min(WATCH_MIN_INTERVAL_S).optional(),
        state_file: z.string().min(1).optional(),
      }),
      async execute(args: Record<string, unknown>, ctx: ToolContext) {
        const created = await deps.engine.create(args as never, {
          runId: ctx.runId ?? null,
          grants: deps.runGrants.get(ctx.runId),
          toolCtx: ctx,
        });
        return created;
      },
    },
    {
      name: 'watch.list',
      description:
        'What is being watched right now, with each one’s current status, when it was last checked, and where its history file is.',
      tier: 'ro',
      isEmpty: (result) => ((result as { watchers?: unknown[] }).watchers ?? []).length === 0,
      args: z.object({ include_done: z.boolean().optional() }),
      async execute(args: { include_done?: boolean }) {
        return {
          watchers: deps.repo.list({ includeDone: args.include_done ?? false }).map((w) => ({
            watch_id: w.id,
            note: w.note,
            status: w.status,
            last_status: w.last_status,
            last_polled_at: w.last_polled_at,
            changed_at: w.changed_at,
            consecutive_failures: w.consecutive_failures,
            state_file: w.state_file,
            next_poll_at: deps.nextPollAt(w.schedule_id),
          })),
        };
      },
    },
    {
      name: 'watch.cancel',
      description: 'Stop watching something. The history file stays where it is.',
      tier: 'se',
      args: z.object({ watch_id: z.string().min(1) }),
      async execute(args: { watch_id: string }) {
        return deps.engine.cancel(args.watch_id);
      },
    },
    {
      name: 'watch.poll',
      description:
        'Check one watcher right now instead of waiting for its next scheduled look. A change found this way is announced exactly as a scheduled one would be.',
      tier: 'ro',
      args: z.object({ watch_id: z.string().min(1) }),
      async execute(args: { watch_id: string }, ctx: ToolContext) {
        return deps.engine.step(args.watch_id, { toolCtx: ctx });
      },
    },
  ];
}
