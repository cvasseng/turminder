import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * llama.cpp prompt-cache visibility (§21.1).
 *
 * llama.cpp answers carry a non-standard `timings` object, and
 * `timings.prompt_n` is the number of prompt tokens it actually **evaluated** —
 * everything else came out of the KV cache. That single number is the
 * difference between "this conversation is expensive" and "this conversation
 * re-reads a cached prefix and costs almost nothing", and nothing in the
 * OpenAI-compatible shape reports it.
 *
 * Best-effort by construction: an endpoint that sends no `timings` yields no
 * stats, and that is a normal outcome, not an error. Nothing here may alter,
 * reorder, delay, or fail the response the SDK is reading.
 */

export interface TimingsSlot {
  /** `timings.prompt_n` from the last response observed on this slot. */
  promptEvaluated?: number;
}

const store = new AsyncLocalStorage<TimingsSlot>();

/**
 * Run `fn` with a slot the wrapped fetch can write into. The slot is captured
 * by closure when the request goes out, so a streaming response that finishes
 * after `fn`'s fetch call returned still lands in the right place.
 */
export function withTimings<T>(slot: TimingsSlot, fn: () => Promise<T>): Promise<T> {
  return store.run(slot, fn);
}

/**
 * Wrap a fetch so llama.cpp `timings` are harvested on the way past. Both
 * paths are read-only observers:
 *
 * - non-streaming: the response is cloned and the clone parsed, so the body the
 *   SDK reads is untouched;
 * - streaming: a `TransformStream` that passes every chunk through unchanged
 *   and merely looks at it. It enqueues before parsing, so nothing waits on
 *   this code.
 */
export function timingsFetch(inner: typeof globalThis.fetch): typeof globalThis.fetch {
  return async (input, init) => {
    const response = await inner(input, init);
    const slot = store.getStore();
    // No slot means nobody asked (a probe, a health check): stay out of the way.
    if (!slot || !response.body || !response.ok) return response;

    const type = response.headers.get('content-type') ?? '';
    if (type.includes('text/event-stream')) {
      return new Response(response.body.pipeThrough(sseObserver(slot)), {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });
    }

    try {
      const clone = response.clone();
      // Deliberately not awaited: the SDK gets its response now, and the clone
      // resolves whenever it resolves. A failure to parse is a non-event.
      void clone
        .json()
        .then((body: unknown) => readTimings(body, slot))
        .catch(() => {});
    } catch {
      // A body that cannot be cloned (already disturbed) simply yields no stats.
    }
    return response;
  };
}

/**
 * Passes SSE bytes through untouched while watching for the final chunk's
 * `timings`. Buffers only a partial trailing line, because a `data:` frame can
 * be split across network chunks and half a JSON object parses as nothing.
 */
function sseObserver(slot: TimingsSlot): TransformStream<Uint8Array, Uint8Array> {
  const decoder = new TextDecoder();
  let pending = '';
  const scan = (text: string) => {
    pending += text;
    const lines = pending.split('\n');
    // The last element is whatever came after the final newline: incomplete.
    pending = lines.pop() ?? '';
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('data:')) continue;
      const payload = trimmed.slice(5).trim();
      if (!payload || payload === '[DONE]') continue;
      try {
        readTimings(JSON.parse(payload), slot);
      } catch {
        // Not JSON, or JSON we do not recognise. Either way, not our problem.
      }
    }
    // A stream that never sends timings must not grow this buffer without
    // bound; a partial line is short by definition, but a pathological server
    // sending no newlines at all should not be able to exhaust memory.
    if (pending.length > 64 * 1024) pending = '';
  };

  return new TransformStream({
    transform(chunk, controller) {
      // Forward first, always. Observation happens after the consumer has it.
      controller.enqueue(chunk);
      try {
        scan(decoder.decode(chunk, { stream: true }));
      } catch {
        /* an undecodable chunk is still a chunk the SDK gets */
      }
    },
    flush() {
      try {
        scan(decoder.decode());
      } catch {
        /* nothing left to learn */
      }
    },
  });
}

/**
 * Reads `timings.prompt_n` out of one llama.cpp payload. Last writer wins: in a
 * stream, the chunk carrying `timings` is the final one.
 */
function readTimings(body: unknown, slot: TimingsSlot): void {
  const timings = (body as { timings?: unknown } | null)?.timings as
    { prompt_n?: unknown } | undefined;
  const n = timings?.prompt_n;
  if (typeof n === 'number' && Number.isFinite(n) && n >= 0) slot.promptEvaluated = n;
}
