import { z } from 'zod';
import type { Outbox } from '../../egress/outbox.js';
import type { ToolContext, ToolDefinition } from '../types.js';

/**
 * The `deliver` integration (App. F.3). `confirm` deliveries are deliberately
 * absent: those are created by the dispatcher during the confirmation
 * round-trip, never requested by a model.
 */
export function deliverTools(outbox: Outbox): ToolDefinition[] {
  return [
    {
      name: 'deliver.notify',
      description:
        'Send the user a desktop notification. Use it when something genuinely needs their attention now — not to acknowledge your own work. Add actions only when you need a decision back.',
      tier: 'se',
      args: z.object({
        title: z.string().min(1),
        body: z.string().min(1),
        actions: z
          .array(z.object({ id: z.string().min(1), label: z.string().min(1) }))
          .max(4)
          .optional()
          .describe('buttons; a click comes back as an event'),
        ttl_s: z
          .number()
          .int()
          .positive()
          .optional()
          .describe('seconds it stays worth showing'),
      }),
      async execute(
        args: {
          title: string;
          body: string;
          actions?: { id: string; label: string }[];
          ttl_s?: number;
        },
        ctx: ToolContext,
      ) {
        const delivery = outbox.queue({
          intent: 'notify',
          payload: {
            title: args.title,
            body: args.body,
            ...(args.actions?.length ? { actions: args.actions } : {}),
          },
          ...(args.ttl_s ? { ttlS: args.ttl_s } : {}),
          createdByRun: ctx.runId,
          eventId: ctx.eventId,
        });
        return { delivery_id: delivery.id };
      },
    },
  ];
}
