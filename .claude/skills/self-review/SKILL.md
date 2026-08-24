---
name: self-review
description: The exit ritual — run this checklist against your diff before declaring any Turminder change done. Use when finishing a task, before committing, or when asked "is this ready". It exists because changes that compile and pass their own happy-path test still routinely violate the spec contract.
---

# Self-review — run against the actual diff, not your memory of it

Look at the real diff (`git diff` / `git status` in the repo and, if you
touched it, in the data dir). For each question, the answer is either
"yes", "n/a", or you're not done. Do not summarize this checklist back —
act on it.

## Contract

- [ ] Does the diff change behavior the spec describes? Then the spec
      changed in this same commit (appendix row, DDL, constant, frame
      table, tool table — whichever is authoritative). Code-only divergence
      is the #1 correction this project has had to make.
- [ ] New/changed tool → App. F row matches args/returns EXACTLY (names,
      types, defaults). New event → App. B row with idempotency +
      serialization keys. New frame → App. D. New config key → App. G
      example. New constant → App. A.
- [ ] `package.json` dependencies untouched — or App. J updated and the
      user explicitly approved.
- [ ] plan.md checkbox state matches reality (nothing ticked that isn't
      done; nothing done that isn't ticked).
- [ ] README still true: a user-visible capability landed → a bullet in
      "What it can do"; a command/port/default/flow the README states
      changed → the statement fixed (see `readme-upkeep`).
- [ ] CHANGELOG updated under `# Next` for user-visible changes — with the
      placement rule from `changelog-upkeep`: a fix to something itself
      introduced in Next gets NO "Fixed" line (edit the feature's entry or
      nothing); "Fixed" entries are only for behavior a user of the last
      numbered release could have hit.

## Invariants (the silent breakers)

- [ ] No throw for an expected failure; no `{error}` shape invented that
      isn't `{error: snake_case, message}`.
- [ ] No secret can reach a tool result, log line, trace row, git commit,
      or model context via any path this diff adds. If the diff touches
      secrets at all: does the sentinel test cover the new path?
- [ ] Module boundaries hold (App. I): nothing below `net` imports `net`;
      integrations don't touch sockets; `core`/`db` import nothing above.
- [ ] If the diff touches `src/model/`, `src/prompts/`, or `src/chat/`:
      prefix-stability, context-discipline, and reasoning tests still pass
      UNMODIFIED. Loosening a guard test to ship a change is the failure
      mode, not a fix.
- [ ] Anything user-visible that changed state is traced; anything traced
      derives from originals, not capped/elided forms.

## Quality

- [ ] Tests: happy path + the expected-failure paths + (if applicable)
      idempotency/replay. Fakes extended, not duplicated. `npm test`
      actually run, actually green — paste-worthy output seen, not assumed.
- [ ] `npm run typecheck` and `npm run lint` clean.
- [ ] Comments in touched files still TRUE after the change (stale
      load-bearing comments are worse than none).
- [ ] Names/style match the surrounding file, not your habits: snake_case
      result keys with units, `log('scope')`, deps-object factories.

## Scope

- [ ] Nothing in the diff is an unrequested "improvement" — refactors,
      renames, reorganizations, or behavior tweaks beyond the task. If you
      spotted something worth fixing, it's a note to the user, not a
      change.
- [ ] Every file in `git status` is either part of the task or explained.

Finish by stating: what changed, what was verified (which tests, run how),
and anything you noticed but deliberately did not touch.
