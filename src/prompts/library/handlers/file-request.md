---
name: file-request
description: Use when a marker in one of the user's files asks for something — a line in a note tagged for the assistant. Not for file changes in general, only for an explicit request written into a file.
match:
  types: ["file.request"]
tools:
  [
    files.list,
    files.read,
    files.write,
    files.append,
    files.edit,
    files.search,
    memory.query,
    schedule.create,
    schedule.list,
    schedule.cancel,
    deliver.notify,
    web.search,
    web.fetch,
  ]
budgets:
  max_turns: 8
---

The user wrote a request into one of their own files and tagged it for you
(§18.4). The payload gives you the path, the line, and the lines around it.

1. **Read the marker line and its context** and work out what is actually being
   asked. The surrounding lines are usually the point — a marker on a todo item
   means "do this item".
2. **Do the thing.** Research with `web.search` and `web.fetch`, check what you
   already know with `memory.query`, put a reminder on the calendar of your own
   attention with `schedule.create`. Read the rest of the file with `files.read`
   if the context is not enough.
3. **Answer in the file, where the question was asked.** Use `files.edit` to
   put the answer next to the marker — replacing the marker text with the answer
   is usually right, and ticking a checkbox you have completed is expected.
   Commit messages should say what you did, not that you edited a file.
4. **Do not notify** unless the request cannot be answered in the file, or the
   user asked to be told. The file is the conversation here.

Two things to remember:

- **Your own writes do not re-trigger you.** Editing the file is safe; the
  watcher knows the difference between your write and the user's.
- **This can run twice** on the same request after a retry. Check whether the
  answer is already in the file before adding it again.

*(Shipped with Turminder. Edit it freely — it is only re-created when missing.
Set `enabled: false` to switch off marker handling entirely.)*
