---
name: printing
description: Use when asked to print something, or to scan something. Covers what to print (render it first), which device, and what to say when a machine refuses.
---

# Printing and scanning

## Print a document, never a source file

**Anything you print goes through `docs.to_pdf` first**, unless it is already a
PDF or a photograph. A markdown note sent straight to a printer comes out as a
page of `##` and `*` — the printer accepted it, the user did not get what they
asked for. The same is true of anything else you wrote to the workspace as
text: notes, plans, tables, a list of numbers.

So the shape of "print my todo list" is three steps, not one:

1. `docs.to_pdf` on the file (or the embed) → a PDF in the workspace.
2. `print.document` on that PDF.
3. Say what you printed and on which machine.

`print.document` refuses a file it cannot identify with
`{error: "render_first"}` rather than sending it — if you see that, you skipped
step 1.

**Already a PDF, a JPEG or a PNG?** Print it as it is. Converting a photo to
PDF to print it is a step that costs quality and buys nothing.

**Making something worth printing.** A page that will exist on paper is worth a
moment's layout: a title, sensible margins, and no screenful of raw data where a
table belongs. If the content deserves it, build an embed and `docs.to_pdf`
that — the PDF is exactly the page that was previewed.

## Which machine

`print.devices` lists what is set up and what each one can do. With one device
you can leave `device` out. With several, **say which one** — if you get
`{error: "which_device"}` you guessed instead of asking, and the fix is to ask
the user, not to pick the first name in the list.

A device the user mentions that is not in the list is not a failure to report
and stop at: `setup.printers` finds machines on the network and adds them
through a form, and that is the answer to "I have a printer in the study".

## When a machine says no

Every one of these is a sentence to the user, not a retry:

- `{error: "device_busy"}` — the printer and the scanner are **one mechanism**.
  Starting a scan mid-print aborts the page. Say what it is doing and offer to
  do the thing again in a minute; do not loop.
- `{error: "systool_missing"}` — a PDF needs converting for this printer and
  the converter is not installed. Give the user the install hint verbatim.
- `{error: "format_unsupported"}` — say what the printer *does* take, which is
  in the result.
- `{error: "certificate_changed"}` — do not print, do not retry. Tell the user
  the device is not the one that was set up, and that re-adding it through
  `setup.printers` is what records a new certificate. If a printer was factory
  reset or replaced, that is the explanation; if not, it is worth their
  attention.
- `{error: "too_many_pages"}` — check the page count is what the user meant
  before narrowing it. Nobody prints ninety pages by accident on purpose.

## Scanning

The user has to have **put the page on the glass** before you call
`print.scan`. If the conversation does not say they have, ask — a scan of an
empty platen is a blank page they now have to delete.

The result is a **path**, not text. There is no OCR: you cannot read a scan
back, and you must not guess at what it says or infer it from the filename. Say
where it landed and what it is; if they want to know what is on it, that is a
thing you cannot do yet, and saying so is the honest answer.

A scan arriving on its own — someone scanned at the machine's own panel into
the scan inbox — is the `scan-received` handler's business, not yours.
