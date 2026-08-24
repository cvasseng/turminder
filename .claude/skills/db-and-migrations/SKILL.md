---
name: db-and-migrations
description: How to change the database — schema migrations, repositories, and the rules that keep events.db consistent. Read before touching src/db/, adding a table or column, writing SQL anywhere, or changing what gets persisted. Never edit a shipped migration.
---

# Database & migrations (spec App. C, §12.2)

One database (`data/events.db`), `better-sqlite3`, WAL, foreign keys ON,
**single writer process** — that last one is a spec invariant, not a
suggestion. The sync API is fine *because* of it.

## Changing the schema — the only path

1. **New migration file**: `src/db/migrations/NNN-kebab-name.ts`, exporting
   `{version: NNN, name, up(db)}` (see `003-conversation-open-namespaces.ts`
   as the exemplar — including its header comment explaining WHY and what
   the default means for existing rows).
2. Register it in `src/db/migrations/index.ts`.
3. **Update spec App. C in the same commit** — the DDL there is normative;
   a column that exists in code but not in App. C is a spec violation.
4. **Never edit a shipped migration.** `001-init.ts` and successors are
   history; installed databases already ran them. Fixing a past migration
   means writing a new one that migrates forward. The only exception is a
   migration that has never left your working tree.
5. Pick defaults that make existing rows behave like the feature always
   existed and was unused (`'[]'`, `NULL`, `0`) — a migration must never
   require a data backfill script to leave the system correct.

`MANIFEST.layout_version` is for the *data-dir layout* (directories,
files); `meta.db_version` is for the *database*. They move independently —
don't bump one for the other.

## Repositories

- One repo per table in `src/db/repos/`, wired through `repos/index.ts`.
  All SQL lives in repos — no inline SQL in executors, integrations, or
  `net/`. If a module needs a new query, it gets a repo method.
- Prepared statements at construction; methods are small, typed, and named
  for intent (`turnForEvent`, `tokensForConversation`), not for SQL.
- JSON columns are TEXT; parse/stringify at the repo boundary so callers
  see typed objects. Timestamps are ISO 8601 UTC with milliseconds via
  `core/time.js` — never `new Date().toISOString()` scattered inline.
- `meta` is the key-value junk drawer for cursors and caches
  (`meta.cursor()`, `meta.json()`), keyed `<owner>:<what>` — use it before
  inventing a table for small state. Invent a table when the data needs
  queries, indexes, or lifecycle.

## Persistence rules that bite

- **Idempotency lives in the schema**: `ux_events_idem` dedupes on
  `(source, idempotency_key)` — sources rely on insert-time dedupe, so
  never "optimize" submission by pre-checking existence (race) and never
  drop that partial index.
- Status columns are CHECK-constrained enums; extending one is a migration
  + an App. C edit + a search for every `switch` on it.
- The retention job NULLs `events.payload` and prunes `trace.data` fields
  (C.2) — new columns holding payload-sized data need a retention decision
  at design time, in App. C.
- Cursor-after-submit ordering in sources (`source.ts tick()`): the cursor
  is written AFTER events are submitted so a crash re-emits and dedupe
  absorbs it. Don't reorder for tidiness.

## Tests

`test/db.test.ts` and per-feature tests run migrations from scratch on a
temp dir — every migration must apply cleanly on an empty database AND on
one that has real rows from the prior version (write both cases for
schema-shape changes). Use `test/helpers.ts` / `service-harness.ts` for
setup rather than hand-building databases.
