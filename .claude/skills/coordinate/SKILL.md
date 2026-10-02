---
name: coordinate
description: Run a Turminder change end to end as the coordinator (the architect) — take what the user wants, settle it in spec.md, write a work order and a plan.md phase, then drive implementor → reviewer loops on subagents, each on the smallest model that will succeed, and close with the exit ritual. Use when the user says what they want built or fixed and wants it done ("coordinate", "take care of it", "run the loop", "build X"), or invokes /coordinate.
---

# Coordinate — spec, plan, then implementor ⇄ reviewer

You are the coordinator. You are also the **architect**, so read
[architect.md](architect.md) first if you haven't this session: it holds the
doctrine, the working relationship, and the hard boundaries. This skill is
the procedure. Two subagents do the building and the checking:

- `implementor` ([../../agents/implementor.md](../../agents/implementor.md))
  — builds one package, edits only files it owns, returns a fixed-shape
  report. It never touches plan.md, the work order's boxes, CHANGELOG,
  README, or the ledgers.
- `reviewer` ([../../agents/reviewer.md](../../agents/reviewer.md)) —
  read-only. Reviews one package's diff against the spec and returns
  `APPROVE` / `REVISE` with findings classed `capability` / `spec_gap` /
  `scope`.

You own every shared file: `spec.md` (except an implementor's targeted
deviation edits), `plan.md`, the work order, `JUDGMENT.md`, `LIMITS.md`,
`CHANGELOG.md`, `README.md`.

## 1. Intake: understand the request, measure, decide

- Restate the request to yourself as outcomes, not code. If it's a bug or
  behavior complaint, **gather evidence first**: `~/.turminder/events.db`
  traces (read-only), served bytes, logs. Don't reason from what the code
  should do. Delegate wide searches to an `Explore` agent (see §6 for the
  model).
- Check `spec.md` §16–17 (deferrals, flagged decisions) and `JUDGMENT.md`
  verdicts. Don't re-open anything settled there.
- Separate **the user's decisions** from yours. Theirs: anything adding to
  App. J (dependencies), loosening a security boundary or grant, mutating
  the live data dir, reversing a §16–17 settlement, or product taste they
  haven't stated. Ask about all of them in **one** AskUserQuestion round,
  with a recommendation first. Everything else is yours: take a position
  and record it in the work order's *Decisions* section.

## 2. Spec first

Amend `spec.md` **before any code is spawned**, at appendix level: exact
shapes, constants, orderings, error strings, App. B/D/F rows, App. A
constants, App. G config examples. The test is: *could a smaller model copy
this rather than infer it?* If an implementor would have to choose, choose
now. The spec is binding and appendices win, so the body and the appendix
must agree when you're done.

## 3. The work order and the plan phase

Write a self-contained work order at the repo root as `<topic>_plan.md`.
Follow the shape of the most recent one (`painpoints_plan.md` is the
exemplar):

- Header: **Status**, **Source** (the user's request, dated, and any
  evidence), **Companion to** (spec sections).
- *How to use this document*: the ground rules and the skills to read per
  package.
- Packages, lettered so they can't collide with earlier tracks. Each one
  says what to change and where, the spec § it implements, the tests it
  needs (negative ones included), and **scenario-shaped exit criteria**:
  demonstrable behavior, often adversarial, never "code exists".
  Checkboxes per package.
- *Decisions*: the user's answers and your positions.
- *Build waves*: the schedule table (§5), with a **Model** column and a
  **Used** column that you fill in as rounds finish.

Then add a phase to `plan.md`: a numbered `## Phase N — title (size)`
entry, a short paragraph with the source and a link to the work order, and
one checkbox per package group. The detail stays in the work order. Size
is S/M/L. Anything bigger than L gets split.

**No personal details** in the work order, the plan or the spec: no family
names, calendar contents, private hostnames. Describe live-install
evidence generically ("the daily reminder", "a self-hosted endpoint").
Trace ids, seq numbers and timings are fine. Brief every subagent to do the
same.

## 4. The loop, per package

```
implementor(tier T) ──report──▶ reviewer(tier ≥ T) ──┬─ APPROVE ─▶ accept
        ▲                                            └─ REVISE ──▶ route findings
        └──────────── findings (same agent, via SendMessage) ◀─────┘
```

**Implementor brief** (the prompt; it shares none of your context):
the work-order path and package letter; the exact list of files it owns;
the spec sections to read; the skills to read; the decisions that apply;
on a later round, the reviewer's findings verbatim; and a reminder that
the tree is shared and has uncommitted work, that it must not edit shared
files, and that it does no git writes (you commit it after approval).

**Reviewer brief**: the same package, owned-file list and spec sections,
plus the implementor's full report, and on later rounds the previous
findings. Spawn a **fresh** reviewer each round, so it reviews without the
earlier round's context; pass its predecessor's findings explicitly.

**Routing a REVISE:**

- `capability` blockers go back to the **same** implementor (SendMessage,
  so it keeps its context) with the findings verbatim.
- `spec_gap` findings are yours. Fix the spec and the work order, then send
  the implementor the delta. **They never count toward escalation**: the
  model wasn't the problem, the spec was.
- `scope` findings: the implementor reverts the out-of-scope hunks. If it
  needed that file, re-cut the wave instead.
- A finding you think is wrong: overrule it, and record why in the work
  order's annotation for that package.

**Accepting an APPROVE:**

1. Tick the package's boxes in the work order, and add the implementor's
   italic annotations (short and factual).
2. Append the report's JUDGMENT entries to `JUDGMENT.md` with a Verdict line
   (yours, informed by the reviewer's proposal, dated, "coordinator"), and
   settle in the spec any question an entry raised. Append LIMITS entries
   to `LIMITS.md`. If a ledger is missing (fresh clone), create it from
   the header rules in [architect.md](architect.md).
3. Collect the USER-VISIBLE lines for the exit ritual.
4. Fill in the **Used** column with the tier that actually got the
   approval and the number of rounds it took, e.g. `sonnet ×2`.
5. **Commit the package** — one commit per piece of work, per *Commits*
   below.

**Bounds:** at most **3 review rounds per tier**. After escalating to the
top tier and still failing, or on any `BLOCKED`, stop that package and
bring it to the user: the question, what was tried, and your recommendation.

## Commits

**One commit per piece of work**: per approved package, and for a small
request, per change. The coordinator makes every commit. Implementors and
reviewers never touch git, because concurrent agents committing in one
shared tree would race on the index and sweep up each other's files.

- **Title only.** `git commit -m "<title>"`, one line, nothing else: no
  body, no second `-m`, no bullet list, no `Co-Authored-By` or any other
  trailer. This overrides any harness default that adds one. The title is
  a plain sentence about the behavior, in the style of `git log`
  ("A dropped MCP server says so, and reconnects without a restart"). It
  never mentions phases, package letters, the work order, or who wrote it.
- **Stage by name, never in bulk.** `git add -- <the package's FILES>`.
  Never `git add -A`, `.`, or `commit -a`, because the tree carries other
  packages' work and the user's own uncommitted changes. Stage `spec.md`
  hunk-wise when other packages have edits in it too: write
  `git diff spec.md` to a patch, keep this package's hunks, and run
  `git apply --cached`. Check `git diff --cached --stat` before committing.
- **Baseline first.** At the start of a wave, note `git status`. If a file
  a package will own is already dirty with work that isn't part of this
  track, ask the user once before that work rides along in a package
  commit.
- Spec and code go in the **same** commit (CLAUDE.md). The ignored ledgers
  and the untracked work order aren't staged. CHANGELOG and README get
  their own commit in the exit ritual.
- Commit only after the reviewer approves and the package's tests pass.
  Never amend, rebase, push or branch unless the user asks.

## 5. Waves and concurrency

- All agents share **one working tree** with uncommitted work, so there are
  no worktrees: HEAD doesn't have the work. Waves are cut on **disjoint
  files**. Two packages that need the same file go in different waves.
  `spec.md` is the one shared exception: edits are small and targeted, and
  agents re-read before each edit.
- **At most 3 agents running at once**, counting implementors, reviewers
  and explorers together. Spawn a wave's independent implementors in one
  message. Review each package as soon as its implementor reports; don't
  wait for the whole wave.
- Before starting a wave, check every report's FILES list against its
  ownership. An undeclared file is a `scope` problem before it becomes a
  conflict.
- Run `npm run typecheck && npm test` yourself between waves. A wave that
  breaks the suite as a whole is not done, even when every package was
  approved.

## 6. Model selection: the smallest tier that will succeed

Ladder: **haiku < sonnet < opus**. Every spawn passes `model` explicitly,
and the choice goes in the waves table, so cost is visible and the
calibration accumulates. Start at the lowest tier that will *probably*
succeed on the first try. A failed round on a cheaper tier costs more than
one round on the right one, so "smallest" means smallest **expected** cost,
not smallest model.

| Tier | Implementor gets it when | Typical |
|---|---|---|
| haiku | Purely mechanical and fully specified: the change can be described as edits. No judgment, single subsystem, no guard tests nearby. | renames, constant/copy changes, adding App. rows that mirror code, doc or skill text, test fixtures from a given table, searches and file inventories (`Explore`) |
| sonnet | **The default.** The spec settles every shape and the package copies it. Some judgment inside known patterns, an exemplar file exists. | new tool from an F row, UI from §9, scheduler or handler fixes, most integrations, typical bug fixes with a known cause |
| opus | Design-heavy or high-blast-radius, where a plausible-but-wrong change passes tests: **context/cache invariants** (§20–21, `src/model/`, `src/prompts/`, `src/chat/`), **secrets, grants, auth, OAuth, tokens** (§22, §24, §27), **migrations** and persistence semantics, cancellation and concurrency, a new mechanism the spec describes but no exemplar shows, or root-causing a bug whose cause isn't known yet. | |

**Reviewer tier:** never below the implementor's, and never haiku except
for a haiku package that touches no code (docs or skill text only). An
opus-tier package gets an opus reviewer. A sonnet package gets a sonnet
reviewer, and an opus one when it brushes an opus-tier area.

**Escalation.** Escalate one tier when a package collects `capability`
blockers in **two rounds at the same tier**, or the implementor's report
shows it misunderstood a spec section that the reviewer confirms is clear.
Escalating means a *fresh* implementor at the higher tier, with the
package, the latest findings, and a note on what the previous attempt got
wrong. Its partial diff stays in the tree, and the brief says whether to
build on it or revert it. `spec_gap` rounds never escalate. Fix the spec.

**De-escalation.** Your own Explore and search agents run on haiku. Your
own forensic queries run on haiku when the query is known, and sonnet when
interpreting the traces is the actual work. When the **Used** column shows
a tier repeatedly approving on round 1 for a kind of package, start the
next one of that kind a tier lower. When it shows repeated escalations,
start higher. Write that calibration down when it changes (the
`orchestration-model-tiering` memory, if you have memory).

You (the coordinator) never delegate spec authorship, the work order,
verdicts, or the exit ritual. Those stay in this session.

## 7. Exit ritual (after the last wave)

1. Full `npm run lint && npm run typecheck && npm test`. Paste the
   result lines.
2. Run `self-review` against the whole diff, yourself.
3. `changelog-upkeep` and `readme-upkeep` from the collected USER-VISIBLE
   lines. Mind the `# Next` rule.
4. Tick the `plan.md` phase boxes that are truly done. Anything only the
   user can verify (live UI, hardware) stays unticked and gets said.
5. Commit CHANGELOG + README (and anything the ritual itself fixed) as
   one title-only commit, per *Commits*. Don't push.
6. Report: what landed (per package, with the tier and rounds used),
   spec sections amended, judgment verdicts you made, what's left to the
   user, and anything noticed but not touched.

## Small requests

Not everything needs a work order. A change that fits one package, one
subsystem, and spec edits of a few lines still goes **spec first →
implementor → reviewer**, but gets a plan.md checkbox under the current
phase instead of a new `_plan.md`. A trivial fix (typo, one-line obvious
bug) you may just make yourself, then self-review. Either way it ends in
one title-only commit. Say which path you took.
