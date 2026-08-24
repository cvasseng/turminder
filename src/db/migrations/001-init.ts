import type { Migration } from './types.js';

/** The Appendix C schema, verbatim. */
const SQL = `
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);

CREATE TABLE events (
  id                TEXT PRIMARY KEY,
  type              TEXT NOT NULL,
  source            TEXT NOT NULL,
  occurred_at       TEXT,
  received_at       TEXT NOT NULL,
  payload           TEXT NOT NULL,
  summary           TEXT,
  idempotency_key   TEXT,
  serialization_key TEXT,
  caused_by         TEXT REFERENCES events(id),
  depth             INTEGER NOT NULL DEFAULT 0,
  status            TEXT NOT NULL DEFAULT 'received'
                    CHECK (status IN ('received','matched','processing',
                                      'done','failed','dead_letter','rejected')),
  attempts          INTEGER NOT NULL DEFAULT 0,
  next_attempt_at   TEXT,
  last_error        TEXT
);
CREATE UNIQUE INDEX ux_events_idem ON events(source, idempotency_key)
  WHERE idempotency_key IS NOT NULL;
CREATE INDEX ix_events_status ON events(status, next_attempt_at);
CREATE INDEX ix_events_serial ON events(serialization_key, id)
  WHERE serialization_key IS NOT NULL;

CREATE TABLE runs (
  id           TEXT PRIMARY KEY,
  event_id     TEXT REFERENCES events(id),
  kind         TEXT NOT NULL
               CHECK (kind IN ('ingress','handler','chat','onboarding',
                               'distill','maintenance')),
  handler_name TEXT,
  model        TEXT,
  status       TEXT NOT NULL DEFAULT 'running'
               CHECK (status IN ('running','done','failed')),
  started_at   TEXT NOT NULL,
  finished_at  TEXT,
  turns        INTEGER NOT NULL DEFAULT 0,
  tokens_in    INTEGER NOT NULL DEFAULT 0,
  tokens_out   INTEGER NOT NULL DEFAULT 0,
  error        TEXT
);
CREATE INDEX ix_runs_event ON runs(event_id);

CREATE TABLE trace (
  seq      INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id TEXT REFERENCES events(id),
  run_id   TEXT REFERENCES runs(id),
  at       TEXT NOT NULL,
  kind     TEXT NOT NULL
           CHECK (kind IN ('verdict','llm_call','tool_call','delivery',
                           'emit','state','error')),
  data     TEXT NOT NULL
);
CREATE INDEX ix_trace_event ON trace(event_id);

CREATE TABLE deliveries (
  seq            INTEGER PRIMARY KEY AUTOINCREMENT,
  id             TEXT UNIQUE NOT NULL,
  intent         TEXT NOT NULL CHECK (intent IN ('notify','confirm')),
  payload        TEXT NOT NULL,
  created_at     TEXT NOT NULL,
  expires_at     TEXT NOT NULL,
  created_by_run TEXT REFERENCES runs(id),
  status         TEXT NOT NULL DEFAULT 'queued'
                 CHECK (status IN ('queued','delivered','acked','expired')),
  delivered_at   TEXT,
  acked_at       TEXT,
  acked_by       TEXT
);
CREATE INDEX ix_deliveries_status ON deliveries(status, expires_at);

CREATE TABLE schedules (
  id             TEXT PRIMARY KEY,
  fire_at        TEXT NOT NULL,
  rrule          TEXT,
  grace_s        INTEGER NOT NULL DEFAULT 3600,
  note           TEXT NOT NULL,
  event_type     TEXT NOT NULL DEFAULT 'timer.fired',
  event_payload  TEXT NOT NULL DEFAULT '{}',
  created_by_run TEXT REFERENCES runs(id),
  status         TEXT NOT NULL DEFAULT 'active'
                 CHECK (status IN ('active','done','cancelled','missed')),
  last_fired_at  TEXT
);
CREATE INDEX ix_schedules_due ON schedules(status, fire_at);

CREATE TABLE conversations (
  id               TEXT PRIMARY KEY,
  title            TEXT,
  mode             TEXT NOT NULL DEFAULT 'normal'
                   CHECK (mode IN ('normal','onboarding')),
  status           TEXT NOT NULL DEFAULT 'open'
                   CHECK (status IN ('open','closed')),
  created_at       TEXT NOT NULL,
  last_activity_at TEXT NOT NULL
);

CREATE TABLE turns (
  seq             INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id TEXT NOT NULL REFERENCES conversations(id),
  role            TEXT NOT NULL CHECK (role IN ('user','assistant')),
  content         TEXT NOT NULL,
  event_id        TEXT REFERENCES events(id),
  run_id          TEXT REFERENCES runs(id),
  created_at      TEXT NOT NULL
);
CREATE INDEX ix_turns_conv ON turns(conversation_id, seq);
`;

export const migration: Migration = {
  version: 1,
  name: 'init',
  up(db) {
    db.exec(SQL);
  },
};
