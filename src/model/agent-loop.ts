import type { ModelMessage, ToolSet } from 'ai';
import { log } from '../core/logger.js';
import { errMessage } from '../core/errors.js';
import { reservedMarkers, stripReservedMarkers } from '../core/markers.js';
import {
  ModelCallError,
  type JsonSchemaSpec,
  type ModelGateway,
  type TurnResult,
} from './gateway.js';
import { emptyDispatcher, type DispatchResult, type ToolDispatcher } from './dispatcher.js';
import {
  compactRung,
  elideStaleResults,
  stubBulkArgs,
  type CompactionRung,
  type ElisionSettings,
} from './elide.js';
import {
  nullTraceSink,
  type AgentActivity,
  type Budgets,
  type ModelSelector,
  type Priority,
  type ResolvedEndpoint,
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

/**
 * Silent-turn retries (§20.10, App. A): once per run, not per response. A
 * model that reasons and stops twice has been told what nothing means and did
 * it again; a third call would only spend more of somebody's patience.
 */
const SILENT_TURN_RETRIES = 1;

/**
 * The silent-turn note (§20.10) — this quote IS the shipped text, and the spec
 * and this string move together. Appended at the tail in the user role like
 * the §20.8 correction, so the prefix is untouched; run-local, never persisted.
 */
const SILENT_TURN_NOTE =
  'System note: your last turn ended without a reply or a tool call, so ' +
  'nothing happened — reasoning is not seen by anyone. Do what you were ' +
  'working toward now: call the tool, or answer.';

/**
 * The window budget (§20.11, App. A). The reserve is what the answer gets:
 * `max(OUTPUT_RESERVE_TOKENS, 20% of W)`, because an output that runs into the
 * wall is cut mid-sentence or mid-tool-call and nothing in it can be used.
 */
const OUTPUT_RESERVE_TOKENS = 6000;
const OUTPUT_RESERVE_SHARE = 0.2;
/**
 * The starting chars-per-token ratio, and its ceiling (App. A): pessimistic,
 * because an over-estimate costs a compaction and an under-estimate a refused
 * call. Each call that reports usage re-measures it, never above this — a
 * server that tokenizes denser is measured rather than guessed.
 */
const CHARS_PER_TOKEN = 3;
/**
 * `max_tokens = W − estimate − margin`, `margin = max(256, 3% of W)` (App. A
 * `window_margin`): vllm counts `max_tokens` against the window, so an
 * estimate a little low must not become a refusal.
 */
const WINDOW_MARGIN_MIN = 256;
const WINDOW_MARGIN_SHARE = 0.03;
const windowMargin = (w: number) =>
  Math.max(WINDOW_MARGIN_MIN, Math.ceil(w * WINDOW_MARGIN_SHARE));
/**
 * App. A `min_output_room`: less room than this after the last rung, and the
 * run ends `context_full`.
 */
const MIN_OUTPUT_ROOM = 1024;
/** Length refusals answered by learning, compacting and retrying (App. A). */
const CONTEXT_RETRIES = 1;
/** `length` finishes answered by compacting and asking again (App. A). */
const LENGTH_RETRIES = 1;
/** §20.4's App. A default, for compaction on a run that passed no elision. */
const DEFAULT_ELIDE_THRESHOLD_CHARS = 2000;

/**
 * The cut-off note (§20.11) — this quote IS the shipped text, and the spec and
 * this string move together, as with §20.8 and §20.10. With the window
 * unknown there is no honest `<k>`, so that one sentence is left out.
 */
function lengthNote(tokensOut: number, room?: number): string {
  return (
    `System note: your last output was cut off after ${tokensOut} tokens because the ` +
    `context window was full, so nothing in it was executed. ` +
    (room !== undefined ? `${room} tokens of output fit now. ` : '') +
    `If you were writing something large, put it in one tool call and keep ` +
    `the prose around it short.`
  );
}

export type StopReason =
  | 'stop'
  | 'max_turns'
  | 'max_tokens'
  | 'timeout'
  | 'stalled'
  | 'aborted'
  | 'error'
  /** The working set no longer fits the window, even compacted (§20.11). */
  | 'context_full'
  /** The answer ran into the window twice (§20.11). */
  | 'output_cut';

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
  /**
   * The effective window the run budgeted against (§20.11): observed, else
   * configured. Absent when neither is known — and then nothing was budgeted.
   */
  contextWindow?: number;
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
    if (controller.signal.aborted) return;
    timedOut = true;
    controller.abort(new Error(`agent run exceeded timeout_s=${budgets.timeoutS}`));
  }, budgets.timeoutS * 1000);
  /**
   * The stall clock (§9), when the caller asked for one. Armed by the gateway's
   * first tick (the call has left the queue), reset by every tick after it, and
   * disarmed the moment the call settles — so tool execution, and a form or
   * confirmation waiting on a human inside one, never runs it. A run that is
   * working slowly lives; one whose stream went quiet ends here rather than at
   * the ceiling. Streamed calls only: a call that does not stream ticks once,
   * on leaving the queue, and would read its own generation as silence.
   *
   * Each clock stands down if the run is already stopped: the first to fire
   * names the stop, and a later timer never relabels it (§9).
   */
  let stalled = false;
  let stallTimer: ReturnType<typeof setTimeout> | undefined;
  const disarmStall = () => {
    if (stallTimer !== undefined) clearTimeout(stallTimer);
    stallTimer = undefined;
  };
  const stallS = budgets.stallS;
  const onProgress =
    stallS === undefined || !req.onDelta
      ? undefined
      : () => {
          disarmStall();
          stallTimer = setTimeout(() => {
            if (controller.signal.aborted) return;
            stalled = true;
            controller.abort(
              new Error(`agent run stalled: nothing streamed for stall_s=${stallS}`),
            );
          }, stallS * 1000);
        };
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
  // `settled` is whether the last two results were identical — the only
  // condition under which a repeat may be answered from the cache.
  const repeats = new Map<
    string,
    { count: number; output: unknown; ok: boolean; settled: boolean }
  >();
  /** Writes per (tool, target) — the args minus their bulk content (§20.7). */
  const writes = new Map<string, number>();
  // Fabrication-guard retries spent on the current assistant response (§20.8).
  let markerRetries = 0;
  // Silent-turn nudges spent this run (§20.10) — never restored.
  let silentRetries = 0;
  // Consecutive empty results per tool namespace (§20.9), reset by any
  // non-empty result from that namespace.
  const futile = new Map<string, number>();
  /**
   * Tools whose results the elision pass must leave alone (§20.4), learned
   * from the calls this run actually made. Declared statically by the tool and
   * reported per call, exactly as `bulkArgs` is: the transcript is the loop's,
   * and only the dispatcher can see the handle behind a name.
   */
  const neverElide = new Set<string>();
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

  /**
   * The window budget (§20.11). `W` is re-read every turn — observed beats
   * configured, and a refusal mid-run teaches the run a smaller one — and the
   * estimate is anchored on what the endpoint last *reported*, so only the
   * characters added (or compacted away) since are guessed at. The observed
   * sizes themselves are the gateway's (§20.11: the model stack's, not ours).
   */
  let learnedWindow: number | undefined;
  let contextWindow: number | undefined;
  let lastCall: { tokensIn: number; chars: number } | null = null;
  // The run's chars-per-token ratio (§20.11): starts at the default, and
  // each call that reports usage re-measures it, never above the default.
  let charsPerToken = CHARS_PER_TOKEN;
  let contextRetries = 0;
  let lengthRetries = 0;
  // The cut turn's `tokens_out`, while a §20.11 note is owed to the next call.
  let cutTokensOut: number | null = null;
  // After a refusal or a cut-off output the next call compacts at least once,
  // even when the arithmetic says it fits: the arithmetic is what just failed.
  let forceCompaction = false;
  const compactThreshold = req.elision?.thresholdChars ?? DEFAULT_ELIDE_THRESHOLD_CHARS;
  const windowFor = (): { ep: ResolvedEndpoint | null; size: number | undefined } => {
    let ep: ResolvedEndpoint;
    try {
      ep = gateway.router.resolve(req.selector).endpoint;
    } catch {
      // The gateway will throw the same thing, properly, in a moment.
      return { ep: null, size: learnedWindow };
    }
    return { ep, size: learnedWindow ?? gateway.contextWindow(ep) };
  };

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

      // Before the call, not after: the point is to shrink what this turn sends.
      if (req.elision) {
        const dropped = elideStaleResults(messages, req.elision, neverElide);
        if (dropped.length)
          l.debug({ tools: dropped, turn: turns + 1 }, 'elided stale results');
      }
      const system = typeof req.system === 'function' ? req.system() : req.system;
      const toolSet = dispatcher.toolSet();
      const { ep: windowEp, size: W } = windowFor();
      contextWindow = W;
      const estimate = () =>
        estimateTokens(lastCall, requestChars(system, messages, toolSet), charsPerToken);
      let maxOutputTokens = req.maxOutputTokens;
      /**
       * Did the window bound this call's output (§20.11)? Only then is a
       * `length` finish the window's doing. A cut at a cap the caller or G.2
       * set below the room is that caller's own budget and behaves as before.
       */
      let windowBound = req.maxOutputTokens === undefined;
      /**
       * The window is a budget (§20.11). Unknown `W` skips all of this — no
       * compaction, no `max_tokens` — which is exactly the behaviour before
       * the budget existed, and the only honest one without a number. (The
       * `length` rule below is the one part that does not need a number.)
       */
      if (W) {
        let est = estimate();
        const reserve = Math.max(OUTPUT_RESERVE_TOKENS, Math.ceil(W * OUTPUT_RESERVE_SHARE));
        const forced = forceCompaction;
        forceCompaction = false;
        for (const rung of [1, 2, 3] as CompactionRung[]) {
          if (est + reserve <= W && !(forced && rung === 1)) break;
          const before = est;
          const replaced = compactRung(messages, rung, compactThreshold, neverElide);
          est = estimate();
          trace.append('error', {
            message: 'compacted',
            rung,
            estimate_before: before,
            estimate_after: est,
            window: W,
          });
          l.info({ rung, replaced, before, after: est, window: W }, 'compacted the transcript');
        }
        /**
         * `max_tokens = min(room, G.2 max_output_tokens, the caller's cap)`.
         * The first two are the endpoint's limits; the caller's is its own
         * budget — a title has no business with twenty thousand tokens just
         * because they would fit.
         */
        const bound = (room: number) =>
          Math.min(
            room,
            windowEp?.maxOutputTokens ?? Infinity,
            req.maxOutputTokens ?? Infinity,
          );
        let room = W - est - windowMargin(W);
        if (cutTokensOut !== null) {
          // Appended at the tail in the user role, like §20.8's correction, so
          // the prefix is untouched; run-local, never persisted. `<k>` is the
          // `max_tokens` this call actually sends, measured with the note
          // itself in the transcript.
          const note: ModelMessage = {
            role: 'user',
            content: lengthNote(cutTokensOut, bound(room)),
          };
          messages.push(note);
          est = estimate();
          room = W - est - windowMargin(W);
          note.content = lengthNote(cutTokensOut, bound(room));
          cutTokensOut = null;
        }
        if (room < MIN_OUTPUT_ROOM) {
          stopReason = 'context_full';
          error = `context window full: ${est} of ${W} tokens`;
          break;
        }
        maxOutputTokens = bound(room);
        windowBound = maxOutputTokens === room;
      } else if (cutTokensOut !== null) {
        // No window, so nothing to compact against and no room to promise:
        // the note without its `<k>` sentence, and the same request again.
        messages.push({ role: 'user', content: lengthNote(cutTokensOut) });
        cutTokensOut = null;
      }
      const sentChars = requestChars(system, messages, toolSet);
      // Image and file parts cost tokens and no characters: a call carrying
      // one measures nothing about the tokenizer (§20.11).
      const measurable = !hasBinaryParts(messages);

      turns += 1;
      req.onActivity?.({ kind: 'thinking', turn: turns });
      streamedThisTurn = '';
      let turn: TurnResult;
      try {
        turn = await gateway.turn({
          selector: req.selector,
          priority: req.priority,
          system,
          messages,
          tools: toolSet,
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
                    // The gateway does not know which turn it is serving, nor
                    // the window the run is budgeting against (§20.11).
                    activity.kind === 'usage'
                      ? { ...activity, turn: turns, ...(W ? { context_size: W } : {}) }
                      : activity,
                  ),
              }
            : {}),
          ...(maxOutputTokens ? { maxOutputTokens } : {}),
          ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
          ...(req.jsonSchema ? { jsonSchema: req.jsonSchema } : {}),
          ...(req.grammar ? { grammar: req.grammar } : {}),
          ...(onProgress ? { onProgress } : {}),
        });
      } catch (e) {
        disarmStall();
        /**
         * A call refused for length is not a failure (§20.11): the endpoint
         * just said how big its window is. Recorded as the observed size,
         * then the next pass compacts against it and asks once more. A
         * second refusal means the working set does not fit, and the run
         * says so rather than dying of an HTTP error.
         */
        const refused = e instanceof ModelCallError && !controller.signal.aborted ? e : null;
        const limit = refused?.contextLimit;
        if (!refused || !limit) throw e;
        endpoint = refused.endpoint;
        // The gateway has already recorded it as the observed size.
        learnedWindow = limit;
        contextWindow = limit;
        // A refused call is not a turn: `max_turns` counts calls that
        // returned, so a one-turn run (ingress) still gets its retry.
        turns -= 1;
        // The refusal proves the estimate was low; when it says by how much,
        // that is the number to measure the rungs from.
        if (refused.contextPromptTokens) {
          lastCall = { tokensIn: refused.contextPromptTokens, chars: sentChars };
          // The server counted this prompt, so it is a measurement too.
          if (measurable) {
            charsPerToken = measuredRatio(
              charsPerToken,
              sentChars,
              refused.contextPromptTokens,
            );
          }
        }
        const retry = contextRetries < CONTEXT_RETRIES;
        trace.append('error', {
          message: 'context_overflow',
          limit,
          outcome: retry ? 'retried' : 'gave_up',
        });
        if (retry) {
          contextRetries += 1;
          forceCompaction = true;
          l.warn({ endpoint, limit }, 'call refused for length; compacting and retrying once');
          continue;
        }
        stopReason = 'context_full';
        error = `context window full: ${estimateTokens(lastCall, sentChars, charsPerToken)} of ${limit} tokens`;
        break;
      }
      // Settled: from here until the next call, nothing the model does is
      // late — tools, forms and confirmations run on their own budgets (§9).
      disarmStall();
      lastCall = { tokensIn: turn.tokensIn, chars: sentChars };
      if (measurable) charsPerToken = measuredRatio(charsPerToken, sentChars, turn.tokensIn);

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
       * A `length` finish is never `done` (§20.11). The turn was cut off
       * mid-output, so its text is unfinished and any tool call it was
       * writing is incomplete: nothing in it runs, and what it streamed is
       * taken back. Once per run the loop compacts and asks again with a note
       * saying what happened and how much fits now; a second cut ends the
       * run `output_cut`. This holds with the window unknown too — only the
       * compaction and the room figure need a number. What the cut turn cost
       * still counts — it was spent.
       */
      if (turn.finishReason === 'length' && windowBound) {
        req.onRetract?.();
        const retry = lengthRetries < LENGTH_RETRIES;
        trace.append('error', {
          message: 'output_cut',
          tokens_out: turn.tokensOut,
          outcome: retry ? 'retried' : 'gave_up',
        });
        l.warn(
          {
            turn: turns,
            tokens_out: turn.tokensOut,
            window: W,
            dropped_calls: turn.toolCalls.length,
          },
          retry
            ? 'output cut off at the window; compacting and asking again'
            : 'output cut off twice',
        );
        if (retry) {
          lengthRetries += 1;
          cutTokensOut = turn.tokensOut;
          forceCompaction = true;
          continue;
        }
        stopReason = 'output_cut';
        error = 'output cut off at the context window';
        break;
      }

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
        const results: ToolMessage['content'] = [];
        for (const call of valid) {
          const startedAt = Date.now();
          req.onActivity?.({ kind: 'tool_call', tool: call.toolName, args: call.input });
          // The circling backstop (§20.7): an identical call repeated within a
          // run is a model that lost the thread — usually because the earlier
          // result was elided. Repeats execute, and say so only when the
          // answer really is the same as last time: a retry that worked after
          // a failure must not be told "the answer has not changed"
          // (2026-10-02). From the 4th, once two results in a row agreed, the
          // cached result is returned without touching the tool, because by
          // then the upstream answer is not the missing piece.
          const trivialArgs =
            !call.input ||
            typeof call.input !== 'object' ||
            Object.keys(call.input as object).length === 0;
          const repeatKey = trivialArgs ? null : `${call.toolName} ${stableJson(call.input)}`;
          const seen = repeatKey ? repeats.get(repeatKey) : undefined;
          let outcome: DispatchResult;
          if (seen && seen.count >= 3 && seen.settled) {
            seen.count += 1;
            outcome = {
              // A cached error is still an error on the trace (§20.7).
              ok: seen.ok,
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
                // Stop and timeout reach a call in flight, not just the next
                // turn: a form still waiting when the run ends is closed
                // rather than left on screen to write for nobody (§19.1).
                signal: controller.signal,
              });
            } catch (e) {
              // A dispatcher that throws is a bug, but the run should survive it.
              outcome = { ok: false, output: { error: 'tool_failed', message: errMessage(e) } };
            }
            if (seen) {
              seen.count += 1;
              const identical = stableJson(outcome.output) === stableJson(seen.output);
              seen.settled = identical;
              seen.output = outcome.output;
              seen.ok = outcome.ok;
              if (identical) {
                outcome = {
                  ...outcome,
                  output: {
                    repeated_call: true,
                    note: `identical to your earlier ${call.toolName} call this run — the answer has not changed`,
                    result: outcome.output,
                  },
                };
              }
            } else if (repeatKey) {
              repeats.set(repeatKey, {
                count: 1,
                output: outcome.output,
                ok: outcome.ok,
                settled: false,
              });
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
          // Learned once and remembered for the run: every later elision pass
          // walks the whole transcript, including this result (§20.4).
          if (outcome.neverElide) neverElide.add(call.toolName);
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
            // What the model was handed instead of the answer (§20.3). Without
            // it, a capped result and a tool that summarises by nature look
            // identical in the trace, and "how often does the cap bite, and on
            // what" stays a guess — which is how three shipped skills spent
            // weeks coming back cut in half unnoticed.
            ...(outcome.truncatedFrom !== undefined
              ? { truncated_from: outcome.truncatedFrom }
              : {}),
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
          /**
           * A skill body is delivered once per run (§20.11). The tool cannot
           * see the transcript, so the loop decides: a body already present
           * and unstubbed — earlier in the run, or earlier in this round —
           * reaches the model as a pointer to that copy. A body compaction
           * stubbed is no longer present, so a fetch after that delivers it
           * in full. The trace above already has the real result.
           */
          const delivered = dedupeSkill(
            call.toolName,
            outcome.output,
            loadedSkills([...messages, { role: 'tool', content: results }]),
          );
          results.push({
            type: 'tool-result' as const,
            toolCallId: call.toolCallId,
            toolName: call.toolName,
            output: { type: 'json' as const, value: delivered as never },
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
        /**
         * The silent turn (§20.10): a normal finish with nothing in it but
         * reasoning — no text, no tool call of any kind. `turn.text` rather
         * than the post-guard text, so a §20.8 strip that left nothing is not
         * mistaken for one: the guard has already dealt with that turn.
         */
        if (turn.finishReason === 'stop' && !turn.text.trim() && !turn.toolCalls.length) {
          // Only with a turn and token budget left — the loop-top checks —
          // so a nudge never buys a call the budgets would refuse anyway.
          const nudge =
            silentRetries < SILENT_TURN_RETRIES &&
            turns < budgets.maxTurns &&
            promptTokens + tokensOut < budgets.maxTokens;
          trace.append('error', {
            message: 'silent_turn',
            outcome: nudge ? 'nudged' : 'gave_up',
            reasoning_chars: turn.reasoningChars,
          });
          if (nudge) {
            silentRetries += 1;
            l.warn(
              { turn: turns, reasoning_chars: turn.reasoningChars },
              'model turn ended with reasoning only; nudging once',
            );
            messages.push({ role: 'user', content: SILENT_TURN_NOTE });
            continue;
          }
        }
        stopReason = 'stop';
        break;
      }
    }
  } catch (e) {
    // Keep what the cut-off turn had already said: the user watched it
    // arrive (§9). Stripped like any fresh output (§20.8) — this text died
    // before the guard could look at it.
    const salvage = () => {
      const partial = stripReservedMarkers(streamedThisTurn).trim();
      if (partial) {
        text = partial;
        spoken.push(partial);
      }
    };
    if (timedOut) {
      stopReason = 'timeout';
      error = `timeout after ${budgets.timeoutS}s`;
      salvage();
    } else if (stalled) {
      stopReason = 'stalled';
      error = `stalled: nothing streamed for ${stallS}s`;
      salvage();
    } else if (req.abortSignal?.aborted) {
      stopReason = 'aborted';
      error = 'aborted';
      salvage();
    } else {
      stopReason = 'error';
      error = errMessage(e);
      // Named even when the very first turn never got far enough to set
      // `endpoint` above (X1b) — a caller reporting this failure to a person
      // needs to say which endpoint it was.
      if (e instanceof ModelCallError) endpoint = e.endpoint;
      trace.append('error', { message: error });
    }
    l.warn({ stopReason, error }, 'agent run ended abnormally');
  } finally {
    clearTimeout(timer);
    disarmStall();
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
    ...(contextWindow ? { contextWindow } : {}),
    messages,
  };
  if (error) result.error = error;
  return result;
}

type ToolMessage = Extract<ModelMessage, { role: 'tool' }>;

/**
 * The prompt estimate (§20.11): the previous call's reported `tokens_in` plus
 * whatever the request has grown (or, after compaction, shrunk) by since, at
 * the run's chars-per-token ratio. A first call — or one after an endpoint
 * that reports no usage — has no anchor, so the whole request is estimated.
 */
function estimateTokens(
  last: { tokensIn: number; chars: number } | null,
  chars: number,
  ratio: number,
): number {
  if (last && last.tokensIn > 0) {
    const delta = chars - last.chars;
    // Growth is costed at the (pessimistic) ratio; what compaction removed
    // is credited at no more than the last request's own average, because
    // crediting it at the pessimistic ratio would claim more room than it
    // freed — the one direction where 3 is optimistic.
    const credit = Math.max(ratio, last.chars / last.tokensIn);
    return Math.max(0, last.tokensIn + Math.ceil(delta / (delta >= 0 ? ratio : credit)));
  }
  return Math.ceil(chars / ratio);
}

/** Does any message carry an image or file part (§26)? */
function hasBinaryParts(messages: ModelMessage[]): boolean {
  return messages.some(
    (m) =>
      Array.isArray(m.content) &&
      (m.content as { type: string }[]).some((p) => p.type === 'image' || p.type === 'file'),
  );
}

/**
 * `min(3, chars ÷ tokens)` (§20.11): the latest measurement, never above the
 * default. A call that reported no usage measures nothing and leaves it.
 */
function measuredRatio(current: number, chars: number, tokens: number): number {
  if (!(tokens > 0) || !(chars > 0)) return current;
  return Math.min(CHARS_PER_TOKEN, chars / tokens);
}

/**
 * How many characters a request carries: the system prompt, the transcript,
 * and the tool definitions. Binary parts (§26 image bytes) count as nothing —
 * serialized they would be an array of every byte, which is not what the
 * endpoint is sent and would read as a window full of digits.
 */
function requestChars(system: string, messages: ModelMessage[], tools: ToolSet): number {
  let chars = system.length;
  chars += (
    JSON.stringify(messages, function (this: Record<string, unknown>, key, value: unknown) {
      const raw = this[key];
      return raw instanceof Uint8Array || raw instanceof ArrayBuffer ? '' : value;
    }) ?? ''
  ).length;
  for (const [name, t] of Object.entries(tools)) {
    const schema = (t as { inputSchema?: { jsonSchema?: unknown } }).inputSchema;
    let shape = '';
    try {
      shape = JSON.stringify(schema?.jsonSchema ?? {}) ?? '';
    } catch {
      /* an unserializable schema still costs its name and description */
    }
    chars += name.length + (t.description?.length ?? 0) + shape.length;
  }
  return chars;
}

/** The loop's own wrappers (§20.7, §20.9): the real result rides in `result`. */
function unwrapResult(value: unknown): unknown {
  let v = value;
  while (
    v &&
    typeof v === 'object' &&
    !Array.isArray(v) &&
    'result' in v &&
    ('repeated_call' in v || 'repeated_write' in v || 'futile_streak' in v)
  ) {
    v = (v as { result: unknown }).result;
  }
  return v;
}

function deliveredSkill(
  tool: string,
  value: unknown,
): { name: string; content: string } | null {
  const v = unwrapResult(value) as Record<string, unknown> | null;
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const body = tool === 'skills.fetch' ? v : tool === 'tools.open' ? v.skill : null;
  if (!body || typeof body !== 'object') return null;
  const { name, content } = body as { name?: unknown; content?: unknown };
  return typeof name === 'string' && typeof content === 'string' ? { name, content } : null;
}

/**
 * The skills whose full body is in the transcript right now. A stubbed or
 * elided body is a marker string, so it is not here — which is what lets a
 * fetch after compaction deliver the body again.
 */
function loadedSkills(messages: ModelMessage[]): Set<string> {
  const names = new Set<string>();
  for (const m of messages) {
    if (m.role !== 'tool' || !Array.isArray(m.content)) continue;
    for (const part of m.content) {
      if (part.type !== 'tool-result' || part.output?.type !== 'json') continue;
      const skill = deliveredSkill(part.toolName, part.output.value);
      if (skill) names.add(skill.name);
    }
  }
  return names;
}

/**
 * The transcript form of a result that would deliver a skill body already
 * loaded (§20.11, F.12): `skills.fetch` becomes a pointer, `tools.open` drops
 * `skill` and names it instead. Anything else passes through untouched, and
 * the loop's own wrappers are kept, with the pointer inside.
 */
function dedupeSkill(tool: string, output: unknown, loaded: ReadonlySet<string>): unknown {
  if (!output || typeof output !== 'object' || Array.isArray(output)) return output;
  const o = output as Record<string, unknown>;
  if (unwrapResult(o) !== o) {
    const inner = dedupeSkill(tool, o.result, loaded);
    return inner === o.result ? output : { ...o, result: inner };
  }
  const skill = deliveredSkill(tool, o);
  if (!skill || !loaded.has(skill.name)) return output;
  if (tool === 'skills.fetch') {
    return {
      name: skill.name,
      already_loaded: true,
      note: 'this skill is already in your context above; use that copy',
    };
  }
  const { skill: _dropped, ...rest } = o;
  return { ...rest, skill_already_loaded: skill.name };
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
