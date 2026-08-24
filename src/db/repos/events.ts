import type { Db } from '../index.js';
import { newId } from '../../core/ids.js';
import { nowIso } from '../../core/time.js';

export type EventStatus =
  'received' | 'matched' | 'processing' | 'done' | 'failed' | 'dead_letter' | 'rejected';

export interface EventRow {
  id: string;
  type: string;
  source: string;
  occurred_at: string | null;
  received_at: string;
  payload: string;
  summary: string | null;
  idempotency_key: string | null;
  serialization_key: string | null;
  caused_by: string | null;
  depth: number;
  status: EventStatus;
  attempts: number;
  next_attempt_at: string | null;
  last_error: string | null;
}

/** The §4.1 envelope, payload parsed. */
export interface EventRecord extends Omit<EventRow, 'payload'> {
  payload: unknown;
}

export interface NewEventInput {
  type: string;
  source: string;
  payload: unknown;
  occurred_at?: string | null;
  idempotency_key?: string | null;
  serialization_key?: string | null;
  caused_by?: string | null;
  depth?: number;
  status?: EventStatus;
}

function toRecord(row: EventRow): EventRecord {
  let payload: unknown;
  try {
    payload = JSON.parse(row.payload);
  } catch {
    payload = { _unparsable: row.payload };
  }
  return { ...row, payload };
}

export class EventsRepo {
  constructor(private readonly db: Db) {}

  /**
   * Insert an event. Duplicate (source, idempotency_key) is not an error: the
   * existing event is returned and the caller is told it was a duplicate (§4.1).
   */
  insert(input: NewEventInput): { event: EventRecord; duplicate: boolean } {
    if (input.idempotency_key) {
      const existing = this.byIdempotency(input.source, input.idempotency_key);
      if (existing) return { event: existing, duplicate: true };
    }
    const row: EventRow = {
      id: newId(),
      type: input.type,
      source: input.source,
      occurred_at: input.occurred_at ?? null,
      received_at: nowIso(),
      payload: JSON.stringify(input.payload ?? {}),
      summary: null,
      idempotency_key: input.idempotency_key ?? null,
      serialization_key: input.serialization_key ?? null,
      caused_by: input.caused_by ?? null,
      depth: input.depth ?? 0,
      status: input.status ?? 'received',
      attempts: 0,
      next_attempt_at: null,
      last_error: null,
    };
    try {
      this.db
        .prepare(
          `INSERT INTO events (id, type, source, occurred_at, received_at, payload, summary,
             idempotency_key, serialization_key, caused_by, depth, status, attempts,
             next_attempt_at, last_error)
           VALUES (@id, @type, @source, @occurred_at, @received_at, @payload, @summary,
             @idempotency_key, @serialization_key, @caused_by, @depth, @status, @attempts,
             @next_attempt_at, @last_error)`,
        )
        .run(row);
    } catch (e) {
      // Lost a race on the unique index: treat as the duplicate it is.
      if (input.idempotency_key) {
        const existing = this.byIdempotency(input.source, input.idempotency_key);
        if (existing) return { event: existing, duplicate: true };
      }
      throw e;
    }
    return { event: toRecord(row), duplicate: false };
  }

  get(id: string): EventRecord | null {
    const row = this.db.prepare(`SELECT * FROM events WHERE id = ?`).get(id) as
      EventRow | undefined;
    return row ? toRecord(row) : null;
  }

  byIdempotency(source: string, key: string): EventRecord | null {
    const row = this.db
      .prepare(`SELECT * FROM events WHERE source = ? AND idempotency_key = ?`)
      .get(source, key) as EventRow | undefined;
    return row ? toRecord(row) : null;
  }

  setStatus(
    id: string,
    status: EventStatus,
    extra: {
      attempts?: number;
      next_attempt_at?: string | null;
      last_error?: string | null;
    } = {},
  ): void {
    const sets = ['status = @status'];
    if (extra.attempts !== undefined) sets.push('attempts = @attempts');
    if (extra.next_attempt_at !== undefined) sets.push('next_attempt_at = @next_attempt_at');
    if (extra.last_error !== undefined) sets.push('last_error = @last_error');
    this.db.prepare(`UPDATE events SET ${sets.join(', ')} WHERE id = @id`).run({
      id,
      status,
      attempts: extra.attempts ?? null,
      next_attempt_at: extra.next_attempt_at ?? null,
      last_error: extra.last_error ?? null,
    });
  }

  setSummary(id: string, summary: string): void {
    this.db.prepare(`UPDATE events SET summary = ? WHERE id = ?`).run(summary, id);
  }

  /**
   * Events eligible to run now: fresh arrivals and retries whose backoff has
   * elapsed, oldest first (ULIDs sort chronologically).
   */
  eligible(now: string, limit = 50): EventRecord[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM events
          WHERE status IN ('received','failed')
            AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
          ORDER BY id ASC
          LIMIT ?`,
      )
      .all(now, limit) as EventRow[];
    return rows.map(toRecord);
  }

  /**
   * The oldest non-terminal event for a serialization key. Strict per-key
   * ordering (§4.4) means a later event may not overtake an earlier one that is
   * still waiting — including one waiting out a retry backoff.
   */
  oldestPending(serializationKey: string): string | null {
    const row = this.db
      .prepare(
        `SELECT id FROM events
          WHERE serialization_key = ?
            AND status IN ('received','failed','processing','matched')
          ORDER BY id ASC LIMIT 1`,
      )
      .get(serializationKey) as { id: string } | undefined;
    return row?.id ?? null;
  }

  /** Earliest scheduled retry, so the queue can sleep exactly long enough. */
  nextRetryAt(): string | null {
    const row = this.db
      .prepare(
        `SELECT MIN(next_attempt_at) AS at FROM events
          WHERE status = 'failed' AND next_attempt_at IS NOT NULL`,
      )
      .get() as { at: string | null } | undefined;
    return row?.at ?? null;
  }

  /**
   * Anything left `processing` belongs to a previous life of the process
   * (single writer, §12.2). Hand them back to the queue.
   */
  requeueOrphaned(): number {
    const r = this.db
      .prepare(
        `UPDATE events SET status = 'failed', next_attempt_at = NULL,
           last_error = COALESCE(last_error, 'interrupted by restart')
         WHERE status IN ('processing','matched')`,
      )
      .run();
    return r.changes;
  }

  recent(opts: { limit?: number; status?: EventStatus; type?: string } = {}): EventRecord[] {
    const where: string[] = [];
    const args: unknown[] = [];
    if (opts.status) {
      where.push('status = ?');
      args.push(opts.status);
    }
    if (opts.type) {
      where.push('type GLOB ?');
      args.push(opts.type);
    }
    const rows = this.db
      .prepare(
        `SELECT * FROM events ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
          ORDER BY id DESC LIMIT ?`,
      )
      .all(...args, opts.limit ?? 20) as EventRow[];
    return rows.map(toRecord);
  }

  /** Events newer than the given id, oldest first — the `tail` cursor. */
  since(afterId: string, limit = 100): EventRecord[] {
    const rows = this.db
      .prepare(`SELECT * FROM events WHERE id > ? ORDER BY id ASC LIMIT ?`)
      .all(afterId, limit) as EventRow[];
    return rows.map(toRecord);
  }

  latestId(): string | null {
    const row = this.db.prepare(`SELECT MAX(id) AS id FROM events`).get() as
      { id: string | null } | undefined;
    return row?.id ?? null;
  }

  countsByStatus(): Record<string, number> {
    const rows = this.db
      .prepare(`SELECT status, COUNT(*) AS n FROM events GROUP BY status`)
      .all() as { status: string; n: number }[];
    return Object.fromEntries(rows.map((r) => [r.status, r.n]));
  }

  /** The provenance chain, newest first: this event, its cause, and so on (§5.5). */
  chain(id: string, maxHops = 32): EventRecord[] {
    const out: EventRecord[] = [];
    let cursor: string | null = id;
    while (cursor && out.length < maxHops) {
      const ev = this.get(cursor);
      if (!ev) break;
      out.push(ev);
      cursor = ev.caused_by;
    }
    return out;
  }
}
