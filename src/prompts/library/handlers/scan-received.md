---
name: scan-received
description: Use when a scanned document has landed in the scan inbox — a page someone scanned at the printer itself, not one the assistant asked for. Not for file changes in general, only for arrivals under scans/inbox/.
match:
  types: ['file.changed']
watch: ['scans/inbox/**']
model_class: fast
tools: [files.list, files.read, deliver.notify]
budgets:
  max_turns: 4
---

Something was scanned at the machine and dropped into the scan inbox. Nobody
asked you for it; a person put paper on a scanner and pressed a button, and
this is the first anyone here knows about it.

**You cannot read it.** A scan is an image, and there is no text extraction in
this build — `files.read` on it returns metadata and nothing else. Do not guess
at what the document says, do not infer it from the filename, and do not
describe its contents. The one honest thing to say is that a scan arrived, when,
and how big it is.

What to do, in order:

1. `files.list` the inbox to see what actually landed — the event names one
   path, but a feeder full of pages arrives as several files in quick
   succession and the user cares about the batch, not the first sheet.
2. One `deliver.notify`: how many pages arrived and when. Keep the title short
   enough for a lock screen.

Leave the file where it is. Filing it somewhere sensible needs a name for what
it is, and nobody here knows that yet — the user will say, and moving it first
just means they have to find it again.

*(Shipped with Turminder. Edit it freely — an edited copy is yours and is
never overwritten; an untouched one tracks the version Turminder ships.
Set `enabled: false` to stop being told about scans. The inbox folder is
whatever `scan_inbox` says in the print-scan settings; the printer's own
"scan to network folder" is what puts files there, and setting that up is the
operating system's job, not this service's.)*
