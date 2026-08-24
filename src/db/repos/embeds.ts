import type { Db } from '../index.js';
import { newId } from '../../core/ids.js';
import { nowIso } from '../../core/time.js';

export type EmbedKind = 'ephemeral' | 'persistent';

/** When a binding re-executes (§23.2). `schedule` is §16-deferred. */
export type BindingRefresh = 'manual' | 'on_serve';

/**
 * One frozen read-only call (§23.2). The model chose the tool and the args
 * once, at bind time; nothing re-decides them afterwards, which is what makes
 * unattended replay zero new capability.
 */
export interface EmbedBinding {
  name: string;
  tool: string;
  args: Record<string, unknown>;
  refresh: BindingRefresh;
}

/**
 * What one binding last returned. `fetched_at` is the age of `value`, so a
 * failed refresh leaves it alone and sets `ok: false` — the page then serves
 * data that is visibly stale rather than data that looks fresh (§23.2).
 */
export interface BoundValue {
  value: unknown;
  fetched_at: string;
  ok: boolean;
  error?: string;
  /** The failing tool's own message; the code alone is not actionable (§23.2). */
  message?: string;
}

export interface EmbedRow {
  id: string;
  title: string;
  kind: EmbedKind;
  /** The *creating* conversation, the reaping anchor — never ownership (§22.1). */
  conversation_id: string | null;
  created_by_run: string | null;
  created_at: string;
  updated_at: string;
  last_served_at: string | null;
  /** Bumped to revoke every outstanding scoped link (§22.3). */
  token_generation: number;
  /** The state pouch, JSON (§22.4). */
  state: string;
  /** Frozen read-only call specs, JSON array (§23.2). */
  bindings: string;
  /** Per binding `{value, fetched_at, ok, error?}`, JSON object (§23.2). */
  bound_data: string;
}

/** Embeds (§22.1, App. C). The HTML itself is a file; this row is the handle. */
export class EmbedsRepo {
  constructor(private readonly db: Db) {}

  create(input: {
    title: string;
    kind?: EmbedKind;
    conversationId?: string | null;
    createdByRun?: string | null;
    id?: string;
  }): EmbedRow {
    const at = nowIso();
    const row: EmbedRow = {
      id: input.id ?? newId(),
      title: input.title,
      kind: input.kind ?? 'ephemeral',
      conversation_id: input.conversationId ?? null,
      created_by_run: input.createdByRun ?? null,
      created_at: at,
      updated_at: at,
      last_served_at: null,
      token_generation: 1,
      state: '{}',
      bindings: '[]',
      bound_data: '{}',
    };
    this.db
      .prepare(
        `INSERT INTO embeds
           (id, title, kind, conversation_id, created_by_run, created_at, updated_at,
            last_served_at, token_generation, state, bindings, bound_data)
         VALUES (@id, @title, @kind, @conversation_id, @created_by_run, @created_at,
                 @updated_at, @last_served_at, @token_generation, @state, @bindings,
                 @bound_data)`,
      )
      .run(row);
    return row;
  }

  get(id: string): EmbedRow | null {
    return (this.db.prepare(`SELECT * FROM embeds WHERE id = ?`).get(id) as EmbedRow) ?? null;
  }

  /**
   * Every embed, newest first, optionally filtered. `query` is a
   * case-insensitive title substring — the search-before-create lookup (§22.2),
   * deliberately dumb: an embed is found by the name the user calls it.
   */
  list(opts: { kind?: EmbedKind; query?: string; limit?: number } = {}): EmbedRow[] {
    const where: string[] = [];
    const args: unknown[] = [];
    if (opts.kind) {
      where.push(`kind = ?`);
      args.push(opts.kind);
    }
    if (opts.query) {
      where.push(`lower(title) LIKE ?`);
      args.push(`%${opts.query.toLowerCase()}%`);
    }
    return this.db
      .prepare(
        `SELECT * FROM embeds ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
          ORDER BY updated_at DESC, id DESC LIMIT ?`,
      )
      .all(...args, opts.limit ?? 50) as EmbedRow[];
  }

  /** An edit or a state write; what the reaper's quiet window is measured from. */
  touch(id: string): void {
    this.db.prepare(`UPDATE embeds SET updated_at = ? WHERE id = ?`).run(nowIso(), id);
  }

  /**
   * Records a serve or a marker resolution (§22.1). Kept separate from
   * `updated_at` so "still in use" and "recently changed" stay distinguishable,
   * and bumped from *any* conversation — an embed in active use never reaps
   * because of where it was born.
   */
  markServed(id: string): void {
    this.db.prepare(`UPDATE embeds SET last_served_at = ? WHERE id = ?`).run(nowIso(), id);
  }

  promote(id: string): void {
    this.db
      .prepare(`UPDATE embeds SET kind = 'persistent', updated_at = ? WHERE id = ?`)
      .run(nowIso(), id);
  }

  /**
   * Back to ephemeral, which puts the row back within the reaper's reach
   * (§22.1) — the point of unkeeping rather than a side effect of it.
   *
   * `updated_at` moves, so the quiet clock restarts here: unkeeping something
   * should not delete it a moment later because it happened to be old.
   */
  demote(id: string): void {
    this.db
      .prepare(`UPDATE embeds SET kind = 'ephemeral', updated_at = ? WHERE id = ?`)
      .run(nowIso(), id);
  }

  /** Revokes every outstanding scoped link by changing what they hash against. */
  rotate(id: string): number | null {
    const row = this.get(id);
    if (!row) return null;
    const next = row.token_generation + 1;
    this.db
      .prepare(`UPDATE embeds SET token_generation = ?, updated_at = ? WHERE id = ?`)
      .run(next, nowIso(), id);
    return next;
  }

  state(id: string): Record<string, unknown> {
    const row = this.db.prepare(`SELECT state FROM embeds WHERE id = ?`).get(id) as
      { state: string } | undefined;
    if (!row) return {};
    try {
      const parsed = JSON.parse(row.state) as unknown;
      return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : {};
    } catch {
      // A pouch we cannot parse is a pouch the embed can overwrite.
      return {};
    }
  }

  /** Whole-blob replace; there are no patch semantics in v1 (§22.4). */
  setState(id: string, state: Record<string, unknown>): number {
    const serialized = JSON.stringify(state);
    this.db
      .prepare(`UPDATE embeds SET state = ?, updated_at = ? WHERE id = ?`)
      .run(serialized, nowIso(), id);
    return Buffer.byteLength(serialized, 'utf8');
  }

  remove(id: string): boolean {
    return this.db.prepare(`DELETE FROM embeds WHERE id = ?`).run(id).changes > 0;
  }

  /**
   * Deleting a conversation orphans its embeds rather than destroying them
   * (§22.1): `conversation_id` was only the reaping anchor, and an embed
   * rendered in other conversations must survive its birth chat. `reapable`
   * treats a NULL anchor as "conversation gone", so ephemeral orphans age out
   * on the normal TTL; anything in cross-chat use is protected by
   * `last_served_at` exactly as before.
   */
  orphanConversation(conversationId: string): number {
    return this.db
      .prepare(`UPDATE embeds SET conversation_id = NULL WHERE conversation_id = ?`)
      .run(conversationId).changes;
  }

  /**
   * Reaping candidates (§22.1): ephemeral, creating conversation closed (or
   * gone), and quiet since `cutoff` by both clocks. `last_served_at IS NULL`
   * falls back to `updated_at` — an embed nobody ever opened is judged by when
   * it was last written.
   */
  reapable(cutoff: string): EmbedRow[] {
    return this.db
      .prepare(
        `SELECT e.* FROM embeds e
           LEFT JOIN conversations c ON c.id = e.conversation_id
          WHERE e.kind = 'ephemeral'
            AND (c.id IS NULL OR c.status = 'closed')
            AND e.updated_at < ?
            AND COALESCE(e.last_served_at, e.updated_at) < ?`,
      )
      .all(cutoff, cutoff) as EmbedRow[];
  }

  /** Embed ids that exist, for the reaper's orphaned-binding repair (§22.5). */
  ids(): string[] {
    return (this.db.prepare(`SELECT id FROM embeds`).all() as { id: string }[]).map(
      (r) => r.id,
    );
  }

  /* ── data bindings (§23.2) ───────────────────────────────────────────── */

  bindings(id: string): EmbedBinding[] {
    const row = this.db.prepare(`SELECT bindings FROM embeds WHERE id = ?`).get(id) as
      { bindings: string } | undefined;
    return row ? (parseJson(row.bindings, []) as EmbedBinding[]) : [];
  }

  /**
   * Replaces the whole binding list and drops the data of bindings that are
   * gone (App. F.13). Kept in one statement: an embed whose bindings and data
   * disagree would serve a placeholder no manifest line explains.
   */
  setBindings(id: string, bindings: EmbedBinding[]): void {
    const keep = new Set(bindings.map((b) => b.name));
    const data = this.boundData(id);
    const pruned: Record<string, BoundValue> = {};
    for (const [name, value] of Object.entries(data)) if (keep.has(name)) pruned[name] = value;
    this.db
      .prepare(`UPDATE embeds SET bindings = ?, bound_data = ?, updated_at = ? WHERE id = ?`)
      .run(JSON.stringify(bindings), JSON.stringify(pruned), nowIso(), id);
  }

  boundData(id: string): Record<string, BoundValue> {
    const row = this.db.prepare(`SELECT bound_data FROM embeds WHERE id = ?`).get(id) as
      { bound_data: string } | undefined;
    return row ? (parseJson(row.bound_data, {}) as Record<string, BoundValue>) : {};
  }

  /**
   * Stores what the binder fetched. Deliberately does *not* touch
   * `updated_at`: an `on_serve` refresh is not an edit, and letting it look
   * like one would keep resetting the reaper's quiet window (§22.1).
   */
  setBoundData(id: string, data: Record<string, BoundValue>): number {
    const serialized = JSON.stringify(data);
    this.db.prepare(`UPDATE embeds SET bound_data = ? WHERE id = ?`).run(serialized, id);
    return Buffer.byteLength(serialized, 'utf8');
  }
}

/** JSON columns are TEXT; a column we cannot parse is a column with no data. */
function parseJson(text: string, fallback: unknown): unknown {
  try {
    const parsed = JSON.parse(text) as unknown;
    return parsed === null ? fallback : parsed;
  } catch {
    return fallback;
  }
}
