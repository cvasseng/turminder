import type { RunGrantView } from './run-grants.js';
import type { ToolHandle } from './types.js';

/**
 * Frozen read-only calls (§23.2), shared by embed bindings and watchers (§30).
 *
 * The three refusals below are the entire security argument for replaying a
 * recorded call unattended: it must be a call that **exists**, is **read-only**,
 * and was **already available to the run doing the freezing**. You cannot
 * freeze what you could not call, so replaying it later grants nobody anything
 * they did not already have. Two copies of that argument is one copy too many,
 * which is why it lives here rather than in each caller.
 */

export type FrozenCallError =
  | { error: 'unknown_tool'; message: string; tool: string }
  | { error: 'not_ro'; message: string; tool: string }
  | { error: 'not_granted'; message: string; tool: string }
  | { error: 'no_prior_call'; message: string; tool: string }
  | { error: 'args_conflict'; message: string; tool: string };

export interface FrozenCallRequest {
  tool: string;
  args?: Record<string, unknown>;
  /** "Freeze the args of my most recent call to this tool" (§23.2). */
  args_from?: boolean;
  /** Prefix for error messages, e.g. `binding price` — omitted for watchers. */
  label?: string;
}

export interface FrozenCallDeps {
  tools: () => readonly ToolHandle[];
  /** The run's grant set. Null fails closed: the grant set of nothing is nothing. */
  grants: RunGrantView | null;
  /** The run's own most recent successful call to a tool, from the trace. */
  priorArgs?: (tool: string) => Record<string, unknown> | null;
}

/** Validate and resolve one frozen call, or say exactly why not. */
export function resolveFrozenCall(
  request: FrozenCallRequest,
  deps: FrozenCallDeps,
): { tool: string; args: Record<string, unknown>; handle: ToolHandle } | FrozenCallError {
  const where = request.label ? `${request.label}: ` : '';
  let args = request.args ?? {};
  if (request.args_from) {
    if (request.args && Object.keys(request.args).length) {
      return {
        error: 'args_conflict',
        message: `${where}give args OR args_from, not both`,
        tool: request.tool,
      };
    }
    const prior = deps.priorArgs?.(request.tool) ?? null;
    if (!prior) {
      return {
        error: 'no_prior_call',
        message:
          `${where}args_from needs a successful ${request.tool} call earlier in this run — ` +
          `call it once first (to see the data), or pass args explicitly`,
        tool: request.tool,
      };
    }
    args = prior;
  }

  const handle = deps.tools().find((t) => t.name === request.tool);
  if (!handle) {
    return {
      error: 'unknown_tool',
      message: `${where}there is no tool called ${request.tool}`,
      tool: request.tool,
    };
  }
  if (handle.tier !== 'ro') {
    return {
      error: 'not_ro',
      message: `${where}only read-only tools can be frozen; ${request.tool} has side effects`,
      tool: request.tool,
    };
  }
  if (!new Set(deps.grants?.granted() ?? []).has(request.tool)) {
    return {
      error: 'not_granted',
      message: `${where}${request.tool} is not something this run may call, so it cannot be frozen`,
      tool: request.tool,
    };
  }
  return { tool: request.tool, args, handle };
}

/**
 * Follow a dotted path into a result — the same syntax `{{data:name.path}}`
 * placeholders use (§23.2, §30.1). Missing anywhere is `undefined`, never a
 * throw: a path that does not fit the shape is an answer, not a crash.
 */
export function resolvePath(value: unknown, path: string): unknown {
  const segments = path.split('.').filter(Boolean);
  let current = value;
  for (const segment of segments) {
    if (current === null || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

/**
 * What a result looks like, without its contents — for the error that has to
 * explain why a `status_path` found nothing (§30.3). Keys and types only, so a
 * refusal can teach without quoting somebody's data back at them.
 */
export function shapeDigest(value: unknown, depth = 2): string {
  if (value === null) return 'null';
  if (Array.isArray(value))
    return depth <= 0 ? 'array' : `[${shapeDigest(value[0], depth - 1)}]`;
  if (typeof value !== 'object') return typeof value;
  if (depth <= 0) return 'object';
  const entries = Object.entries(value as Record<string, unknown>).slice(0, 12);
  return `{${entries.map(([k, v]) => `${k}: ${shapeDigest(v, depth - 1)}`).join(', ')}}`;
}
