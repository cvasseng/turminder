import { z } from 'zod';
import type { TurnsIndex } from '../../rag/turns-index.js';
import type { ProjectScope } from '../../projects/scope.js';
import type { ToolContext, ToolDefinition } from '../types.js';

export interface HistoryDeps {
  index: TurnsIndex;
  /** Which project islands this conversation may search (§31.3). */
  scope: ProjectScope;
}

/** App. A: `history.search` returns at most this many hits per call. */
const MAX_K = 20;

const iso = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}/, 'use an ISO 8601 date, e.g. 2026-08-01')
  .describe('ISO 8601 date or timestamp');

/**
 * The `history` integration (App. F.15, §25): past conversations as a
 * searchable corpus.
 *
 * Two things it deliberately is not. It is not memory — memories are curated
 * facts the assistant chose to keep, this is the raw transcript, and the two
 * stores never see each other (§18.1). And it is not recall of the *current*
 * conversation: those turns are already in the context asking the question,
 * so they are excluded rather than paid for twice.
 */
export function historyTools(deps: HistoryDeps): ToolDefinition[] {
  return [
    {
      name: 'history.search',
      /** Nothing found in past conversations (§20.9). */
      isEmpty: (result) => ((result as { results?: unknown[] }).results ?? []).length === 0,
      description:
        'Search what was said in earlier conversations — "what did we decide about X". Returns short excerpts with the conversation they came from, never whole transcripts. This searches conversations only: your memory is memory.query, the workspace is files.search. The conversation you are in now is not searched, because you can already see it.',
      tier: 'ro',
      args: z.object({
        query: z.string().min(1),
        k: z.number().int().min(1).max(MAX_K).optional(),
        before: iso.optional().describe('only turns at or before this'),
        after: iso.optional().describe('only turns at or after this'),
      }),
      async execute(
        args: { query: string; k?: number; before?: string; after?: string },
        ctx: ToolContext,
      ) {
        const { results, mode } = await deps.index.search(args.query, {
          k: args.k ?? 5,
          ...(args.before ? { before: args.before } : {}),
          ...(args.after ? { after: args.after } : {}),
          ...(ctx.conversationId ? { excludeConversation: ctx.conversationId } : {}),
          // Turns from a project conversation surface only where that project
          // is loaded (§31.3) — the filter is in the index, not in a prompt.
          loaded: deps.scope.loaded(ctx.conversationId),
        });
        return {
          results: results.map((r) => ({
            conversation_id: r.conversation_id,
            title: r.title,
            turn_seq: r.turn_seq,
            role: r.role,
            excerpt: r.excerpt,
            created_at: r.created_at,
            score: Number(r.score.toFixed(4)),
          })),
          // Which path answered, so a degraded endpoint is visible in the
          // trace rather than showing up as "the search got worse" (§8.3).
          retrieval: mode,
        };
      },
    },
  ];
}
