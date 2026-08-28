import type { EventRecord } from '../db/repos/events.js';

/**
 * One row of the activity panel (§4.2.1, App. D.2). Deliberately not the event:
 * a payload is untrusted content (§1.1, H.2) and has no business crossing to a
 * screen, so what travels is what the *server* wrote about it — type, source,
 * the ingress summary, and where it is in the lifecycle.
 */
export interface EventStatusRow {
  id: string;
  type: string;
  source: string;
  summary: string | null;
  status: EventRecord['status'];
  attempts: number;
  next_attempt_at: string | null;
  received_at: string;
  last_error: string | null;
}

export function toStatusRow(event: EventRecord): EventStatusRow {
  return {
    id: event.id,
    type: event.type,
    source: event.source,
    summary: event.summary ?? null,
    status: event.status,
    attempts: event.attempts,
    next_attempt_at: event.next_attempt_at ?? null,
    received_at: event.received_at,
    last_error: event.last_error ?? null,
  };
}

/**
 * Fan-out for event lifecycle movement, with no idea what a socket is — the
 * activity panel subscribes here so a row does not go stale under the reader.
 *
 * Transient like the chat stream and `files.changed`: the durable record is the
 * `events` table itself, and a client that missed a push re-derives with
 * `event.list`. Nothing here is allowed to be the only copy of anything.
 */
export class EventFeed {
  private readonly listeners = new Set<(e: EventStatusRow) => void>();

  subscribe(listener: (e: EventStatusRow) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  moved(event: EventRecord): void {
    if (!this.listeners.size) return;
    const row = toStatusRow(event);
    for (const listener of this.listeners) listener(row);
  }
}
