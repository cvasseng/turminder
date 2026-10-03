import type { z } from 'zod';

/** Read-only tools may auto-execute; side-effecting tools are gated (§11.3). */
export type ToolTier = 'ro' | 'se';

/**
 * Ambient per-run context. It travels as MCP request `_meta`, never as tool
 * arguments: provenance is stamped by the dispatcher, never model-supplied
 * (App. F.4).
 */
export interface ToolContext {
  runId: string | null;
  eventId: string | null;
  conversationId?: string | null;
  handlerName?: string | null;
  /**
   * Fires when whoever made this call has stopped waiting for it: the
   * transport timed out, or the run was stopped, timed out or failed (§19.1).
   * Not provenance and not `_meta` — it crosses the MCP transport as the
   * protocol's own `notifications/cancelled`, and arrives on the serving side
   * as that request's signal. A tool that waits on a human hands it to the
   * form broker, which is what stops an abandoned form from ever writing.
   */
  signal?: AbortSignal;
}

export const META_KEY = 'turminder';

/** How a bundled integration is authored (§11.1). Validated with zod at the edge. */
export interface ToolDefinition<A = any> {
  /** `<integration>.<verb>` (App. F). */
  name: string;
  description: string;
  tier: ToolTier;
  args: z.ZodType<A>;
  /**
   * Raise this tool's transcript budget above `tool_result_max_chars` (§20.3).
   * For tools whose *job* is returning a document, called with explicit
   * limits. External MCP tools never get an override.
   */
  maxResultChars?: number;
  /**
   * Keep this tool's results out of the §20.4 elision pass. For the one kind
   * of result that is not data but *instructions* — a skill body the run is
   * meant to be following. Eliding those trades a stale-data saving the run
   * never wanted for a re-fetch that costs a whole turn and, worse, sends the
   * model back to re-read its brief mid-task. Declare it nowhere else: every
   * other large result is exactly what elision is for.
   */
  neverElide?: boolean;
  /**
   * This call waits on a person — it raises a form (§19.1) — and returns the
   * longest that wait may take, in seconds, read at call time so a reload of
   * `form_timeout_s` applies. The transport then waits that long plus the
   * ordinary tool budget for the effect (App. A), instead of giving up at the
   * tool-call timeout while the human is still typing. Declare it only on a
   * tool that genuinely suspends on an answer; everything else keeps the
   * ceiling that makes a hung tool fail.
   */
  awaitsHuman?(): number;
  /**
   * Did this result contain nothing (§20.9)? A **structural** fact the tool
   * declares — zero matches, zero results, no entries — never a judgement
   * about usefulness, which stays with the model. The loop counts consecutive
   * empties per namespace and eventually says so; a tool that does not declare
   * this falls back to "an `{error}` return counts as empty, nothing else".
   */
  isEmpty?(result: unknown): boolean;
  /**
   * Arg fields that carry authored content (§20.6). After the call runs they
   * are stubbed out of the transcript, so an artifact is paid for once as
   * output tokens and never again as context. Name only the fields whose value
   * can be read back with another tool.
   */
  bulkArgs?: readonly string[];
  /**
   * Say what this call will do, for the person being asked to approve it
   * (§7.3, App. D.3). The generic humaniser reads this tool's description and
   * schema and is right for nearly everything — declare this only where that
   * reads badly, never for symmetry.
   *
   * `action` completes the sentence "<who> wants to …"; naming the actor is
   * not the tool's business, because a handler-gated call has to say *which
   * handler* is asking. Display text only: never a secret, never a value the
   * model wrote about itself.
   */
  confirmSummary?(args: A): ConfirmLines;
  /**
   * What a successful call changed, in one terse phrase for the run record
   * (§20.2): `created embed <id> "<title>" (persistent; bindings: a, b)`,
   * `wrote <path>`. The next run reads it in place of the payload, so ids are
   * written whole and first, and the phrase is at most 120 chars. Called only
   * for a `se` call that did not return `{error}`, with the tool's real result
   * (not the transcript's capped form). `null` = this call changed nothing
   * worth naming, and it is listed as used instead. A `se` tool that declares
   * none gets `<tool> <target>`; declare it wherever a phrase beats that.
   */
  effect?(args: A, result: any): string | null;
  execute(args: A, ctx: ToolContext): Promise<unknown>;
}

/** A tool's own words for a confirmation dialog (§7.3). */
export interface ConfirmLines {
  action: string;
  lines: { label: string; value: string }[];
}

/**
 * What the agent layer sees: one shape for bundled integrations and external
 * MCP servers alike (§11.1).
 */
export interface ToolHandle {
  name: string;
  description: string;
  tier: ToolTier;
  /** JSON Schema, as advertised by the MCP server. */
  inputSchema: Record<string, unknown>;
  /** Which connection serves it — an integration name or an MCP server name. */
  source: string;
  /** Per-tool transcript budget (§20.3); bundled integrations only. */
  maxResultChars?: number;
  /** Exempt from elision (§20.4); bundled integrations only — never MCP. */
  neverElide?: boolean;
  /** Structural emptiness (§20.9); bundled integrations only — never MCP. */
  isEmpty?(result: unknown): boolean;
  /** Content-bearing arg fields to stub after execution (§20.6). */
  bulkArgs?: readonly string[];
  /** This tool's own words for an approval dialog (§7.3); bundled only. */
  confirmSummary?(args: unknown): ConfirmLines;
  /** The run-record phrase for a successful call (§20.2); bundled only. */
  effect?(args: unknown, result: unknown): string | null;
  call(args: unknown, ctx: ToolContext): Promise<ToolCallOutcome>;
}

export interface ToolCallOutcome {
  ok: boolean;
  /** What goes into the transcript — capped at the hub boundary (§20.3). */
  output: unknown;
  /**
   * What the tool actually returned, when the transcript form was capped.
   * The trace and the activity summary must show this, not the excerpt: a
   * trace that records our truncation instead of the tool's answer is a trace
   * that cannot answer "what did the tool say".
   */
  traceOutput?: unknown;
  /**
   * The full serialized length, when the §20.3 cap fired — so how often the
   * cap bites, and how hard, is a query rather than a guess (C.1). Set only by
   * the cap itself: a tool that supplies its own `traceOutput` for other
   * reasons has truncated nothing.
   */
  truncatedFrom?: number;
}
