# Turminder

A self-hosted, event-driven LLM personal assistant (Node/TypeScript,
llama.cpp-first). The service is named after Turminder Xuss, the drone in
Iain M. Banks' *Matter*; each installed instance names itself after a
Culture Mind during onboarding.

**spec.md is binding** — appendices win over body text, and behavior
changes update the spec in the same commit. plan.md tracks phases with
checkboxes; keep it truthful. When unsure how to do something, the order of
authority is: spec appendix → spec body → the closest exemplar file →
ask. Never "a reasonable way I just invented".

## Commands

- `npm run dev` — run the service (`npx tsx src/index.ts <cmd>` for CLI:
  `ask`, `events`, `tools list`, `setup`, `onboard`, `auth google`, …)
- `npm test` / `npm run typecheck` / `npm run lint`
- Data lives in `~/.turminder` (or `--data-dir` / `TURMINDER_DATA_DIR`) —
  a git repo over the human-readable half + `events.db`. It is the user's
  live install: read freely, mutate only when the task requires it.

## Skills — read BEFORE editing, not after breaking

| Touching | Read first |
|---|---|
| anything at all | `turminder-conventions` (the constitution) |
| `src/tools/integrations/`, new tools, pollers, external APIs | `writing-integrations` |
| `src/model/`, `src/prompts/`, `src/chat/`, message/context assembly | `context-and-prompts` |
| `src/db/`, schema, SQL, persistence | `db-and-migrations` |
| `src/net/`, `daemon/`, `ui/`, frames, routes | `protocol-and-ui` |
| a feature users would notice, or anything README.md claims | `readme-upkeep` |
| any user-visible change (entry under `# Next`) | `changelog-upkeep` |
| finishing any change | `self-review` (the exit ritual) |

## The rules most often broken — do not be next

1. **No improvisation.** No new dependencies (App. J is a whitelist), no
   new mechanisms when an existing primitive covers it (everything is an
   event; every capability is a tool), no drive-by refactors or
   "improvements" beyond the task.
2. **Expected failures are `{error, message}` return values, not throws.**
3. **Secrets never leave the secret store (§27)** — not into results, logs,
   traces, commits, or model context. `${secret:KEY}` references only, and
   `core/secret-store` is the only module that touches `secrets/`.
4. **The context/cache invariants (spec §20–21) are guarded by tests**
   (`context-discipline`, `reasoning`, prefix-stability). If your change
   makes one fail, the change is wrong — never loosen a guard test.
5. **Spec and code move together.** A tool, event, frame, column, or
   constant that exists in code but not in the spec appendix is a bug.
