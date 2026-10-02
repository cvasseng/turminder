---
name: embeds
description: Building an embed — a small self-contained HTML page (a chart, a table, a dashboard, a little app with buttons) rendered inline in chat or on its own link. Also the way to make a designed, printable or recurring document (a digest, a report, a cover sheet) as a reusable template. Use whenever showing something would beat describing it, or the user asks to see, open or build a view, chart, dashboard, tool, or a document that should look good on paper or be produced again.
---

# Embeds

An embed is one HTML file you write. You put its marker in your reply and the
chat renders it in a sandboxed frame. Embeds can **say** things — emit an event,
read and write their own small state pouch — and nothing else. Anything that
*acts* needs a handler the user has agreed to (see "Mini-apps" below).

## Before you create one

1. **Search first.** Call `embeds.list {query: "..."}` before building
   anything the user may already have. Embeds are not tied to one
   conversation — the budget dashboard from last week is still there, and a
   second copy of it is a bug, not a feature. Then:
   - The user said *see*, *show*, *open* → re-render the found embed's marker.
   - The user asked to *build/create/make* and you found a match → **do not
     silently edit it and do not build a duplicate**. Ask, with the existing
     embed in view:

     ```
     setup.form {
       title: "You already have \"NO5 energy dashboard\"",
       embed_id: "<the found id>",
       fields: [{name: "decision", label: "Continue it, or start fresh?",
                 type: "choice", options: ["Continue existing", "Start fresh"]}]
     }
     ```

     One click answers. Continue → `embeds.edit` the existing one; start
     fresh → `embeds.create` with a clearly distinct title. Cancelled form →
     ask in chat, do nothing to the existing embed meanwhile.
2. **Decide if it earns a page.** Three numbers are a sentence. A week of
   numbers, a comparison, a thing with buttons — that is an embed.
3. **Inventory the data.** List every value the page will show and where each
   comes from. Anything that comes from a tool becomes a *binding* with a
   `{{data:name}}` placeholder — decide the names now, before writing markup.
   Only truly static content (labels, illustrative examples) may be literal.

## Creating

The order is: placeholders in the markup → **one** `embeds.create` that carries
the `bindings` → marker last in your reply. A data-bound page is one call, not
create-then-bind.

`embeds.create {title, html, bindings?}` returns `{embed_id, url, marker,
bindings, note}`. `bindings` takes exactly the entries `embeds.bind` takes
(`args_from` included, see below). If they are rejected the page **is still
created** and the result carries `bind_error` saying why: fix it with
`embeds.bind {embed_id, bindings}` — never create the page again. A create with
no bindings, on a page that shows tool data, is an unfinished job, and the
`note` will say so.

Put the marker — `{{embed:<id>}}` — on its own line at the *end* of your reply,
after the prose about it: the chat renders the view where the marker sits, so a
view above the words introducing it reads backwards. Without the marker nothing
renders.

**Few rounds.** Every round on a slow model is minutes. If you need to see a
data shape first, make all the direct calls in parallel in one round, then
write the page and create it with its bindings in the next. Do not probe one
tool at a time, and do not search, create, bind and edit in separate rounds
when the information was available at the start.

The rules the file must obey, because the sandbox enforces them:

- **One file.** Inline `<style>` and `<script>`. No web fonts, no `@import`,
  no remote images. Exactly two outside references are allowed: the Highcharts
  CDN (`https://code.highcharts.com/…`) and the vendored libraries under
  `/embed-vendor/…` (reveal.js, for decks). The tool refuses everything else at
  authoring time rather than letting you find out from a blank frame.
- **All charting is Highcharts.** Never another chart library, never a
  hand-rolled canvas/SVG chart. Fetch the `highcharts` skill before writing
  chart code — it has the script tags, the patterns, and the styling rules.
- **Numbers come from bindings, never from your own text.** If a value came
  out of a tool, bind it (below) and put a placeholder where it goes. Typing a
  number you read in a tool result is the one mistake this system is built to
  make impossible — do not be the exception.
- **Images are `data:` URIs**, or drawn — SVG and `<canvas>` both work.
- Assume a narrow frame and both light and dark surroundings; style against the
  house tokens (`var(--t-bg)`, `--t-fg`, `--t-muted`, `--t-accent`,
  `--t-border`, `--t-font`, `--t-mono`, `--t-gap`, `--t-radius`), which are
  already defined when the page is served. No per-embed palettes.

To change one, use `embeds.edit {embed_id, find, replace}` — `find` must appear
exactly once. Read it back first with `embeds.read` if you did not just write it.

## Data bindings — the only way numbers get in

A binding is a frozen read-only tool call attached to the embed. The service
runs it; the value goes straight into the page. It never passes through you,
so it cannot be transcribed wrong.

```
embeds.bind {embed_id, bindings: [
  {name: "revenue", tool: "asana.list_tasks", args: {...}, refresh: "on_serve"},
  {name: "weather", tool: "weather.forecast", args: {location: "Oslo"}}
]}
```

- `refresh: "on_serve"` re-fetches every time the page is opened (live
  dashboards); the default, `"manual"`, fetches once and then only when you
  call `embeds.refresh`.
- Only **read-only** tools you are **already allowed to call** can be bound —
  you cannot bind what you could not call. `embeds.bind` replaces the whole
  list and fetches everything once.
- **Don't re-write args — reference your own call.** The reliable workflow:
  call the tool directly first (to see the data shape), then bind with
  `args_from: true` — the server copies the args of that call for you,
  exactly. This cannot be nested wrong and works even after your earlier
  call's transcript entry was elided. Write `args` by hand only for a call
  you have not made: flat values (`{"area": "NO5"}`), never re-wrapped. If
  the bind is rejected with `invalid_binding_args`, read the per-binding
  message: it is the tool telling you which field has the wrong shape.
- Two ways to use a bound value in the HTML:
  - `{{data:revenue}}` or `{{data:revenue.total}}` in the markup — substituted
    server-side, escaped, at serve time.
  - `turminder.data.revenue` in your script — the whole object, read-only,
    available before your code runs. This is what chart config uses.
- A failing upstream serves the **last good value marked stale** rather than a
  blank. The user can see every binding's tool, arguments and fetch time from
  the "data ⓘ" control on the frame — so say what you bound, plainly.

"Refresh it" means `embeds.refresh`, not rewriting the page.

## The runtime API

Three calls and one value, injected as `window.turminder` when the page is
served:

```js
await turminder.event('logged', { reps: 12 });  // fire-and-forget → {accepted}
const state = await turminder.getState();       // the pouch, an object
await turminder.setState({ ...state, last: 3 }); // whole-blob replace, ≤ 64KB
```

- `getState()`/`setState()` are the embed's memory: a chosen tab, a running
  count, a draft. It survives reload and service restart. There are no patch
  semantics — read, change, write the whole object.
- `event(action, data?)` emits an `embed.action` event onto the assistant's own
  loop. On its own it does nothing at all: it is a message with no recipient
  until a handler is bound. Rate-limited to about one a second, so do not put one
  in an animation loop.
- `turminder.data` is bound data (above), not a call — it is already there.
- You can also seed the pouch yourself with `embeds.write_state`.

## Mini-apps: an embed that causes something

The pattern, in order:

1. `embeds.create` the page, with a button calling `turminder.event('...')`.
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
cause — ask for them as narrowly as the job allows.

## Templates: documents made more than once

When the user wants a document that should **look designed** — a digest, a
report, a cover sheet, anything printed — or any output that will be produced
again, build an embed template. This is the default; do not write markdown and
hand it to `docs.to_pdf` for these (that is for quick one-offs). A template is
an ordinary embed used in a particular way:

- **Layout is the HTML.** House tokens only, with print in mind: an `@page`
  rule for size and margins, `break-inside: avoid` on blocks, nothing that only
  works interactively. Print comes out light with colours kept, from the theme's
  own print tokens, so the template needs no palette.
- **Data is bindings with `refresh: "on_serve"`, and their args mean *now*.**
  Leave dates out wherever the tool defaults to today. A binding with a literal
  date prints the same day forever. The trap: `args_from: true` copies the args
  of your earlier call, dates included — so the direct call you copy from must
  itself have been made without dates.
- **Prose is the state pouch.** What you write fresh for each issue (the summary,
  the commentary) goes in with `embeds.write_state {embed_id, state}`, and the
  page's script renders it from `turminder.getState()`. The HTML never changes
  to make a new issue. Numbers and values a tool returned never go through the
  pouch — they are bindings.
- **An issue is three calls, no authoring:** `embeds.write_state` →
  `docs.to_pdf {source: <embed id>, out_path}` (bindings are refreshed, the
  served page is printed) → optionally `print.document` on the PDF.
- **A template outlives its conversation.** If a handler or a recurring request
  depends on one, `embeds.promote` it first (ask — it is the user's call), or
  the expiry rule will delete it.
- **Wiring a recurring issue** is an ordinary `handler.update {name, ...}` on
  the handler that produces the content (`name` is required): `requested_tools` is the *whole* new set, so keep
  its existing tools and add `embeds.write_state`, `docs.to_pdf` and, if it
  prints, `print.document`, with a `reason`. The change goes through an approval form the user
  answers; the handler is untouched until they approve. Its `body` names the template by embed id.

A small example — a digest with two bindings, a written summary, tokens only.
Round 1: the direct calls, in parallel, with no date args — `weather.forecast
{location: "Oslo", days: 3}` and `schedule.list {}`. Round 2: one create:

```
embeds.create {
  title: "Daily digest",
  html: "<style>
    @page { size: A4; margin: 16mm }
    body { font: 14px var(--t-font); color: var(--t-fg); background: var(--t-bg) }
    section { break-inside: avoid; margin-bottom: var(--t-gap);
              border: 1px solid var(--t-border); border-radius: var(--t-radius);
              padding: var(--t-gap) }
    h2 { color: var(--t-accent); margin: 0 0 .4em }
  </style>
  <h1>Daily digest</h1>
  <section><h2>Summary</h2><p id=summary></p></section>
  <section><h2>Weather</h2>
    <p>{{data:weather.days.0.summary}}, up to {{data:weather.days.0.temp_max_c}} C</p></section>
  <section><h2>Coming up</h2><ul id=upcoming></ul></section>
  <script>
    for (const s of turminder.data.upcoming.schedules) {
      const li = document.createElement('li');
      li.textContent = s.note;
      document.getElementById('upcoming').append(li);
    }
    turminder.getState().then(s => {
      document.getElementById('summary').textContent = s.summary || '';
    });
  </script>",
  bindings: [
    {name: "weather", tool: "weather.forecast", args_from: true, refresh: "on_serve"},
    {name: "upcoming", tool: "schedule.list", args_from: true, refresh: "on_serve"}
  ]
}
```

The placeholder paths follow the result shape the direct call showed
(`weather.forecast` returns `days:[{date, summary, temp_min_c, temp_max_c, …}]`;
dotted segments, `0` indexes a list). Lists are iterated in script through
`turminder.data.<name>`. An unresolved placeholder prints literally, so check
paths against the result.

Tools in one response run in order, so an issue is one response: round 3
`embeds.write_state {embed_id, state: {summary: "..."}}`, then
`docs.to_pdf {source: <embed id>, out_path: "digests/<date>.pdf"}`, then, if
asked, `print.document` on that same `out_path`; round 4 the reply. A first
issue is four rounds in all.

## Presentations

A deck is an embed using reveal.js, served from the vendor route. The skeleton:

```html
<link rel="stylesheet" href="/embed-vendor/reveal.js/reset.css">
<link rel="stylesheet" href="/embed-vendor/reveal.js/reveal.css">
<div class="reveal"><div class="slides">
  <section><h1>Title</h1><p>One line of framing.</p></section>
  <section><h2>The number</h2><p style="font-size:2em">{{data:revenue}}</p></section>
  <section><div id="chart" style="height:60vh"></div></section>
</div></div>
<script src="/embed-vendor/reveal.js/reveal.js"></script>
<script>Reveal.initialize({});</script>
```

No reveal theme is loaded on purpose — the house tokens already drive its
colours and type, so do not add one and do not restyle the deck. Slides are
centred, as reveal has them.

The house behavior is applied around your code — do not re-implement it:

- `Reveal.initialize` is wrapped: animated transitions, a 1280×720 logical
  size, full-viewport display, controls and progress arrive as defaults.
  Pass options only to *differ* (e.g. `transition: 'fade'`); `'none'` is
  not available, and `hash` stays off.
- Charts on a slide are **rebuilt automatically when the slide is entered**
  — right size, load animation playing for the audience. Do not wire
  `slidechanged` handlers or replay animations yourself; create each chart
  once, anywhere in your script. A container with `data-no-replay` is left
  alone (use it for a chart that accumulates state).
- Light/dark is automatic everywhere: tokens swap with the viewer's scheme
  and live charts restyle themselves. Never hardcode a hex color in markup,
  CSS, or chart config — if you type `#`, you are probably wrong.

## Exporting a PDF

`docs.to_pdf {source, out_path}` prints a **served** page, so the PDF is the
artifact the user just looked at:

- `source` is an embed id (bindings are refreshed first, so the numbers are
  current), or a `.md`/`.html` path in the file store.
- `out_path` lands in the file store with a git commit, e.g. `reports/q3.pdf`.
- A deck needs nothing special: it is recognised as one and printed in
  reveal's own `print-pdf` mode, one slide per page.
- It needs chromium installed. If it is missing you get
  `{error: "systool_missing", hint}` — pass the hint on and carry on; nothing
  else stops working.

Reading PDFs is the other direction: `docs.outline` first (page count, table of
contents, one line per page), then `docs.read {path, pages: "10-20"}` for the
pages that matter. Never read a long document in one call.

## Keeping and expiring

New embeds are **ephemeral**: once the conversation they were born in is closed
and nobody has opened them for a month, they are deleted, along with any bound
handler. `embeds.promote` keeps one for good — it gets git history and a
permanent link — and it needs the user's approval, so *ask*.

When you render an embed that was built in a different conversation, say that it
will eventually expire and offer to keep it. That is the one case the expiry
rule gets wrong on its own: the quarterly dashboard that is rarely opened and
very much wanted.

*(Shipped with Turminder. Edit it freely — an edited copy is yours and is
never overwritten; an untouched one tracks the version Turminder ships.)*
