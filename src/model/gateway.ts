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
import { UserFacingError } from '../core/errors.js';
import { ThinkFilter, stripThink } from './reasoning.js';
import { wavSeconds } from './wav.js';
import { internalToolName, toWireMessages, toWireToolSet } from './tool-names.js';
import { timingsFetch, withTimings, type TimingsSlot } from './timings.js';
import type { InferenceScheduler } from './scheduler.js';
import type { ModelRouter } from './router.js';
import {
  callCost,
  nullTraceSink,
  speakCost,
  transcribeCost,
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

/** One transcription (§10.9): audio in, text out, priced by the second. */
export interface TranscribeRequest {
  audio: Uint8Array;
  /** What the bytes are. Only `audio/wav` is produced by anything we ship; the
   *  endpoint decides what else it will take. */
  mime: string;
  /**
   * The language to ask for, when the endpoint has not pinned one of its own
   * (G.2 `language:` wins). `auto` — from either source — means the parameter
   * is omitted and the transcriber detects (§10.9).
   */
  language?: string;
  priority: Priority;
  trace?: TraceSink;
  abortSignal?: AbortSignal;
}

export interface TranscribeResult {
  text: string;
  /** Seconds of audio sent, from the WAV header — what the call was priced by. */
  audioSeconds: number;
  endpoint: ResolvedEndpoint;
}

/** One synthesis (§10.9): text in, WAV out, priced by the thousand characters. */
export interface SpeakRequest {
  text: string;
  /**
   * Override the endpoint's configured voice, **for this call only** (§33.5):
   * the preview route has to make one sentence in a voice nobody has chosen
   * yet, without writing anything anywhere.
   */
  voice?: string;
  priority: Priority;
  trace?: TraceSink;
  abortSignal?: AbortSignal;
}

export interface SpeakResult {
  /**
   * The response body, unread. Handed over rather than buffered so the voice
   * adapter can start playing the first sentence while the rest renders
   * (§33.2) — the whole reason speech is streamed at all.
   */
  stream: ReadableStream<Uint8Array>;
  chars: number;
  endpoint: ResolvedEndpoint;
}

/** Speech calls get the tool-call ceiling, not the agent-loop one: a
 *  transcriber that has not answered in a minute is down, not thinking. */
const SPEECH_TIMEOUT_MS = 60_000;

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
    const { endpoint: ep, resolved_by, requested_class } = this.router.resolve(req.selector);
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
        // §11.5: dotted tool names are an internal fact and the wire gets
        // `__`, because Anthropic and OpenAI reject a dot in a tool name
        // outright. A pure facade in both directions (`tool-names.ts`) — the
        // reverse has to work for names this request never offered, since a
        // paged-closed or ungranted call is exactly the one an error quotes.
        const wireTools =
          req.tools && Object.keys(req.tools).length ? toWireToolSet(req.tools) : undefined;
        const common = {
          model,
          system: req.system,
          // History names tools too: a run's own tool-call and tool-result
          // parts ride along on every later step and are validated the same way.
          messages: toWireMessages(req.messages) as ModelMessage[],
          stopWhen: stepCountIs(1),
          maxRetries: 1,
          ...(wireTools ? { tools: wireTools } : {}),
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
            purpose: req.selector.purpose,
            endpoint: ep.name,
            resolved_by,
            ...(requested_class ? { requested_class } : {}),
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
          // The §10.6 routing decision, on every row: who asked, which
          // endpoint served it, what was asked for, and why the router chose it.
          purpose: req.selector.purpose,
          endpoint: ep.name,
          resolved_by,
          ...(requested_class ? { requested_class } : {}),
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

  /**
   * Audio in, text out, through the `stt` route (§10.9). Queued and traced
   * like any other model call, because it is one — an `llm_call` row with
   * `purpose: 'stt'`, zero tokens, and the seconds it was priced by.
   *
   * Unlike a tool, this **throws**: a transcriber that 500s or is not
   * configured is an outage or a bug, not an expected result the model should
   * read. The adapter above turns it into an HTTP status (App. E).
   */
  async transcribe(req: TranscribeRequest): Promise<TranscribeResult> {
    const { endpoint: ep, resolved_by } = this.speechEndpoint('stt');
    const audioSeconds = wavSeconds(req.audio);
    // The endpoint's own pin wins over the caller's locale (§10.9); `auto`
    // from either means "you work it out" — the parameter is left off.
    const want = ep.language ?? req.language;
    const language = want && want !== 'auto' ? want : undefined;

    return this.speechCall({
      ep,
      resolved_by,
      purpose: 'stt',
      priority: req.priority,
      trace: req.trace,
      extra: { audio_s: audioSeconds },
      priced: transcribeCost(ep, audioSeconds),
      run: async () => {
        const form = new FormData();
        // `new Uint8Array(…)` re-homes the bytes in a plain ArrayBuffer: a
        // Buffer read off a socket may be a view into a pooled (or shared)
        // one, which `Blob` will not take.
        const bytes = new Uint8Array(req.audio);
        form.set('file', new Blob([bytes], { type: req.mime }), 'utterance.wav');
        form.set('model', ep.model);
        form.set('response_format', 'json');
        if (language) form.set('language', language);
        const res = await this.speechFetch(`${ep.url}/audio/transcriptions`, ep, {
          method: 'POST',
          body: form,
          ...(req.abortSignal ? { signal: req.abortSignal } : {}),
        });
        const body = (await res.json()) as { text?: unknown };
        const text = typeof body.text === 'string' ? body.text.trim() : '';
        return { text, audioSeconds, endpoint: ep };
      },
    });
  }

  /**
   * Text in, WAV out, through the `tts` route (§10.9). The body is returned
   * unread: §33.2's whole latency argument is that the speaker starts on the
   * first sentence, which cannot happen if the gateway buffers the response.
   * The trace row is therefore written when the endpoint *starts* answering —
   * `duration_ms` is time-to-first-byte, which is the number voice is judged
   * by (§33.4), and the scheduler slot is released to whoever is next rather
   * than held for however long the consumer takes to drink the stream.
   */
  async speak(req: SpeakRequest): Promise<SpeakResult> {
    const { endpoint: ep, resolved_by } = this.speechEndpoint('tts');
    const chars = req.text.length;

    return this.speechCall({
      ep,
      resolved_by,
      purpose: 'tts',
      priority: req.priority,
      trace: req.trace,
      extra: { chars },
      priced: speakCost(ep, chars),
      run: async () => {
        const res = await this.speechFetch(`${ep.url}/audio/speech`, ep, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            model: ep.model,
            input: req.text,
            ...((req.voice ?? ep.voice) ? { voice: req.voice ?? ep.voice } : {}),
            response_format: 'wav',
          }),
          ...(req.abortSignal ? { signal: req.abortSignal } : {}),
        });
        if (!res.body) throw new Error(`${ep.name}: /audio/speech answered without a body`);
        return { stream: res.body, chars, endpoint: ep };
      },
    });
  }

  private speechEndpoint(kind: 'stt' | 'tts'): {
    endpoint: ResolvedEndpoint;
    resolved_by: 'route' | 'kind_default';
  } {
    const ep = this.router.resolveSpeech(kind);
    if (!ep) {
      throw new UserFacingError(
        'no_speech_endpoint',
        `no ${kind} endpoint configured`,
        `add one with the speech_endpoint setup form (§10.9)`,
      );
    }
    return ep;
  }

  private async speechFetch(
    url: string,
    ep: ResolvedEndpoint,
    init: RequestInit,
  ): Promise<Response> {
    const headers = new Headers(init.headers);
    if (ep.apiKey) headers.set('authorization', `Bearer ${ep.apiKey}`);
    const res = await this.fetchImpl(url, {
      ...init,
      headers,
      ...(init.signal ? {} : { signal: AbortSignal.timeout(SPEECH_TIMEOUT_MS) }),
    });
    if (!res.ok) {
      // The status and nothing from the body: an endpoint's error text is not
      // ours to relay, and a misconfigured proxy has been known to echo the
      // Authorization header back in it (§27).
      throw new Error(`${ep.name}: ${url.replace(ep.url, '')} answered HTTP ${res.status}`);
    }
    return res;
  }

  /**
   * The queue-and-trace wrapper both speech doors share (§10.3, §10.9). One
   * `llm_call` row per call, error rows included — the request log (§10.8)
   * shows a transcription that failed exactly as it shows a chat turn that did.
   */
  private async speechCall<T>(args: {
    ep: ResolvedEndpoint;
    resolved_by: 'route' | 'kind_default';
    purpose: 'stt' | 'tts';
    priority: Priority;
    trace?: TraceSink;
    extra: { audio_s: number } | { chars: number };
    priced: { cost: number; currency: string } | null;
    run: () => Promise<T>;
  }): Promise<T> {
    const { ep } = args;
    const trace = args.trace ?? nullTraceSink;
    return this.scheduler.run({
      endpoint: ep.name,
      priority: args.priority,
      concurrency: ep.concurrency,
      fn: async ({ queueWaitMs }) => {
        const started = Date.now();
        const row = (stopReason: string): LlmCallTrace => ({
          model: ep.name,
          priority: args.priority,
          queue_wait_ms: queueWaitMs,
          duration_ms: Date.now() - started,
          tokens_in: 0,
          tokens_out: 0,
          stop_reason: stopReason,
          purpose: args.purpose,
          endpoint: ep.name,
          resolved_by: args.resolved_by,
          ...args.extra,
          ...(args.priced ? { cost: args.priced.cost, currency: args.priced.currency } : {}),
        });
        try {
          const out = await args.run();
          const rec = row('stop');
          trace.append('llm_call', rec);
          l.debug(rec, 'speech call');
          return out;
        } catch (e) {
          trace.append('llm_call', row('error'));
          throw e;
        }
      },
    });
  }
}

/**
 * The default way `none` travels when an endpoint declares the level but not
 * how to send it (§10.6, G.2). Exported because the probe sends the same
 * fragment to find out whether the knob actually works.
 */
export const DEFAULT_NO_THINK: Record<string, unknown> = { reasoning_effort: 'none' };

/**
 * Request-body extras: output constraints, and the one routing parameter
 * (§10.6).
 *
 * `reasoning_effort` is sent only when a level was chosen **and** the endpoint
 * that actually serves this call declares it (G.2 `efforts:`). An endpoint
 * that has not said it understands the knob does not get handed it — its own
 * default stands, undeclared and unguessed — and the level is checked against
 * the *resolved* endpoint, not the one the chooser was looking at.
 *
 * `none` is the one level that does not travel as `reasoning_effort: <level>`:
 * turning thinking off is spelled differently by every server, so the endpoint
 * says how in `no_think` and that fragment is merged in **instead**. Still the
 * body, never the messages — a guard test asserts the request is byte-identical
 * either way, because a prompt change would forfeit the prefix cache on every
 * voice turn (§20.5, §21.1).
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
  if (effort && ep.efforts?.includes(effort)) {
    if (effort === 'none') Object.assign(extra, ep.noThink ?? DEFAULT_NO_THINK);
    else extra.reasoning_effort = effort;
  }
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
    // Back to the name the rest of the system knows. A model that answered
    // with the dotted name anyway passes through unchanged.
    toolName: internalToolName(call.toolName),
    input: call.input,
    invalid: call.invalid === true,
    unknownTool: call.invalid === true && NoSuchToolError.isInstance(call.error),
  };
  if (call.error !== undefined) {
    out.error = call.error instanceof Error ? call.error.message : String(call.error);
  }
  return out;
}
