import { marked } from 'marked';

/**
 * The shipped print stylesheet (§23.4). Written against the `--t-*` tokens the
 * serve-time theme defines (§23.3), so a printed note and a printed dashboard
 * are recognisably the same system — which is the whole reason generation goes
 * through the browser rather than a document converter.
 */
const PRINT_STYLE = `<style>
@page { margin: 18mm 16mm; }
body { max-width: 40rem; margin: 0 auto; line-height: 1.55; }
h1, h2, h3 { line-height: 1.25; margin: 1.6em 0 0.6em; }
h1 { font-size: 1.9rem; }
h2 { font-size: 1.4rem; }
h3 { font-size: 1.15rem; }
h1:first-child { margin-top: 0; }
p, li { orphans: 3; widows: 3; }
code, pre { font-family: var(--t-mono); font-size: 0.9em; }
pre {
  background: var(--t-surface);
  border: 1px solid var(--t-border);
  border-radius: var(--t-radius);
  padding: 0.8em;
  overflow-wrap: break-word;
  white-space: pre-wrap;
}
blockquote {
  margin: 1em 0;
  padding: 0.2em 0 0.2em 1em;
  border-left: 3px solid var(--t-border);
  color: var(--t-muted);
}
table { border-collapse: collapse; width: 100%; }
th, td { border: 1px solid var(--t-border); padding: 0.4em 0.6em; text-align: left; }
th { background: var(--t-surface); }
img { max-width: 100%; }
a { color: var(--t-accent); }
hr { border: 0; border-top: 1px solid var(--t-border); margin: 2em 0; }
</style>
`;

/**
 * A markdown file from the store, as a printable page. `marked` is the same
 * renderer the chat transcript uses — one markdown dialect in the system, not
 * two that disagree about tables.
 */
export function renderMarkdownDocument(markdown: string): string {
  return `${PRINT_STYLE}<main>${marked.parse(markdown, { async: false })}</main>`;
}

/**
 * An HTML file from the store, printed as authored. It gets the print
 * stylesheet too — a hand-written page that already styles itself simply
 * overrides it, which is the same deal an embed gets with the theme.
 */
export function renderHtmlDocument(html: string): string {
  return `${PRINT_STYLE}${html}`;
}
