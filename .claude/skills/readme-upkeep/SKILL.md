---
name: readme-upkeep
description: Keeping README.md true. Use after landing a feature a user would care about, changing install/run steps, renaming tools or commands, or changing any behavior the README already describes. The README lies until you update it in the same change.
---

# README upkeep

README.md is the front door, deliberately short (~90 lines), written for
someone deciding whether to run this rather than for someone building it.
Depth lives in `docs/`. The rule: **if your diff adds something a user would
care about, or changes something the README already claims, the README moves
in the same commit.**

## The shape (do not restructure it)

Title and CI badge, one paragraph, the screenshot, `## Why`, `## Status`,
`## Run it`, `## What it can do`, `## Docs`, `## License`. In that order.
Anything longer than a line belongs in one of:

| Detail | Home |
|---|---|
| a capability described in full | `docs/features.md` |
| a design argument, a mechanism, a rationale | `docs/design.md` |
| systemd, LAN bind, device pairing, optional npm scripts | `docs/running.md` |
| contracts, schemas, constants | `spec.md` |

## What qualifies

Update **"What it can do"** when you land a user-visible capability: a new
built-in tool family, integration, or interaction surface. **One line, no
bold lead-in, no subordinate clauses.** If it needs a paragraph, the
paragraph is a section in `docs/features.md` and the README line stays one
line. Internal machinery (a dispatcher refactor, a cache, a test harness) is
never README-worthy, however proud of it you are.

Update **"Run it"** when anything it states stops being true: commands, the
port, the default bind, prerequisites, the data directory, the setup flow,
the number of provider presets. These are verifiable claims. Check them
against `package.json`, `src/core/config.ts`, `ui/setup.html` and the CLI
before writing, not from memory.

Update **"Status"** whenever its numbers or its admissions go stale: the
test-file count, the context budgets, what has and has not been run on a real
machine, whether a release is tagged. This section is the most valuable one
in the file precisely because it admits things, so never quietly soften it.
If a change *weakens* a claim elsewhere, updating the README is not the fix;
flag the design problem to the user.

Update **"Why"** almost never. Three sentences and a link to
`docs/design.md`. Touch it only when a change genuinely strengthens or
weakens the gate-between-reading-and-acting claim.

## How to write it

- Plain, specific, mechanism over adjective. "Numbers never pass through the
  model's token stream" is the house style; "robust and secure" is not.
- **Numbers over adjectives.** "54 test files", "30,000 tokens per run",
  "8 tool namespaces in the prompt" — never "aggressive context discipline"
  or "the full suite". A number can be checked, which is the point.
- Four constructions are banned, because they are what generated prose reads
  like: antithesis ("capability is enforced, not prompted") more than once in
  the file; italics used for emphasis; em-dash appositives (the README has
  zero, keep it that way); three-item parentheticals.
- Never name competing projects. Contrast by design property.

## Checklist (run against the diff)

- [ ] User-visible capability landed? → one line in "What it can do", placed
      with its kin, plus its section in `docs/features.md`.
- [ ] Any command, port, default, prerequisite, count or flow the README
      states changed? → fixed, verified against code.
- [ ] Do the existing lines still describe reality? (Renamed a tool? Changed
      a default? The README doesn't know unless you tell it.)
- [ ] Are the "Status" numbers still true?
- [ ] Still ~90 lines? If the file grew, the new prose belongs in `docs/`.

*(Related: `self-review` runs this check as part of the exit ritual.)*
