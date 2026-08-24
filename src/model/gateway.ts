import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import {
  NoSuchToolError,
  generateText,
  streamText,
  stepCountIs,
  type LanguageModel,
  type ModelMessage,
  type ToolSet,
} from 'ai';
import { log } from '../core/logger.js';
import { ThinkFilter, stripThink } from './reasoning.js';
import { timingsFetch, withTimings, type TimingsSlot } from './timings.js';
import type { InferenceScheduler } from './scheduler.js';
import type { ModelRouter } from './router.js';
import {
  callCost,
  nullTraceSink,
  type AgentActivity,
  type LlmCallTrace,
  type ModelSelector,
  type Priority,
  type ResolvedEndpoint,
  type TraceSink,
} from './types.js';

const l = log('model');

export interface JsonSchemaSpec {
  name: string;
  schema: Record<string, unknown>;
}

export interface TurnRequest {
  selector: ModelSelector;
  priority: Priority;
  system: string;
  messages: ModelMessage[];
  tools?: ToolSet;
  maxOutputTokens?: number;
  temperature?: number;
  abortSignal?: AbortSignal;
  trace?: TraceSink;
  /** JSON-constrained output; llama.cpp compiles the schema to a GBNF grammar. */
  jsonSchema?: JsonSchemaSpec;
  /** Raw GBNF grammar (llama.cpp only), for cases a JSON schema cannot express. */
  grammar?: string;
  /** Present => stream, and deltas are pushed here as they arrive. */
  onDelta?: (text: string) => void;
  /**
   * Reasoning deltas, for live "thinking" feedback (§20.1.1). Transient by
   * construction: reasoning never reaches `text`, `messages`, or `turns`.
   */
  onReasoning?: (text: string) => void;
  /** Progress feedback for whoever is watching (chat UI). */
  onActivity?: (activity: AgentActivity) => void;
}

export interface RawToolCall {
  toolCallId: string;
  toolName: string;
  input: unknown;
  /** Unparsable arguments or a tool that does not exist. */
  invalid: boolean;
  /**
   * The name was not in the definitions we rendered. Distinct from malformed
   * arguments because the two want opposite handling: a name the SDK does not
   * know may still be a tool the *dispatcher* knows — granted but paged out
   * (§21.2.4) — so this one goes to the dispatcher rather than back as a
   * correction. It is also the only way F.7.3's `not_granted` refusal is ever
   * reached by a real model.
   */
  unknownTool: boolean;
  error?: string;
}

export interface TurnResult {
  /** Reasoning-stripped (§20.1). Safe to persist, safe to re-feed. */
  text: string;
  /**
   * Prompt tokens the endpoint actually evaluated, from llama.cpp `timings`
   * (§21.1). Undefined when the endpoint reports none — the honest answer, and
   * the reason the whole feature is best-effort.
   */
  promptEvaluated?: number;
  /** How much reasoning this turn produced. Metrics only — never stored. */
  reasoningChars: number;
  toolCalls: RawToolCall[];
  tokensIn: number;
  tokensOut: number;
  finishReason: string;
  endpoint: ResolvedEndpoint;
  queueWaitMs: number;
  durationMs: number;
}

export interface GatewayOptions {
  /** Injected for tests; defaults to global fetch. */
  fetch?: typeof globalThis.fetch;
  /** llama.cpp prompt cache reuse across calls (§10.3). */
  cachePrompt?: boolean;
}

/**
 * The single door to every LLM endpoint (§10). Nothing else in the system
 * constructs a model client, so priority, queue-wait measurement, and the
 * llm_call trace row cannot be bypassed.
 */
export class ModelGateway {
  private readonly plainModels = new Map<string, LanguageModel>();
  /**
   * The one fetch every model client goes through — the seam §21.1 harvests
   * llama.cpp `timings` from. Built once so the wrapper is not re-created per
   * model, and applied even when no fetch was injected, because the capture is
   * not a test concern.
   */
  private readonly fetchImpl: typeof globalThis.fetch;

  constructor(
    readonly router: ModelRouter,
    private readonly scheduler: InferenceScheduler,
    private readonly opts: GatewayOptions = {},
  ) {
    this.fetchImpl = timingsFetch(opts.fetch ?? ((...args) => globalThis.fetch(...args)));
  }

  private buildModel(ep: ResolvedEndpoint, extraBody?: Record<string, unknown>): LanguageModel {
    const cachePrompt = this.opts.cachePrompt ?? true;
    const provider = createOpenAICompatible({
      name: ep.name,
      baseURL: ep.url,
      includeUsage: true,
      supportsStructuredOutputs: true,
      ...(ep.apiKey ? { apiKey: ep.apiKey } : {}),
      fetch: this.fetchImpl,
      transformRequestBody: (body) => ({
        ...body,
        ...(cachePrompt ? { cache_prompt: true } : {}),
        ...(extraBody ?? {}),
      }),
    });
    return provider.chatModel(ep.model);
  }

  private model(ep: ResolvedEndpoint, extraBody?: Record<string, unknown>): LanguageModel {
    if (extraBody) return this.buildModel(ep, extraBody);
    const cached = this.plainModels.get(ep.name);
    if (cached) return cached;
    const m = this.buildModel(ep);
    this.plainModels.set(ep.name, m);
    return m;
  }

  /**
   * One model call: routed, queued, traced. Multi-turn control lives in the
   * agent loop (§10.4), not here — this is deliberately a single step.
   */
  async turn(req: TurnRequest): Promise<TurnResult> {
    const ep = this.router.pick(req.selector);
    const extraBody = buildExtraBody(req, ep);
    const model = this.model(ep, extraBody);
    const trace = req.trace ?? nullTraceSink;

    return this.scheduler.run({
      endpoint: ep.name,
      priority: req.priority,
      concurrency: ep.concurrency,
      ...(req.abortSignal ? { abortSignal: req.abortSignal } : {}),
      ...(req.onActivity
        ? { onQueued: () => req.onActivity?.({ kind: 'queued', priority: req.priority }) }
        : {}),
      fn: async ({ queueWaitMs }) => {
        const started = Date.now();
        // The wrapped fetch writes into this (§21.1). One slot per call, so a
        // second concurrent call on the same endpoint cannot land in it.
        const timings: TimingsSlot = {};
        const common = {
          model,
          system: req.system,
          messages: req.messages,
          stopWhen: stepCountIs(1),
          maxRetries: 1,
          ...(req.tools && Object.keys(req.tools).length ? { tools: req.tools } : {}),
          ...(req.maxOutputTokens ? { maxOutputTokens: req.maxOutputTokens } : {}),
          ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
          ...(req.abortSignal ? { abortSignal: req.abortSignal } : {}),
        } as const;

        let text: string;
        let reasoningChars: number;
        let rawToolCalls: unknown[];
        let usageIn: number | undefined;
        let usageOut: number | undefined;
        let finishReason: string;

        try {
          // The whole interaction runs inside the timings scope, not just the
          // call that starts it: `streamText` issues its request lazily, when
          // the stream below is first read.
          const settled = await withTimings(timings, async () => {
            if (req.onDelta) {
              const r = streamText(common);
              // fullStream rather than textStream: an endpoint that extracts
              // think blocks itself puts them on the reasoning channel, and that
              // is where the live feedback comes from.
              const filter = new ThinkFilter();
              let acc = '';
              let reasoning = 0;
              for await (const part of r.fullStream) {
                if (part.type === 'reasoning-delta') {
                  reasoning += part.text.length;
                  req.onReasoning?.(part.text);
                  continue;
                }
                if (part.type !== 'text-delta') continue;
                // Defence in depth for endpoints that leave think blocks inline
                // (unrecognised chat template, --reasoning-format none).
                const visible = filter.push(part.text);
                if (visible) {
                  acc += visible;
                  req.onDelta(visible);
                }
              }
              const tail = filter.flush();
              if (tail) {
                acc += tail;
                req.onDelta(tail);
              }
              const usage = await r.usage;
              return {
                text: acc,
                reasoningChars: reasoning + filter.suppressed,
                rawToolCalls: (await r.toolCalls) as unknown[],
                usageIn: usage.inputTokens,
                usageOut: usage.outputTokens,
                finishReason: await r.finishReason,
              };
            }
            const r = await generateText(common);
            const stripped = stripThink(r.text);
            if (r.reasoningText) req.onReasoning?.(r.reasoningText);
            return {
              text: stripped,
              reasoningChars:
                (r.reasoningText?.length ?? 0) + (r.text.length - stripped.length),
              rawToolCalls: r.toolCalls as unknown[],
              usageIn: r.usage.inputTokens,
              usageOut: r.usage.outputTokens,
              finishReason: r.finishReason,
            };
          });
          ({ text, reasoningChars, rawToolCalls, usageIn, usageOut, finishReason } = settled);
        } catch (e) {
          const rec: LlmCallTrace = {
            model: ep.name,
            priority: req.priority,
            queue_wait_ms: queueWaitMs,
            duration_ms: Date.now() - started,
            tokens_in: 0,
            tokens_out: 0,
            stop_reason: 'error',
            endpoint: ep.name,
            ...(req.selector.class ? { requested_class: req.selector.class } : {}),
            ...(req.selector.resolvedBy ? { resolved_by: req.selector.resolvedBy } : {}),
          };
          trace.append('llm_call', rec);
          throw e;
        }

        const durationMs = Date.now() - started;
        const priced = callCost(ep, usageIn ?? 0, usageOut ?? 0);
        const rec: LlmCallTrace = {
          model: ep.name,
          priority: req.priority,
          queue_wait_ms: queueWaitMs,
          duration_ms: durationMs,
          tokens_in: usageIn ?? 0,
          tokens_out: usageOut ?? 0,
          stop_reason: finishReason,
          // The §10.6 routing decision, on every row: which endpoint served
          // this, what was asked for, and who decided.
          endpoint: ep.name,
          ...(req.selector.class ? { requested_class: req.selector.class } : {}),
          ...(req.selector.resolvedBy ? { resolved_by: req.selector.resolvedBy } : {}),
          // Stamped at call time (§10.5); absent for a costless endpoint.
          ...(priced ? { cost: priced.cost, currency: priced.currency } : {}),
          // Size only: the content itself is stored nowhere in v1 (§20.1.4).
          ...(reasoningChars ? { reasoning_chars: reasoningChars } : {}),
          // Absent unless the endpoint volunteered it (§21.1).
          ...(timings.promptEvaluated !== undefined
            ? { prompt_evaluated: timings.promptEvaluated }
            : {}),
        };
        trace.append('llm_call', rec);
        l.debug(rec, 'llm call');
        req.onActivity?.({
          kind: 'usage',
          turn: 0,
          tokens_in: usageIn ?? 0,
          tokens_out: usageOut ?? 0,
          ...(timings.promptEvaluated !== undefined
            ? { prompt_evaluated: timings.promptEvaluated }
            : {}),
          duration_ms: durationMs,
          queue_wait_ms: queueWaitMs,
          ...(ep.contextSize ? { context_size: ep.contextSize } : {}),
        });

        return {
          text,
          reasoningChars,
          ...(timings.promptEvaluated !== undefined
            ? { promptEvaluated: timings.promptEvaluated }
            : {}),
          toolCalls: rawToolCalls.map(normaliseToolCall),
          tokensIn: usageIn ?? 0,
          tokensOut: usageOut ?? 0,
          finishReason,
          endpoint: ep,
          queueWaitMs,
          durationMs,
        };
      },
    });
  }
}

/**
 * Request-body extras: output constraints, and the one routing parameter
 * (§10.6).
 *
 * `reasoning_effort` is sent only when a level was chosen **and** the endpoint
 * that actually serves this call declares it (G.2 `efforts:`). An endpoint
 * that has not said it understands the knob does not get handed it — its own
 * default stands, undeclared and unguessed — and the level is checked against
 * the *resolved* endpoint, not the one the chooser was looking at.
 */
function buildExtraBody(
  req: TurnRequest,
  ep: ResolvedEndpoint,
): Record<string, unknown> | undefined {
  const extra: Record<string, unknown> = {};
  if (req.grammar) extra.grammar = req.grammar;
  else if (req.jsonSchema) {
    extra.response_format = {
      type: 'json_schema',
      json_schema: { name: req.jsonSchema.name, schema: req.jsonSchema.schema, strict: true },
    };
  }
  const effort = req.selector.effort;
  if (effort && ep.efforts?.includes(effort)) extra.reasoning_effort = effort;
  return Object.keys(extra).length ? extra : undefined;
}

function normaliseToolCall(c: unknown): RawToolCall {
  const call = c as {
    toolCallId: string;
    toolName: string;
    input: unknown;
    invalid?: boolean;
    error?: unknown;
  };
  const out: RawToolCall = {
    toolCallId: call.toolCallId,
    toolName: call.toolName,
    input: call.input,
    invalid: call.invalid === true,
    unknownTool: call.invalid === true && NoSuchToolError.isInstance(call.error),
  };
  if (call.error !== undefined) {
    out.error = call.error instanceof Error ? call.error.message : String(call.error);
  }
  return out;
}
