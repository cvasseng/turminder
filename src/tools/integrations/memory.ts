import { z } from 'zod';
import { MemoryTypeSchema } from '../../core/config-schemas.js';
import type { MemoryAgent } from '../../memory/agent.js';
import type { ProjectScope } from '../../projects/scope.js';
import type { ToolContext, ToolDefinition } from '../types.js';

/**
 * The `memory` integration (App. F.1). Every write goes through the memory
 * agent — it is the single writer, and it commits (§8.2).
 *
 * Both halves are project-aware (§31): retrieval sees only the islands this
 * conversation loaded, and a save lands in the island being worked on unless
 * it says otherwise. Neither is the model's discipline — the scope comes from
 * the conversation row.
 */
export function memoryTools(agent: MemoryAgent, scope: ProjectScope): ToolDefinition[] {
  return [
    {
      name: 'memory.query',
      /** Nothing recalled (§20.9). */
      isEmpty: (result) => ((result as { results?: unknown[] }).results ?? []).length === 0,
      description:
        'Search your long-term memory for facts, preferences, notes and references. Use it before assuming you do not know something about the user.',
      tier: 'ro',
      args: z.object({
        query: z.string().min(1),
        k: z.number().int().min(1).max(20).optional(),
      }),
      async execute(args: { query: string; k?: number }, ctx: ToolContext) {
        const { results, mode } = await agent.query(
          args.query,
          args.k ?? 5,
          scope.loaded(ctx.conversationId),
        );
        return {
          results: results.map((r) => ({
            name: r.name,
            description: r.description,
            type: r.type,
            content: r.content,
            score: Number(r.score.toFixed(4)),
          })),
          retrieval: mode,
        };
      },
    },
    {
      name: 'memory.save',
      description:
        'Remember something for good: a durable fact, preference, note or reference. Do not use it for the passing detail of one conversation. If an existing memory covers it, this updates that one instead of adding a duplicate.',
      tier: 'se',
      // §20.6: memory.query reads it back; carrying it in context too is waste.
      bulkArgs: ['content'],
      args: z.object({
        type: MemoryTypeSchema,
        description: z.string().min(1).describe('one line, what this memory is about'),
        content: z.string().min(1).describe('the memory itself, in prose'),
        name: z
          .string()
          .optional()
          .describe('optional stable name; a slug of it becomes the filename'),
        project: z
          .string()
          .nullable()
          .optional()
          .describe(
            'which loaded project this belongs to; omit for the one being worked on, null to remember it generally',
          ),
      }),
      async execute(
        args: {
          type: 'fact' | 'preference' | 'note' | 'reference';
          description: string;
          content: string;
          name?: string;
          project?: string | null;
        },
        ctx: ToolContext,
      ) {
        const loaded = scope.loaded(ctx.conversationId);
        // Three cases, and they are different on purpose (§31.5): absent
        // means "where we are working", an explicit name must be somewhere
        // this conversation can see, and null is the escape hatch.
        let project: string | null;
        if (args.project === undefined) project = loaded.at(-1) ?? null;
        else if (args.project === null) project = null;
        else if (loaded.includes(args.project)) project = args.project;
        else {
          return {
            error: 'not_loaded',
            message: loaded.length
              ? `"${args.project}" is not loaded here; loaded: ${loaded.join(', ')}`
              : `"${args.project}" is not loaded here — load it first, or pass project: null to remember this generally`,
          };
        }
        return agent.save({ ...args, project });
      },
    },
    {
      name: 'memory.update',
      description: 'Revise an existing memory by name.',
      tier: 'se',
      bulkArgs: ['content'],
      args: z.object({
        name: z.string().min(1),
        content: z.string().optional(),
        description: z.string().optional(),
      }),
      async execute(args: { name: string; content?: string; description?: string }) {
        const result = await agent.update(args.name, args);
        return result ?? { error: 'not_found', name: args.name };
      },
    },
    {
      name: 'memory.forget',
      description: 'Delete a memory that has turned out to be wrong or is no longer true.',
      tier: 'se',
      args: z.object({ name: z.string().min(1), reason: z.string().min(1) }),
      async execute(args: { name: string; reason: string }) {
        return agent.forget(args.name, args.reason);
      },
    },
  ];
}
