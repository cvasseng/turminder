import type { Db } from '../index.js';
import { getMeta, setMeta } from '../index.js';

/**
 * The key/value corner of the database (App. C). Used for schema version and
 * for source cursors — the "where did I get to" of every poller.
 */
export class MetaRepo {
  constructor(private readonly db: Db) {}

  get(key: string): string | null {
    return getMeta(this.db, key);
  }

  set(key: string, value: string): void {
    setMeta(this.db, key, value);
  }

  delete(key: string): void {
    this.db.prepare(`DELETE FROM meta WHERE key = ?`).run(key);
  }

  cursor(source: string): string | null {
    return this.get(`source:${source}:cursor`);
  }

  setCursor(source: string, value: string): void {
    this.set(`source:${source}:cursor`, value);
  }

  json<T>(key: string, fallback: T): T {
    const raw = this.get(key);
    if (raw === null) return fallback;
    try {
      return JSON.parse(raw) as T;
    } catch {
      return fallback;
    }
  }

  setJson(key: string, value: unknown): void {
    this.set(key, JSON.stringify(value));
  }
}
