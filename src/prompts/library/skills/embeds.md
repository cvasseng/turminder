---
name: embeds
description: Building an embed — a small self-contained HTML page (a chart, a table, a dashboard, a little app with buttons) rendered inline in chat or on its own link. Use whenever showing something would beat describing it, or the user asks to see, open or build a view, chart, dashboard or tool. Also the start of a designed, printable or recurring document (a digest, a report) — fetch `embeds-templates` with it. Decks and buttons that cause things have companion skills too.
---

# Embeds

An embed is one HTML file you write. You put its marker in your reply and the
chat renders it in a sandboxed frame. Embeds can **say** things — emit an event, read and
write their own small state pouch — and nothing else. Anything that
*acts* needs a handler the user has agreed to.

**Fetch a companion only when you need it:** `embeds-templates` for a designed,
printable or recurring document (digest, report, cover sheet);
`embeds-presentations` for a slide deck; `embeds-mini-apps` for a button that
makes something happen.

## Before you create one

1. **Search first.** `embeds.list {query: "..."}` before building anything the
   user may already have. Embeds outlive their conversation — last week's
   budget dashboard is still there, and a second copy is a bug. Then:
   - The user said *see*, *show*, *open* → re-render the found embed's marker.
   - The user asked to *build/create/make* and you found a match → **do not
     silently edit it and do not build a duplicate**. Ask with `setup.form
     {title, embed_id: <found id>, fields: [{name: "decision", label:
     "Continue it, or start fresh?", type: "choice", options: ["Continue
     existing", "Start fresh"]}]}` — the existing embed shows in the form.
     Continue → `embeds.edit` it; start fresh → `embeds.create` with a clearly
     distinct title. Cancelled → ask in chat, touch nothing meanwhile.
2. **Does it earn a page?** Three numbers are a sentence; a week of numbers,
   a comparison, a thing with buttons is an embed.
3. **Inventory the data.** List every value and where it comes from. Anything
   from a tool becomes a *binding* with a `{{data:name}}` placeholder — decide
   the names before writing markup. Only static content (labels, examples)
   may be literal.

## Creating

Placeholders in the markup → **one** `embeds.create` that carries the
`bindings` → marker last in your reply. A data-bound page is one call, not
create-then-bind.

`embeds.create {title, html, bindings?}` returns `{embed_id, url, marker,
bindings, note}`; `bindings` takes what `embeds.bind` takes. If they are
rejected the page **is still created** and the result carries `bind_error`:
fix it with `embeds.bind {embed_id, bindings}` — never create the page again.
A create with no bindings on a page that shows tool data is an unfinished job,
and the `note` says so.

Put the marker `{{embed:<id>}}` on its own line at the *end* of your reply,
after the prose about it. Without the marker nothing renders.

**Few rounds** — each is minutes on a slow model. To see a data shape first,
make all the direct calls in parallel in one round, then create the page with
its bindings in the next. Never probe one tool at a time, and never search, create, bind and edit in separate rounds when you knew enough at the start.

The rules the file must obey, because the sandbox enforces them:

- **One file.** Inline `<style>` and `<script>`. No web fonts, no `@import`,
  no remote images. Only two outside references: the Highcharts CDN
  (`https://code.highcharts.com/…`) and `/embed-vendor/…` (reveal.js). The tool
  refuses everything else at authoring time.
- **All charting is Highcharts.** Never another chart library, never a
  hand-rolled canvas/SVG chart. Fetch the `highcharts` skill before writing
  chart code.
- **Numbers come from bindings, never from your own text.** Typing a number
  you read in a tool result is the one mistake this system is built to make
  impossible — do not be the exception.
- **Images are `data:` URIs**, or drawn — SVG and `<canvas>` both work.
- Assume a narrow frame and light and dark surroundings; use the house tokens
  (`var(--t-bg)`, `--t-fg`, `--t-muted`, `--t-accent`, `--t-border`,
  `--t-font`, `--t-mono`, `--t-gap`, `--t-radius`). No per-embed palettes.

To change one: `embeds.edit {embed_id, find, replace}` — `find` must appear
exactly once; `embeds.read` it first if you did not just write it.

## Data bindings — the only way numbers get in

A binding is a frozen read-only tool call attached to the embed. The service
runs it and the value goes straight into the page, never through you.

```
embeds.bind {embed_id, bindings: [
  {name: "revenue", tool: "asana.list_tasks", args: {...}, refresh: "on_serve"},
  {name: "weather", tool: "weather.forecast", args: {location: "Oslo"}}
]}
```

- `refresh: "on_serve"` re-fetches every time the page is opened (live
  dashboards); the default, `"manual"`, fetches once and then only on
  `embeds.refresh`. "Refresh it" means `embeds.refresh`, not rewriting the page.
- Only **read-only** tools you are **already allowed to call** can be bound.
  `embeds.bind` replaces the whole list and fetches everything once.
- **Don't re-write args — reference your own call.** Call the tool directly
  first (to see the data shape), then bind with `args_from: true`: the server
  copies that call's args exactly, even once its transcript entry is elided.
  Write `args` by hand only for a call you have not made: flat values
  (`{"area": "NO5"}`), never re-wrapped. On `invalid_binding_args`, the
  per-binding message says which field has the wrong shape.
- Use a bound value as `{{data:revenue}}` / `{{data:revenue.total}}` in the
  markup (substituted server-side, escaped) or as `turminder.data.revenue` in
  script (the whole object, read-only, there before your code runs — what chart
  config uses).
- A failing upstream serves the **last good value marked stale**. The user sees
  each binding's tool, arguments and fetch time under "data ⓘ" on the frame —
  so say what you bound, plainly.

## The runtime API

Injected as `window.turminder` when the page is served:

```js
await turminder.event('logged', { reps: 12 });  // fire-and-forget → {accepted}
const state = await turminder.getState();       // the pouch, an object
await turminder.setState({ ...state, last: 3 }); // whole-blob replace, ≤ 64KB
```

- `getState()`/`setState()` are the embed's memory (a tab, a count, a draft),
  surviving reload and restart. No patch semantics — read, change, write the
  whole object. Seed it with `embeds.write_state`.
- `event(action, data?)` emits an `embed.action` event. It does nothing until a
  handler is bound (`embeds-mini-apps`). Rate-limited to about one a second.

## Exporting a PDF

`docs.to_pdf {source, out_path}` prints a **served** page — the PDF is what the
user just looked at. `source` is an embed id (bindings refreshed first) or a
`.md`/`.html` path in the file store; `out_path` lands in the file store with a
git commit, e.g. `reports/q3.pdf`. A deck prints one slide per page. It needs
chromium; if missing you get `{error: "systool_missing", hint}` — pass the hint
on and carry on.

Reading PDFs: `docs.outline` first, then `docs.read {path, pages: "10-20"}` —
never a long document in one call.

## Keeping and expiring

New embeds are **ephemeral**: once their conversation is closed and nobody has
opened them for a month, they are deleted, with any bound handler.
`embeds.promote` keeps one for good (git history, a permanent link) and needs
the user's approval, so *ask*. When you render an embed built in a different
conversation, say it will eventually expire and offer to keep it — the
quarterly dashboard that is rarely opened and very much wanted is the case the
expiry rule gets wrong.

*(Shipped with Turminder; edit freely — an edited copy is never overwritten.)*
