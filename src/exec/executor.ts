import { log } from '../core/logger.js';
import { errMessage } from '../core/errors.js';
import type { Config } from '../core/config.js';
import type { Repos } from '../db/repos/index.js';
import type { EventRecord } from '../db/repos/events.js';
import { runAgent } from '../model/agent-loop.js';
import type { ModelGateway } from '../model/gateway.js';
import type { Budgets } from '../model/types.js';
import type { RagIndex } from '../rag/index-store.js';
import { GrantedDispatcher } from '../tools/dispatcher.js';
import type { RunGrants } from '../tools/run-grants.js';
import type { ConfirmBroker } from './confirm.js';
import type { ToolHub } from '../tools/hub.js';
import {
  assembleSystemPrompt,
  renderEventPayload,
  fenceMemoryRecall,
} from '../prompts/index.js';
import type { LoadedHandler } from './handlers.js';

const l = log('exec');

export interface HandlerExecutorDeps {
  repos: Repos;
  config: Config;
  gateway: ModelGateway;
  tools: ToolHub;
  /** Absent means confirm-tier tools are denied outright. */
  confirm?: ConfirmBroker;
  /** Where this run's grant set is published for the length of the run (§23.2). */
  runGrants?: RunGrants;
  rag?: RagIndex;
}

export interface HandlerOutcome {
  handler: string;
  runId: string;
  ok: boolean;
  error?: string;
  toolCalls: number;
}

/**
 * One agentic run per matched handler (§5.4). The event payload arrives fenced
 * as untrusted data, the dispatcher is built from the handler's own grant, and
 * budgets are enforced — on local inference a runaway loop starves everything
 * else on the GPU, so budgets are a liveness requirement, not hygiene.
 */
export class HandlerExecutor {
  constructor(private readonly deps: HandlerExecutorDeps) {}

  async run(event: EventRecord, handler: LoadedHandler): Promise<HandlerOutcome> {
    const { repos, config, gateway, tools } = this.deps;
    const settings = config.settings;
    const runId = repos.runs.create({
      kind: 'handler',
      eventId: event.id,
      handlerName: handler.name,
    });
    const trace = repos.trace.sink({ eventId: event.id, runId });

    const budgets: Budgets = {
      maxTurns: handler.frontmatter.budgets?.max_turns ?? settings.budgetMaxTurns,
      maxTokens: handler.frontmatter.budgets?.max_tokens ?? settings.budgetMaxTokens,
      timeoutS: handler.frontmatter.budgets?.timeout_s ?? settings.budgetTimeoutS,
    };

    const toolCtx = { runId, eventId: event.id, handlerName: handler.name };
    const dispatcher = new GrantedDispatcher(
      tools.handles(),
      { tools: handler.frontmatter.tools, confirm: handler.frontmatter.confirm },
      toolCtx,
      this.deps.confirm
        ? (call, handle) => this.deps.confirm!.request(call, handle, toolCtx)
        : undefined,
    );

    // Auto-retrieved memory against the event summary (§5.4).
    let memories: { name: string; description: string; content: string }[] = [];
    if (this.deps.rag) {
      try {
        const retrieved = await this.deps.rag.retrieve(
          event.summary ?? `${event.type} ${JSON.stringify(event.payload).slice(0, 500)}`,
          settings.memoryTopK,
        );
        memories = retrieved.hits.map((h) => ({
          name: h.name,
          description: h.description,
          content: h.content,
        }));
      } catch (e) {
        l.warn({ err: errMessage(e) }, 'memory retrieval failed; running without it');
      }
    }

    // Items 1–4 of the H.1 order only: base prompt, identity, skill roster,
    // tool definitions. Everything handler-specific rides message-side, which
    // makes the system prompt byte-identical for every handler run (§20.5).
    const system = assembleSystemPrompt({
      kind: 'handler',
      identity: config.identity(),
      personality: config.personality(),
      skills: tools.skills.roster(),
    });

    const payload = renderEventPayload(event, {
      maxChars: 20_000,
      userName: config.identity()?.frontmatter.user_name ?? null,
    });
    const message =
      `# Your instructions for this behaviour: ${handler.name}\n\n${handler.body}\n\n` +
      `---\n\nAn event arrived.\n\n` +
      `Envelope:\n- type: ${event.type}\n- source: ${event.source}\n` +
      `- occurred_at: ${event.occurred_at ?? event.received_at}\n` +
      `- event_id: ${event.id}\n` +
      (event.summary ? `- summary: ${event.summary}\n` : '') +
      `\nPayload:\n${payload}`;
    // H.1 items 5–7 in message order: memory, then the task, then the payload.
    const messages: { role: 'user'; content: string }[] = [
      ...(memories.length
        ? [{ role: 'user' as const, content: fenceMemoryRecall(memories) }]
        : []),
      { role: 'user' as const, content: message },
    ];

    // The handler's own grant, published for the length of the loop, so a
    // handler that binds data to an embed is held to what it may call (§23.2).
    const releaseGrants = this.deps.runGrants?.register(runId, dispatcher);
    let result;
    try {
      result = await runAgent(gateway, {
        /**
         * §10.6 step 2: a handler's frontmatter decides. An explicit
         * `endpoint:` pin bypasses class routing entirely (the behaviour that
         * must run local, or must run hosted); otherwise its `model_class`
         * applies — which defaults to `fast`, so a handler that says nothing
         * still resolves by the kind default rather than by accident.
         */
        selector: {
          ...(handler.frontmatter.endpoint
            ? { endpoint: handler.frontmatter.endpoint }
            : { class: handler.frontmatter.model_class }),
          // The reasoning level this behaviour asked for, if any (§10.6). The
          // gateway drops it when the serving endpoint does not declare it.
          ...(handler.frontmatter.effort ? { effort: handler.frontmatter.effort } : {}),
          ...(dispatcher.granted().length ? { caps: ['tools' as const] } : {}),
          resolvedBy: 'frontmatter' as const,
        },
        priority: 'event',
        // Long tool-heavy runs otherwise carry every result to the end (§20.4).
        elision: {
          thresholdChars: config.settings.elideThresholdChars,
          afterTurns: config.settings.elideAfterTurns,
        },
        futileThreshold: config.settings.futileStreakThreshold,
        system,
        messages,
        dispatcher,
        budgets,
        trace,
      });
    } finally {
      releaseGrants?.();
    }

    const ok = result.stopReason === 'stop';
    repos.runs.finish(runId, {
      status: ok ? 'done' : 'failed',
      turns: result.turns,
      tokensIn: result.tokensIn,
      tokensOut: result.tokensOut,
      model: result.endpoint || null,
      error: ok ? null : (result.error ?? result.stopReason),
    });

    l.info(
      {
        handler: handler.name,
        event: event.id,
        stop: result.stopReason,
        turns: result.turns,
        tools: result.toolCallCount,
      },
      ok ? 'handler run complete' : 'handler run failed',
    );

    return {
      handler: handler.name,
      runId,
      ok,
      toolCalls: result.toolCallCount,
      ...(ok ? {} : { error: result.error ?? `stopped: ${result.stopReason}` }),
    };
  }
}
