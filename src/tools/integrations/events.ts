import { z } from 'zod';
import { log } from '../../core/logger.js';
import type { EventIntake } from '../../ingress/intake.js';
import type { ToolContext, ToolDefinition } from '../types.js';

const l = log('tool:events');

/**
 * `events.emit` (App. F.4). Provenance — `caused_by`, depth, and the emitting
 * run — is stamped here from the run context, never from the model's arguments.
 */
export function eventsTools(intake: EventIntake): ToolDefinition[] {
  return [
    {
      name: 'events.emit',
      description:
        "Emit a new internal event onto the assistant's own event loop. Use this to hand work to another behaviour, not to talk to the user.",
      tier: 'se',
      args: z.object({
        type: z.string().describe('dot-namespaced event type, e.g. reminder.due'),
        payload: z.record(z.string(), z.unknown()).default({}),
        serialization_key: z
          .string()
          .optional()
          .describe('events sharing this key are processed strictly in order'),
      }),
      async execute(
        args: { type: string; payload: Record<string, unknown>; serialization_key?: string },
        ctx: ToolContext,
      ) {
        const result = intake.submit({
          type: args.type,
          source: ctx.handlerName ? `handler.${ctx.handlerName}` : 'agent',
          payload: args.payload ?? {},
          serialization_key: args.serialization_key ?? null,
          caused_by: ctx.eventId,
          emitted_by_run: ctx.runId,
        });
        if (result.status === 'rejected') {
          l.warn({ type: args.type, reason: result.reason }, 'emit rejected');
          return { error: 'loop_rejected', reason: result.reason };
        }
        return { event_id: result.event.id, status: result.status };
      },
    },
  ];
}
