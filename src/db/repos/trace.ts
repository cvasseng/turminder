import type { Db } from '../index.js';
import { nowIso } from '../../core/time.js';
import type { TraceKind, TraceSink } from '../../model/types.js';

export interface TraceRow {
  seq: number;
  event_id: string | null;
  run_id: string | null;
  at: string;
  kind: TraceKind;
  data: string;
}

export interface TraceEntry extends Omit<TraceRow, 'data'> {
  data: unknown;
}

function toEntry(row: TraceRow): TraceEntry {
  let data: unknown;
  try {
    data = JSON.parse(row.data);
  } catch {
    data = { _unparsable: row.data };
  }
  return { ...row, data };
}

/**
 * The trace table (§13.1). Every subsystem writes here through a bound sink, so
 * a trace row can never be attributed to the wrong event or run by accident.
 */
export class TraceRepo {
  constructor(private readonly db: Db) {}

  append(
    kind: TraceKind,
    data: unknown,
    ctx: { eventId?: string | null; runId?: string | null } = {},
  ): void {
    this.db
      .prepare(`INSERT INTO trace (event_id, run_id, at, kind, data) VALUES (?, ?, ?, ?, ?)`)
      .run(ctx.eventId ?? null, ctx.runId ?? null, nowIso(), kind, JSON.stringify(data ?? {}));
  }

  /** A TraceSink pinned to one event/run — what the agent loop is handed. */
  sink(ctx: { eventId?: string | null; runId?: string | null }): TraceSink {
    return { append: (kind, data) => this.append(kind, data, ctx) };
  }

  forEvent(eventId: string): TraceEntry[] {
    return (
      this.db
        .prepare(`SELECT * FROM trace WHERE event_id = ? ORDER BY seq ASC`)
        .all(eventId) as TraceRow[]
    ).map(toEntry);
  }

  /**
   * The args of the most recent *successful* call to one tool in one run —
   * what `embeds.bind`'s `args_from` resolves against (§23.2). The trace keeps
   * originals by design, so this is immune to transcript elision: the model
   * references the call, the server moves the bytes.
   */
  lastToolCallArgs(runId: string, tool: string): Record<string, unknown> | null {
    const rows = this.db
      .prepare(
        `SELECT data FROM trace WHERE run_id = ? AND kind = 'tool_call' ORDER BY seq DESC`,
      )
      .all(runId) as { data: string }[];
    for (const row of rows) {
      try {
        const d = JSON.parse(row.data) as {
          tool?: unknown;
          ok?: unknown;
          args?: unknown;
        };
        if (d.tool !== tool || d.ok === false) continue;
        if (d.args && typeof d.args === 'object' && !Array.isArray(d.args)) {
          return d.args as Record<string, unknown>;
        }
      } catch {
        /* a malformed row is not the caller's problem */
      }
    }
    return null;
  }

  /**
   * What a set of runs cost, from the `llm_call` rows they wrote (§10.5). The
   * ledger is a query, never a table: rows are stamped at call time and kept
   * forever (C.2), so editing a price cannot reprice history.
   *
   * Mixed currencies come back grouped rather than added — pretending USD and
   * NOK are the same number is worse than two lines.
   */
  costForRuns(runIds: readonly string[]): { cost: number; currency: string }[] {
    if (!runIds.length) return [];
    const holes = runIds.map(() => '?').join(',');
    const rows = this.db
      .prepare(
        `SELECT json_extract(data, '$.currency') AS currency,
                SUM(json_extract(data, '$.cost')) AS cost
           FROM trace
          WHERE kind = 'llm_call' AND run_id IN (${holes})
            AND json_extract(data, '$.cost') IS NOT NULL
          GROUP BY currency`,
      )
      .all(...runIds) as { currency: string; cost: number }[];
    return rows.map((r) => ({ cost: r.cost, currency: r.currency }));
  }

  /**
   * The usage ledger (§10.5, F.17): every `llm_call` row in a window, grouped.
   * Costless endpoints contribute tokens and no money, which is why cost is
   * summed separately from the call count.
   */
  usage(opts: {
    from?: string | null;
    to?: string | null;
    groupBy: 'endpoint' | 'kind' | 'none';
  }): {
    key: string;
    calls: number;
    tokens_in: number;
    tokens_out: number;
    cost: number | null;
    currency: string | null;
  }[] {
    const where: string[] = [`t.kind = 'llm_call'`];
    const params: unknown[] = [];
    if (opts.from) {
      where.push('t.at >= ?');
      params.push(opts.from);
    }
    if (opts.to) {
      where.push('t.at <= ?');
      params.push(opts.to);
    }
    const keyExpr =
      opts.groupBy === 'endpoint'
        ? `COALESCE(json_extract(t.data, '$.endpoint'), json_extract(t.data, '$.model'), 'unknown')`
        : opts.groupBy === 'kind'
          ? `COALESCE(r.kind, 'unknown')`
          : `'all'`;
    return this.db
      .prepare(
        `SELECT ${keyExpr} AS key,
                json_extract(t.data, '$.currency') AS currency,
                COUNT(*) AS calls,
                COALESCE(SUM(json_extract(t.data, '$.tokens_in')), 0) AS tokens_in,
                COALESCE(SUM(json_extract(t.data, '$.tokens_out')), 0) AS tokens_out,
                SUM(json_extract(t.data, '$.cost')) AS cost
           FROM trace t LEFT JOIN runs r ON r.id = t.run_id
          WHERE ${where.join(' AND ')}
          GROUP BY key, currency
          ORDER BY key`,
      )
      .all(...params) as {
      key: string;
      calls: number;
      tokens_in: number;
      tokens_out: number;
      cost: number | null;
      currency: string | null;
    }[];
  }

  forRun(runId: string): TraceEntry[] {
    return (
      this.db
        .prepare(`SELECT * FROM trace WHERE run_id = ? ORDER BY seq ASC`)
        .all(runId) as TraceRow[]
    ).map(toEntry);
  }

  /**
   * Which handler emitted a given event, via the `emit` trace row that created
   * it. Used by the cycle check (§5.5) without adding columns to `events`.
   */
  emitterOf(eventId: string): { runId: string; handlerName: string | null } | null {
    const row = this.db
      .prepare(
        `SELECT t.run_id AS run_id, r.handler_name AS handler_name
           FROM trace t LEFT JOIN runs r ON r.id = t.run_id
          WHERE t.kind = 'emit'
            AND json_extract(t.data, '$.emitted_event_id') = ?
          ORDER BY t.seq DESC LIMIT 1`,
      )
      .get(eventId) as { run_id: string | null; handler_name: string | null } | undefined;
    if (!row?.run_id) return null;
    return { runId: row.run_id, handlerName: row.handler_name };
  }
}
