---
name: writing-integrations
description: How to write a Turminder bundled integration (tools, pollers, activation). Use whenever adding or modifying anything under src/tools/integrations/, adding a tool, adding an event source/poller, or wiring a new external API into the assistant.
---

# Writing a Turminder integration

An integration is a bundled tool provider — and optionally an event source —
compiled into the service (spec §11.1, §19.5). This skill is the consistency
contract: follow it and a new integration is indistinguishable in style,
wiring, and safety from the shipped ones. `weather.ts` (simple, external API)
and `asana/` (credentialed, poller) are the reference exemplars — read the
closest one before writing.

**The spec is binding and ships with the change.** A new integration updates
spec.md in the same commit: App. F tool table, App. B event rows (if it emits
events), and the F.7 default-grant line if chat gets it by default. Adding an
npm dependency is a spec change (App. J) — default to native `fetch` and the
pinned libraries.

## 1. Decide the shape

Three decisions, in order:

1. **Activation** (§19.5): `none` (no credential, always on — time, weather),
   `form` (a secret/settings form suffices — Asana), or `oauth` (browser
   round-trip — Google Calendar). If a credential is involved, activation is
   NEVER `none`: a credential arriving any way other than a form means it
   passed through a model's context (§14.4.2).
2. **Source?** Does it watch external state and emit events? Then it extends
   `PollingSource` and `provides.source: true`.
3. **File layout**:
   - Simple, tools-only → one file: `src/tools/integrations/<namespace>.ts`
   - Credentialed and/or API-heavy → a directory:
     `src/tools/integrations/<name>/{client.ts, tools.ts, <thing>-source.ts}`
     (API client separate from tool definitions, separate from the poller).

Naming: the **integration name** is human (`google-calendar`); the **tool
namespace** is the prefix of its tools (`calendar.*`) and its key in the hub
— they may differ, and `namespaceOf()` in `registry.ts` derives it from the
first tool. Secret keys are `ALL_CAPS` in the secret store (§27)
(`ASANA_PAT`, `GOOGLE_CLIENT_SECRET`).

## 2. The manifest (always)

Every integration — core or credentialed — has an entry in
`src/tools/integrations/registry.ts` (`MANIFESTS`). Core facilities use the
`core()` helper. Credentialed ones declare their activation `fields`
(`FieldSpec`, App. D.5): secret fields carry `secret_key`; settings fields
carry sensible `value` defaults; labels tell the user where to find the
credential (see the Asana PAT label). `provides` lists every tool name and
event type — `setup.list_integrations` and "what can you connect to" are
generated from this, so an omission is a user-visible lie.

## 3. Tool definitions

Follow `ToolDefinition` (`src/tools/types.ts`) exactly:

- **Name**: `<namespace>.<verb>`, verbs short and literal (`list_events`,
  not `getEventsForCalendar`).
- **Tier**: `ro` auto-executes; anything that mutates external or local
  state is `se`. Destructive operations (delete) additionally get
  confirm-gated in the default grants — note it in the spec F table.
- **Args**: a zod schema with `.describe()` on non-obvious fields and on the
  object itself when args interact ("either location, or both lat and lon").
  Validation happens at the edge; `execute` can trust its input types.
- **Description**: written for a small model deciding whether to call it —
  what it's for, when to use it, one behavioral instruction if needed
  ("Cite the attribution the result carries").
- **Errors are return values, not throws**: expected failures return
  `{error: "snake_case_code", message: "human sentence"}` so the model can
  read them and react. Wrap external calls in try/catch and convert; only
  bugs propagate as exceptions.
- **Results are plain JSON**, compact, model-readable. Include units in key
  names (`temp_min_c`, `precipitation_mm`, `poll_interval_s`). Never include
  a secret, a token, or an internal path in a result.

## 4. Construction and dependencies

Integrations are **factory functions taking a deps object** — never
module-level state (a process-wide `Throttle` singleton is the one accepted
exception):

```ts
export interface FooDeps {
  config: Config;
  meta: MetaRepo;              // caches, cursors — see §6
  fetch?: typeof globalThis.fetch;  // ALWAYS injectable, for tests
  now?: () => Date;            // when time matters, for tests
}
export function fooTools(deps: FooDeps): ToolDefinition[] { … }
```

Secrets are read from `deps.config.secrets.KEY` at call/construction time —
never cached into results, never logged. Logger: `log('tool:<ns>')` from
`core/logger.js`; log at `debug` for routine calls, `warn` for degraded
behavior, and never log argument or result *content* that could carry
secrets or personal text.

## 5. Talking to external APIs

The etiquette that keeps free APIs free (and matches `weather.ts`):

- `USER_AGENT` from `core/version.js` on every request — some APIs
  (api.met.no) hard-403 without it; all of them deserve it.
- `AbortSignal.timeout(…)` on every fetch. No unbounded waits, ever.
- **Cache in the `meta` repo** (`deps.meta.json`/`setJson`, key prefix
  `<ns>:`): respect `Expires`, send `If-Modified-Since`, honor documented
  TTLs (App. A). A repeated question must not mean a repeated upstream call.
- Client-side rate limiting where the provider's policy demands it
  (`Throttle` in weather.ts, `Retry-After` handling in asana/client.ts).
- Pagination: follow it to completion or expose an explicit limit —
  never silently truncate.

## 6. Sources (pollers)

Extend `PollingSource` (`src/ingress/source.ts`) — it already provides the
loop, durable cursors (`meta`), failure backoff, and overlap protection.
You implement `poll(cursor)` and optionally `ready()`:

- **Every emitted event carries an idempotency key** derived from the
  external identity (Message-ID, task gid + state, occurrence id) — a
  re-poll after a crash must be absorbed by dedupe, because the cursor is
  written *after* submission on purpose.
- Pick the **serialization key** for ordered processing (thread id, task
  id, calendar id) — same-entity events must not race.
- **Register new event types in spec App. B** with payload shape and both
  keys. Payloads containing other people's text are untrusted by
  definition — the prompt assembler fences them, but keep payloads to what
  handlers need (the ingress excerpt is 4000 chars).
- `ready()` returns `{ok: false, reason}` when unauthorised — a source that
  can't work must not poll, and must say why.

## 7. Wiring and activation

- **Core** (`activation: none`): construct in `service.ts` alongside the
  others and hand the tools to the hub under the namespace.
- **Credentialed**: add a runtime block in `external.ts`
  (`createSourceStack`), following the calendar/asana blocks exactly:
  - a `z.strictObject` **settings schema** with defaults for every field;
    invalid settings **degrade to defaults with a warning**, never crash —
    one bad credential or typo must not stop the assistant.
  - activation is the switch, not the credential: `active: true` in
    `config/integrations.yaml` gates everything; a missing secret with an
    active record is a reported misconfiguration (`detail` string), not an
    exception. Deactivation keeps secrets so reactivation is one form.
  - `detail` strings are user-facing status ("not activated — 'set up
    asana' in chat") — write them as instructions, not error dumps.
- The activation form's server-side effect (setup integration) must
  **probe the credential live** (one cheap authenticated call) before
  writing the activation record — fail the form with a readable message,
  not later at poll time.
- Never write `config/integrations.yaml`, `mcp.yaml`, or `channels.yaml`
  from integration code — only the setup flow writes those (F.6 carve-out).

## 8. Tests (vitest, `test/`)

Minimum bar, all with injected `fetch` mocks (no network in tests):

1. Happy path per tool: args in → shaped result out.
2. Expected failures return `{error, …}` values (HTTP 4xx/5xx, empty
   results, unauthorised).
3. External-API etiquette: asserts the `User-Agent` header is set; asserts
   a second call within TTL performs **zero** upstream fetches.
4. Sources: a re-poll with the same upstream state emits events that dedupe
   (idempotency keys stable); cursor advances only after submission.
5. Credentialed: the secret sentinel test — activate with a known sentinel
   value, assert it appears in `secrets.yaml` and in nothing else
   (events.db, traces, logs, git). Extend the existing sentinel suite.

## Anti-pattern checklist (reject on review)

- Throwing for an expected failure instead of returning `{error, …}`.
- A tool result, log line, or `detail` string containing a secret.
- Module-level `fetch`/state that a test can't substitute.
- An external call without `USER_AGENT` + timeout, or an uncached repeat.
- A source event without an idempotency key.
- A new npm dependency without an App. J spec change.
- Tools/events present in code but missing from the manifest or spec App. F/B.
- A credentialed integration reachable without the form flow.
- Camel-case or unit-less result keys (`tempMin` → `temp_min_c`).
