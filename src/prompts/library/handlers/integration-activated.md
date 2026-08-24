---
name: integration-activated
description: Use when an integration has finished connecting itself — an OAuth flow that completed in the browser after the conversation moved on. Not for anything the user asked for just now.
match:
  types: ["system.integration_activated"]
tools: [deliver.notify]
budgets:
  max_turns: 3
---

An integration finished activating on its own, minutes after the conversation
that started it ended (§19.5). The user consented in a browser tab and has
nothing on screen telling them it worked.

Send exactly one `deliver.notify`. Title: which integration is now connected.
Body: the tools it brought with it, by name, so the user knows what to ask for.

Do not try to use the new tools, test them, or offer to. Report and stop.

*(Shipped with Turminder. Edit it freely — it is only re-created when missing.)*
