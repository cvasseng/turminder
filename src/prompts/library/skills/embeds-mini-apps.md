---
name: embeds-mini-apps
description: Making an embed that causes something — a button or form that fires an event, and the handler (with only the tools it needs, approved by the user) that acts on it. Use when an embed needs to do more than show or say. Read the `embeds` skill first.
---

# Mini-apps: an embed that causes something

An embed can only *say* things: `turminder.event(action, data)` emits an
`embed.action` event, which does nothing until a handler is bound to it.

The pattern, in order:

1. `embeds.create` the page (see `embeds`), with a button calling
   `turminder.event('...')`.
2. Tell the user what the button will do and what it needs access to.
3. Create the handler with `handler.create`, carrying the binding and only
   the tools the job needs — the user approves them on a form:

```json
{"name": "workout-logger",
 "description": "Records a set logged from the workout embed.",
 "embed": "01J...",
 "requested_tools": ["files.append"],
 "reason": "to log each set you record in the workout app",
 "body": "The payload has the exercise and the reps. Append one line to files/workout-log.md and say nothing else."}
```

`embed` is both the wiring and the leash: with no `event_types` of its own
the handler fires only for `embed.action` from that embed, and it is deleted
along with the embed. Its tools are the *entire* set of things the app can
cause — ask for them as narrowly as the job allows. For writing the handler
body well, see `authoring-handlers`.

*(Shipped with Turminder; edit freely — an edited copy is never overwritten.)*
