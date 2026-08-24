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
  execute(args: A, ctx: ToolContext): Promise<unknown>;
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
  /** Structural emptiness (§20.9); bundled integrations only — never MCP. */
  isEmpty?(result: unknown): boolean;
  /** Content-bearing arg fields to stub after execution (§20.6). */
  bulkArgs?: readonly string[];
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
}
