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

Some handlers and skills ship with Turminder and are installed into your data
directory at every start. One you have edited is yours and is never
overwritten; one you never touched tracks the version we ship, so improvements
reach an install that is already running. The difference is decided by a hash
of what we wrote, recorded in the data directory, which is a record of
authorship and not a guess about intent. A file installed before that record
existed is only adopted when it still matches ours byte for byte — the rest
are reported by `turminder doctor`, `turminder skills list` and
`turminder handlers list`, and `turminder assets refresh <path>` (or `--all`)
takes our version when you say so. A handler or skill that fails to load
raises an event, so it becomes a notification rather than a log line nobody
reads.

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

The scheduler emits and never acts, so a schedule is only half a promise: the
other half is a handler. Booking one therefore comes back with the handlers
that will run it, and a warning in the same reply when none will — worked out
from the handler files on disk, with no model call. A plain reminder needs no
handler at all: one ships, and it delivers a notification saying what you
asked to be told and how late it is. Anything richer gets its own kind of
event and its own handler file, so nothing else competes for it and the tools
it may use while nobody is watching are written down in one place you can read.

## Watchers

"Track this package." A status is checked on a timer by plain code, and the
model is woken only when the answer changes. The history is a file in your
workspace. A delivered parcel closes its own watch. The floor on cadence is
five minutes, and five consecutive failures raise an event of their own.

## Integrations

Asana, Google Calendar, weather from MET/yr.no, time, web search through
SearXNG, page fetching and file download are built in. Anything else connects
over MCP, installed through a form you submit in chat, with credentials typed
into a field that writes straight to the secret store.

An external MCP server can go away — a VPN route changes, a laptop moves
network, a child process exits. Liveness is observed rather than assumed, so a
server that is down is reported as down, with the error that took it, rather
than reported as healthy while every call fails. Its tools stay listed on
purpose: reaching for one is what triggers the reconnect, and the call comes
back naming the server and when it will next be tried instead of vanishing.
Fix the fault, ask the same question again, and it answers. There is also a
capped retry in the background, so a fault fixed outside the conversation is
picked up without one.

## Printing and scanning

"Print the lease." "Scan this." Turminder talks to network printers and
scanners the way a phone does — IPP for printing, AirScan for scanning, both
straight to the machine, with no driver and no print queue in between. Setup
looks for devices itself: it asks the network by name, and on a network where
that is blocked it sweeps the local subnet and confirms every hit by actually
speaking the protocol, so what you pick from is a list of real printers rather
than a list of open ports. Several machines are the normal case; each can be
edited, switched off for the summer, or removed.

A printer that cannot read PDF — which is most consumer inkjets — gets the
pages rasterised on the way out, and says so if the converter is not
installed rather than printing nothing. A scan lands in your workspace as a
committed file. A page scanned at the machine's own panel arrives too, if you
point its "scan to network folder" at the scan inbox: a shipped handler
notices and tells you. There is no OCR yet, and it says so instead of
guessing what the page said.

Printers ship self-signed certificates, so the first setup records the
certificate each machine presented and every later job checks it. A printer
that comes back wearing a different one stops the job and says so, rather
than quietly trusting whatever answered.

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

A document at a web address takes one extra hop rather than a second reader:
it is downloaded into your workspace and then read from there, so the invoice
you asked a question about is still there next month to print, index or find
again. Page fetching only reads text and the text-shaped structured formats;
anything else is refused with a note naming the download step, which is what
stops a Word file arriving as several megabytes of decoded zip container.

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

## Voice

Speaking to the assistant is chat with a different mouth. A recording goes to
`POST /api/voice` and the answer comes back as audio, sentence by sentence, so
the speaker starts before the whole reply is written. What was heard and what
was said become an ordinary conversation — listed and searchable beside the
typed ones, marked with a microphone, distilled like any other. The same
tools, the same permissions, the same record; a gated action still needs a
screen, because a microphone in a room is not a device you hold.

The transcriber and the synthesiser are endpoints like any other: anything
speaking the OpenAI audio dialect, local or hosted, connected by asking. The
assistant raises a form, sends real audio to check the endpoint can actually
hear and speak, and only then writes it down. "Speak Norwegian" or "use a
different voice" opens one more form — a language list and a voice list with a
play button, so you hear a voice before you choose it.

Notifications can be read aloud, and the handler that raised one chooses the
sentence worth hearing: "Invoice from Hafslund, two thousand three hundred
kroner, due Friday" instead of the three-line body it wrote for the screen.
The words are always the server's; a device asks for a delivery by id and gets
audio back.

Thinking is off for spoken conversations where the model can be told to stop —
a second of silence before the first word is a second too long — and every
transcription and every spoken sentence shows up in the Requests panel with
what it cost.

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

Adding an endpoint asks which model it should serve, from the list the
endpoint itself publishes, because what the assistant can do with an endpoint
is measured against one model rather than an address. Change the model later
and the endpoint listings say the measurements no longer describe it; ask it
to re-probe and they are taken again, leaving the price, the classes and the
key alone.

## Inspection

`turminder events show` prints an event with its trace. There are listings
for tools and grants, and traces replay.
