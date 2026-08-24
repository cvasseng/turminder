import type BetterSqlite3 from 'better-sqlite3';
import { log } from '../core/logger.js';
import { errMessage } from '../core/errors.js';
import type { DataHome } from '../core/datadir.js';
import type { FileStore } from '../files/store.js';
import { hashContent } from '../files/store.js';
import type { EmbeddingClient } from './embeddings.js';
import { excerptFor, lexicalSearch } from './index-store.js';
import { projectOfPath } from '../projects/store.js';
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

export interface FileHit {
  path: string;
  excerpt: string;
  score: number;
}

export interface FileSearchResult {
  results: FileHit[];
  mode: 'vector' | 'lexical' | 'empty';
}

const EXCERPT_CHARS = 600;

/**
 * The files corpus (§18.1) — the same sqlite-vec machinery as memory, in its
 * own database. Files are never auto-retrieved into a prompt: this index exists
 * only so `files.search` can answer a question the agent chose to ask.
 *
 * Binary files are stored and listed but never indexed (§18.2).
 */
export class FilesIndex {
  private db: BetterSqlite3.Database | null = null;
  private dimension = 0;

  constructor(
    private readonly home: DataHome,
    private readonly store: FileStore,
    private readonly embeddings: EmbeddingClient,
  ) {}

  private get path(): string {
    return this.home.path('cache', 'files-rag.db');
  }

  private open(): BetterSqlite3.Database {
    if (this.db) return this.db;
    const db = openVectorDb(this.path);
    db.exec(`
      CREATE TABLE IF NOT EXISTS files (
        path    TEXT PRIMARY KEY,
        content TEXT NOT NULL,
        hash    TEXT NOT NULL,
        project TEXT
      );
    `);
    // A corpus indexed before projects existed holds only general files, and
    // NULL is what general means here (§31.2).
    ensureColumn(db, 'files', 'project', 'project TEXT');
    this.db = db;
    this.dimension = storedDimension(db);
    if (this.dimension > 0) this.vectors(this.dimension);
    return db;
  }

  private vectors(dimension: number): void {
    ensureVectorTable(this.db!, 'file_vectors', 'path', dimension);
    this.dimension = dimension;
  }

  close(): void {
    this.db?.close();
    this.db = null;
  }

  async rebuild(): Promise<{ indexed: number; vectors: number }> {
    this.close();
    removeDbFiles(this.path);
    return this.sync();
  }

  /** Bring the index in line with the store: new, changed, and gone files. */
  async sync(): Promise<{ indexed: number; vectors: number }> {
    const db = this.open();
    const entries = this.store.list().filter((e) => !e.binary);
    const existing = new Map(
      (
        db.prepare(`SELECT path, hash FROM files`).all() as { path: string; hash: string }[]
      ).map((r) => [r.path, r.hash]),
    );

    const changed: { path: string; content: string }[] = [];
    for (const entry of entries) {
      const file = this.store.readText(entry.path);
      if (!file) continue;
      if (existing.get(entry.path) !== file.hash) {
        changed.push({ path: file.path, content: file.content });
      }
      this.upsert(file.path, file.content, file.hash);
    }

    const present = new Set(entries.map((e) => e.path));
    for (const gone of [...existing.keys()].filter((p) => !present.has(p))) this.forget(gone);

    const vectors = await this.embed(changed);
    l.debug({ indexed: entries.length, vectors }, 'files index synced');
    return { indexed: entries.length, vectors };
  }

  /** Reindex one file — what the watcher's tier 1 does, at background priority. */
  async indexOne(rel: string, content: string | null): Promise<void> {
    this.open();
    if (content === null) {
      this.forget(rel);
      return;
    }
    const hash = hashContent(content);
    const current = this.db!.prepare(`SELECT hash FROM files WHERE path = ?`).get(rel) as
      { hash: string } | undefined;
    if (current?.hash === hash) return;
    this.upsert(rel, content, hash);
    await this.embed([{ path: rel, content }]);
  }

  /**
   * `files.search` (App. F.8). Files corpus only, by construction — and only
   * the islands this conversation has loaded (§31.3): everything under
   * `projects/<name>/` is scoped by where it sits, so the filter needs no
   * tagging ceremony to be true.
   */
  async search(query: string, k = 5, loaded: string[] = []): Promise<FileSearchResult> {
    const text = query.trim();
    if (!text) return { results: [], mode: 'empty' };
    const db = this.open();
    const scope = scopeClause('project', loaded);
    const rows = db
      .prepare(`SELECT path, content FROM files WHERE ${scope.sql}`)
      .all(...scope.params) as {
      path: string;
      content: string;
    }[];
    if (!rows.length) return { results: [], mode: 'empty' };

    if (this.dimension > 0) {
      try {
        const [vector] = await this.embeddings.embed([text]);
        if (vector?.length === this.dimension) {
          const allowed = new Set(rows.map((r) => r.path));
          // Over-fetch, then filter: the KNN cannot see the scope, and asking
          // for exactly k would return fewer once a scoped file took a slot.
          const hits = db
            .prepare(
              `SELECT v.path AS path, distance, f.content AS content
                 FROM file_vectors v JOIN files f ON f.path = v.path
                WHERE v.embedding MATCH ? AND k = ?
                ORDER BY distance`,
            )
            .all(toBuffer(vector), Math.max(k * 4, k + 20)) as {
            path: string;
            distance: number;
            content: string;
          }[];
          const scoped = hits.filter((h) => allowed.has(h.path)).slice(0, k);
          if (scoped.length) {
            return {
              mode: 'vector',
              results: scoped.map((h) => ({
                path: h.path,
                excerpt: excerptFor(h.content, text, EXCERPT_CHARS),
                score: 1 / (1 + h.distance),
              })),
            };
          }
        }
      } catch (e) {
        l.warn({ err: errMessage(e) }, 'vector file search failed; falling back to lexical');
      }
    }

    // Same lexical fallback memory uses: a crude search beats no search.
    const hits = lexicalSearch(
      text,
      rows.map((r) => ({ name: r.path, description: '', type: 'file', content: r.content })),
      k,
    );
    return {
      mode: 'lexical',
      results: hits.map((h) => ({
        path: h.name,
        excerpt: excerptFor(h.content, text, EXCERPT_CHARS),
        score: h.score,
      })),
    };
  }

  stats(): { indexed: number; vectors: number; dimension: number } {
    const db = this.open();
    const indexed = (db.prepare(`SELECT COUNT(*) AS n FROM files`).get() as { n: number }).n;
    const vectors =
      this.dimension > 0
        ? (db.prepare(`SELECT COUNT(*) AS n FROM file_vectors`).get() as { n: number }).n
        : 0;
    return { indexed, vectors, dimension: this.dimension };
  }

  /** The island a path belongs to (§31.2): `projects/<name>/…`, or general. */
  private upsert(rel: string, content: string, hash: string): void {
    this.db!.prepare(
      `INSERT INTO files (path, content, hash, project) VALUES (?, ?, ?, ?)
         ON CONFLICT(path) DO UPDATE SET content = excluded.content,
           hash = excluded.hash, project = excluded.project`,
    ).run(rel, content, hash, projectOfPath(rel));
  }

  private forget(rel: string): void {
    this.db!.prepare(`DELETE FROM files WHERE path = ?`).run(rel);
    if (this.dimension > 0) {
      this.db!.prepare(`DELETE FROM file_vectors WHERE path = ?`).run(rel);
    }
  }

  private async embed(files: { path: string; content: string }[]): Promise<number> {
    if (!files.length) return 0;
    try {
      const embedded = await this.embeddings.embed(
        files.map((f) => `${f.path}\n\n${f.content}`),
      );
      if (embedded.length !== files.length || !embedded[0]?.length) return 0;
      this.vectors(embedded[0].length);
      // vec0 virtual tables have no UPSERT: delete then insert.
      const remove = this.db!.prepare(`DELETE FROM file_vectors WHERE path = ?`);
      const insert = this.db!.prepare(
        `INSERT INTO file_vectors (path, embedding) VALUES (?, ?)`,
      );
      files.forEach((file, i) => {
        remove.run(file.path);
        insert.run(file.path, toBuffer(embedded[i]!));
      });
      return files.length;
    } catch (e) {
      l.warn({ err: errMessage(e) }, 'file embedding pass failed; lexical search still works');
      return 0;
    }
  }
}
