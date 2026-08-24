import crypto from 'node:crypto';
import type BetterSqlite3 from 'better-sqlite3';
import { log } from '../core/logger.js';
import { errMessage } from '../core/errors.js';
import type { DataHome } from '../core/datadir.js';
import type { MemoryRecord, MemoryStore } from '../memory/store.js';
import type { EmbeddingClient } from './embeddings.js';
import { scopeClause } from '../projects/scope.js';
import {
  ensureColumn,
  ensureVectorTable,
  openVectorDb,
  removeDbFiles,
  storedDimension,
  toBuffer,
} from './vector-db.js';

const l = log('rag');

export interface RetrievalHit {
  name: string;
  description: string;
  type: string;
  content: string;
  score: number;
  /** The island it belongs to (§31.2); null is general. Internal to the
   *  retrieval layer — App. F.1's result shape does not carry it. */
  project?: string | null;
}

export interface RetrievalResult {
  hits: RetrievalHit[];
  /** How the hits were found — traces should not imply vectors that never ran. */
  mode: 'vector' | 'lexical' | 'empty';
}

interface IndexRow {
  name: string;
  description: string;
  type: string;
  content: string;
  hash: string;
  /** The island this memory belongs to (§31.2); null is general. */
  project: string | null;
}

function hashOf(record: MemoryRecord): string {
  return crypto
    .createHash('sha256')
    .update(`${record.description}\n${record.type}\n${record.content}\n${record.project ?? ''}`)
    .digest('hex');
}

function embeddingText(record: MemoryRecord): string {
  return `${record.name}\n${record.description}\n\n${record.content}`;
}

/**
 * The RAG index (§8.3): sqlite-vec over the memory files, living in
 * `data/cache/` because it is derived data — rebuildable, never precious.
 *
 * When no embedding endpoint is available (a llama.cpp server started without
 * `--embeddings`), retrieval falls back to lexical scoring rather than
 * returning nothing: an assistant that forgets is worse than one that searches
 * crudely.
 */
export class RagIndex {
  private db: BetterSqlite3.Database | null = null;
  private dimension = 0;

  constructor(
    private readonly home: DataHome,
    private readonly store: MemoryStore,
    private readonly embeddings: EmbeddingClient,
  ) {}

  private get path(): string {
    return this.home.path('cache', 'rag.db');
  }

  private open(): BetterSqlite3.Database {
    if (this.db) return this.db;
    const db = openVectorDb(this.path);
    db.exec(`
      CREATE TABLE IF NOT EXISTS memories (
        name        TEXT PRIMARY KEY,
        description TEXT NOT NULL,
        type        TEXT NOT NULL,
        content     TEXT NOT NULL,
        hash        TEXT NOT NULL,
        project     TEXT,
        rowid_ref   INTEGER
      );
    `);
    // An index built before projects existed has no column to filter on, and
    // every row in it is general — which is exactly what NULL means here.
    ensureColumn(db, 'memories', 'project', 'project TEXT');
    this.db = db;
    this.dimension = storedDimension(db);
    if (this.dimension > 0) this.vectors(this.dimension);
    return db;
  }

  private vectors(dimension: number): void {
    ensureVectorTable(this.db!, 'vectors', 'name', dimension);
    this.dimension = dimension;
  }

  close(): void {
    this.db?.close();
    this.db = null;
  }

  /** Wipe and rebuild from the files on disk (`--rebuild-index`). */
  async rebuild(): Promise<{ indexed: number; vectors: number }> {
    this.close();
    removeDbFiles(this.path);
    return this.sync();
  }

  /**
   * Bring the index in line with the files: new and changed memories are
   * re-embedded, deleted ones are dropped.
   */
  async sync(): Promise<{ indexed: number; vectors: number }> {
    const db = this.open();
    const records = this.store.list();
    const existing = new Map(
      (
        db.prepare(`SELECT name, hash FROM memories`).all() as { name: string; hash: string }[]
      ).map((r) => [r.name, r.hash]),
    );

    const upsert = db.prepare(
      `INSERT INTO memories (name, description, type, content, hash, project)
       VALUES (@name, @description, @type, @content, @hash, @project)
       ON CONFLICT(name) DO UPDATE SET description=excluded.description,
         type=excluded.type, content=excluded.content, hash=excluded.hash,
         project=excluded.project`,
    );

    const changed: MemoryRecord[] = [];
    for (const record of records) {
      const hash = hashOf(record);
      const row: IndexRow = {
        name: record.name,
        description: record.description,
        type: record.type,
        content: record.content,
        hash,
        project: record.project ?? null,
      };
      if (existing.get(record.name) !== hash) changed.push(record);
      upsert.run(row);
    }

    const names = new Set(records.map((r) => r.name));
    for (const gone of [...existing.keys()].filter((n) => !names.has(n))) {
      db.prepare(`DELETE FROM memories WHERE name = ?`).run(gone);
      if (this.dimension > 0) db.prepare(`DELETE FROM vectors WHERE name = ?`).run(gone);
    }

    let vectors = 0;
    if (changed.length) {
      try {
        const embedded = await this.embeddings.embed(changed.map(embeddingText));
        if (embedded.length === changed.length && embedded[0]?.length) {
          this.vectors(embedded[0].length);
          // vec0 virtual tables do not support UPSERT: replace instead.
          const remove = this.db!.prepare(`DELETE FROM vectors WHERE name = ?`);
          const insert = this.db!.prepare(
            `INSERT INTO vectors (name, embedding) VALUES (?, ?)`,
          );
          changed.forEach((record, i) => {
            remove.run(record.name);
            insert.run(record.name, toBuffer(embedded[i]!));
            vectors += 1;
          });
        }
      } catch (e) {
        l.warn({ err: errMessage(e) }, 'embedding pass failed; lexical retrieval still works');
      }
    }

    l.debug({ indexed: records.length, vectors }, 'rag index synced');
    return { indexed: records.length, vectors };
  }

  /**
   * Top-k memories for a query (§5.4), inside the caller's project scope
   * (§31.3): a memory tagged with an island surfaces only where that island is
   * loaded. The filter is here, in retrieval — the model cannot leak what it
   * is never handed.
   */
  async retrieve(query: string, k = 5, loaded: string[] = []): Promise<RetrievalResult> {
    const text = query.trim();
    if (!text) return { hits: [], mode: 'empty' };
    const db = this.open();
    const scope = scopeClause('project', loaded);
    const rows = db
      .prepare(
        `SELECT name, description, type, content, project FROM memories WHERE ${scope.sql}`,
      )
      .all(...scope.params) as {
      name: string;
      description: string;
      type: string;
      content: string;
      project: string | null;
    }[];
    if (!rows.length) return { hits: [], mode: 'empty' };

    if (this.dimension > 0) {
      try {
        const [vector] = await this.embeddings.embed([text]);
        if (vector?.length === this.dimension) {
          const allowed = new Set(rows.map((r) => r.name));
          // Over-fetch and filter after: the KNN cannot see the scope, so
          // asking for exactly k would quietly return fewer once an
          // out-of-scope memory took one of the slots.
          const hits = db
            .prepare(
              `SELECT v.name AS name, distance, m.description AS description,
                      m.type AS type, m.content AS content, m.project AS project
                 FROM vectors v JOIN memories m ON m.name = v.name
                WHERE v.embedding MATCH ? AND k = ?
                ORDER BY distance`,
            )
            .all(toBuffer(vector), Math.max(k * 4, k + 20)) as (RetrievalHit & {
            distance: number;
          })[];
          const scoped = hits.filter((h) => allowed.has(h.name)).slice(0, k);
          if (scoped.length) {
            return {
              mode: 'vector',
              hits: scoped.map((h) => ({
                name: h.name,
                description: h.description,
                type: h.type,
                content: h.content,
                project: h.project ?? null,
                score: 1 / (1 + h.distance),
              })),
            };
          }
        }
      } catch (e) {
        l.warn({ err: errMessage(e) }, 'vector retrieval failed; falling back to lexical');
      }
    }

    return { mode: 'lexical', hits: lexicalSearch(text, rows, k) };
  }

  stats(): { indexed: number; vectors: number; dimension: number } {
    const db = this.open();
    const indexed = (db.prepare(`SELECT COUNT(*) AS n FROM memories`).get() as { n: number }).n;
    const vectors =
      this.dimension > 0
        ? (db.prepare(`SELECT COUNT(*) AS n FROM vectors`).get() as { n: number }).n
        : 0;
    return { indexed, vectors, dimension: this.dimension };
  }
}

/**
 * A window of `content` around the first query term that appears in it, capped
 * at `max` characters. Shared by every corpus (§18.1, §25): a hit the model
 * cannot see the context of is a hit it has to spend another call on.
 */
export function excerptFor(content: string, query: string, max: number): string {
  const terms = query
    .toLowerCase()
    .split(/\s+/)
    .filter((t) => t.length > 2);
  const haystack = content.toLowerCase();
  const at = terms
    .map((t) => haystack.indexOf(t))
    .filter((i) => i >= 0)
    .sort((a, b) => a - b)[0];
  if (at === undefined) return content.slice(0, max);
  const from = Math.max(0, at - max / 3);
  const text = content.slice(from, from + max);
  return from > 0 ? `…${text}` : text;
}

const STOPWORDS = new Set([
  'the',
  'a',
  'an',
  'and',
  'or',
  'of',
  'to',
  'in',
  'is',
  'are',
  'was',
  'were',
  'do',
  'does',
  'did',
  'i',
  'you',
  'my',
  'me',
  'what',
  'when',
  'how',
  'that',
  'this',
  'it',
  'for',
  'on',
  'with',
  'about',
  'have',
  'has',
  'be',
  'at',
  'as',
  'if',
  'so',
  'not',
  'his',
  'her',
  'their',
]);

function tokenise(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9åäöæøéèüñ]+/i)
    .filter((w) => w.length > 2 && !STOPWORDS.has(w));
}

/** Lexical fallback: term overlap weighted towards name and description. */
export function lexicalSearch(
  query: string,
  rows: { name: string; description: string; type: string; content: string }[],
  k: number,
): RetrievalHit[] {
  const terms = new Set(tokenise(query));
  if (!terms.size) return [];
  const scored = rows.map((row) => {
    const nameTerms = new Set(tokenise(`${row.name} ${row.description}`));
    const bodyTerms = new Set(tokenise(row.content));
    let score = 0;
    for (const term of terms) {
      if (nameTerms.has(term)) score += 2;
      else if (bodyTerms.has(term)) score += 1;
    }
    return { ...row, score: score / (terms.size * 2) };
  });
  return scored
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, k);
}
