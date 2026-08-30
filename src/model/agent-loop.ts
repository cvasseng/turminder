import type { ModelMessage } from 'ai';
import { log } from '../core/logger.js';
import { errMessage } from '../core/errors.js';
import { reservedMarkers, stripReservedMarkers } from '../core/markers.js';
import type { JsonSchemaSpec, ModelGateway } from './gateway.js';
import { emptyDispatcher, type DispatchResult, type ToolDispatcher } from './dispatcher.js';
import { elideStaleResults, stubBulkArgs, type ElisionSettings } from './elide.js';
import {
  nullTraceSink,
  type AgentActivity,
  type Budgets,
  type ModelSelector,
  type Priority,
  type ToolCallTrace,
  type TraceSink,
} from './types.js';

const l = log('agent');

/** Appendix A defaults. */
export const DEFAULT_BUDGETS: Budgets = { maxTurns: 10, maxTokens: 30_000, timeoutS: 180 };

/**
 * The futility backstop (§20.9, App. A). From this many consecutive empty
 * results in one namespace, the results ride wrapped with a note saying the
 * approach is not working. §20.7 catches the same call twice; this catches
 * four different calls that all found nothing.
 */
const FUTILE_STREAK_THRESHOLD = 3;

/**
 * Fabrication-guard retries (App. A): one per assistant response, then the
 * reserved patterns are stripped and the run carries on (§20.8). A dead run
 * would punish the user for the model imitating our own annotation.
 */
const MARKER_RETRIES = 1;

/**
 * The rewrite backstop's threshold (§20.7, App. A): the write to the same
 * target, with different content, that comes back wrapped. Two rewrites is a
 * correction; three is a model that no longer believes its own results.
 */
const REPEATED_WRITE_THRESHOLD = 3;

/**
 * The corrective note a retry carries (§20.8). An error that teaches, per
 * §23.2's precedent: naming the pattern is what makes it fixable, and the
 * middle sentence is the whole lesson of the incident. The paraphrase clause
 * is the way out for the one legitimate case — a reply that means to *discuss*
 * a marker — which the guard cannot tell from fabrication and rejects the
 * same. The rejected text is deliberately not quoted back: it is the thing
 * being unlearned.
 */
function markerCorrection(markers: string[]): string {
  return (
    `System note: your reply contained ${markers.join(', ')} — that annotation is ` +
    `written by the system, never by you. If you used a tool, call it — text ` +
    `claiming tool use is not tool use. To talk *about* a marker, describe it ` +
    `without writing it verbatim. Answer again, without it.`
  );
}

export type StopReason = 'stop' | 'max_turns' | 'max_tokens' | 'timeout' | 'aborted' | 'error';

export interface AgentRunRequest {
  selector: ModelSelector;
  priority: Priority;
  /**
   * The system prompt. A function is re-read before every turn, for the one
   * thing that legitimately changes mid-run: the closed-namespace catalog,
   * which must stop calling a namespace closed the moment the model opens it
   * (§21.2). Anything else volatile here re-bills the whole prompt every turn —
   * that is what §20.5 exists to prevent.
   */
  system: string | (() => string);
  messages: ModelMessage[];
  dispatcher?: ToolDispatcher;
  budgets?: Partial<Budgets>;
  trace?: TraceSink;
  /**
   * Consecutive empty results in one namespace before the §20.9 note appears.
   * Absent uses the App. A default.
   */
  futileThreshold?: number;
  onDelta?: (text: string) => void;
  /**
   * Take back everything streamed for the turn in flight (§20.8).
   *
   * Deltas leave before anything has looked at them, so a turn the guard
   * rejects has already been shown. Without this the caller is left holding
   * the offending text with the replacement appended after it — which is what
   * put internal markers, and two answers, in front of users.
   */
  onRetract?: () => void;
  /** Progress feedback for a human watching the run (chat UI). */
  onActivity?: (activity: AgentActivity) => void;
  abortSignal?: AbortSignal;
  maxOutputTokens?: number;
  temperature?: number;
  /**
   * Mid-run elision of stale large tool results (§20.4). Absent means off,
   * which is right for single-turn calls that have no history to shrink.
   */
  elision?: ElisionSettings;
  /** Constrain output to a JSON schema (llama.cpp grammar) — §10.1. */
  jsonSchema?: JsonSchemaSpec;
  /** Raw GBNF grammar, when a schema cannot express the shape. */
  grammar?: string;
}

export interface AgentRunResult {
  /** Text of the final assistant turn — what a JSON-constrained call parses. */
  text: string;
  /**
   * DISPLAY (§20.2): everything the assistant said across every turn, joined.
   * A model that comments before calling a tool has said something the user
   * saw streamed; persisting only the last turn would lose it (and it would
   * vanish on the next page load).
   */
  assistantText: string;
  /**
   * MODEL CONTEXT (§20.2): the last non-empty utterance. Pre-tool narration
   * is display-only and must not accumulate in history.
   */
  contextText: string;
  turns: number;
  /** Every prompt token billed, summed across calls — the run's real cost. */
  tokensIn: number;
  tokensOut: number;
  /**
   * The largest single prompt, i.e. how much context the run actually used.
   * The budget is checked against this plus output, because the same prompt is
   * re-sent every turn: charging it repeatedly makes `max_tokens` fire on
   * ordinary tool-using work rather than on a runaway loop.
   */
  promptTokens: number;
  /**
   * Prompt tokens the endpoint actually evaluated across the run, summed over
   * the turns that reported any (§21.1). `null` when no turn did — the honest
   * "this endpoint does not say", as opposed to "it evaluated nothing".
   */
  promptEvaluated: number | null;
  /** Prompt tokens billed on the turns `promptEvaluated` covers (§21.1). */
  billedWithTimings: number;
  toolCallCount: number;
  /** Names of the tools called, deduped, in call order (§20.2). */
  toolsUsed: string[];
  /** Reasoning produced across the run. Metrics only (§20.1). */
  reasoningChars: number;
  stopReason: StopReason;
  error?: string;
  endpoint: string;
  /** Full transcript including tool calls and results, for debugging/replay. */
  messages: ModelMessage[];
}

/**
 * C.1's excerpt cap. Tool results and the fabrication guard's offending text
 * share it deliberately (§20.8): both are forensic samples the retention job
 * drops at the same age, so they are capped by the same number.
 */
const EXCERPT_CAP = 1000;

function excerptResult(value: unknown): string {
  const s = typeof value === 'string' ? value : JSON.stringify(value);
  return (s ?? '').slice(0, EXCERPT_CAP);
}

/**
 * The turn loop (§10.4). Ours, deliberately: budgets, capability enforcement,
 * priority and tracing are policy, and policy does not belong in a dependency.
 *
 * Budget exhaustion is not an exception — it is a stop reason the caller acts on
 * (§5.4: the handler executor turns it into a failed run).
 */
export async function runAgent(
  gateway: ModelGateway,
  req: AgentRunRequest,
): Promise<AgentRunResult> {
  const budgets: Budgets = { ...DEFAULT_BUDGETS, ...req.budgets };
  const dispatcher: ToolDispatcher = req.dispatcher ?? emptyDispatcher;
  const trace = req.trace ?? nullTraceSink;
  const messages: ModelMessage[] = [...req.messages];

  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort(new Error(`agent run exceeded timeout_s=${budgets.timeoutS}`));
  }, budgets.timeoutS * 1000);
  const onOuterAbort = () => controller.abort(req.abortSignal?.reason ?? new Error('aborted'));
  req.abortSignal?.addEventListener('abort', onOuterAbort, { once: true });

  let turns = 0;
  let tokensIn = 0;
  let tokensOut = 0;
  let promptTokens = 0;
  // Summed only over turns that reported a figure, so a mixed run (an endpoint
  // that stopped sending `timings`) reports the part it knows rather than a
  // total that silently understates evaluation.
  let promptEvaluated: number | null = null;
  let billedWithTimings = 0;
  let toolCallCount = 0;
  const toolsUsed = new Set<string>();
  // Identical calls seen this run, for the circling backstop (§20.7).
  // Zero-arg calls are exempt: `time.now` twice in a run is time passing,
  // not a model that lost the thread.
  const repeats = new Map<string, { count: number; output: unknown }>();
  /** Writes per (tool, target) — the args minus their bulk content (§20.7). */
  const writes = new Map<string, number>();
  // Fabrication-guard retries spent on the current assistant response (§20.8).
  let markerRetries = 0;
  // Consecutive empty results per tool namespace (§20.9), reset by any
  // non-empty result from that namespace.
  const futile = new Map<string, number>();
  const futileThreshold = req.futileThreshold ?? FUTILE_STREAK_THRESHOLD;
  let reasoningChars = 0;
  let text = '';
  const spoken: string[] = [];
  // What the current gateway turn has streamed so far. An aborted turn (App. D
  // `chat.stop`) dies mid-stream inside gateway.turn, so its text never reaches
  // `spoken` — but the user already watched it go past, so the catch salvages
  // it from here rather than letting the throw discard it.
  let streamedThisTurn = '';
  let endpoint = '';
  let stopReason: StopReason;
  let error: string | undefined;

  try {
    for (;;) {
      if (turns >= budgets.maxTurns) {
        stopReason = 'max_turns';
        break;
      }
      // New tokens only: the prompt is re-sent each turn, so summing it would
      // make a four-turn run look like four times the work it is.
      if (promptTokens + tokensOut >= budgets.maxTokens) {
        if (turns === 1) {
          l.warn(
            { promptTokens, maxTokens: budgets.maxTokens },
            'the prompt alone exceeds max_tokens; raise the budget rather than shortening the loop',
          );
        }
        stopReason = 'max_tokens';
        break;
      }

      turns += 1;
      // Before the call, not after: the point is to shrink what this turn sends.
      if (req.elision) {
        const dropped = elideStaleResults(messages, req.elision);
        if (dropped.length) l.debug({ tools: dropped, turn: turns }, 'elided stale results');
      }
      req.onActivity?.({ kind: 'thinking', turn: turns });
      streamedThisTurn = '';
      const turn = await gateway.turn({
        selector: req.selector,
        priority: req.priority,
        system: typeof req.system === 'function' ? req.system() : req.system,
        messages,
        tools: dispatcher.toolSet(),
        trace,
        abortSignal: controller.signal,
        ...(req.onDelta
          ? {
              onDelta: (t: string) => {
                streamedThisTurn += t;
                req.onDelta!(t);
              },
            }
          : {}),
        // Reasoning is feedback, never content (§20.1): it rides the activity
        // channel and is not accumulated into anything this loop returns.
        ...(req.onActivity
          ? { onReasoning: (text: string) => req.onActivity?.({ kind: 'reasoning', text }) }
          : {}),
        ...(req.onActivity
          ? {
              onActivity: (activity: AgentActivity) =>
                req.onActivity?.(
                  // The gateway does not know which turn it is serving.
                  activity.kind === 'usage' ? { ...activity, turn: turns } : activity,
                ),
            }
          : {}),
        ...(req.maxOutputTokens ? { maxOutputTokens: req.maxOutputTokens } : {}),
        ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
        ...(req.jsonSchema ? { jsonSchema: req.jsonSchema } : {}),
        ...(req.grammar ? { grammar: req.grammar } : {}),
      });

      endpoint = turn.endpoint.name;
      tokensIn += turn.tokensIn;
      tokensOut += turn.tokensOut;
      promptTokens = Math.max(promptTokens, turn.tokensIn);
      if (turn.promptEvaluated !== undefined) {
        promptEvaluated = (promptEvaluated ?? 0) + turn.promptEvaluated;
        billedWithTimings += turn.tokensIn;
      }
      reasoningChars += turn.reasoningChars;

      /**
       * The fabrication guard (§20.8), on every fresh assistant text before it
       * settles into anything. A response that speaks one of the system's own
       * markers is rejected *whole* — its tool calls included, because
       * executing half of a response we are about to ask for again is how one
       * append becomes two. What the turn cost still counts: it was spent.
       */
      const markers = reservedMarkers(turn.text);
      let responseText = turn.text;
      if (markers.length && markerRetries < MARKER_RETRIES) {
        markerRetries += 1;
        trace.append('error', {
          message: 'reserved_marker_in_output',
          markers,
          outcome: 'retried',
          // What the model tried to fabricate, so tuning the guard is a query
          // rather than a guess (§20.8). The offending text goes nowhere else:
          // it is not delivered, not persisted, and not quoted back.
          excerpt: turn.text.slice(0, EXCERPT_CAP),
        });
        l.warn(
          { markers, turn: turns, dropped_calls: turn.toolCalls.length },
          'reserved marker in fresh output; retrying the turn',
        );
        // Rejected whole, so unsay it whole: the next attempt streams from a
        // clean slate rather than appending a second answer to a bad one.
        req.onRetract?.();
        messages.push({ role: 'user', content: markerCorrection(markers) });
        continue;
      }
      if (markers.length) {
        // A repeat offence is not a dead run: strip, then deliver and persist
        // what is left. The turn the user sees and the turn the model re-reads
        // are both clean, and the trace says what happened.
        trace.append('error', {
          message: 'reserved_marker_in_output',
          markers,
          outcome: 'stripped',
          // Pre-strip, like the retried branch: the trace records the offence,
          // not the cleaned-up remains that the user and the model will see.
          excerpt: turn.text.slice(0, EXCERPT_CAP),
        });
        responseText = stripReservedMarkers(turn.text);
        // What was streamed is the *un*stripped text, so it has to go — and
        // unlike the retry branch there is no next attempt to replace it, so
        // the cleaned remains are streamed in its place. Retract-then-restream
        // rather than a diff: the caller's job is to render what it is told,
        // not to work out which characters moved.
        req.onRetract?.();
        if (responseText) req.onDelta?.(responseText);
        l.warn({ markers, turn: turns }, 'reserved marker survived the retry; stripped');
      } else {
        // The budget is one retry per assistant *response* (App. A), so a clean
        // one restores it: a model that slips at turn 9 gets the same chance it
        // got at turn 1.
        markerRetries = 0;
      }
      // Already reasoning-stripped by the gateway (§20.1), so nothing this
      // loop accumulates — and nothing it persists — can carry think content.
      text = responseText;
      if (responseText.trim()) spoken.push(responseText.trim());

      /**
       * A name the rendered definitions did not contain still goes to the
       * dispatcher: it may be granted but paged out (§21.2.4), and if it is
       * not, the refusal belongs to the enforcement point rather than to a
       * hand-written correction message here (App. F.7.3).
       */
      const valid = turn.toolCalls.filter((c) => !c.invalid || c.unknownTool);
      // Left over: a tool we do render, called with arguments that are not JSON.
      const invalid = turn.toolCalls.filter((c) => c.invalid && !c.unknownTool);

      if (responseText || valid.length) {
        messages.push({
          role: 'assistant',
          content: [
            ...(responseText ? [{ type: 'text' as const, text: responseText }] : []),
            ...valid.map((c) => ({
              type: 'tool-call' as const,
              toolCallId: c.toolCallId,
              toolName: c.toolName,
              input: c.input,
            })),
          ],
        });
      }

      if (valid.length) {
        const results = [];
        for (const call of valid) {
          const startedAt = Date.now();
          req.onActivity?.({ kind: 'tool_call', tool: call.toolName, args: call.input });
          // The circling backstop (§20.7): an identical call repeated within a
          // run is a model that lost the thread — usually because the earlier
          // result was elided. Repeats 2–3 execute but say so; from the 4th,
          // the cached result is returned without touching the tool, because
          // by then the upstream answer is not the missing piece.
          const trivialArgs =
            !call.input ||
            typeof call.input !== 'object' ||
            Object.keys(call.input as object).length === 0;
          const repeatKey = trivialArgs ? null : `${call.toolName} ${stableJson(call.input)}`;
          const seen = repeatKey ? repeats.get(repeatKey) : undefined;
          let outcome: DispatchResult;
          if (seen && seen.count >= 3) {
            seen.count += 1;
            outcome = {
              ok: true,
              output: {
                repeated_call: true,
                note:
                  `this exact ${call.toolName} call has now been made ${seen.count} times ` +
                  `this run; this is the same result as before. Stop repeating it — use ` +
                  `what you already have, or change the arguments.`,
                result: seen.output,
              },
            };
          } else {
            try {
              outcome = await dispatcher.dispatch({
                toolCallId: call.toolCallId,
                name: call.toolName,
                args: call.input,
              });
            } catch (e) {
              // A dispatcher that throws is a bug, but the run should survive it.
              outcome = { ok: false, output: { error: 'tool_failed', message: errMessage(e) } };
            }
            if (seen) {
              seen.count += 1;
              seen.output = outcome.output;
              outcome = {
                ...outcome,
                output: {
                  repeated_call: true,
                  note: `identical to your earlier ${call.toolName} call this run — the answer has not changed`,
                  result: outcome.output,
                },
              };
            } else if (repeatKey) {
              repeats.set(repeatKey, { count: 1, output: outcome.output });
            }
          }
          /**
           * The rewrite backstop (§20.7). The identical-args map above cannot
           * see the other way a model circles: the same write tool aimed at the
           * same target with *different* content every time — a model that
           * believes its write failed and re-sends it reworded (2026-08-30:
           * eight `memory.update` calls to one memory in seventy seconds, all
           * stored, all committed). The target is the call minus its bulk
           * fields; from the third such write the result comes back wrapped.
           * Pressure, never refusal: every write still runs and still lands.
           */
          if (outcome.bulkArgs?.length && !seen && !trivialArgs) {
            const target = { ...(call.input as Record<string, unknown>) };
            for (const field of outcome.bulkArgs) delete target[field];
            if (Object.keys(target).length) {
              const writeKey = `${call.toolName} ${stableJson(target)}`;
              const count = (writes.get(writeKey) ?? 0) + 1;
              writes.set(writeKey, count);
              if (count >= REPEATED_WRITE_THRESHOLD) {
                outcome = {
                  ...outcome,
                  output: {
                    repeated_write: true,
                    note:
                      `this is ${call.toolName} number ${count} to the same target this run, ` +
                      `each with different content, and each one was stored — you are ` +
                      `rewriting, not fixing. If you doubt what is there, read it back with ` +
                      `the tool; otherwise stop.`,
                    result: outcome.output,
                  },
                };
              }
            }
          }
          /**
           * The futility backstop (§20.9). Counting is per namespace because
           * that is the unit an approach lives in: four different `web.*`
           * calls that all found nothing is one wrong idea, not four unlucky
           * ones. The data always arrives — the wrapper adds pressure, never
           * a refusal — and the first non-empty result clears it.
           */
          const namespace = call.toolName.split('.')[0] ?? call.toolName;
          let streak = futile.get(namespace) ?? 0;
          streak = outcome.empty ? streak + 1 : 0;
          futile.set(namespace, streak);
          if (streak >= futileThreshold) {
            const remaining = Math.max(0, budgets.maxTurns - turns);
            outcome = {
              ...outcome,
              output: {
                futile_streak: streak,
                note:
                  `${streak} ${namespace}.* calls in a row have returned nothing. ` +
                  `The approach is likely wrong, not the parameters — switch strategy ` +
                  `(different tool, different source), or answer with what you already ` +
                  `have. ${remaining} of ${budgets.maxTurns} turns remain.`,
                result: outcome.output,
              },
            };
          }
          toolCallCount += 1;
          toolsUsed.add(call.toolName);
          // The trace and the activity line show what the tool returned; only
          // the transcript sees the capped form (§20.3).
          const reported =
            outcome.traceOutput !== undefined ? outcome.traceOutput : outcome.output;
          const rec: ToolCallTrace = {
            tool: call.toolName,
            // Redaction is the dispatcher's call, not ours (App. F.9).
            args: outcome.traceArgs !== undefined ? outcome.traceArgs : call.input,
            ok: outcome.ok,
            result_excerpt: excerptResult(reported),
            duration_ms: Date.now() - startedAt,
            // Tuning data for §17.11: how often streaks happen, and where.
            ...(streak >= futileThreshold ? { futile_streak: streak } : {}),
            ...(outcome.denied ? { denied: outcome.denied } : {}),
            // Why the toolset grew mid-run (§21.2.4).
            ...(outcome.implicitOpen ? { implicit_open: outcome.implicitOpen } : {}),
          };
          trace.append('tool_call', rec);
          req.onActivity?.({
            kind: 'tool_result',
            tool: call.toolName,
            ok: outcome.ok,
            summary: excerptResult(reported).slice(0, 200),
          });
          // Now, not on the next elision pass: §20.6 has no age threshold —
          // the artifact is in the store the moment the call returns.
          if (outcome.bulkArgs?.length) {
            const stubbed = stubBulkArgs(messages, call.toolCallId, outcome.bulkArgs);
            if (stubbed.length)
              l.debug(
                { tool: call.toolName, fields: stubbed },
                'stored bulk args out of context',
              );
          }
          results.push({
            type: 'tool-result' as const,
            toolCallId: call.toolCallId,
            toolName: call.toolName,
            output: { type: 'json' as const, value: outcome.output as never },
          });
        }
        messages.push({ role: 'tool', content: results });
      }

      if (invalid.length) {
        // Malformed tool calls stay out of the transcript as calls (there is
        // nothing valid to echo) and come back as a correction instead.
        for (const c of invalid) {
          trace.append('tool_call', {
            tool: c.toolName || '(unparsable)',
            args: c.input,
            ok: false,
            result_excerpt: c.error ?? 'malformed tool call',
            duration_ms: 0,
          } satisfies ToolCallTrace);
        }
        messages.push({
          role: 'user',
          content:
            `System note: ${invalid.length} tool call(s) could not be parsed ` +
            `(${invalid.map((c) => `${c.toolName || 'unknown'}: ${c.error ?? 'invalid arguments'}`).join('; ')}). ` +
            `Tool arguments must be JSON matching the tool's schema. Retry, or answer without the tool.`,
        });
      }

      if (!valid.length && !invalid.length) {
        stopReason = 'stop';
        break;
      }
    }
  } catch (e) {
    if (timedOut) {
      stopReason = 'timeout';
      error = `timeout after ${budgets.timeoutS}s`;
    } else if (req.abortSignal?.aborted) {
      stopReason = 'aborted';
      error = 'aborted';
      // Keep what the aborted turn had already said. Stripped like any fresh
      // output (§20.8) — this text died before the guard could look at it.
      const partial = stripReservedMarkers(streamedThisTurn).trim();
      if (partial) {
        text = partial;
        spoken.push(partial);
      }
    } else {
      stopReason = 'error';
      error = errMessage(e);
      trace.append('error', { message: error });
    }
    l.warn({ stopReason, error }, 'agent run ended abnormally');
  } finally {
    clearTimeout(timer);
    req.abortSignal?.removeEventListener('abort', onOuterAbort);
  }

  if (stopReason !== 'stop') req.onActivity?.({ kind: 'stopped', reason: stopReason });

  const result: AgentRunResult = {
    text,
    assistantText: spoken.join('\n\n'),
    /**
     * The run's last non-empty utterance — the final answer. This, not the
     * whole narration, is what history reconstruction re-reads (§20.2).
     */
    contextText: spoken.at(-1) ?? '',
    turns,
    tokensIn,
    tokensOut,
    promptTokens,
    promptEvaluated,
    /**
     * The prompt tokens the cache figure is *about*. Comparing
     * `promptEvaluated` against the run's whole `tokensIn` would report a
     * flattering cache hit rate whenever some turns went untimed.
     */
    billedWithTimings,
    toolCallCount,
    toolsUsed: [...toolsUsed],
    reasoningChars,
    stopReason,
    endpoint,
    messages,
  };
  if (error) result.error = error;
  return result;
}

/** Key-order-independent serialization, so "the same call" means the same call. */
function stableJson(value: unknown): string {
  return (
    JSON.stringify(value, (_key, v) =>
      v && typeof v === 'object' && !Array.isArray(v)
        ? Object.fromEntries(
            Object.entries(v as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : 1)),
          )
        : v,
    ) ?? 'null'
  );
}
