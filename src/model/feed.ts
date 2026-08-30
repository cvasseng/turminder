import type { CallRow } from '../db/repos/trace.js';

export type { CallRow };

/**
 * Fan-out for new `llm_call` rows, with no idea what a socket is — the request
 * log subscribes here so a row does not go stale under the reader.
 *
 * Transient like the chat stream and the activity panel (§4.2.1, §10.8): the
 * durable record is the `trace` table itself, and a client that missed a push
 * re-derives with `calls.list`. Nothing here is allowed to be the only copy
 * of anything. Modelled on `src/ingress/feed.ts`'s `EventFeed`.
 */
export class CallFeed {
  private readonly listeners = new Set<(row: CallRow) => void>();

  subscribe(listener: (row: CallRow) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  made(row: CallRow): void {
    if (!this.listeners.size) return;
    for (const listener of this.listeners) listener(row);
  }
}

/**
 * The one place a `CallRow` becomes the wire shape (App. D.1/D.2 `calls.list`,
 * `calls.list.result`, `call.made`) — used by both the list read and the live
 * push, so they cannot drift apart into carrying different fields. Named
 * explicitly rather than a spread: a field added to `CallRow` later must be
 * added here on purpose before it rides the wire.
 */
export function toCallFrame(row: CallRow): CallRow {
  return {
    seq: row.seq,
    at: row.at,
    purpose: row.purpose,
    endpoint: row.endpoint,
    tokens_in: row.tokens_in,
    tokens_out: row.tokens_out,
    ...(row.cost !== undefined ? { cost: row.cost } : {}),
    ...(row.currency !== undefined ? { currency: row.currency } : {}),
    duration_ms: row.duration_ms,
    stop_reason: row.stop_reason,
    resolved_by: row.resolved_by,
  };
}
