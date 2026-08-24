import type { Db } from '../index.js';
import { newId } from '../../core/ids.js';
import { nowIso } from '../../core/time.js';

export type WatcherStatus = 'active' | 'done' | 'cancelled';

export interface WatcherRow {
  id: string;
  note: string;
  tool: string;
  args: string;
  status_path: string;
  terminal_values: string | null;
  state_file: string;
  schedule_id: string;
  last_status: string | null;
  last_polled_at: string | null;
  changed_at: string | null;
  consecutive_failures: number;
  status: WatcherStatus;
  created_by_run: string | null;
  created_at: string;
}

export interface NewWatcher {
  note: string;
  tool: string;
  args: Record<string, unknown>;
  statusPath: string;
  terminalValues?: readonly (string | number | boolean)[] | null;
  stateFile: string;
  scheduleId: string;
  lastStatus?: string | null;
  createdByRun?: string | null;
}

/**
 * Watchers (§30). The row holds what the machine needs between polls; the
 * transition log a human reads is a file in the store (§30.4), because "what
 * is the status of my package" should be answerable with `files.read` and no
 * inference at all.
 */
export class WatchersRepo {
  constructor(private readonly db: Db) {}

  create(input: NewWatcher): WatcherRow {
    const now = nowIso();
    const row: WatcherRow = {
      id: newId(),
      note: input.note,
      tool: input.tool,
      args: JSON.stringify(input.args),
      status_path: input.statusPath,
      terminal_values: input.terminalValues?.length
        ? JSON.stringify(input.terminalValues)
        : null,
      state_file: input.stateFile,
      schedule_id: input.scheduleId,
      last_status: input.lastStatus ?? null,
      last_polled_at: now,
      changed_at: now,
      consecutive_failures: 0,
      status: 'active',
      created_by_run: input.createdByRun ?? null,
      created_at: now,
    };
    this.db
      .prepare(
        `INSERT INTO watchers (id, note, tool, args, status_path, terminal_values, state_file,
           schedule_id, last_status, last_polled_at, changed_at, consecutive_failures, status,
           created_by_run, created_at)
         VALUES (@id, @note, @tool, @args, @status_path, @terminal_values, @state_file,
           @schedule_id, @last_status, @last_polled_at, @changed_at, @consecutive_failures,
           @status, @created_by_run, @created_at)`,
      )
      .run(row);
    return row;
  }

  get(id: string): WatcherRow | null {
    return (
      (this.db.prepare(`SELECT * FROM watchers WHERE id = ?`).get(id) as WatcherRow) ?? null
    );
  }

  list(opts: { includeDone?: boolean } = {}): WatcherRow[] {
    const sql = opts.includeDone
      ? `SELECT * FROM watchers ORDER BY created_at DESC`
      : `SELECT * FROM watchers WHERE status = 'active' ORDER BY created_at DESC`;
    return this.db.prepare(sql).all() as WatcherRow[];
  }

  /** A poll that found nothing new: only the clock moved. */
  markPolled(id: string, at: string = nowIso()): void {
    this.db
      .prepare(`UPDATE watchers SET last_polled_at = ?, consecutive_failures = 0 WHERE id = ?`)
      .run(at, id);
  }

  /** A transition: the status, when it changed, and the clock. */
  markChanged(id: string, status: string, at: string = nowIso()): void {
    this.db
      .prepare(
        `UPDATE watchers SET last_status = ?, changed_at = ?, last_polled_at = ?,
           consecutive_failures = 0 WHERE id = ?`,
      )
      .run(status, at, at, id);
  }

  /**
   * A failed poll. The last known status stands — nothing looks fresher than
   * it is (§23.2) — and the counter is what makes the alert edge-triggered.
   */
  markFailed(id: string, at: string = nowIso()): number {
    this.db
      .prepare(
        `UPDATE watchers SET last_polled_at = ?, consecutive_failures = consecutive_failures + 1
          WHERE id = ?`,
      )
      .run(at, id);
    const row = this.get(id);
    return row?.consecutive_failures ?? 0;
  }

  setStatus(id: string, status: WatcherStatus): boolean {
    const info = this.db.prepare(`UPDATE watchers SET status = ? WHERE id = ?`).run(status, id);
    return info.changes > 0;
  }

  argsOf(row: WatcherRow): Record<string, unknown> {
    try {
      return JSON.parse(row.args) as Record<string, unknown>;
    } catch {
      return {};
    }
  }

  terminalOf(row: WatcherRow): (string | number | boolean)[] {
    if (!row.terminal_values) return [];
    try {
      const parsed = JSON.parse(row.terminal_values) as unknown;
      return Array.isArray(parsed) ? (parsed as (string | number | boolean)[]) : [];
    } catch {
      return [];
    }
  }
}
