import type { ModelMessage } from 'ai';
import { z } from 'zod';
import { errMessage, UserFacingError } from '../core/errors.js';
import { log } from '../core/logger.js';
import type { Config } from '../core/config.js';
import type { BackgroundTasks } from '../core/background.js';
import type { Repos } from '../db/repos/index.js';
import type { EventRecord } from '../db/repos/events.js';
import { runAgent } from '../model/agent-loop.js';
import type { ModelGateway } from '../model/gateway.js';
import type { ModelCap, ModelEffort, ModelSelector, RunKind } from '../model/types.js';
import { GrantedDispatcher, type Grants } from '../tools/dispatcher.js';
import { PagedDispatcher } from '../tools/paged.js';
import type { RunGrants } from '../tools/run-grants.js';
import type { GrantStore } from '../tools/grants.js';
import type { ToolHub } from '../tools/hub.js';
import { assembleSystemPrompt, fenceMemoryRecall } from '../prompts/index.js';
import type { ProjectStore } from '../projects/store.js';
import type { RagIndex } from '../rag/index-store.js';
import type { TurnsIndex } from '../rag/turns-index.js';
import type { UploadStore } from '../uploads/store.js';
import type { ConfirmBroker } from '../exec/confirm.js';
import { toModelMessages, type ImageContext } from './history.js';
import type { ChatStreamHub } from './stream.js';
import { suggestTitle } from './title.js';

const l = log('chat');

export const ChatMessagePayload = z.object({
  conversation_id: z.string().min(1),
  text: z.string(),
  /** Metadata only (§26.2): the bytes are read from the store at assembly. */
  attachments: z
    .array(
      z.object({
        upload_id: z.string().min(1),
        name: z.string(),
        mime: z.string(),
        bytes: z.number().int().nonnegative(),
      }),
    )
    .optional(),
});

/** Onboarding gets exactly the tools it needs to write its own config (App. F.7). */
export const ONBOARDING_GRANTS = [
  'config.read',
  'config.write',
  // The "want your phone connected?" step (F.7, §24.3). Create-blind, so
  // widening onboarding's grant does not widen what it can see.
  'setup.token_create',
] as const;

export interface ChatExecutorDeps {
  repos: Repos;
  config: Config;
  gateway: ModelGateway;
  tools: ToolHub;
  stream: ChatStreamHub;
  /** Auto-retrieved memory (§5.4); absent before the RAG layer exists. */
  rag?: RagIndex;
  /** The project roster and the conversation's loaded islands (§31). */
  projects?: ProjectStore;
  /** The history corpus (§25). Never auto-retrieved — only indexed here. */
  history?: TurnsIndex;
  /** Chat attachments (§26). Absent means images degrade to their markers. */
  uploads?: UploadStore;
  /** Absent means confirm-tier tools are denied outright. */
  confirm?: ConfirmBroker;
  /** Access the user granted at runtime (§19); absent means the configured set only. */
  grants?: GrantStore;
  /** Where this run's grant set is published for the length of the run (§23.2). */
  runGrants?: RunGrants;
  /** Tracks work nobody waits for, so it finishes before shutdown. */
  background: BackgroundTasks;
}

/**
 * A chat turn is an event like any other (§9): it just skips the applicability
 * gate and runs at interactive priority. Everything below this — agent loop,
 * tools, traces — is the same machinery handlers use.
 */
export class ChatExecutor {
  constructor(private readonly deps: ChatExecutorDeps) {}

  /** Does any endpoint accept image parts (§10.2, §26.3)? */
  private canSee(gateway: ChatExecutorDeps['gateway']): boolean {
    try {
      gateway.router.pick({ class: 'best', caps: ['vision'] });
      return true;
    } catch {
      return false;
    }
  }

  async handle(event: EventRecord): Promise<void> {
    const { repos, config, gateway, tools, stream } = this.deps;
    const startedAt = Date.now();
    /**
     * Two ways in. Usually a `chat.message`: somebody typed something. But the
     * §3c greeting arrives as `system.onboarding_ready` and has no user turn at
     * all — the assistant speaks first, which is the one run in the system that
     * answers nobody.
     */
    const greeting = event.type === 'system.onboarding_ready';
    const payload = greeting ? null : ChatMessagePayload.parse(event.payload);
    const conversation = greeting
      ? // Reuse an empty onboarding conversation rather than adding to a litter
        // of them: a greeting that failed to land left one behind, and the
        // retry belongs in the same place.
        (repos.conversations.onboardingConversation() ??
        repos.conversations.create({ mode: 'onboarding' }))
      : (repos.conversations.get(payload!.conversation_id) ??
        repos.conversations.create({ id: payload!.conversation_id }));

    // At-least-once delivery means this can be a retry: don't double-record.
    if (payload && !repos.conversations.turnForEvent(event.id)) {
      repos.conversations.addTurn({
        conversationId: conversation.id,
        role: 'user',
        text: payload.text,
        eventId: event.id,
        ...(payload.attachments?.length ? { attachments: payload.attachments } : {}),
      });
    }

    const onboarding = conversation.mode === 'onboarding';
    const kind: RunKind = onboarding ? 'onboarding' : 'chat';
    const runId = repos.runs.create({ kind, eventId: event.id });
    const trace = repos.trace.sink({ eventId: event.id, runId });

    const toolCtx = {
      runId,
      eventId: event.id,
      conversationId: conversation.id,
    };
    /**
     * Resolved per turn, not once per run: a run can install an MCP server or
     * be granted access to one part-way through, and the point of doing that
     * mid-conversation is to use the result in the same conversation (§19).
     */
    const grantsFor = (): Grants => {
      if (onboarding) return { tools: [...ONBOARDING_GRANTS] };
      const configured = {
        tools: config.settings.chatTools,
        confirm: config.settings.chatConfirm,
      };
      return this.deps.grants ? this.deps.grants.merged(configured) : configured;
    };
    const granted = new GrantedDispatcher(
      () => tools.handles(),
      grantsFor,
      toolCtx,
      this.deps.confirm
        ? (call, handle) => this.deps.confirm!.request(call, handle, toolCtx)
        : undefined,
    );
    /**
     * Tool paging (§21.2), chat only: onboarding's whole grant is two `config`
     * tools, and handler runs are single-shot with small explicit grants —
     * paging either would cost a turn to buy back nothing. Wrapping, never
     * folding in: `granted` stays the enforcement point, and the paged view can
     * only ever hide what it already allows.
     */
    const paged = onboarding
      ? null
      : new PagedDispatcher(granted, {
          core: config.settings.chatCoreNamespaces,
          store: {
            opened: () => repos.conversations.openNamespaces(conversation.id),
            // Write-through on every open: the point of a sticky open set is
            // that the *next* message still has the tools, and a run that
            // crashes after opening one has still learned something.
            open: (namespace) => {
              repos.conversations.openNamespace(conversation.id, namespace);
            },
          },
          describe: (namespace) => tools.describeNamespace(namespace),
          // A namespace's same-named skill arrives WITH the open (§21.2.3):
          // guaranteed loading, once per conversation, instead of a
          // "read the skill first" rule the model can (and did) skip.
          skillFor: (namespace) => {
            const skill = tools.skills.get(namespace);
            return skill ? { name: skill.name, content: skill.body } : null;
          },
        });
    const dispatcher = paged ?? granted;

    // Auto-push the memories that look relevant to this turn (§5.4); the model
    // can still pull more with memory.query.
    let memories: { name: string; description: string; content: string }[] = [];
    // `payload` is implied by `!onboarding` — a greeting is always an onboarding
    // run — but saying so keeps the invariant checked rather than assumed.
    if (this.deps.rag && !onboarding && payload) {
      try {
        const retrieved = await this.deps.rag.retrieve(
          payload.text,
          config.settings.memoryTopK,
          // Auto-retrieval is scoped like every other retrieval (§31.3) — it
          // is the path that would otherwise inject project facts into
          // unrelated conversations without anyone asking.
          repos.conversations.loadedProjects(conversation.id),
        );
        memories = retrieved.hits.map((h) => ({
          name: h.name,
          description: h.description,
          content: h.content,
        }));
        if (memories.length) {
          stream.activity({
            conversationId: conversation.id,
            runId,
            activity: { kind: 'recalled', count: memories.length, mode: retrieved.mode },
          });
          trace.append('state', {
            from: null,
            to: 'memory_retrieved',
            mode: retrieved.mode,
            count: memories.length,
          });
        }
      } catch (e) {
        l.warn({ err: (e as Error).message }, 'memory retrieval failed; continuing without it');
      }
    }

    const identity = config.identity();
    const personality = config.personality();
    // Conversation-stable material only (§20.5): base prompt, identity, skill
    // roster, closed-namespace catalog. Anything that changes per message goes
    // at the tail instead, or llama.cpp reprocesses the whole conversation on
    // every turn.
    //
    // Re-derived per turn rather than built once, for the single mid-run change
    // there is: `tools.open` moves a namespace out of the catalog and into the
    // tool definitions, and the two must not disagree about it. Both live at
    // the prompt head, so it is one bust, not two.
    const system = () =>
      assembleSystemPrompt({
        kind,
        identity,
        personality,
        // Description-only roster; bodies are fetched via skills.fetch (§11.1).
        skills: onboarding ? [] : tools.skills.roster(),
        // What islands exist (§31.2). Names and one line each — the contents
        // arrive only through project.load, in the conversation, on the record.
        ...(onboarding || !this.deps.projects ? {} : { projects: this.deps.projects.roster() }),
        // One line per closed namespace (§21.2.2). Empty once everything
        // granted is open, and absent entirely for onboarding.
        ...(paged ? { toolCatalog: paged.catalog() } : {}),
      });

    const history = repos.conversations.history(conversation.id, {
      limit: config.settings.chatContextTurns,
    });
    /**
     * Images ride only when an endpoint can actually look at them (§26.3).
     * Asking the router first means the honest bracket — "you cannot see it" —
     * is chosen by what this install has, not by hope; and reading the bytes
     * here, at assembly time, is what keeps them out of every other layer.
     */
    const wantsVision = history.some((t) => t.attachments.length > 0);
    const visionEndpoint = wantsVision && this.canSee(gateway);
    const images: ImageContext | null =
      visionEndpoint && this.deps.uploads
        ? {
            window: config.settings.imageContextTurns,
            read: (attachment) => {
              const row = this.deps.uploads!.repo.get(attachment.upload_id);
              return row ? this.deps.uploads!.read(row) : null;
            },
          }
        : null;
    // Model context, not the display transcript (§20.2): each assistant turn
    // contributes its final answer plus the names of the tools it used.
    const messages: ModelMessage[] = toModelMessages(history, images);
    if (greeting && !messages.length) {
      /**
       * The greeting has no history to send, and a request with no messages at
       * all is not something every OpenAI-compatible endpoint accepts. So the
       * triggering event goes in the user slot — exactly what a handler run
       * does with the event that woke it (`exec/executor.ts`), and for the same
       * reason: the run needs to be told what happened, and the system prompt
       * is conversation-stable material only (§20.5).
       *
       * System-authored, so unfenced (H.2): no external content reaches here.
       */
      messages.push({
        role: 'user',
        content:
          'You have just been installed and nobody has said anything to you yet. ' +
          'Open the conversation yourself, following your instructions above.',
      });
    }
    if (memories.length) {
      // Immediately before the latest user message, so the prefix up to the
      // previous exchange stays byte-stable (§20.5).
      const at = messages.at(-1)?.role === 'user' ? messages.length - 1 : messages.length;
      messages.splice(at, 0, { role: 'user', content: fenceMemoryRecall(memories) });
    }

    const wantsTools = granted.granted().length > 0;
    const caps: ModelCap[] = wantsTools ? ['tools'] : [];
    if (visionEndpoint) caps.push('vision');
    /**
     * §10.6 step 1: a conversation's override wins **absolutely** — over
     * class and over the capability filter. The user forcing a model is the
     * confirmation; the selector labels endpoints missing `tools` so the
     * choice is informed rather than gated. An override naming an endpoint
     * that has since left models.yaml clears itself, with a notice, rather
     * than killing the conversation.
     */
    let selector: ModelSelector = { class: 'best', caps, resolvedBy: 'kind_default' };
    const override = conversation.model_override;
    if (override) {
      if (gateway.router.byName(override)) {
        selector = { endpoint: override, resolvedBy: 'override' };
      } else {
        repos.conversations.setModelOverride(conversation.id, null);
        stream.failed({
          conversationId: conversation.id,
          message: `the model "${override}" is no longer configured — using the default again`,
        });
        l.warn(
          { conversation: conversation.id, endpoint: override },
          'stale model override cleared',
        );
      }
    }
    if (!override || selector.resolvedBy !== 'override') {
      try {
        gateway.router.pick(selector);
      } catch (e) {
        if (!(e instanceof UserFacingError) || e.code !== 'no_endpoint' || !wantsTools) throw e;
        // Honest degradation (plan §3b): no tool-capable endpoint means chat
        // without tools, not chat that fails.
        l.warn({ err: e.message }, 'no tool-capable endpoint; running chat without tools');
        selector = { class: 'best', resolvedBy: 'kind_default' };
      }
    }
    // An override may point at an endpoint with no `tools` cap; the tools go
    // quiet rather than the turn failing (§10.6: informed, not gated).
    const chosen = gateway.router.pick(selector);
    const toolsAvailable = wantsTools && chosen.caps.includes('tools');

    /**
     * The reasoning level rides the same surface and clears the same way
     * (§10.6). Checked against the endpoint that actually resolved: a level
     * the serving model never declared is stale in exactly the way a vanished
     * endpoint is, and the parameter must never be sent unguessed.
     */
    const effort = conversation.effort_override;
    if (effort) {
      if (chosen.efforts?.some((e) => e === effort)) {
        selector = { ...selector, effort: effort as ModelEffort };
      } else {
        repos.conversations.setEffortOverride(conversation.id, null);
        stream.failed({
          conversationId: conversation.id,
          message: `${chosen.name} does not offer "${effort}" reasoning — using its own default again`,
        });
        l.warn(
          { conversation: conversation.id, endpoint: chosen.name, effort },
          'stale effort override cleared',
        );
      }
    }

    /**
     * Published for the length of the loop, and only that long (§23.2):
     * `embeds.bind` has to know what this run may call, and the inner
     * dispatcher is the only thing that actually knows. Deliberately not the
     * paged wrapper — what can be bound must not depend on which namespaces
     * happen to be open this turn.
     */
    const releaseGrants = this.deps.runGrants?.register(runId, granted);
    let result;
    try {
      result = await runAgent(gateway, {
        selector,
        priority: 'interactive',
        // Long tool-heavy runs otherwise carry every result to the end (§20.4).
        elision: {
          thresholdChars: config.settings.elideThresholdChars,
          afterTurns: config.settings.elideAfterTurns,
        },
        futileThreshold: config.settings.futileStreakThreshold,
        system,
        messages,
        ...(toolsAvailable ? { dispatcher } : {}),
        budgets: {
          maxTurns: config.settings.chatMaxTurns,
          maxTokens: config.settings.chatMaxTokens,
          timeoutS: config.settings.chatTimeoutS,
        },
        trace,
        onDelta: (text) => stream.delta({ conversationId: conversation.id, runId, text }),
        // The guard rejected a turn that was already on its way out (§20.8).
        onRetract: () => stream.retract({ conversationId: conversation.id, runId }),
        onActivity: (activity) =>
          stream.activity({ conversationId: conversation.id, runId, activity }),
      });
    } finally {
      releaseGrants?.();
    }

    // Everything it said this run, not just the final turn: the user watched it
    // all stream past, so all of it belongs in the transcript.
    const text = result.assistantText.trim() || result.text.trim();
    // A run cut short by a budget has usually still said something useful.
    // Throwing that away and showing only an error is the worse failure.
    const cutShort = result.stopReason !== 'stop' && text.length > 0;
    const failed = text.length === 0;

    repos.runs.finish(runId, {
      status: failed || cutShort ? 'failed' : 'done',
      turns: result.turns,
      tokensIn: result.tokensIn,
      tokensOut: result.tokensOut,
      model: result.endpoint || null,
      error: failed
        ? (result.error ?? 'empty response')
        : cutShort
          ? (result.error ?? `stopped: ${result.stopReason}`)
          : null,
    });

    if (failed) {
      const message = result.error ?? 'the model returned nothing';
      // Chat failures are reported in-band. A retry an hour later would answer
      // a question the user has long since re-asked, so the event is complete.
      stream.failed({ conversationId: conversation.id, message });
      l.warn({ conversation: conversation.id, stop: result.stopReason }, 'chat turn failed');
      return;
    }

    const turn = repos.conversations.addTurn({
      conversationId: conversation.id,
      role: 'assistant',
      // Display gets everything spoken; model context gets the final answer
      // and the tool names (§20.2).
      text,
      contextText: result.contextText.trim() || text,
      toolsUsed: result.toolsUsed,
      runId,
    });
    stream.done({ conversationId: conversation.id, runId, turnSeq: turn.seq });
    if (cutShort) {
      // Keep the answer, but say plainly that it is unfinished and why.
      stream.failed({
        conversationId: conversation.id,
        message: `answer cut short (${result.stopReason})${
          result.stopReason === 'max_tokens'
            ? ' — raise chat.max_tokens in config/turminder.yaml'
            : result.stopReason === 'timeout'
              ? ' — raise chat.timeout_s in config/turminder.yaml'
              : ''
        }`,
      });
      l.warn(
        {
          conversation: conversation.id,
          stop: result.stopReason,
          turns: result.turns,
          prompt_tokens: result.promptTokens,
          output_tokens: result.tokensOut,
        },
        'chat turn cut short but kept',
      );
    }

    // What this turn cost, and how full the window is (shown under the input).
    const total = repos.runs.tokensForConversation(conversation.id);
    let contextSize: number | null = null;
    try {
      contextSize = gateway.router.pick(selector).contextSize ?? null;
    } catch {
      /* the endpoint went away between the run and now; not worth failing over */
    }
    // The ledger is a query over stamped rows (§10.5), so "what did this cost"
    // is answered from the same numbers the trace shows, not a running total
    // somebody has to keep correct.
    const runCost = repos.trace.costForRuns([runId]);
    const conversationRunIds = repos.runs.idsForConversation(conversation.id);
    const conversationCost = repos.trace.costForRuns(conversationRunIds);
    // Mixed currencies in one conversation are possible (two providers); the
    // frame reports the run's own currency and sums only that one.
    const currency = runCost[0]?.currency ?? conversationCost[0]?.currency ?? null;
    const cost = currency
      ? {
          run: runCost.find((c) => c.currency === currency)?.cost ?? 0,
          conversation: conversationCost.find((c) => c.currency === currency)?.cost ?? 0,
          currency,
        }
      : null;

    stream.usage({
      conversationId: conversation.id,
      runId,
      model: result.endpoint,
      turns: result.turns,
      // Pressure, not billing (§21.1): the peak single prompt is what has to
      // fit in the window; the sum across turns is what the work cost.
      contextUsed: result.promptTokens,
      promptEvaluated: result.promptEvaluated,
      billedWithTimings: result.billedWithTimings,
      tokensIn: result.tokensIn,
      tokensOut: result.tokensOut,
      contextSize,
      conversationTokensIn: total.tokensIn,
      conversationTokensOut: total.tokensOut,
      cost,
      durationMs: Date.now() - startedAt,
      queueWaitMs: 0,
    });

    // Both of this run's turns join the history corpus (§25) — after the run,
    // at background priority, because indexing is never on the path between a
    // question and its answer.
    const turns = this.deps.history;
    if (turns) this.deps.background.run('history:index', () => turns.indexNew());

    // Name the conversation from its opening exchange, once. Fire and forget:
    // it runs at background priority and must not hold the conversation's
    // serialization key, or the next message would queue behind a cosmetic call.
    const current = repos.conversations.get(conversation.id);
    // Not for the greeting: titling reads the opening *exchange*, and there is
    // no user half of it yet. The next turn is still untitled, so it gets one
    // then — from a real exchange.
    if (!current?.title && payload) {
      this.deps.background.run('chat:title', () =>
        this.titleLater(conversation.id, payload.text, text),
      );
    }

    // Onboarding ends when identity.md exists; from then on this is a normal chat.
    if (onboarding) {
      config.reload();
      if (config.identity()) {
        repos.conversations.setMode(conversation.id, 'normal');
        stream.mode({ conversationId: conversation.id, mode: 'normal' });
        l.info({ conversation: conversation.id }, 'onboarding complete');
      }
    }
  }

  /** Titles a conversation out of band, and never lets that failure matter. */
  private async titleLater(
    conversationId: string,
    userText: string,
    assistantText: string,
  ): Promise<void> {
    const { repos, gateway, stream } = this.deps;
    const runId = repos.runs.create({ kind: 'maintenance' });
    const trace = repos.trace.sink({ runId });
    try {
      const result = await suggestTitle(gateway, { userText, assistantText, trace });
      const finish = {
        status: 'done' as const,
        turns: result.turns,
        tokensIn: result.tokensIn,
        tokensOut: result.tokensOut,
        model: result.model,
      };
      // Re-check: a distillation pass may have named it in the meantime.
      if (!result.title || repos.conversations.get(conversationId)?.title) {
        repos.runs.finish(runId, finish);
        return;
      }
      repos.conversations.setTitle(conversationId, result.title);
      stream.titled({ conversationId, title: result.title });
      repos.runs.finish(runId, finish);
      l.info({ conversation: conversationId, title: result.title }, 'named the conversation');
    } catch (e) {
      repos.runs.finish(runId, { status: 'failed', error: errMessage(e) });
    }
  }
}

export function chatFailureMessage(e: unknown): string {
  return errMessage(e);
}
