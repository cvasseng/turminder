import type { ToolCallOutcome, ToolHandle } from './types.js';

/**
 * The transcript budget for one tool result (§20.3), applied at the hub
 * boundary so bundled integrations and external MCP servers are treated
 * identically — a 100k-char answer from someone else's MCP server is exactly
 * the case that would otherwise blow the context window.
 */
export const TRUNCATION_HINT =
  'result exceeded the transcript budget; refine the call (offset/limit/max_results) to fetch the part you need';

export interface CappedResult {
  /** What the transcript gets. */
  output: unknown;
  /** Set only when the cap fired: what the tool actually returned. */
  traceOutput?: unknown;
}

function serialize(output: unknown): string {
  if (typeof output === 'string') return output;
  try {
    return JSON.stringify(output) ?? '';
  } catch {
    // A result with a cycle in it cannot be a transcript entry anyway.
    return String(output);
  }
}

/**
 * Cap one result. Returns the original untouched when it fits, so the common
 * case allocates nothing and the trace keeps the identical object.
 */
export function capResult(output: unknown, maxChars: number): CappedResult {
  const serialized = serialize(output);
  if (serialized.length <= maxChars) return { output };
  return {
    output: {
      _truncated: true,
      total_chars: serialized.length,
      excerpt: serialized.slice(0, maxChars),
      hint: TRUNCATION_HINT,
    },
    traceOutput: output,
  };
}

/**
 * Wrap a handle so every result passes the budget. The wrapper is where the
 * order of operations from §20.3 is enforced: the capped form goes to the
 * agent loop's transcript, the original rides along as `traceOutput` for the
 * trace row and the activity summary.
 */
export function budgeted(handle: ToolHandle, defaultMaxChars: number): ToolHandle {
  // An override is only ever present on a bundled integration's handle
  // (§20.3): external servers do not get to raise their own ceiling.
  const max = handle.maxResultChars ?? defaultMaxChars;
  return {
    ...handle,
    async call(args, ctx): Promise<ToolCallOutcome> {
      const result = await handle.call(args, ctx);
      const capped = capResult(result.output, max);
      return {
        ok: result.ok,
        output: capped.output,
        // A handle that already carried a trace form keeps it; otherwise the
        // cap supplies one only when it actually truncated something.
        ...(result.traceOutput !== undefined
          ? { traceOutput: result.traceOutput }
          : capped.traceOutput !== undefined
            ? { traceOutput: capped.traceOutput }
            : {}),
      };
    },
  };
}
