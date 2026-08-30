import type { Migration } from './types.js';

/**
 * §10.8: the request log's `recentCalls()` and the existing `usage()` query
 * both filter `trace` by `kind` and `at`, and the table had only
 * `ix_trace_event` (keyed on `event_id`, which most `llm_call` rows lack — a
 * chat turn's calls carry a `run_id`, not an `event_id`). Without this index
 * both queries fall back to a full scan of a table that is never pruned
 * (C.2: metrics are kept forever).
 */
export const migration: Migration = {
  version: 12,
  name: 'trace-kind-at',
  up(db) {
    db.exec(`CREATE INDEX ix_trace_kind_at ON trace(kind, at)`);
  },
};
