---
name: turminder-conventions
description: The Turminder constitution — cross-cutting rules for ANY code change in this repo. Read before fixing a bug, adding a feature, or refactoring anything. If you are about to invent a pattern, helper, dependency, file location, or error style, this skill is what stops you.
---

# Turminder conventions — the constitution

spec.md is **binding** (appendices win over body text) and plan.md tracks
delivery. When code and spec must diverge, the spec changes **in the same
commit** — never silently. If you find yourself designing something the
spec doesn't cover, stop and check whether an existing mechanism already
covers it; this system is deliberately built from very few primitives.

## The ten rules that stop improvisation

1. **Don't invent a second mechanism.** One event loop (§1.1) — anything
   that "happens" is an event with a trace. One tool interface (§11.1) —
   new capability = integration or MCP, never a bespoke code path. One
   delivery pipeline (§7) — user-facing output is a delivery or a chat
   frame, never a new side channel.
2. **Expected failures are return values** — `{error: "snake_case",
   message: "human sentence"}` — never throws. Only bugs throw. This holds
   for tools, sources, and internal helpers that agents consume.
3. **No new dependencies.** App. J is the whitelist; adding a package is a
   spec change the user approves, not an implementation decision. Prefer
   native `fetch`, `node:` builtins, and the pinned libraries.
4. **Injected deps, no module state.** Factories take `{config, meta,
   fetch?, now?}`-style deps objects. `fetch` and `now` are ALWAYS
   substitutable — tests never touch the network or the wall clock.
   (Accepted exception: process-wide throttles, e.g. the Nominatim
   `Throttle` in weather.ts.)
5. **Secrets never leave the secret store (§27)** — not in tool results,
   logs, traces, git, or model context. Only `${secret:KEY}` references
   travel (spec G.6, §14.4.2), and `core/secret-store` is the only module
   that touches `secrets/`. The sentinel test in CI is the enforcement;
   don't create a path it doesn't cover.
6. **Module boundaries** (App. I): `core` and `db` import nothing above
   themselves; `tools/integrations/*` never import `net`; only `net`
   touches sockets; nothing imports `ui` or `daemon`.
7. **Config files have owners.** `config.write` is fenced to
   `config/`+`handlers/`+`skills/` minus the carve-outs; `mcp.yaml`,
   `integrations.yaml`, `channels.yaml`, `grants.yaml` are written ONLY by
   their owning flows (setup forms, token CLI). Never add a writer.
8. **Naming**: tools are `<namespace>.<verb>`; result keys are snake_case
   with units (`temp_min_c`, `poll_interval_s`); events are dot-namespaced
   lowercase with idempotency + serialization keys per App. B.
9. **Every mutation of the data repo commits** with a meaningful message
   (memory, files, config writes). Every LLM call goes through the gateway;
   every tool call through a dispatcher. There are no bypasses, including
   "just this once for debugging".
10. **Zod at every edge**: config files, tool args, event payloads,
    settings. Strict objects; unknown keys are load errors, and invalid
    *settings* degrade to defaults with a warning rather than crashing
    (see `external.ts settings()`).

## Style you must match (not improve)

- Comments state constraints the code can't show, written as prose with a
  point of view (read any file — match that voice). No "// call the
  function" comments, no changelog comments.
- Logger per module: `const l = log('scope')`; `warn` for degraded, never
  log content that could carry secrets or personal text.
- Errors: `errMessage(e)` from `core/errors.js`; user-facing ones are
  `UserFacingError` with a code and a next-step hint.
- Tests live in `test/*.test.ts` (vitest), use the fakes
  (`fake-llama.ts`, `fake-asana.ts`, `service-harness.ts`) — extend those
  rather than hand-rolling new mocks.
- **Prompts are markdown files in `src/prompts/library/<category>/`, never
  string literals in a module.** Base prompts use `{{fragment}}`
  placeholders (strict substitution — typos throw at startup); shipped
  skills/handlers are auto-discovered from the directory, no registry. The
  contract test rejects document-sized template literals in `prompts/*.ts`.

## When you're unsure

The order of authority: spec appendix → spec body → the closest existing
exemplar file → asking the user. "I'll just do it a reasonable way" is not
on the list — the reasonable way is whatever the exemplar already does.

Related skills: `writing-integrations` (tools/sources),
`context-and-prompts` (model/prompt/chat layers), `db-and-migrations`
(schema), `protocol-and-ui` (WS/HTTP/UI), `self-review` (run before
declaring any change done).
