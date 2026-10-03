---
name: embeds-templates
description: Building a designed, printable or recurring document (a digest, a report, a cover sheet) as an embed template that is produced again and again — layout, now-relative bindings, prose in the state pouch, the three-call issue, wiring a recurring handler. Use whenever a document should look good on paper or be produced more than once. Read the `embeds` skill first.
---

# Templates: documents made more than once

When the user wants a document that should **look designed** — a digest, a
report, a cover sheet, anything printed — or any output that will be produced
again, build an embed template (see `embeds` for creating, bindings and the
sandbox rules). This is the default; do not write markdown and hand it to
`docs.to_pdf` for these (that is for quick one-offs). A template is an ordinary
embed used in a particular way:

- **Layout is the HTML.** House tokens only, with print in mind: an `@page`
  rule for size and margins, `break-inside: avoid` on blocks, nothing that only
  works interactively. Print comes out light with colours kept, from the theme's
  own print tokens, so the template needs no palette.
- **Data is bindings with `refresh: "on_serve"`, and their args mean *now*.**
  Leave dates out wherever the tool defaults to today. A binding with a
  literal date prints the same day forever. The trap: `args_from: true` copies
  the args of your earlier call, dates included — so the direct call you copy
  from must itself have been made without dates.
- **Prose is the state pouch.** What you write fresh for each issue (the
  summary, the commentary) goes in with `embeds.write_state {embed_id, state}`,
  and the page's script renders it from `turminder.getState()`. The HTML never
  changes to make a new issue. Numbers and values a tool returned never go through the
  pouch — they are bindings.
- **An issue is three calls, no authoring:** `embeds.write_state` →
  `docs.to_pdf {source: <embed id>, out_path}` (bindings are refreshed, the
  served page is printed) → optionally `print.document` on the PDF.
- **A template outlives its conversation.** If a handler or a recurring request
  depends on one, `embeds.promote` it first (ask — it is the user's call), or
  the expiry rule will delete it.
- **Wiring a recurring issue** is an ordinary `handler.update {name, ...}` on
  the handler that produces the content (`name` is required): `requested_tools`
  is the *whole* new set, so keep its existing tools and add
  `embeds.write_state`, `docs.to_pdf` and, if it prints, `print.document`, with
  a `reason`. The change goes through an approval form the user answers; the
  handler is untouched until they approve. Its `body` names the template by
  embed id.

A small example — a digest with two bindings, a written summary, tokens only.
Round 1: the direct calls, in parallel, with no date args — `weather.forecast
{location: "Oslo", days: 3}` and `schedule.list {}`. Round 2: one create:

```
embeds.create {
  title: "Daily digest",
  html: "<style>
    @page { size: A4; margin: 16mm }
    body { font: 14px var(--t-font); color: var(--t-fg); background: var(--t-bg) }
    section { break-inside: avoid; border: 1px solid var(--t-border);
              border-radius: var(--t-radius); padding: var(--t-gap) }
    h2 { color: var(--t-accent) }
  </style>
  <h1>Daily digest</h1>
  <section><h2>Summary</h2><p id=summary></p></section>
  <section><h2>Weather</h2>
    <p>{{data:weather.days.0.summary}}, up to {{data:weather.days.0.temp_max_c}} C</p></section>
  <section><h2>Coming up</h2><ul id=upcoming></ul></section>
  <script>
    for (const s of turminder.data.upcoming.schedules)
      document.getElementById('upcoming').append(
        Object.assign(document.createElement('li'), {textContent: s.note}));
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

Placeholder paths follow the result shape the direct call showed
(`weather.forecast` returns `days:[{date, summary, temp_min_c, temp_max_c, …}]`;
dotted segments, `0` indexes a list); lists are iterated in script via
`turminder.data.<name>`. An unresolved placeholder prints literally — check
paths against the result.

Tools in one response run in order, so an issue is one response: round 3
`embeds.write_state {embed_id, state: {summary: "..."}}`, then
`docs.to_pdf {source: <embed id>, out_path: "digests/<date>.pdf"}`, then, if
asked, `print.document` on that `out_path`; round 4 the reply.

*(Shipped with Turminder; edit freely — an edited copy is never overwritten.)*
