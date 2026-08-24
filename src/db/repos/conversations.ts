import type { Db } from '../index.js';
import { newId } from '../../core/ids.js';
import { stripReservedMarkers } from '../../core/markers.js';
import { nowIso } from '../../core/time.js';

export type ConversationMode = 'normal' | 'onboarding';
export type ConversationStatus = 'open' | 'closed';

export interface ConversationRow {
  id: string;
  title: string | null;
  mode: ConversationMode;
  status: ConversationStatus;
  created_at: string;
  last_activity_at: string;
  /** `last_activity_at` the distillation pass last ran against; null until then. */
  distilled_at: string | null;
  /** JSON array of tool namespaces this conversation has opened (§21.2.5). */
  open_namespaces: string;
  /** JSON array of project slugs loaded here, load order preserved (§31.1). */
  loaded_projects: string;
  /** Endpoint this conversation is pinned to, or null to resolve normally (§10.6). */
  model_override: string | null;
  /** Reasoning level this conversation asks for, or null for the endpoint's
   *  own default — which is then never named on the wire (§10.6). */
  effort_override: string | null;
}

export interface TurnRow {
  seq: number;
  conversation_id: string;
  role: 'user' | 'assistant';
  content: string;
  event_id: string | null;
  run_id: string | null;
  created_at: string;
}

/**
 * One turn, with display and model context kept apart (§20.2). `text` is what
 * the user watched stream; `contextText` is what history reconstruction feeds
 * back. Conflating them is how pre-tool narration ends up accumulating in
 * every subsequent prompt.
 */
/** What a user turn says about its attachments (§26.2). Metadata, never bytes. */
export interface TurnAttachment {
  upload_id: string;
  name: string;
  mime: string;
  bytes: number;
}

export interface Turn extends Omit<TurnRow, 'content'> {
  /** DISPLAY: everything spoken across the run. */
  text: string;
  /** MODEL: the run's last non-empty utterance. Falls back to `text`. */
  contextText: string;
  /** Names of the tools the run called, deduped, in call order. */
  toolsUsed: string[];
  /** User turns only (§26.2); empty for everything else. */
  attachments: TurnAttachment[];
}

function toTurn(row: TurnRow): Turn {
  let parsed: {
    text?: string;
    context_text?: string;
    tools_used?: unknown;
    attachments?: unknown;
  } = {};
  try {
    parsed = JSON.parse(row.content) as typeof parsed;
  } catch {
    // A row written before the content column held JSON at all.
    parsed = { text: row.content };
  }
  const text = parsed.text ?? '';
  return {
    ...row,
    text,
    // No migration (§20.2): rows written before the split fall back to `text`,
    // so old conversations degrade gracefully rather than emptying out.
    contextText: parsed.context_text ?? text,
    toolsUsed: Array.isArray(parsed.tools_used)
      ? parsed.tools_used.filter((t): t is string => typeof t === 'string')
      : [],
    attachments: Array.isArray(parsed.attachments)
      ? (parsed.attachments as TurnAttachment[]).filter(
          (a) => a && typeof a.upload_id === 'string',
        )
      : [],
  };
}

/** Conversations and their turns (§9). Tool activity lives in trace, not here (App. C.2). */
export class ConversationsRepo {
  constructor(private readonly db: Db) {}

  create(opts: { mode?: ConversationMode; id?: string } = {}): ConversationRow {
    const row: ConversationRow = {
      id: opts.id ?? newId(),
      title: null,
      mode: opts.mode ?? 'normal',
      status: 'open',
      created_at: nowIso(),
      model_override: null,
      effort_override: null,
      last_activity_at: nowIso(),
      distilled_at: null,
      open_namespaces: '[]',
      loaded_projects: '[]',
    };
    this.db
      .prepare(
        `INSERT INTO conversations
           (id, title, mode, status, created_at, last_activity_at, distilled_at,
            open_namespaces)
         VALUES (@id, @title, @mode, @status, @created_at, @last_activity_at,
                 @distilled_at, @open_namespaces)`,
      )
      .run(row);
    return row;
  }

  get(id: string): ConversationRow | null {
    return (
      (this.db
        .prepare(`SELECT * FROM conversations WHERE id = ?`)
        .get(id) as ConversationRow) ?? null
    );
  }

  /**
   * Conversations, most recent first. Archived ones (status `closed`) are left
   * out unless asked for: an assistant you talk to daily accumulates them, and
   * the list is for what is live.
   */
  list(
    opts: { limit?: number; status?: ConversationStatus; includeArchived?: boolean } = {},
  ): ConversationRow[] {
    const where = opts.status
      ? `WHERE status = ?`
      : opts.includeArchived
        ? ''
        : `WHERE status = 'open'`;
    const args: unknown[] = opts.status ? [opts.status] : [];
    return this.db
      .prepare(
        `SELECT * FROM conversations ${where} ORDER BY last_activity_at DESC, id DESC LIMIT ?`,
      )
      .all(...args, opts.limit ?? 50) as ConversationRow[];
  }

  /**
   * The newest conversation still in onboarding mode, if there is one.
   *
   * The greeting (§3c) needs to know whether one is already under way: it is
   * emitted both when setup commits and at every start that still has no
   * identity, and neither caller should produce a second one. Newest first
   * because `onboard --redo` can legitimately make another.
   */
  onboardingConversation(): ConversationRow | null {
    return (
      (this.db
        .prepare(
          `SELECT * FROM conversations WHERE mode = 'onboarding'
           ORDER BY last_activity_at DESC, id DESC LIMIT 1`,
        )
        .get() as ConversationRow | undefined) ?? null
    );
  }

  touch(id: string): void {
    this.db
      .prepare(`UPDATE conversations SET last_activity_at = ? WHERE id = ?`)
      .run(nowIso(), id);
  }

  setTitle(id: string, title: string): void {
    this.db.prepare(`UPDATE conversations SET title = ? WHERE id = ?`).run(title, id);
  }

  setMode(id: string, mode: ConversationMode): void {
    this.db.prepare(`UPDATE conversations SET mode = ? WHERE id = ?`).run(mode, id);
  }

  /**
   * Reopens a closed conversation. Returns false when it was already open.
   * Used when the user talks into one they archived earlier (§9): continuity
   * matters more than the tidiness of a closed row.
   */
  reopen(id: string): boolean {
    const r = this.db
      .prepare(`UPDATE conversations SET status = 'open' WHERE id = ? AND status = 'closed'`)
      .run(id);
    return r.changes > 0;
  }

  /** Closes the conversation; returns false when it was already closed. */
  close(id: string): boolean {
    const r = this.db
      .prepare(`UPDATE conversations SET status = 'closed' WHERE id = ? AND status = 'open'`)
      .run(id);
    return r.changes > 0;
  }

  /**
   * Deletes a conversation and its turns for good. The `chat.message` events
   * stay: they are the audit trail (§13.1), and the transcript is what the user
   * asked to be rid of.
   */
  remove(id: string): { deleted: boolean; turns: number } {
    const conversation = this.get(id);
    if (!conversation) return { deleted: false, turns: 0 };
    const turns = this.turnCount(id);
    this.db.transaction(() => {
      // Turns first: they hold the foreign key.
      this.db.prepare(`DELETE FROM turns WHERE conversation_id = ?`).run(id);
      this.db.prepare(`DELETE FROM conversations WHERE id = ?`).run(id);
    })();
    return { deleted: true, turns };
  }

  addTurn(input: {
    conversationId: string;
    role: 'user' | 'assistant';
    text: string;
    /** Assistant turns: the run's final utterance (§20.2). Defaults to `text`. */
    contextText?: string;
    toolsUsed?: string[];
    eventId?: string | null;
    runId?: string | null;
    /** User turns only (§26.2). */
    attachments?: readonly TurnAttachment[];
  }): Turn {
    const created = nowIso();
    const toolsUsed = input.toolsUsed ?? [];
    /**
     * Persistence is fenced regardless of path (§20.8): no reserved marker is
     * ever written into `turns`. The agent loop's guard is the first door and
     * catches it while there is still time to ask the model again; this is the
     * last one, and it holds for callers that do not exist yet. A pattern that
     * reaches a row rides back into every later prompt and teaches itself.
     */
    const text = stripReservedMarkers(input.text);
    // Only written when it differs: a user turn, or an assistant turn whose
    // whole output was its final answer, needs no second copy of the string.
    const stripped =
      input.contextText === undefined ? undefined : stripReservedMarkers(input.contextText);
    const contextText = stripped !== undefined && stripped !== text ? stripped : undefined;
    const attachments = input.attachments ?? [];
    const content: Record<string, unknown> = { text };
    if (contextText !== undefined) content.context_text = contextText;
    if (toolsUsed.length) content.tools_used = toolsUsed;
    if (attachments.length) content.attachments = attachments;

    const info = this.db
      .prepare(
        `INSERT INTO turns (conversation_id, role, content, event_id, run_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.conversationId,
        input.role,
        JSON.stringify(content),
        input.eventId ?? null,
        input.runId ?? null,
        created,
      );
    this.touch(input.conversationId);
    return {
      seq: Number(info.lastInsertRowid),
      conversation_id: input.conversationId,
      role: input.role,
      text,
      contextText: contextText ?? text,
      toolsUsed,
      attachments: [...attachments],
      event_id: input.eventId ?? null,
      run_id: input.runId ?? null,
      created_at: created,
    };
  }

  /** Was this event already turned into a user turn? Keeps retries idempotent. */
  turnForEvent(eventId: string): Turn | null {
    const row = this.db
      .prepare(`SELECT * FROM turns WHERE event_id = ? LIMIT 1`)
      .get(eventId) as TurnRow | undefined;
    return row ? toTurn(row) : null;
  }

  /**
   * The last `limit` turns, oldest first — the model's context window (§9).
   * `after` (ISO timestamp, exclusive) is the distillation delta (§8.2): only
   * turns the last pass never saw.
   */
  history(
    conversationId: string,
    opts: { limit?: number; beforeSeq?: number; after?: string } = {},
  ): Turn[] {
    const limit = opts.limit ?? 40;
    const where = ['conversation_id = ?'];
    const params: (string | number)[] = [conversationId];
    if (opts.beforeSeq) {
      where.push('seq < ?');
      params.push(opts.beforeSeq);
    }
    if (opts.after) {
      where.push('created_at > ?');
      params.push(opts.after);
    }
    const rows = this.db
      .prepare(
        `SELECT * FROM turns
          WHERE ${where.join(' AND ')}
          ORDER BY seq DESC LIMIT ?`,
      )
      .all(...params, limit) as TurnRow[];
    return rows.reverse().map(toTurn);
  }

  /**
   * Every turn, oldest first, with its conversation's title — the corpus the
   * history index is built from (§25). `afterSeq` makes the common case cheap:
   * turns are append-only, so "what is new" is one comparison, and a rebuild
   * is the same query from zero.
   */
  indexableTurns(
    opts: { afterSeq?: number } = {},
  ): (Turn & { title: string | null; loadedProjects: string })[] {
    const rows = this.db
      .prepare(
        `SELECT t.*, c.title AS conversation_title,
                c.loaded_projects AS conversation_projects FROM turns t
           JOIN conversations c ON c.id = t.conversation_id
          WHERE t.seq > ? ORDER BY t.seq ASC`,
      )
      .all(opts.afterSeq ?? 0) as (TurnRow & {
      conversation_title: string | null;
      conversation_projects: string;
    })[];
    return rows.map((row) => {
      const { conversation_title, conversation_projects, ...turn } = row;
      return {
        ...toTurn(turn),
        title: conversation_title,
        // The islands the turn's conversation had loaded — what a history row
        // inherits at indexing time (§31.2).
        loadedProjects: conversation_projects ?? '[]',
      };
    });
  }

  /** Which turn seqs still exist — how a derived index notices deletions. */
  liveTurnSeqs(): Set<number> {
    const rows = this.db.prepare(`SELECT seq FROM turns`).all() as { seq: number }[];
    return new Set(rows.map((r) => r.seq));
  }

  turnCount(conversationId: string): number {
    const row = this.db
      .prepare(`SELECT COUNT(*) AS n FROM turns WHERE conversation_id = ?`)
      .get(conversationId) as { n: number };
    return row.n;
  }

  /**
   * Open conversations that have been quiet since before `cutoff` and have said
   * something since the last distillation — the idle-distil sweep (§9). Idle
   * does not archive: status is left alone, only the pass is owed.
   */
  needingDistillation(cutoff: string): ConversationRow[] {
    return this.db
      .prepare(
        `SELECT * FROM conversations
          WHERE status = 'open' AND last_activity_at < ?
            AND (distilled_at IS NULL OR distilled_at < last_activity_at)`,
      )
      .all(cutoff) as ConversationRow[];
  }

  /**
   * Namespaces this conversation has paged in (§21.2.5). The core set is not
   * stored — it is the same for every conversation and comes from config, so
   * changing the default takes effect everywhere rather than only in
   * conversations started afterwards.
   */
  openNamespaces(id: string): string[] {
    const row = this.db
      .prepare(`SELECT open_namespaces FROM conversations WHERE id = ?`)
      .get(id) as { open_namespaces: string } | undefined;
    if (!row) return [];
    try {
      const parsed = JSON.parse(row.open_namespaces) as unknown;
      return Array.isArray(parsed)
        ? parsed.filter((n): n is string => typeof n === 'string')
        : [];
    } catch {
      // A hand-mangled column means this conversation starts from core again,
      // which costs one round of re-opening and nothing else.
      return [];
    }
  }

  /**
   * Project islands loaded here (§31.1), oldest first — the order is what
   * `memory.save` reads to find "the most recently loaded" one.
   */
  loadedProjects(id: string): string[] {
    const row = this.db
      .prepare(`SELECT loaded_projects FROM conversations WHERE id = ?`)
      .get(id) as { loaded_projects: string } | undefined;
    if (!row) return [];
    try {
      const parsed = JSON.parse(row.loaded_projects) as unknown;
      return Array.isArray(parsed)
        ? parsed.filter((n): n is string => typeof n === 'string')
        : [];
    } catch {
      return [];
    }
  }

  /**
   * Loads one project into this conversation, write-through and idempotent.
   * Append rather than sort (unlike `open_namespaces`): load order is
   * information here — the last one loaded is where an untargeted
   * `memory.save` lands (§31.5). There is no unload in v1 (§31.1).
   */
  loadProject(id: string, name: string): boolean {
    const current = this.loadedProjects(id);
    if (current.includes(name)) return false;
    this.db
      .prepare(`UPDATE conversations SET loaded_projects = ? WHERE id = ?`)
      .run(JSON.stringify([...current, name]), id);
    return true;
  }

  /**
   * Records one namespace as open, write-through and idempotent. Monotonic by
   * construction: there is no counterpart that removes one (§21.2.3).
   * Returns whether this call was the one that added it.
   */
  openNamespace(id: string, namespace: string): boolean {
    const current = this.openNamespaces(id);
    if (current.includes(namespace)) return false;
    // Sorted on the way in: the column is read straight into a rendered
    // prompt, and byte-determinism there is what keeps the prefix cache warm.
    const next = [...current, namespace].sort();
    this.db
      .prepare(`UPDATE conversations SET open_namespaces = ? WHERE id = ?`)
      .run(JSON.stringify(next), id);
    return true;
  }

  /**
   * Marks the transcript up to `last_activity_at` as distilled. Claimed when the
   * event is emitted rather than when the pass finishes: the pass runs at
   * background priority, and the sweep ticks every minute — waiting for it would
   * queue the same conversation over and over.
   */
  /**
   * Pin this conversation to an endpoint, or clear the pin (§10.6). The user
   * forcing a model *is* the confirmation — the device-token precedent — so
   * there is no gate here, only a record.
   */
  setModelOverride(id: string, endpoint: string | null): void {
    this.db
      .prepare(`UPDATE conversations SET model_override = ? WHERE id = ?`)
      .run(endpoint, id);
  }

  /** Same surface, same rules, for the reasoning level (§10.6). */
  setEffortOverride(id: string, effort: string | null): void {
    this.db
      .prepare(`UPDATE conversations SET effort_override = ? WHERE id = ?`)
      .run(effort, id);
  }

  markDistilled(id: string): void {
    this.db
      .prepare(`UPDATE conversations SET distilled_at = last_activity_at WHERE id = ?`)
      .run(id);
  }
}
