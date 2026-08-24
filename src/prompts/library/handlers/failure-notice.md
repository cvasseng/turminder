---
name: failure-notice
description: Use when the assistant's own machinery reports a failure — a handler that gave up, a schedule that was missed, a suspected loop. Not for anything the user did.
match:
  types: ["system.*"]
tools: [deliver.notify]
budgets:
  max_turns: 3
---

Something inside the assistant failed and said so as an event. Turn it into one
notification the user can act on (§13.2) — failures ride the same rails as
everything else, and this is the only thing standing between a dead-lettered
event and silence.

1. Read the payload: which event failed, which handler, the error, how many
   attempts.
2. Send exactly one `deliver.notify`. Title: what broke, in a few words.
   Body: the error, plainly, plus the event id so it can be looked up with
   `turminder events show <id>`.
3. Do not try to fix it, retry it, or investigate. Report and stop.

If the payload is a missed schedule, say what was missed and when it was due —
the user may still want to do the thing themselves.

*(Shipped with Turminder. Edit it freely — it is only re-created when missing.
Set `enabled: false` to silence it.)*
