import type {
  ModelCap,
  ModelClass,
  ModelEffort,
  ModelEndpointKind,
} from '../core/config-schemas.js';
import type { Purpose } from './routes.js';

export type { ModelCap, ModelClass, ModelEffort, ModelEndpointKind };
export type { Purpose };

/** Inference scheduler priorities (§10.3). Strict order, highest first. */
export type Priority = 'interactive' | 'event' | 'background';

export const PRIORITY_RANK: Record<Priority, number> = {
  interactive: 0,
  event: 1,
  background: 2,
};

/** Run kinds, mirroring the `runs.kind` check constraint (App. C). */
export type RunKind = 'ingress' | 'handler' | 'chat' | 'onboarding' | 'distill' | 'maintenance';

/**
 * A caller-supplied override that beats the route (§10.6 steps 1–2): the
 * conversation's model override, or a handler's frontmatter. `by` says which,
 * because the two differ in what they may pin — an override always names an
 * exact endpoint (it came from the model selector, which only ever offers
 * endpoints), a frontmatter pin may instead name a class.
 */
export type Pin =
  | { endpoint: string; by: 'override' }
  | { endpoint?: string; class?: ModelClass; by: 'frontmatter' };

/** How a caller asks for a model: who is asking, plus required capabilities
 *  and an optional pin (§10.6). The router decides everything else. */
export interface ModelSelector {
  /** Who is asking (§10.6 vocabulary, `src/model/routes.ts`) — required, so
   *  a call that forgets to say who it is fails to compile rather than
   *  silently routing on a guess. */
  purpose: Purpose;
  caps?: ModelCap[];
  /**
   * Reasoning level to ask for (§10.6). Reaches the wire only if the endpoint
   * that actually serves the call declares it — the selector may resolve
   * somewhere other than where the choice was made.
   */
  effort?: ModelEffort;
  /** Beats the route when present (§10.6 steps 1–2). */
  pin?: Pin;
}

export interface ResolvedEndpoint {
  name: string;
  url: string;
  apiKey?: string;
  /** Model id sent to the API; llama.cpp ignores it, other providers don't. */
  model: string;
  /** What this endpoint does (§10.1, §10.6, §10.9, G.2). A `chat` selector never
   *  resolves to an `embedding`, `stt` or `tts` endpoint —
   *  `ModelRouter.chatEndpoints()` filters them out before any chat surface
   *  sees the list. */
  kind: ModelEndpointKind;
  classes: ModelClass[];
  caps: ModelCap[];
  contextSize?: number;
  /** Reasoning levels this endpoint honors (§10.6, G.2); absent = the knob is
   *  never sent to it. */
  efforts?: ModelEffort[];
  /** How `none` travels to this endpoint (§10.6, G.2 `no_think`); absent means
   *  the default fragment, `{reasoning_effort: "none"}`. */
  noThink?: Record<string, unknown>;
  /** Max concurrent in-flight calls (llama.cpp slots). Default 1. */
  concurrency: number;
  /**
   * Price, in the unit its kind is sold in (§10.5, §10.9, G.2): tokens for
   * `chat`, minutes of audio for `stt`, thousands of characters for `tts`.
   * Absent means costless **by declaration** — the local box — which is
   * reported as `local`, never as a zero that looks like a measurement.
   */
  cost?: EndpointCost;
  /** The voice a `tts` endpoint speaks with (§33.5, G.2). */
  voice?: string;
  /** The language an `stt` endpoint transcribes (§10.9, G.2); `auto` means the
   *  parameter is omitted and the transcriber detects. */
  language?: string;
}

/** The three prices, discriminated by which field is present — the shape
 *  `ModelCostSchema` parses, camel-cased for the resolved endpoint. */
export type EndpointCost =
  | { inPerMtok: number; outPerMtok: number; currency: string }
  | { perMinute: number; currency: string }
  | { perKchar: number; currency: string };

/** What `EmbeddingClient` needs from an endpoint (§8.3) — the embedding-kind
 *  slice of `ResolvedEndpoint`, so `ModelRouter.embedding()`'s result passes
 *  straight through without a second shape to keep in sync. */
export type EmbeddingEndpoint = Pick<ResolvedEndpoint, 'url' | 'model' | 'apiKey'>;

/**
 * What a call cost, at the prices configured when it ran (§10.5). Stamping
 * beats deriving: editing a price must not silently reprice history.
 */
export function callCost(
  endpoint: Pick<ResolvedEndpoint, 'cost'>,
  tokensIn: number,
  tokensOut: number,
): { cost: number; currency: string } | null {
  const price = endpoint.cost;
  if (!price || !('inPerMtok' in price)) return null;
  const cost = (tokensIn * price.inPerMtok) / 1e6 + (tokensOut * price.outPerMtok) / 1e6;
  return { cost, currency: price.currency };
}

/** What a transcription cost (§10.9): seconds of audio at the `stt` endpoint's
 *  per-minute price. Same stamping rule as `callCost` — the price at call time. */
export function transcribeCost(
  endpoint: Pick<ResolvedEndpoint, 'cost'>,
  audioSeconds: number,
): { cost: number; currency: string } | null {
  const price = endpoint.cost;
  if (!price || !('perMinute' in price)) return null;
  return { cost: (audioSeconds / 60) * price.perMinute, currency: price.currency };
}

/** What a spoken sentence cost (§10.9): characters at the `tts` endpoint's
 *  per-thousand-characters price. */
export function speakCost(
  endpoint: Pick<ResolvedEndpoint, 'cost'>,
  chars: number,
): { cost: number; currency: string } | null {
  const price = endpoint.cost;
  if (!price || !('perKchar' in price)) return null;
  return { cost: (chars / 1000) * price.perKchar, currency: price.currency };
}

/**
 * A price rendered for a human (§10.5, §10.9): tokens, minutes, or thousands
 * of characters, whichever unit the endpoint's kind is sold in. `local` for an
 * endpoint that declared no price — unpriced and free are different claims,
 * and `0.00` would state the wrong one.
 */
export function priceLabel(cost: EndpointCost | undefined): string {
  if (!cost) return 'local';
  if ('inPerMtok' in cost)
    return `${cost.inPerMtok}/${cost.outPerMtok} ${cost.currency} per Mtok`;
  if ('perMinute' in cost) return `${cost.perMinute} ${cost.currency} per minute`;
  return `${cost.perKchar} ${cost.currency} per kchar`;
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
  /**
   * The run is suspended on a human confirmation (§11.3) and will stay there
   * until somebody answers or the App. A timeout deems it denied. Until this
   * existed, a suspended run looked exactly like a slow one — which is fine on
   * a screen showing the confirm card and useless to `/api/voice`, which has
   * to say "I need your approval on a screen" and hang up rather than hold an
   * HTTP response open for an hour (§33.2).
   */
  | { kind: 'awaiting_confirm'; tool: string }
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
  /** Who asked (§10.6). Every row from the M2-and-later gateway carries this;
   *  rows written before it simply lack it (C.1). */
  purpose?: Purpose;
  /** The endpoint that served it, and why it was chosen (§10.6, C.1). */
  endpoint?: string;
  requested_class?: string;
  resolved_by?: 'override' | 'frontmatter' | 'route' | 'kind_default';
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
  /** Seconds of audio transcribed, on a `purpose: stt` row (§10.9, C.1). */
  audio_s?: number;
  /** Characters spoken, on a `purpose: tts` row (§10.9, C.1). */
  chars?: number;
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
