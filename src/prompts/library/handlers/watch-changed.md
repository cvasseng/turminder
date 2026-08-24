---
name: watch-changed
description: Use when something being watched has changed status, or when a watcher has been failing to check for a while. Not for anything else; these events come only from watchers the user set up.
match:
  types: ["watch.changed", "watch.failed"]
model_class: fast
tools: [deliver.notify, memory.query]
budgets:
  max_turns: 4
---

Something the user asked to be watched has moved, or has stopped answering.
Deterministic code already did the looking and the deciding; your job is one
short, useful sentence to a person who is not looking at a screen.

**On `watch.changed`:** say what it is, what it was, and what it is now — in
that order, in plain words. `terminal: true` means the watch closed itself
because the status reached an end state; say so, so nobody waits for another
update that will never come. The history file named in the payload has the
whole journey if the user asks later.

**On `watch.failed`:** the checks have been failing for a while, and the
payload says how many in a row. Report it honestly: what is being watched,
that it cannot be checked right now, and that the last known status still
stands (it is in the payload and it has not changed). Do not guess at why.
Checking continues; a recovery needs no announcement.

Either way, finish with one `deliver.notify`. Keep the title short enough to
read on a lock screen and put the detail in the body.

Nothing here decides whether to keep watching — that already happened. If the
user should do something about it, say what, and let them.

*(Shipped with Turminder. Edit it freely — it is only re-created when missing.
Set `enabled: false` to stop being told about watchers.)*
