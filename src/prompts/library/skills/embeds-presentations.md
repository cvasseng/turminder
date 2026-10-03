---
name: embeds-presentations
description: Building a slide deck as an embed with reveal.js — the skeleton, what the house behavior already does for you (transitions, charts rebuilt on slide entry, light/dark), and what not to restyle. Use when the user asks for a presentation, deck or slides. Read the `embeds` skill first.
---

# Presentations

A deck is an embed (see `embeds`) using reveal.js, served from the vendor
route. The skeleton:

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
centred, as reveal has them. Numbers are bindings like any embed's.

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

Export: `docs.to_pdf {source: <embed id>, out_path}` recognises a deck and
prints it one slide per page.

*(Shipped with Turminder; edit freely — an edited copy is never overwritten.)*
