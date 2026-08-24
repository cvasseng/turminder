import type BetterSqlite3 from 'better-sqlite3';
import { log } from '../core/logger.js';
import { errMessage } from '../core/errors.js';
import type { DataHome } from '../core/datadir.js';
import type { ConversationsRepo } from '../db/repos/conversations.js';
import type { EmbeddingClient } from './embeddings.js';
import { excerptFor, lexicalSearch } from './index-store.js';
import { inScope } from '../projects/scope.js';
import {
  ensureColumn,
  ensureVectorTable,
  openVectorDb,
  removeDbFiles,
  storedDimension,
  toBuffer,
} from './vector-db.js';

const l = log('rag');

function parseProjects(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((p): p is string => typeof p === 'string')
      : [];
  } catch {
    return [];
  }
}

/** App. A: how much of a turn a hit is allowed to carry back. */
const EXCERPT_CHARS = 500;

export interface HistoryHit {
  conversation_id: string;
  title: string | null;
  turn_seq: number;
  role: 'user' | 'assistant';
  excerpt: string;
  created_at: string;
  score: number;
}

export interface HistorySearchResult {
  results: HistoryHit[];
  mode: 'vector' | 'lexical' | 'empty';
}

export interface HistorySearchOptions {
  k?: number;
  /** ISO 8601 bounds on the turn's own timestamp. */
  before?: string;
  after?: string;
  /** Never return turns from here — the caller's own conversation (§25). */
  excludeConversation?: string;
  /** Islands loaded in the querying conversation (§31.3). */
  loaded?: string[];
}

interface TurnIndexRow {
  seq: number;
  conversation_id: string;
  title: string | null;
  role: 'user' | 'assistant';
  text: string;
  created_at: string;
  /** JSON array: what its conversation had loaded when it was indexed (§31.2). */
  projects: string;
}

/**
 * The third RAG corpus (§25): persisted turns, in their own database next to
 * memory's and files' — same sqlite-vec machinery, same lexical fallback, no
 * new mechanism.
 *
 * Two properties are load-bearing. **The corpus is disjoint** (§18.1): this
 * index holds turns and nothing else, which is what makes "history.search
 * never returns a memory" true by construction rather than by filtering. And
 * **nothing here is ever auto-injected**: memory has an auto-retrieve path
 * (§5.4), history does not — it enters a prompt only through a tool call the
 * model chose to make.
 *
 * What gets indexed is `context_text` for assistant turns (§20.2) — what the
 * model would re-read, not the display narration — and `text` for user turns.
 */
export class TurnsIndex {
  private db: BetterSqlite3.Database | null = null;
  private dimension = 0;

  constructor(
    private readonly home: DataHome,
    private readonly conversations: ConversationsRepo,
    private readonly embeddings: EmbeddingClient,
  ) {}

  private get path(): string {
    return this.home.path('cache', 'turns-rag.db');
  }

  private open(): BetterSqlite3.Database {
    if (this.db) return this.db;
    const db = openVectorDb(this.path);
    db.exec(`
      CREATE TABLE IF NOT EXISTS turns (
        seq             INTEGER PRIMARY KEY,
        conversation_id TEXT NOT NULL,
        title           TEXT,
        role            TEXT NOT NULL,
        text            TEXT NOT NULL,
        created_at      TEXT NOT NULL,
        projects        TEXT NOT NULL DEFAULT '[]'
      );
      CREATE INDEX IF NOT EXISTS ix_turns_conv ON turns(conversation_id);
    `);
    // Turns indexed before projects existed belong to no island, which is what
    // the default says — and general turns are what they are (§31.2).
    ensureColumn(db, 'turns', 'projects', `projects TEXT NOT NULL DEFAULT '[]'`);
    this.db = db;
    this.dimension = storedDimension(db);
    if (this.dimension > 0) this.vectors(this.dimension);
    return db;
  }

  private vectors(dimension: number): void {
    // vec0 keys are TEXT here, like the other two corpora; the seq is
    // stringified on the way in and parsed on the way out.
    ensureVectorTable(this.db!, 'turn_vectors', 'seq', dimension);
    this.dimension = dimension;
  }

  close(): void {
    this.db?.close();
    this.db = null;
  }

  /**
   * Wipe and rebuild from `events.db` alone (`--rebuild-index`). The index is
   * derived data by decree (§8.3, §25) — losing it costs an embedding pass,
   * never a fact.
   */
  async rebuild(): Promise<{ indexed: number; vectors: number }> {
    this.close();
    removeDbFiles(this.path);
    return this.sync();
  }

  /**
   * Reconcile with `events.db`: index what is new, forget what was deleted.
   * Turns are append-only, so "new" is everything past the highest seq we
   * hold; deletion happens a whole conversation at a time and is caught here
   * as well as at the delete itself, because a ghost in a search result is a
   * correctness bug, not staleness.
   */
  async sync(): Promise<{ indexed: number; vectors: number }> {
    const db = this.open();
    const live = this.conversations.liveTurnSeqs();
    const held = (db.prepare(`SELECT seq FROM turns`).all() as { seq: number }[]).map(
      (r) => r.seq,
    );
    for (const seq of held) if (!live.has(seq)) this.forgetTurn(seq);

    const vectors = await this.indexNew();
    const indexed = (db.prepare(`SELECT COUNT(*) AS n FROM turns`).get() as { n: number }).n;
    l.debug({ indexed, vectors }, 'turns index synced');
    return { indexed, vectors };
  }

  /**
   * Index every turn the index has not seen. Called at `background` priority
   * once a run has persisted its turns (§25) — after, never during: indexing
   * is not on the path between the user's question and the answer.
   */
  async indexNew(): Promise<number> {
    const db = this.open();
    const highest = (
      db.prepare(`SELECT MAX(seq) AS seq FROM turns`).get() as { seq: number | null }
    ).seq;
    const turns = this.conversations.indexableTurns({ afterSeq: highest ?? 0 });
    if (!turns.length) return 0;

    const insert = db.prepare(
      `INSERT INTO turns (seq, conversation_id, title, role, text, created_at, projects)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(seq) DO UPDATE SET title = excluded.title, text = excluded.text,
         projects = excluded.projects`,
    );
    const rows: TurnIndexRow[] = [];
    for (const turn of turns) {
      // Assistant turns index what the model re-reads (§20.2); user turns are
      // what the user actually said.
      const text = (turn.role === 'assistant' ? turn.contextText : turn.text).trim();
      if (!text) continue;
      // The islands its conversation had loaded, inherited at indexing time
      // (§31.2) — cache-side, and a rebuild re-derives it from the row.
      const projects = turn.loadedProjects;
      insert.run(
        turn.seq,
        turn.conversation_id,
        turn.title,
        turn.role,
        text,
        turn.created_at,
        projects,
      );
      rows.push({
        seq: turn.seq,
        conversation_id: turn.conversation_id,
        title: turn.title,
        role: turn.role,
        text,
        created_at: turn.created_at,
        projects,
      });
    }
    return this.embed(rows);
  }

  /** Drop a whole conversation's turns — the user deleted it (§9). */
  forgetConversation(conversationId: string): void {
    const db = this.open();
    const seqs = (
      db.prepare(`SELECT seq FROM turns WHERE conversation_id = ?`).all(conversationId) as {
        seq: number;
      }[]
    ).map((r) => r.seq);
    for (const seq of seqs) this.forgetTurn(seq);
  }

  /**
   * `history.search` (App. F.15). Turns corpus only, by construction — and
   * never the querying conversation's own turns, which are already in the
   * context that is asking (§25).
   */
  async search(query: string, opts: HistorySearchOptions = {}): Promise<HistorySearchResult> {
    const text = query.trim();
    const k = opts.k ?? 5;
    if (!text) return { results: [], mode: 'empty' };
    const db = this.open();
    const rows = this.candidates(opts);
    if (!rows.length) return { results: [], mode: 'empty' };

    if (this.dimension > 0) {
      try {
        const [vector] = await this.embeddings.embed([text]);
        if (vector?.length === this.dimension) {
          const allowed = new Set(rows.map((r) => r.seq));
          // Over-fetch: the KNN runs over every vector, and the date and
          // conversation filters are applied after it, so asking for exactly k
          // would quietly return fewer once anything is excluded.
          const hits = db
            .prepare(
              `SELECT v.seq AS seq, distance FROM turn_vectors v
                WHERE v.embedding MATCH ? AND k = ?
                ORDER BY distance`,
            )
            .all(toBuffer(vector), Math.max(k * 4, k + 20)) as {
            seq: string;
            distance: number;
          }[];
          const byId = new Map(rows.map((r) => [r.seq, r]));
          const results = hits
            .map((h) => ({ seq: Number(h.seq), distance: h.distance }))
            .filter((h) => allowed.has(h.seq))
            .slice(0, k)
            .map((h) => this.hit(byId.get(h.seq)!, text, 1 / (1 + h.distance)));
          if (results.length) return { mode: 'vector', results };
        }
      } catch (e) {
        l.warn({ err: errMessage(e) }, 'vector history search failed; falling back to lexical');
      }
    }

    // The same lexical fallback memory and files use: a crude search beats an
    // apology (§8.3). The title carries the weight a name carries there.
    const hits = lexicalSearch(
      text,
      rows.map((r) => ({
        name: `${r.seq}`,
        description: r.title ?? '',
        type: 'turn',
        content: r.text,
      })),
      k,
    );
    const byId = new Map(rows.map((r) => [r.seq, r]));
    return {
      mode: 'lexical',
      results: hits.map((h) => this.hit(byId.get(Number(h.name))!, text, h.score)),
    };
  }

  stats(): { indexed: number; vectors: number; dimension: number } {
    const db = this.open();
    const indexed = (db.prepare(`SELECT COUNT(*) AS n FROM turns`).get() as { n: number }).n;
    const vectors =
      this.dimension > 0
        ? (db.prepare(`SELECT COUNT(*) AS n FROM turn_vectors`).get() as { n: number }).n
        : 0;
    return { indexed, vectors, dimension: this.dimension };
  }

  /** The rows a search is allowed to return, after scope and date filters. */
  private candidates(opts: HistorySearchOptions): TurnIndexRow[] {
    const where: string[] = [];
    const params: unknown[] = [];
    if (opts.excludeConversation) {
      where.push('conversation_id != ?');
      params.push(opts.excludeConversation);
    }
    if (opts.after) {
      where.push('created_at >= ?');
      params.push(opts.after);
    }
    if (opts.before) {
      where.push('created_at <= ?');
      params.push(opts.before);
    }
    const rows = this.db!.prepare(
      `SELECT seq, conversation_id, title, role, text, created_at, projects FROM turns
       ${where.length ? `WHERE ${where.join(' AND ')}` : ''}`,
    ).all(...params) as TurnIndexRow[];
    // The scope filter runs here rather than in SQL: a turn carries a *set* of
    // islands, and every one of them has to be loaded (§31.1 — loading A never
    // exposes B, and a turn from an A+B conversation is partly about B).
    const loaded = opts.loaded ?? [];
    return rows.filter((row) => inScope(parseProjects(row.projects), loaded));
  }

  private hit(row: TurnIndexRow, query: string, score: number): HistoryHit {
    return {
      conversation_id: row.conversation_id,
      title: row.title,
      turn_seq: row.seq,
      role: row.role,
      excerpt: excerptFor(row.text, query, EXCERPT_CHARS),
      created_at: row.created_at,
      score,
    };
  }

  private forgetTurn(seq: number): void {
    this.db!.prepare(`DELETE FROM turns WHERE seq = ?`).run(seq);
    if (this.dimension > 0) {
      this.db!.prepare(`DELETE FROM turn_vectors WHERE seq = ?`).run(String(seq));
    }
  }

  private async embed(rows: TurnIndexRow[]): Promise<number> {
    if (!rows.length) return 0;
    try {
      const embedded = await this.embeddings.embed(rows.map((r) => r.text));
      if (embedded.length !== rows.length || !embedded[0]?.length) return 0;
      this.vectors(embedded[0].length);
      // vec0 virtual tables have no UPSERT: delete then insert.
      const remove = this.db!.prepare(`DELETE FROM turn_vectors WHERE seq = ?`);
      const insert = this.db!.prepare(
        `INSERT INTO turn_vectors (seq, embedding) VALUES (?, ?)`,
      );
      rows.forEach((row, i) => {
        remove.run(String(row.seq));
        insert.run(String(row.seq), toBuffer(embedded[i]!));
      });
      return rows.length;
    } catch (e) {
      l.warn(
        { err: errMessage(e) },
        'turn embedding failed; lexical history search still works',
      );
      return 0;
    }
  }
}
