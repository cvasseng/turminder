---
name: changelog-upkeep
description: Keeping CHANGELOG.md true — run as part of the exit ritual whenever a change is user-visible. The version being built lives under "# Next"; the one rule that gets broken is adding "Fixed X in A" when A itself is still in Next. Read this before touching the file.
---

# Changelog upkeep

CHANGELOG.md is written for a user reading release notes, not for a
reviewer reading history. Format: the version currently being built is
`# Next` at the top; released versions are numbered headings below it
(`# 0.2.0 — 2026-09-01`). Entries are one line each, user-facing,
bulleted with `*`.

## The one rule: Next describes a finished delta

`# Next` is the *complete* difference between the last numbered release
and what will ship — written as if everything in it arrived whole. The
reader of a release has never seen the intermediate states, so the
intermediate states do not exist:

- **Never** add "Fixed bug xyz in A" when feature A is itself introduced
  in Next. From the release reader's perspective, A never had that bug —
  the fix is part of A arriving. If the fix changed what A *is*, edit A's
  existing entry to describe the final behavior; otherwise the fix needs
  no entry at all.
- The same goes for reworks: if A landed in Next as one design and was
  rebuilt before release, the entry describes what ships, not the
  journey. One entry per feature, kept true, however many commits it took.
- A "Fixed" entry is legitimate only when the broken behavior exists in a
  **numbered version below**. The placement test is one question: *could a
  user of the last release have hit this?* Yes → it's a fix worth an
  entry. No → it's mid-flight, fold it into the feature's entry or omit.

## What gets an entry

Same bar as `readme-upkeep`: user-visible. New capability, changed
behavior, removed behavior, a fix to released behavior. Internal
refactors, test work, and spec/plan edits do not — the changelog is not
plan.md.

## Entry style

- One line, present-tense description of what the software now does:
  `* Embeds: LLM-authored pages rendered sandboxed in chat, with live
  data bindings.` — not commit prose, not "various improvements".
- Name the feature the way the README names it, so the two documents
  agree on vocabulary.
- Amending an existing Next entry (because the feature grew or changed)
  is normal and preferred over stacking related lines.

## Releasing (the user's call, documented for completeness)

Cutting a version = rename `# Next` to the version number + date, add a
fresh empty `# Next` above it. Never edit a numbered section afterwards —
released notes are history; corrections go in the next version's notes.

## Checklist

- [ ] Is the change user-visible? If not, stop — no entry.
- [ ] Is it a fix/change to something *in Next*? → edit that entry (or
      nothing); never a separate "Fixed" line.
- [ ] Is it a fix to something *in a numbered release*? → a `Fixed` line
      in Next.
- [ ] New capability? → one line in Next, README vocabulary.
- [ ] Numbered sections untouched.
