import type { ToolSet } from 'ai';
import type { ToolCallTrace } from './types.js';

export interface DispatchCall {
  toolCallId: string;
  name: string;
  args: unknown;
  /**
   * The run's own abort (stop, timeout, failure). Handed to the tool as
   * `ToolContext.signal`, so a call the run has walked away from — a form
   * above all — is closed rather than left to write for nobody (§19.1).
   */
  signal?: AbortSignal;
}

export interface DispatchResult {
  ok: boolean;
  /** JSON-serialisable payload handed back to the model as the tool result. */
  output: unknown;
  /** Recorded on the trace when the call was refused rather than executed. */
  denied?: ToolCallTrace['denied'];
  /**
   * What the trace should record as `args`, when the raw arguments must not be
   * stored verbatim (App. F.9). Absent means "store them as they came".
   */
  traceArgs?: unknown;
  /**
   * What the trace should record as the result, when the transcript form was
   * capped (§20.3). Absent means `output` is the whole truth.
   */
  traceOutput?: unknown;
  /**
   * The result's full serialized length, when the §20.3 cap truncated it.
   * Recorded on the trace (C.1) so how often the cap bites is a query.
   */
  truncatedFrom?: number;
  /**
   * Leave this result out of the elision pass (§20.4) — a skill body is the
   * run's instructions, not data it can re-fetch without losing the thread.
   */
  neverElide?: boolean;
  /**
   * Content-bearing arg fields to stub out of the transcript now that the call
   * has run (§20.6). Present only on calls that actually executed — a refused
   * call stored nothing, and a stub claiming otherwise would be a lie.
   */
  bulkArgs?: readonly string[];
  /**
   * Did the call return nothing (§20.9)? Set by the dispatcher, counted by the
   * loop. Absent means "not known", which counts as not empty.
   */
  empty?: boolean;
  /**
   * The namespace a granted-but-closed call paged in on its way through
   * (§21.2.4). Recorded on the trace so "why did the toolset change" has an
   * answer; absent on every call that needed no such thing.
   */
  implicitOpen?: string;
}

/**
 * The enforcement point (§11.4). The agent loop can only call tools through a
 * dispatcher, and a dispatcher only exposes what the run was granted — so a
 * forged or hallucinated call cannot reach an implementation.
 */
export interface ToolDispatcher {
  toolSet(): ToolSet;
  dispatch(call: DispatchCall): Promise<DispatchResult>;
}

/** No tools at all — the ingress agent's dispatcher (§5.3), and the default. */
export const emptyDispatcher: ToolDispatcher = {
  toolSet: () => ({}),
  dispatch: async () => ({
    ok: false,
    output: { error: 'unknown_tool' },
    denied: 'not_granted',
  }),
};
