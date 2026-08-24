---
name: readme-upkeep
description: Keeping README.md true. Use after landing a feature a user would care about, changing install/run steps, renaming tools or commands, or changing any behavior the README already describes. The README lies until you update it in the same change.
---

# README upkeep

README.md is the front door: three sections, deliberately brief, written
for someone deciding whether to run this — not for someone building it.
It goes stale one small change at a time, so the rule is: **if your diff
adds something a user would care about, or changes something the README
already claims, the README moves in the same commit.**

## What qualifies

Update **"What it can do"** when you land a user-visible capability — a
new built-in tool family, integration, or interaction surface. One bullet,
or extend an existing one; a capability is README-worthy when a user would
choose the project partly because of it. Internal machinery (a dispatcher
refactor, a cache, a test harness) never is, however proud of it you are.

Update **"How to run it"** when anything it states stops being true:
commands, the port, the default bind, prerequisites, the data directory,
the setup/onboarding flow. These are verifiable claims — check them
against `package.json`, `src/core/config.ts` defaults, and the CLI before
writing, not from memory.

Update **"Why another assistant system?"** almost never. It states design
principles backed by mechanisms (grants in the dispatcher, secrets out of
context, data bindings, one event loop). Touch it only when a change
genuinely strengthens or weakens one of those claims — and if your change
*weakens* one ("temporarily allow X"), updating the README is not the fix;
flagging the design problem to the user is.

## How to write it

- Match the existing voice: plain, specific, mechanism-over-adjective.
  "Numbers never pass through the model's token stream" is the house
  style; "robust and secure" is not.
- Brevity is the contract. New feature = one bullet. If a bullet needs a
  paragraph, the paragraph belongs in spec.md and the bullet links nothing
  — the README has no deep links except spec.md/plan.md at the bottom.
- The differentiators section never names competing projects. Contrast by
  design property, not by name.
- Never restructure: the three sections, in this order, are the format.
  No badges, screenshots, or feature matrices without the user asking.

## Checklist (run against the diff)

- [ ] Does the diff add a user-visible capability? → one bullet in "What
      it can do", placed with its kin (tools with tools, docs with docs).
- [ ] Does the diff change any command, port, default, prerequisite, or
      flow the README states? → fix the statement, verified against code.
- [ ] Do existing bullets still describe reality? (Renamed a tool?
      Changed a default? The README doesn't know unless you tell it.)
- [ ] Still brief? If your edit grew the file noticeably, cut elsewhere
      or move detail to spec.md.

*(Related: `self-review` runs this check as part of the exit ritual.)*
