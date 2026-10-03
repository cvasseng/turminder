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
  /** Set only when the cap fired: the full serialized length, for C.1. */
  truncatedFrom?: number;
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

type Json = Record<string, unknown>;

function isRecord(v: unknown): v is Json {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function sizeOf(v: unknown): number {
  return serialize(v).length;
}

/** The array-valued key of `obj` with the largest serialization, if any. */
function largestArrayKey(obj: Json): string | null {
  let best: string | null = null;
  let bestSize = -1;
  for (const [k, v] of Object.entries(obj)) {
    if (!Array.isArray(v) || v.length === 0) continue;
    const size = sizeOf(v);
    if (size > bestSize) {
      best = k;
      bestSize = size;
    }
  }
  return best;
}

/** Largest `kept` in [1, total-1] for which `build(kept)` fits, or 0 when none does. */
function fitKept(total: number, maxChars: number, build: (kept: number) => unknown): number {
  let lo = 0;
  let hi = total - 1;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (sizeOf(build(mid)) <= maxChars) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

function truncatedMarker(
  field: string,
  kept: number,
  total: number,
  dropped?: { field: string; count: number },
): Json {
  const leaf = field.split('.').pop()!;
  const more = dropped && dropped.count > 0 ? dropped : null;
  return {
    field,
    kept,
    total,
    hint:
      `${kept} of ${total} ${leaf} shown; narrow the call (a smaller window, max_results, a filter) to see the rest` +
      (more ? `; ${more.count} more ${more.field.split('.').pop()} not shown` : ''),
    ...(more ? { dropped: more } : {}),
  };
}

/**
 * Cut a list at whole items (§20.3), or return null when the output has no
 * list to cut or not even one item fits. Structure, not a per-tool rule:
 * the output itself, the largest array among its top-level keys, and — when
 * not even one item of that fits — the largest array one level inside its
 * first item (`sections.0.tasks`).
 */
function cutList(output: unknown, maxChars: number): unknown | null {
  let base: Json;
  let key: string;
  if (Array.isArray(output)) {
    // A bare array has nowhere to carry the marker; wrap it.
    base = { items: output };
    key = 'items';
  } else if (isRecord(output)) {
    const k = largestArrayKey(output);
    if (k === null) return null;
    base = output;
    key = k;
  } else {
    return null;
  }
  const list = base[key] as unknown[];

  const withTop = (kept: number): Json => ({
    ...base,
    [key]: list.slice(0, kept),
    _truncated: truncatedMarker(key, kept, list.length),
  });
  const kept = fitKept(list.length, maxChars, withTop);
  if (kept >= 1) return withTop(kept);

  // Not even one whole item fits: look one level inside the first item.
  const first = list[0];
  if (!isRecord(first)) return null;
  const inner = largestArrayKey(first);
  if (inner === null) return null;
  const innerList = first[inner] as unknown[];
  const withInner = (k: number): Json => ({
    ...base,
    [key]: [{ ...first, [inner]: innerList.slice(0, k) }],
    _truncated: truncatedMarker(`${key}.0.${inner}`, k, innerList.length, {
      field: key,
      count: list.length - 1,
    }),
  });
  const innerKept = fitKept(innerList.length, maxChars, withInner);
  return innerKept >= 1 ? withInner(innerKept) : null;
}

/**
 * Cap one result. Returns the original untouched when it fits, so the common
 * case allocates nothing and the trace keeps the identical object.
 */
export function capResult(output: unknown, maxChars: number): CappedResult {
  const serialized = serialize(output);
  if (serialized.length <= maxChars) return { output };
  const cut = cutList(output, maxChars);
  if (cut !== null) {
    return { output: cut, traceOutput: output, truncatedFrom: serialized.length };
  }
  return {
    output: {
      _truncated: true,
      total_chars: serialized.length,
      excerpt: serialized.slice(0, maxChars),
      hint: TRUNCATION_HINT,
    },
    traceOutput: output,
    truncatedFrom: serialized.length,
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
        // Whether the cap fired is this wrapper's own fact, and it is the only
        // thing that knows it: by the time the loop sees a result, a capped one
        // and a tool that always returned a summary look identical (C.1).
        ...(capped.truncatedFrom !== undefined ? { truncatedFrom: capped.truncatedFrom } : {}),
      };
    },
  };
}
