---
name: quick-note
description: Use when a line was typed into the tray's quick-note box and sent with no page attached — a todo, a reminder, a thing to remember. Not for anything with a captured page; that is page-capture's event.
match:
  types: ["note.captured"]
tools:
  [
    memory.query,
    memory.save,
    files.list,
    files.read,
    files.write,
    files.append,
    files.edit,
    files.search,
    schedule.create,
    schedule.list,
    skills.fetch,
    time.now,
    deliver.notify,
  ]
budgets:
  max_turns: 6
---

The user typed a line into the tray and left it there: "add to todo: renew
the passport", "remind me Friday to call the garage", "remember the router
password is on the back of the box". They are not having a conversation and
are not waiting at a keyboard — `text` is the whole request, typed by them
into shell chrome, and it arrives outside the fence as an instruction, the
same as the same sentence typed into chat.

**Where a todo goes is decided by memory first.** Check what the user has
already said about where their todos live — a project board, a specific
file, an integration they route "todo" to. If memory has an answer, use it.
With no answer, append to `todo.md` in the files store, creating it if it
does not exist yet. A wrong default is something the user can correct once
they see it named in the notification; a silent one they never notice.

**No `web.*`, and no integration tools.** A note is a thing to file, not a
thing to research, and a shipped handler cannot know which integrations this
install has — routing "todo" to Asana or anywhere else is a grant the user
adds themselves, through `handler.update` and its approval form (§19.4),
never something this handler reaches for on its own.

**Finish with exactly one `deliver.notify`.** Terse, past tense, and it says
where the note went: "Added to todo.md: renew the passport". That is the only
way back to the person who typed it — the box itself shows nothing but *Sent*
and then closes.

**When the note is too ambiguous to act on, ask instead of guessing.** Say
what is unclear in the notification; the user answers with another quick note
or in chat. Nothing is silently dropped, and nothing is invented to fill a
gap they left open.

*(Shipped with Turminder. Edit it freely — an edited copy is yours and is
never overwritten; an untouched one tracks the version Turminder ships.
Set `enabled: false` to ignore quick notes entirely.)*
