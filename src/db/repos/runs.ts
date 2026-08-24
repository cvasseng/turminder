import type { Db } from '../index.js';
import { newId } from '../../core/ids.js';
import { nowIso } from '../../core/time.js';
import type { RunKind } from '../../model/types.js';

export interface RunRow {
  id: string;
  event_id: string | null;
  kind: RunKind;
  handler_name: string | null;
  model: string | null;
  status: 'running' | 'done' | 'failed';
  started_at: string;
  finished_at: string | null;
  turns: number;
  tokens_in: number;
  tokens_out: number;
  error: string | null;
}

export interface NewRun {
  kind: RunKind;
  eventId?: string | null;
  handlerName?: string | null;
  model?: string | null;
}

export interface FinishRun {
  status: 'done' | 'failed';
  turns?: number;
  tokensIn?: number;
  tokensOut?: number;
  model?: string | null;
  error?: string | null;
}

export class RunsRepo {
  constructor(private readonly db: Db) {}

  create(input: NewRun): string {
    const id = newId();
    this.db
      .prepare(
        `INSERT INTO runs (id, event_id, kind, handler_name, model, status, started_at)
         VALUES (?, ?, ?, ?, ?, 'running', ?)`,
      )
      .run(
        id,
        input.eventId ?? null,
        input.kind,
        input.handlerName ?? null,
        input.model ?? null,
        nowIso(),
      );
    return id;
  }

  finish(id: string, f: FinishRun): void {
    this.db
      .prepare(
        `UPDATE runs SET status = ?, finished_at = ?, turns = ?, tokens_in = ?, tokens_out = ?,
           model = COALESCE(?, model), error = ?
         WHERE id = ?`,
      )
      .run(
        f.status,
        nowIso(),
        f.turns ?? 0,
        f.tokensIn ?? 0,
        f.tokensOut ?? 0,
        f.model ?? null,
        f.error ?? null,
        id,
      );
  }

  get(id: string): RunRow | null {
    return (this.db.prepare(`SELECT * FROM runs WHERE id = ?`).get(id) as RunRow) ?? null;
  }

  forEvent(eventId: string): RunRow[] {
    return this.db
      .prepare(`SELECT * FROM runs WHERE event_id = ? ORDER BY started_at ASC, id ASC`)
      .all(eventId) as RunRow[];
  }

  /**
   * Every token this conversation has cost, across all its runs. Assistant
   * turns carry their run id, which is the link.
   */
  tokensForConversation(conversationId: string): { tokensIn: number; tokensOut: number } {
    const row = this.db
      .prepare(
        `SELECT COALESCE(SUM(r.tokens_in), 0) AS tokens_in,
                COALESCE(SUM(r.tokens_out), 0) AS tokens_out
           FROM runs r
          WHERE r.id IN (SELECT run_id FROM turns WHERE conversation_id = ? AND run_id IS NOT NULL)`,
      )
      .get(conversationId) as { tokens_in: number; tokens_out: number };
    return { tokensIn: row.tokens_in, tokensOut: row.tokens_out };
  }

  /** Every run that produced a turn in this conversation — the cost scope (§10.5). */
  idsForConversation(conversationId: string): string[] {
    const rows = this.db
      .prepare(
        `SELECT DISTINCT run_id AS id FROM turns
          WHERE conversation_id = ? AND run_id IS NOT NULL`,
      )
      .all(conversationId) as { id: string }[];
    return rows.map((r) => r.id);
  }

  /** Runs still marked running after a restart are orphans; fail them honestly. */
  failOrphaned(reason = 'interrupted by restart'): number {
    return this.db
      .prepare(
        `UPDATE runs SET status = 'failed', finished_at = ?, error = COALESCE(error, ?)
         WHERE status = 'running'`,
      )
      .run(nowIso(), reason).changes;
  }
}
