import { z } from 'zod';
import type { Outbox } from '../../egress/outbox.js';
import type { ToolContext, ToolDefinition } from '../types.js';

/**
 * The `deliver` integration (App. F.3). `confirm` deliveries are deliberately
 * absent: those are created by the dispatcher during the confirmation
 * round-trip, never requested by a model.
 */
export function deliverTools(
  outbox: Outbox,
  /** Read at call time so a config reload takes effect (App. A, G.1). */
  spokenMaxChars: () => number,
): ToolDefinition[] {
  return [
    {
      name: 'deliver.notify',
      description:
        'Send the user a desktop notification. Use it when something genuinely needs their attention now — not to acknowledge your own work. Add actions only when you need a decision back.',
      tier: 'se',
      args: z.object({
        title: z.string().min(1),
        body: z.string().min(1),
        spoken: z
          .string()
          .min(1)
          .max(spokenMaxChars())
          .optional()
          .describe('one sentence a speaker says instead of title and body'),
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
          spoken?: string;
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
            // Assistant-authored, exactly as the title and body already are
            // (§33.3). A device with no speaker simply ignores it (D.3).
            ...(args.spoken ? { spoken: args.spoken } : {}),
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
