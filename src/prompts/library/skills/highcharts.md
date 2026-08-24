---
name: highcharts
description: Writing chart code in an embed — bar, line, pie, gauge, stock, map, any visualisation of numbers. Fetch BEFORE writing any charting code; all charting is Highcharts, and this is how to load it, structure it, and keep every chart looking like the same system.
---

# Highcharts in embeds

All charting is **Highcharts**. Not chart.js, not d3, not a hand-drawn
`<canvas>` — the authoring check rejects other libraries' CDNs, and a
hand-rolled chart will not match the house style. The Highcharts CDN is the
single external script source an embed may reference.

## Loading

Load only what the chart needs, in this order, before your own script:

```html
<script src="https://code.highcharts.com/highcharts.js"></script>
<!-- then, only if used: -->
<script src="https://code.highcharts.com/highcharts-more.js"></script>   <!-- gauges, ranges, polar -->
<script src="https://code.highcharts.com/modules/stock.js"></script>     <!-- time series w/ navigator -->
<script src="https://code.highcharts.com/maps/modules/map.js"></script>  <!-- maps -->
<script src="https://code.highcharts.com/modules/exporting.js"></script> <!-- only if the user wants an export menu -->
```

The CDN (not a local copy) is deliberate: a downloaded or exported embed
keeps working wherever it is hosted.

## The theme is already applied — do not fight it

Every served embed gets the house theme before your code runs: the palette,
fonts, axis and tooltip styling arrive via `Highcharts.setOptions` the
instant the library loads, and the page's CSS tokens (`--t-bg`, `--t-fg`,
`--t-muted`, `--t-accent`, `--t-border`, `--t-font`, `--t-gap`,
`--t-radius`) are defined on `:root`.

Therefore:

- **Never set `colors`, fonts, or background colors in chart config.** The
  theme owns them. A chart that picks its own palette is a bug — the user is
  obsessive about output consistency, correctly.
- **Light/dark is handled for you**: the theme derives from the page tokens
  and restyles live charts when the viewer's scheme changes. Hardcoding a
  hex anywhere breaks exactly one of the two modes.
- **In decks, charts replay on slide entry automatically** (rebuilt from
  their own options — sized correctly, load animation playing). Create each
  chart once; never add your own `slidechanged` wiring. `data-no-replay` on
  the container opts a chart out.
- Style surrounding HTML with the tokens (`var(--t-muted)`), not literals.
- Per-series color overrides are allowed only when the data itself demands
  it (a red/green threshold, a brand-colored competitor line) — and then use
  palette entries, not new colors.

## Patterns

- One chart per `<div>`, explicit `height` on the container, charts built
  inside a `DOMContentLoaded` listener.
- Data comes from bindings when it comes from tools: reference
  `turminder.data.<name>` in your chart config, never a number you typed
  from a tool result (the anti-telephone rule). Static illustrative data may
  be inlined.
- Time series: prefer `Highcharts.stockChart` past ~100 points; pass epoch
  millis, let the axis do the formatting.
- Keep config minimal — title, series, axis titles when units are not
  obvious. The theme handles the rest. `credits` are already disabled.
- Accessibility: give the chart container an `aria-label`; include the
  accessibility module only for decks the user will present.

## When NOT to chart

Three numbers are a sentence, not a pie chart. A single trend with an
obvious direction is a sparkline sentence ("up 12% since May"). Chart when
comparison, distribution, or shape is the point.

*(Shipped with Turminder. Edit it freely — it is only re-created when missing.)*
