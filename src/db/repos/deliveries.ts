import type { Db } from '../index.js';
import { newId } from '../../core/ids.js';
import { isoPlusSeconds, nowIso } from '../../core/time.js';

export type DeliveryIntent = 'notify' | 'confirm';
export type DeliveryStatus = 'queued' | 'delivered' | 'acked' | 'expired';

export interface DeliveryRow {
  /** The resume cursor (§7.3): a free monotonic sequence. */
  seq: number;
  id: string;
  intent: DeliveryIntent;
  payload: string;
  created_at: string;
  expires_at: string;
  created_by_run: string | null;
  status: DeliveryStatus;
  delivered_at: string | null;
  acked_at: string | null;
  acked_by: string | null;
}

export interface Delivery extends Omit<DeliveryRow, 'payload'> {
  payload: Record<string, unknown>;
}

export interface NewDelivery {
  intent: DeliveryIntent;
  payload: Record<string, unknown>;
  ttlS: number;
  createdByRun?: string | null;
}

function toDelivery(row: DeliveryRow): Delivery {
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(row.payload) as Record<string, unknown>;
  } catch {
    payload = {};
  }
  return { ...row, payload };
}

/** The durable outbox (§7.1). Present in every deployment mode, bundled included. */
export class DeliveriesRepo {
  constructor(private readonly db: Db) {}

  create(input: NewDelivery): Delivery {
    const id = newId();
    const createdAt = nowIso();
    const expiresAt = isoPlusSeconds(input.ttlS);
    const info = this.db
      .prepare(
        `INSERT INTO deliveries (id, intent, payload, created_at, expires_at, created_by_run, status)
         VALUES (?, ?, ?, ?, ?, ?, 'queued')`,
      )
      .run(
        id,
        input.intent,
        JSON.stringify(input.payload),
        createdAt,
        expiresAt,
        input.createdByRun ?? null,
      );
    return {
      seq: Number(info.lastInsertRowid),
      id,
      intent: input.intent,
      payload: input.payload,
      created_at: createdAt,
      expires_at: expiresAt,
      created_by_run: input.createdByRun ?? null,
      status: 'queued',
      delivered_at: null,
      acked_at: null,
      acked_by: null,
    };
  }

  get(id: string): Delivery | null {
    const row = this.db.prepare(`SELECT * FROM deliveries WHERE id = ?`).get(id) as
      DeliveryRow | undefined;
    return row ? toDelivery(row) : null;
  }

  markDelivered(id: string): void {
    this.db
      .prepare(
        `UPDATE deliveries SET status = 'delivered', delivered_at = ?
          WHERE id = ? AND status = 'queued'`,
      )
      .run(nowIso(), id);
  }

  /** Any ack settles a delivery (§7.2). Unknown ids are ignored (App. D). */
  ack(id: string, device: string): Delivery | null {
    const existing = this.get(id);
    if (!existing) return null;
    this.db
      .prepare(
        `UPDATE deliveries SET status = 'acked', acked_at = ?, acked_by = ?
          WHERE id = ? AND status IN ('queued','delivered')`,
      )
      .run(nowIso(), device, id);
    return this.get(id);
  }

  /**
   * Unacked, unexpired deliveries after a device's cursor (§7.3). Anything
   * already past its TTL is marked expired here rather than replayed: a stale
   * "meeting in 10 minutes" is anti-useful.
   */
  replayFor(lastSeenSeq: number): { replay: Delivery[]; expired: number } {
    const now = nowIso();
    const candidates = this.db
      .prepare(
        `SELECT * FROM deliveries
          WHERE seq > ? AND status IN ('queued','delivered')
          ORDER BY seq ASC`,
      )
      .all(lastSeenSeq) as DeliveryRow[];
    const replay: Delivery[] = [];
    let expired = 0;
    for (const row of candidates) {
      if (row.expires_at <= now) {
        this.expire(row.id);
        expired += 1;
      } else {
        replay.push(toDelivery(row));
      }
    }
    return { replay, expired };
  }

  /**
   * Highest delivery seq each device has ever acked (§24.1) — the "is this
   * device still alive" column of a token listing. A device that never acked
   * anything is simply absent from the map; the caller reads that as 0.
   */
  lastSeenByDevice(): Record<string, number> {
    const rows = this.db
      .prepare(
        `SELECT acked_by AS device, MAX(seq) AS seq FROM deliveries
          WHERE acked_by IS NOT NULL GROUP BY acked_by`,
      )
      .all() as { device: string; seq: number }[];
    return Object.fromEntries(rows.map((r) => [r.device, r.seq]));
  }

  expire(id: string): void {
    this.db
      .prepare(
        `UPDATE deliveries SET status = 'expired' WHERE id = ? AND status IN ('queued','delivered')`,
      )
      .run(id);
  }

  /** Sweeps everything past its TTL; returns how many expired. */
  expireStale(now: string = nowIso()): number {
    return this.db
      .prepare(
        `UPDATE deliveries SET status = 'expired'
          WHERE status IN ('queued','delivered') AND expires_at <= ?`,
      )
      .run(now).changes;
  }

  pending(): Delivery[] {
    return (
      this.db
        .prepare(
          `SELECT * FROM deliveries WHERE status IN ('queued','delivered') ORDER BY seq ASC`,
        )
        .all() as DeliveryRow[]
    ).map(toDelivery);
  }

  /**
   * Deliveries still waiting on a person (§4.2.1): unsettled, unexpired, and
   * carrying at least one action to click. A notification with nothing to
   * press is something you read and move past; a `confirm` is a run suspended
   * until somebody answers it, and that is the row the activity panel exists
   * for.
   */
  awaitingAction(now = nowIso(), limit = 50): Delivery[] {
    return (
      this.db
        .prepare(
          `SELECT * FROM deliveries
            WHERE status IN ('queued','delivered') AND expires_at > ?
              AND json_array_length(json_extract(payload, '$.actions')) > 0
            ORDER BY seq DESC LIMIT ?`,
        )
        .all(now, limit) as DeliveryRow[]
    ).map(toDelivery);
  }

  recent(limit = 20): Delivery[] {
    return (
      this.db
        .prepare(`SELECT * FROM deliveries ORDER BY seq DESC LIMIT ?`)
        .all(limit) as DeliveryRow[]
    ).map(toDelivery);
  }
}
