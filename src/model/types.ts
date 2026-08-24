import type { ModelCap, ModelClass, ModelEffort } from '../core/config-schemas.js';

export type { ModelCap, ModelClass, ModelEffort };

/** Inference scheduler priorities (§10.3). Strict order, highest first. */
export type Priority = 'interactive' | 'event' | 'background';

export const PRIORITY_RANK: Record<Priority, number> = {
  interactive: 0,
  event: 1,
  background: 2,
};

/** Run kinds, mirroring the `runs.kind` check constraint (App. C). */
export type RunKind = 'ingress' | 'handler' | 'chat' | 'onboarding' | 'distill' | 'maintenance';

/** How a caller asks for a model: by class + required capabilities (§10.2). */
export interface ModelSelector {
  class?: ModelClass;
  caps?: ModelCap[];
  /** Explicit endpoint by name; bypasses class/caps routing. */
  endpoint?: string;
  /**
   * Reasoning level to ask for (§10.6). Reaches the wire only if the endpoint
   * that actually serves the call declares it — the selector may resolve
   * somewhere other than where the choice was made.
   */
  effort?: ModelEffort;
  /**
   * Why this selector looks the way it does (§10.6). The caller knows — the
   * router cannot — and every `llm_call` row records it, so "why did the big
   * model answer this?" is a query rather than archaeology.
   */
  resolvedBy?: 'override' | 'frontmatter' | 'kind_default';
}

export interface ResolvedEndpoint {
  name: string;
  url: string;
  apiKey?: string;
  /** Model id sent to the API; llama.cpp ignores it, other providers don't. */
  model: string;
  classes: ModelClass[];
  caps: ModelCap[];
  contextSize?: number;
  /** Reasoning levels this endpoint honors (§10.6, G.2); absent = the knob is
   *  never sent to it. */
  efforts?: ModelEffort[];
  /** Max concurrent in-flight calls (llama.cpp slots). Default 1. */
  concurrency: number;
  /**
   * Price per million tokens (§10.5, G.2). Absent means costless **by
   * declaration** — the local box — which is reported as `local`, never as a
   * zero that looks like a measurement.
   */
  cost?: { inPerMtok: number; outPerMtok: number; currency: string };
}

/**
 * What a call cost, at the prices configured when it ran (§10.5). Stamping
 * beats deriving: editing a price must not silently reprice history.
 */
export function callCost(
  endpoint: Pick<ResolvedEndpoint, 'cost'>,
  tokensIn: number,
  tokensOut: number,
): { cost: number; currency: string } | null {
  if (!endpoint.cost) return null;
  const cost =
    (tokensIn * endpoint.cost.inPerMtok) / 1e6 + (tokensOut * endpoint.cost.outPerMtok) / 1e6;
  return { cost, currency: endpoint.cost.currency };
}

/** Agent-loop budgets (§5.4, App. A). */
export interface Budgets {
  maxTurns: number;
  maxTokens: number;
  timeoutS: number;
}

/**
 * What a run is doing right now, for the human watching a chat stream. Purely
 * for feedback: activity is transient, never persisted, and never replayed —
 * the trace is the durable record.
 */
export type AgentActivity =
  | { kind: 'queued'; priority: Priority }
  | { kind: 'thinking'; turn: number }
  /** Live reasoning from a thinking model. Shown, never stored (§20.1). */
  | { kind: 'reasoning'; text: string }
  | { kind: 'recalled'; count: number; mode: string }
  | { kind: 'tool_call'; tool: string; args: unknown }
  | { kind: 'tool_result'; tool: string; ok: boolean; summary: string }
  /** Settled counts for one model call; `context_size` is the endpoint's limit. */
  | {
      kind: 'usage';
      turn: number;
      tokens_in: number;
      tokens_out: number;
      /** llama.cpp `timings.prompt_n` for this turn, when reported (§21.1). */
      prompt_evaluated?: number;
      context_size?: number;
      duration_ms: number;
      queue_wait_ms: number;
    }
  | { kind: 'stopped'; reason: string };

/** Trace row kinds (App. C). */
export type TraceKind =
  'verdict' | 'llm_call' | 'tool_call' | 'delivery' | 'emit' | 'state' | 'error';

/** Trace `data` shapes (App. C.1). */
export interface LlmCallTrace {
  model: string;
  priority: Priority;
  /** The endpoint that served it, and why it was chosen (§10.6, C.1). */
  endpoint?: string;
  requested_class?: string;
  resolved_by?: 'override' | 'frontmatter' | 'kind_default';
  /** Stamped at call time from the endpoint's G.2 pricing (§10.5). */
  cost?: number;
  currency?: string;
  queue_wait_ms: number;
  duration_ms: number;
  tokens_in: number;
  tokens_out: number;
  stop_reason: string;
  /** Reasoning produced, in characters (§20.1). Metrics only, never content. */
  reasoning_chars?: number;
  /**
   * llama.cpp `timings.prompt_n` — prompt tokens actually evaluated rather
   * than served from the KV cache (§21.1). Absent when the endpoint sent no
   * `timings` object, which is every non-llama.cpp endpoint.
   */
  prompt_evaluated?: number;
}

export interface ToolCallTrace {
  tool: string;
  args: unknown;
  ok: boolean;
  result_excerpt?: string;
  duration_ms: number;
  denied?: 'not_granted' | 'confirm_denied' | 'confirm_timeout';
  /** Set when a granted-but-closed call paged its namespace in (§21.2.4). */
  implicit_open?: string;
}

/**
 * Where trace rows go. The database implementation arrives with the event core
 * (phase 2); everything above this interface is testable without a database.
 */
export interface TraceSink {
  append(kind: TraceKind, data: unknown): void;
}

export const nullTraceSink: TraceSink = { append: () => {} };

/** Collects trace rows in memory — tests, dry runs, and the `ask` CLI. */
export class MemoryTraceSink implements TraceSink {
  readonly rows: { kind: TraceKind; data: unknown }[] = [];
  append(kind: TraceKind, data: unknown): void {
    this.rows.push({ kind, data });
  }
  ofKind(kind: TraceKind): unknown[] {
    return this.rows.filter((r) => r.kind === kind).map((r) => r.data);
  }
}
