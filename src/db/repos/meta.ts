import type { Db } from '../index.js';
import type { ObservedContext, ObservedContextStore } from '../../model/types.js';
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

  /**
   * The context size an endpoint was observed to serve (§20.11, App. C) —
   * learned from the startup drift check or a length refusal, never from
   * config — with the configured `context_size` it was learned against.
   * A legacy plain-integer value reads as `{size, configured: null}`.
   * Anything without a positive integer size reads as unknown rather than as
   * a window of zero.
   */
  observedContext(endpoint: string): ObservedContext | null {
    const raw = this.get(`observed_context_size:${endpoint}`);
    if (raw === null) return null;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return null;
    }
    const positive = (n: unknown): n is number => Number.isInteger(n) && (n as number) > 0;
    if (positive(parsed)) return { size: parsed, configured: null };
    const v = parsed as { size?: unknown; configured?: unknown } | null;
    if (!v || typeof v !== 'object' || !positive(v.size)) return null;
    return { size: v.size, configured: positive(v.configured) ? v.configured : null };
  }

  setObservedContext(endpoint: string, observed: ObservedContext): void {
    this.setJson(`observed_context_size:${endpoint}`, {
      size: Math.floor(observed.size),
      configured: observed.configured,
    });
  }

  deleteObservedContext(endpoint: string): void {
    this.delete(`observed_context_size:${endpoint}`);
  }

  /** This repo as the model stack's store of observed windows (§20.11). */
  observedContextStore(): ObservedContextStore {
    return {
      get: (endpoint) => this.observedContext(endpoint),
      set: (endpoint, observed) => this.setObservedContext(endpoint, observed),
      delete: (endpoint) => this.deleteObservedContext(endpoint),
    };
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
