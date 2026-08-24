import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The shell at any width (§9.1), guarded from the only side a vitest suite
 * can reach: the source.
 *
 * There is no browser here and App. J has no room for one, so this file makes
 * no claim about how anything *looks* — the by-hand checklist in plan.md owns
 * that. What it can do is stop the two failures that would silently undo the
 * work: a breakpoint drifting away from the constant App. A publishes, and the
 * CSS and the JS disagreeing about where the boundaries are. Those two files
 * have to agree on the same numbers or the panes and the scrim part company.
 */
const root = path.resolve(import.meta.dirname, '..');
const read = (rel: string): string => fs.readFileSync(path.join(root, rel), 'utf8');

const css = read('ui/style.css');
const js = read('ui/app.js');
const spec = read('spec.md');

/** The App. A row for a constant, as a number of px. */
function specConstant(name: string): number {
  // The table row, not the prose that also names the constant.
  const row = spec
    .split('\n')
    .find((line) => line.startsWith('|') && line.includes(`\`${name}\``));
  if (!row) throw new Error(`App. A should carry a table row for ${name}`);
  const match = /\|\s*(\d+)px/.exec(row);
  if (!match) throw new Error(`App. A row for ${name} should state a px value: ${row}`);
  return Number(match[1]);
}

/** Every `@media` condition in the stylesheet, in source order. */
const mediaConditions = [...css.matchAll(/@media ([^{]+)\{/g)].map((m) => (m[1] ?? '').trim());

describe('the shell at any width (§9.1)', () => {
  it('uses the breakpoints App. A publishes, and no others', () => {
    const sheetMax = specConstant('ui_sheet_max');
    const bothMin = specConstant('ui_both_panels_min');
    const compactMax = specConstant('ui_compact_max');
    const shortMax = specConstant('ui_short_max');

    // The stylesheet writes each threshold as the largest width below it.
    const widths = new Set(
      mediaConditions
        .flatMap((c) => [...c.matchAll(/max-width:\s*([\d.]+)px/g)])
        .map((m) => Math.ceil(Number(m[1] ?? NaN))),
    );
    expect([...widths].sort((a, b) => a - b)).toEqual(
      [compactMax, sheetMax, bothMin].sort((a, b) => a - b),
    );

    const heights = new Set(
      mediaConditions
        .flatMap((c) => [...c.matchAll(/max-height:\s*([\d.]+)px/g)])
        .map((m) => Number(m[1] ?? NaN)),
    );
    expect([...heights]).toEqual([shortMax]);
  });

  it('agrees with app.js about where the boundaries are', () => {
    // The CSS decides what a pane looks like; the JS decides whether opening
    // one closes the others and whether the scrim exists. A mismatch gives you
    // a sheet with no scrim, or a column that thinks it is a sheet.
    const jsWidths = [...js.matchAll(/matchMedia\('\(max-width:\s*([\d.]+)px\)'\)/g)].map((m) =>
      Math.ceil(Number(m[1] ?? NaN)),
    );
    expect(jsWidths.sort((a, b) => a - b)).toEqual([
      specConstant('ui_compact_max'),
      specConstant('ui_sheet_max'),
      specConstant('ui_both_panels_min'),
    ]);
  });

  it('turns all three side panes into sheets below the threshold', () => {
    const sheetBlock = css.slice(css.indexOf('@media (max-width: 1099.98px)'));
    const body = sheetBlock.slice(0, sheetBlock.indexOf('\n}\n'));
    for (const pane of ['#sidebar', '#files', '#embeds']) {
      expect(body, `${pane} should become a sheet below ui_sheet_max`).toContain(pane);
    }
    expect(body).toContain('position: fixed');
    // A sheet the transcript still makes room for is not a sheet.
    expect(body).toMatch(/main\s*\{[^}]*width:\s*100%/);
  });

  it('keeps the transcript free of a horizontal page scroll', () => {
    expect(css).toMatch(/body\s*\{[^}]*overflow-x:\s*clip/s);
  });

  it('measures height in dvh, because vh is not the viewport on a phone', () => {
    expect(css).toMatch(/body\s*\{[^}]*height:\s*100dvh/s);
    // ...and the vh fallback stays, declared first, for anything older.
    expect(css).toMatch(/height:\s*100vh;\s*\n\s*height:\s*100dvh/);
    // Embeds are viewport-sized too, and were the other `vh` in the file.
    expect(css).toMatch(/\.embed-frame\s*\{[^}]*height:\s*min\(320px, 50dvh\)/s);
    expect(css).toMatch(/\.embed-slot\.expanded \.embed-frame\s*\{[^}]*height:\s*85dvh/s);
  });

  it('gives touch what hover-only affordances would otherwise hide', () => {
    const hoverBlock = css.slice(css.indexOf('@media (hover: none)'));
    expect(hoverBlock.slice(0, hoverBlock.indexOf('\n}\n'))).toMatch(
      /\.conv-actions\s*\{[^}]*opacity:\s*1/,
    );
  });

  it('never focuses a text input smaller than 16px on a phone', () => {
    const compact = css.slice(css.indexOf('@media (max-width: 639.98px)'));
    const body = compact.slice(0, compact.indexOf('\n}\n'));
    expect(body).toMatch(/font-size:\s*16px/);
    expect(body).toContain('#composer textarea');
  });

  it('gives the home-indicator allowance to the last row in the column', () => {
    // The usage strip is the bottom of the layout, not the composer above it
    // (§9.1): on the composer the inset opens a gap between the input and the
    // strip and still leaves the numbers under the indicator.
    expect(css).toMatch(/#usage\s*\{[^}]*padding:[^;]*env\(safe-area-inset-bottom\)/s);
    for (const block of css.match(/#composer\s*\{[^}]*\}/gs) ?? []) {
      expect(block).not.toContain('safe-area-inset');
    }
  });

  it('lets the hidden attachments strip actually be hidden', () => {
    // `display: flex` on the element beats the `hidden` attribute the markup
    // sets, and the empty strip keeps its padding on every screen.
    expect(css).toMatch(/#attachments\[hidden\]\s*\{\s*display:\s*none/);
  });
});

/**
 * Sheets get out of the way when the thing behind them changes (§9.1).
 *
 * Driven for real over CDP at 420px — click the sidebar open, press New, and
 * the body goes from `sheet-open` back to `sidebar-collapsed`. What this
 * guards is the wiring, which is the half that rots: a future refactor of the
 * New handler would otherwise silently leave a phone user staring at the
 * sidebar they just acted from.
 */
describe('an action inside a sheet dismisses it (§9.1)', () => {
  it('closes the sheet when a new conversation is started', () => {
    // The button lives in the sidebar footer, so on a narrow screen it is
    // always pressed from inside a sheet.
    expect(js).toMatch(/\$\('new'\)\.onclick[\s\S]{0,400}dismissSheets\(\)/);
  });

  it('closes the sheet when a conversation is picked', () => {
    expect(js).toMatch(/label\.onclick[\s\S]{0,400}dismissSheets\(\)/);
  });

  it('hangs off the gesture, so a reconnect does not close it', () => {
    // `welcome` re-selects the open conversation on every reconnect. If the
    // dismissal lived inside `selectConversation`, a network blip would shut a
    // sheet the reader had deliberately opened — driven over CDP to be sure.
    const fn = js.slice(
      js.indexOf('function selectConversation'),
      js.indexOf('function selectConversation') + 700,
    );
    expect(fn).not.toContain('dismissSheets');
  });

  it('does not collapse a sidebar that is a column', () => {
    // Guarded on sheet mode: on a wide screen nothing is covered, and
    // collapsing the sidebar would be a preference nobody expressed.
    const fn = js.slice(js.indexOf('function dismissSheets'));
    expect(fn.slice(0, 200)).toContain('SHEET_MODE.matches');
    expect(fn.slice(0, 200)).toContain('closeAllPanes()');
  });
});
