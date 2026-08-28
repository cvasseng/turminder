# What Turminder can do

The long version of the list in the [README](../README.md). Behavior is
specified in [spec.md](../spec.md).

## Chat

A web UI with streaming and tool use. Once a model is configured the
assistant opens the conversation itself, picks its name, and learns your
preferences. Drop an image in and a vision-capable model looks at it; a model
that cannot will say so rather than guess. Attachments are capped at 20 MB
and images stay in context for the last two user turns.

## Handlers

"When an invoice mail arrives, file it." Handlers are markdown files you
author in chat: a description the LLM ingress matches events against, a body
that says what to do, and frontmatter listing the tools the handler may use.
Nothing outside that list is callable during the run.

## Memory

Markdown memory files with RAG retrieval, distilled from conversations, five
retrieved per run by default. Every save, update and forget is a git commit
in your data directory. Past conversations are searchable too, so "what did
we decide about the dashboard?" has somewhere to look.

## Shared files

A workspace of notes and todo lists, which can be an existing Obsidian vault.
Type `@turminder do X` in any file and the change becomes an event once the
file has been quiet for 30 seconds. Images and PDFs preview in the side
panel.

## Activity

A panel of everything in flight. Whatever arrives — a page captured from the
browser, a scheduled job, a webhook — shows up the moment it lands and moves
through queued, running and done while you watch, from whichever conversation
you happen to be reading. Something retrying says when it will try again;
something that gave up stays there and says why, rather than vanishing into a
silence you have to go looking for. Approvals waiting on you appear there too.
It shows what the assistant wrote about each arrival, never the contents of
the arrival itself.

## Schedules

Reminders and recurring work over RRULE, delivered as desktop notifications
through a bundled or remote daemon. A delivery can carry approve/deny
buttons for actions that need a human, and an unanswered confirmation counts
as a deny after an hour.

Because the machine is a laptop rather than a server, each schedule says what
to do when it comes due while nothing is running: a missed reminder still
arrives, late and saying how late, while a missed daily digest is skipped
rather than posted in the afternoon as though it were morning. A week away
produces one catch-up and one note saying how many occurrences went by. A daily
time stays the time you asked for when the clocks change.

## Watchers

"Track this package." A status is checked on a timer by plain code, and the
model is woken only when the answer changes. The history is a file in your
workspace. A delivered parcel closes its own watch. The floor on cadence is
five minutes, and five consecutive failures raise an event of their own.

## Integrations

Asana, Google Calendar, weather from MET/yr.no, time, web search through
SearXNG, and page fetching are built in. Anything else connects over MCP,
installed through a form you submit in chat, with credentials typed into a
field that writes straight to the secret store.

## Embeds

The assistant writes small sandboxed HTML pages: Highcharts charts,
dashboards whose numbers come from live data bindings, reveal.js
presentations, and mini-apps whose buttons fire events your handlers act on.
They are iterated in chat and served standalone with scoped tokens. A binding
is a frozen read-only tool call, so the numbers cannot be hallucinated.

## Documents

PDFs and Word documents are read outline first, then the pages or sections
that matter; a tracked-changes `.docx` reads as its final text. Any embed or
markdown file exports to PDF through headless chromium, and the PDF is the
exact page you previewed.

## Projects

A fenced island of files, memories and past conversations. Load one when you
start working on it. Until you do, nothing inside it reaches a prompt,
because the search itself is scoped. Notes written while it is loaded are
filed inside it.

## Devices

Press connect on a new device, approve the prompt that appears on one you
already trust, and a phone is talking to your assistant. Only hashes are
stored, so revoking a device is instant and a lost token is replaced rather
than recovered. The chat UI is built for the phone that arrives this way: the
conversation gets the whole screen, and the panels slide over it on request.

## Desktop app

The same UI in its own window, with a tray icon and reminders that arrive as
native notifications while the window is closed. It keeps the port it ran on,
so a chart you opened in a browser tab is still there tomorrow and the window
remembers what you left it showing. On first run it asks where
the assistant should run: on this computer, where the app carries its own
Node runtime and supervises the service, or on a machine you already run it
on, reached with a connect link. Its key lives in your keyring.

## Browser extension

Open a page, click, and read the exact text that will be sent before it goes:
extraction, a note field, Send. It cannot read a page until you invoke it on
that page, and the note you type is the only part treated as an instruction.

## Cost and model choice

Price your endpoints and every chat shows an estimate; ask what you have
spent this month. With more than one model configured, a selector picks who
answers this conversation, and every call records which endpoint served it
and why. An endpoint that declares reasoning levels gets a second control
beside it, and one that declares none is never sent the knob.

## Inspection

`turminder events show` prints an event with its trace. There are listings
for tools and grants, and traces replay.
