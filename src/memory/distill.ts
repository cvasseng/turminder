import { z } from 'zod';
import { log } from '../core/logger.js';
import { errMessage } from '../core/errors.js';
import type { Config } from '../core/config.js';
import type { Repos } from '../db/repos/index.js';
import type { EventRecord } from '../db/repos/events.js';
import type { ModelGateway } from '../model/gateway.js';
import { runAgent } from '../model/agent-loop.js';
import { assembleSystemPrompt, fenceUntrusted } from '../prompts/index.js';
import { nowIso } from '../core/time.js';
import type { MemoryAgent } from './agent.js';
import type { ChatStreamHub } from '../chat/stream.js';

const l = log('distill');

const DistillOutput = z.object({
  title: z.string(),
  memories: z
    .array(
      z.object({
        type: z.enum(['fact', 'preference', 'note', 'reference']),
        name: z.string(),
        description: z.string(),
        content: z.string(),
        project: z.string().nullable(),
      }),
    )
    .default([]),
});

/** App. H.4 output grammar. */
const DISTILL_SCHEMA = {
  name: 'distillation',
  schema: {
    type: 'object',
    properties: {
      title: {
        type: 'string',
        description: 'at most 60 characters, for the conversation list',
      },
      memories: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            type: { type: 'string', enum: ['fact', 'preference', 'note', 'reference'] },
            name: {
              type: 'string',
              description: 'short kebab-case identifier, at most 60 chars — never a sentence',
            },
            description: { type: 'string' },
            content: { type: 'string' },
            project: {
              type: ['string', 'null'],
              description: "one of the conversation's loaded islands, or null for general",
            },
          },
          required: ['type', 'name', 'description', 'content', 'project'],
          additionalProperties: false,
        },
      },
    },
    required: ['title', 'memories'],
    additionalProperties: false,
  },
};

export interface DistillDeps {
  repos: Repos;
  config: Config;
  gateway: ModelGateway;
  memory: MemoryAgent;
  stream: ChatStreamHub;
}

/**
 * The distillation pass (§8.2): when a conversation is archived or has gone
 * quiet, ask what — if anything — is worth keeping. Runs at `background`
 * priority, because nobody is waiting for it, and most conversations yield
 * nothing.
 */
export class DistillExecutor {
  constructor(private readonly deps: DistillDeps) {}

  async handle(event: EventRecord): Promise<void> {
    const { repos, config, gateway, memory, stream } = this.deps;
    const payload = z
      .object({
        conversation_id: z.string(),
        turn_count: z.number().optional(),
        // The delta boundary (§8.2, App. B). Optional so events queued before
        // the field existed still distil — once, over the whole transcript.
        since: z.string().nullable().optional(),
      })
      .parse(event.payload);

    const conversation = repos.conversations.get(payload.conversation_id);
    if (!conversation) return;
    // Delta-only (§8.2): a fact the distiller never re-sees is a fact it
    // cannot re-file, which is the duplication gate the dedupe pass is not.
    const turns = repos.conversations.history(payload.conversation_id, {
      limit: 200,
      ...(payload.since ? { after: payload.since } : {}),
    });
    if (turns.length === 0) return;

    const runId = repos.runs.create({ kind: 'distill', eventId: event.id });
    const trace = repos.trace.sink({ eventId: event.id, runId });
    // The *display* transcript on purpose (§20.2): distillation is looking for
    // facts worth keeping, and the narration a run produced on its way to an
    // answer often carries them. This is not context reconstruction.
    const transcript = turns.map((t) => `${t.role}: ${t.text}`).join('\n\n');

    const loaded = repos.conversations.loadedProjects(conversation.id);
    // What is already remembered, in scope (§8.2): names and descriptions
    // only, never content — enough to recognise a repeat, too little to leak.
    const known = memory
      .list()
      .filter((m) => m.project === null || loaded.includes(m.project))
      .map((m) => `- ${m.name}: ${m.description}`)
      .join('\n');
    const scopes = loaded.length
      ? `Loaded projects — the only valid \`project\` values besides null: ${loaded.join(', ')}.`
      : 'No projects are loaded: every memory must use `project: null`.';
    const remembered = known
      ? `Already remembered — do not propose these again:\n${known}`
      : 'Nothing is remembered yet.';

    try {
      const result = await runAgent(gateway, {
        // `best`, deliberately (§10.6): background priority makes the latency
        // free, and what-is-worth-keeping is the judgment being paid for.
        selector: { class: 'best', caps: ['json'] },
        priority: 'background',
        system: assembleSystemPrompt({
          kind: 'distill',
          identity: config.identity(),
          personality: config.personality(),
          now: nowIso(),
        }),
        messages: [
          {
            role: 'user',
            content: `A conversation has come to a rest. Decide what is worth remembering.\n\n${scopes}\n\n${remembered}\n\n${fenceUntrusted(
              'chat.conversation',
              transcript,
            )}`,
          },
        ],
        trace,
        budgets: { maxTurns: 1, timeoutS: 300 },
        jsonSchema: DISTILL_SCHEMA,
      });

      const parsed = DistillOutput.safeParse(JSON.parse(result.text.trim()));
      if (!parsed.success)
        throw new Error(`distillation output was not usable: ${result.text.slice(0, 200)}`);

      // Only name the unnamed. An idle pass runs on a conversation the user may
      // still have open in front of them; renaming it under them is worse than
      // keeping the title the opening exchange earned it.
      if (parsed.data.title && !conversation.title) {
        const title = parsed.data.title.slice(0, 60);
        repos.conversations.setTitle(conversation.id, title);
        stream.titled({ conversationId: conversation.id, title });
      }
      // The model scopes each fact, the server keeps the authority (§31.5):
      // only an island this conversation actually loaded is honored, so a
      // transcript can suggest a tag but never mint one. An invalid name
      // falls back to the most recently loaded island — misfiles leak into
      // containment, never general-ward, because general is the one scope no
      // read filter can undo.
      const fallback = loaded.at(-1) ?? null;
      let saved = 0;
      for (const memoryInput of parsed.data.memories) {
        const project =
          memoryInput.project === null
            ? null
            : loaded.includes(memoryInput.project)
              ? memoryInput.project
              : fallback;
        await memory.save({
          type: memoryInput.type,
          name: memoryInput.name,
          description: memoryInput.description,
          content: memoryInput.content,
          reason: `distilled from a conversation on ${nowIso().slice(0, 10)}`,
          project,
        });
        saved += 1;
      }
      repos.runs.finish(runId, {
        status: 'done',
        turns: result.turns,
        tokensIn: result.tokensIn,
        tokensOut: result.tokensOut,
        model: result.endpoint || null,
      });
      l.info({ conversation: conversation.id, saved }, 'conversation distilled');
    } catch (e) {
      repos.runs.finish(runId, { status: 'failed', error: errMessage(e) });
      trace.append('error', { message: errMessage(e) });
      throw e;
    }
  }
}

export { DISTILL_SCHEMA };
