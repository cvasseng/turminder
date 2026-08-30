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
const html = read('ui/index.html');
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
    const compactMax = specConstant('ui_compact_max');
    const shortMax = specConstant('ui_short_max');

    // The stylesheet writes each threshold as the largest width below it.
    const widths = new Set(
      mediaConditions
        .flatMap((c) => [...c.matchAll(/max-width:\s*([\d.]+)px/g)])
        .map((m) => Math.ceil(Number(m[1] ?? NaN))),
    );
    expect([...widths].sort((a, b) => a - b)).toEqual(
      [compactMax, sheetMax].sort((a, b) => a - b),
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
    ]);
  });

  it('has no band App. A no longer publishes', () => {
    // `ui_both_panels_min` existed to say when *both* side panels could be
    // columns. There is one drawer now, so the constant is gone from App. A
    // and neither file may quietly keep the band it named.
    expect(spec).not.toContain('ui_both_panels_min');
    expect(css).not.toContain('1399.98');
    expect(js).not.toContain('1399.98');
  });

  it('turns both side panes into sheets below the threshold', () => {
    const sheetBlock = css.slice(css.indexOf('@media (max-width: 1099.98px)'));
    const body = sheetBlock.slice(0, sheetBlock.indexOf('\n}\n'));
    for (const pane of ['#sidebar', '#drawer']) {
      expect(body, `${pane} should become a sheet below ui_sheet_max`).toContain(pane);
    }
    // Absolute against `#shell`, not fixed against the viewport: the shell
    // starts below the status strip, and that is the whole reason the tab rail
    // stays reachable under an open sheet (§9.1). Both halves or neither.
    expect(body).toContain('position: absolute');
    expect(body).not.toContain('position: fixed');
    expect(css).toMatch(/#shell\s*\{[^}]*position:\s*relative/s);
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
 * One drawer, three tabs (§9.1).
 *
 * The failure this guards is the one that produced the drawer in the first
 * place: a fourth panel arriving as a fourth independent toggle, each with its
 * own body class, storage key and `aria-pressed`, describing a state the
 * layout never honoured. There is one selection here and it has one home.
 */
describe('the side panels are one drawer (§9.1)', () => {
  const TABS = ['files', 'embeds', 'activity', 'calls'];

  /** The markup between a tag with this id and the element that follows it. */
  const at = (needle: string): number => {
    const i = html.indexOf(needle);
    expect(i, `index.html should contain ${needle}`).toBeGreaterThan(-1);
    return i;
  };

  it('puts the rail in a status strip that spans the page', () => {
    // Outside `<main>`: a rail that stopped at the transcript's right edge
    // would sit an inch to the left of the drawer it opens, and on a phone a
    // rail in the sidebar footer is behind a closed sidebar — the two taps
    // this whole change exists to remove.
    const main = html.slice(at('<main>'), at('</main>'));
    expect(main).not.toContain('id="status"');
    expect(main).not.toContain('id="drawer-tabs"');
    expect(at('id="status"')).toBeLessThan(at('id="shell"'));
    expect(at('id="drawer-tabs"')).toBeGreaterThan(at('id="status"'));
    expect(at('id="drawer-tabs"')).toBeLessThan(at('id="shell"'));
  });

  it('is a tablist, not four toggles', () => {
    const rail = html.slice(at('id="drawer-tabs"'), at('<div id="shell">'));
    expect(rail).toContain('role="tablist"');
    expect([...rail.matchAll(/role="tab"/g)]).toHaveLength(TABS.length);
    // `aria-pressed` is the toggle model this replaced. One of them surviving
    // means one panel still thinks it is independent of the others.
    expect(rail).not.toContain('aria-pressed');
    for (const tab of TABS) {
      expect(rail).toContain(`data-tab="${tab}"`);
      expect(rail).toContain(`aria-controls="panel-${tab}"`);
      expect(html).toContain(`id="panel-${tab}"`);
    }
    // Exactly the four panels, all inside the one drawer.
    const drawer = html.slice(at('<aside id="drawer">'), at('</aside>\n    </div>'));
    expect([...drawer.matchAll(/role="tabpanel"/g)]).toHaveLength(TABS.length);
  });

  it('keeps the tab keys the same in the markup and the JS', () => {
    const table = js.slice(js.indexOf('const DRAWER_TABS = {'));
    const keys = [...table.slice(0, table.indexOf('\n};')).matchAll(/^ {2}(\w+): \{/gm)].map(
      (m) => m[1],
    );
    expect(keys).toEqual(TABS);
    // One storage key and one body class, where there were three of each.
    expect(js).toContain("const DRAWER_KEY = 'turminder.drawer'");
    for (const gone of ['filesOpen', 'embedsOpen', 'turminder.activity']) {
      expect(js).not.toContain(gone);
    }
    for (const gone of ['files-open', 'embeds-open', 'activity-open']) {
      expect(css).not.toContain(gone);
      expect(js).not.toContain(gone);
    }
  });

  it('leaves the rail reachable from under an open sheet', () => {
    // The scrim lives inside the shell, and the shell starts below the strip.
    // A scrim over the whole viewport would make switching panels on a phone
    // dismiss-then-open — two taps again, by a different route.
    expect(at('id="scrim"')).toBeGreaterThan(at('<div id="shell">'));
    expect(css).toMatch(/#scrim\s*\{[^}]*position:\s*absolute/s);
  });

  it('reads the activity list before the panel is opened', () => {
    // The tab carries the count of outstanding work, and a count that only
    // became true once you opened the panel would answer the question after
    // you had stopped asking it (§9.1). Unconditional on `welcome`, unlike the
    // file tree, which is only worth fetching for a drawer that is showing it.
    const welcome = js.slice(
      js.indexOf("case 'welcome'"),
      js.indexOf("case 'conversation.list.result'"),
    );
    expect(welcome).toMatch(/^\s*send\('event\.list', \{\}\);/m);
    expect(welcome).toMatch(/if \(state\.drawer === 'files'\) send\('files\.list'/);
  });
});

/**
 * The strip is the shell's toolbar, and the columns are draggable (§9.1).
 *
 * Two failures this guards. One: something that must survive a collapsed
 * sidebar drifting back into the sidebar — the name, the account actions, the
 * rail. Two: a splitter's floor drifting away from the App. A row that gives
 * it, which is how a column quietly learns to eat the transcript.
 */
describe('the toolbar and the splitters (§9.1)', () => {
  const strip = (): string =>
    html.slice(html.indexOf('<div id="status">'), html.indexOf('<div id="shell">'));
  const sidebar = (): string =>
    html.slice(html.indexOf('<aside id="sidebar">'), html.indexOf('</aside>'));

  it('keeps in the strip everything a collapsed sidebar would otherwise hide', () => {
    for (const id of [
      'brand',
      'instance',
      'expand',
      'collapse',
      'forget-token',
      'devices-toggle',
      'drawer-tabs',
    ]) {
      expect(strip(), `#${id} belongs in the status strip`).toContain(`id="${id}"`);
      expect(sidebar(), `#${id} should not also be in the sidebar`).not.toContain(`id="${id}"`);
    }
    // The name leads it; the account actions and the rail close it.
    expect(strip().indexOf('id="brand"')).toBeLessThan(strip().indexOf('class="spacer"'));
    // `<name> | Turminder`, in that order, and the Mind's name is the half
    // that carries the accent and survives a narrow strip.
    expect(strip().indexOf('id="instance"')).toBeLessThan(strip().indexOf('brand-name'));
    expect(css).toMatch(/#instance\s*\{[^}]*color:\s*var\(--accent\)/s);
    expect(css).toMatch(/#instance\s*\{[^}]*text-overflow:\s*ellipsis/s);
    // Smaller than the name it sits behind.
    const brandName = /\.brand-name\s*\{[^}]*\}/s.exec(css)?.[0] ?? '';
    expect(Number(/font-size:\s*(\d+)px/.exec(brandName)?.[1])).toBeLessThan(
      Number(/font-size:\s*(\d+)px/.exec(/#brand\s*\{[^}]*\}/s.exec(css)?.[0] ?? '')?.[1]),
    );
    expect(strip().indexOf('id="forget-token"')).toBeGreaterThan(
      strip().indexOf('class="spacer"'),
    );
    expect(strip().indexOf('id="drawer-tabs"')).toBeGreaterThan(
      strip().indexOf('id="devices-toggle"'),
    );
  });

  it('leaves the sidebar with nothing but its list and its footer', () => {
    // The header went with the name that was in it: a bar existing only to
    // hold the collapse button is a row of chrome for one control that now
    // shares a slot with the button that undoes it.
    expect(sidebar()).not.toContain('<header>');
    expect(css).not.toContain('#sidebar header');
    expect(css).toMatch(/body\.sidebar-collapsed #collapse/);
  });

  it('gives each splitter the floor App. A publishes', () => {
    for (const [name, constant] of [
      ['SIDEBAR_MIN_PX', 'ui_sidebar_min'],
      ['DRAWER_MIN_PX', 'ui_drawer_min'],
      ['TRANSCRIPT_MIN_PX', 'ui_transcript_min'],
    ]) {
      const decl = new RegExp(`const ${name} = (\\d+);`).exec(js);
      expect(decl, `app.js should declare ${name}`).not.toBeNull();
      expect(Number(decl?.[1]), `${name} should be App. A's ${constant}`).toBe(
        specConstant(constant as string),
      );
    }
  });

  it('is a window splitter a keyboard can drive', () => {
    const rail = html.slice(html.indexOf('id="resize-sidebar"'), html.indexOf('<main>'));
    expect(rail).toContain('role="separator"');
    expect(rail).toContain('aria-orientation="vertical"');
    // Without a tabindex a separator is decoration; the arrows never arrive.
    expect(rail).toContain('tabindex="0"');
    expect(js).toMatch(/aria-valuenow/);
    expect(js).toMatch(/aria-valuemax/);
    expect(js).toContain('RESIZE_STEP_PX');
  });

  it('has no splitter where there is no boundary to drag', () => {
    // A sheet floats over the transcript rather than taking width from it.
    const sheetBlock = css.slice(css.indexOf('@media (max-width: 1099.98px)'));
    const body = sheetBlock.slice(0, sheetBlock.indexOf('\n}\n'));
    expect(body).toContain('#resize-sidebar');
    expect(js).toMatch(/if \(SHEET_MODE\.matches \|\| e\.button !== 0\) return;/);
  });

  it('re-fits a stored width without rewriting it', () => {
    // Widths are a preference of the wide layout (§9.1): `applyWidths` writes
    // CSS, and only a deliberate resize reaches localStorage.
    const fn = js.slice(
      js.indexOf('function applyWidths'),
      js.indexOf('function setPaneWidth'),
    );
    expect(fn).toContain("setProperty('--sidebar-w'");
    expect(fn).toContain("setProperty('--drawer-w'");
    expect(fn).not.toContain('localStorage');
  });
});

/**
 * The file panel is a tree, built from the listing that already arrives (§18.5).
 */
describe('the file tree (§18.5)', () => {
  it('needs no frame of its own', () => {
    // F.8's walk is recursive and returns files only, root-relative with `/`
    // separators — the folders are inferred here. A `files.list` that started
    // asking for one directory at a time would be a protocol change, and the
    // spec says this one is not.
    expect(js).toContain('function fileTree');
    expect(js).toMatch(/entry\.path\.split\('\/'\)/);
    const sends = [...js.matchAll(/send\('files\.list', ([^)]*)\)/g)].map((m) => m[1]);
    expect(sends.length).toBeGreaterThan(0);
    for (const arg of sends) expect(arg).toBe('{}');
  });

  it('stores what is closed, because open is the default', () => {
    // A store with four files in two folders must not open worse than the
    // flat list it replaced, so the set that persists is the small one.
    expect(js).toContain("const FOLDERS_KEY = 'turminder.foldersClosed'");
    const fn = js.slice(
      js.indexOf('function folderOpen'),
      js.indexOf('function setFolderOpen'),
    );
    expect(fn).toMatch(/return !state\.files\.collapsed\.has/);
  });

  it('opens the folders the file you opened is under', () => {
    expect(js).toMatch(/case 'files\.read\.result':[\s\S]{0,160}revealFolders\(/);
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

/**
 * The keyboard half of §9.1. A vitest suite cannot open a keyboard, so what it
 * pins is the pair of mechanisms and the fact that the CSS and the JS agree on
 * the names — one deletion here silently puts the composer back behind the
 * keyboard on a device nobody in CI is holding.
 */
describe('the visible viewport is what the layout owns (§9.1)', () => {
  const viewport =
    /<meta[^>]*name="viewport"[^>]*>/s.exec(html.replace(/\s+/g, ' '))?.[0] ?? '';

  it('asks Chrome to shrink the layout for the keyboard', () => {
    // The default is `resizes-visual`, under which `dvh` does not move and the
    // composer is behind the keyboard. That is the entire Android bug.
    expect(viewport).toContain('interactive-widget=resizes-content');
    expect(viewport).toContain('width=device-width');
    // 16px inputs are the no-zoom rule (§9.1); an explicit maximum-scale would
    // be the other way of stopping zoom, and it stops pinch-zoom too.
    expect(viewport).not.toContain('maximum-scale');
    expect(viewport).not.toContain('user-scalable');
  });

  it('measures for Safari, which implements neither', () => {
    expect(js).toContain('window.visualViewport');
    expect(js).toMatch(/setProperty\('--visible-height'/);
    expect(js).toMatch(/setProperty\('--keyboard-inset'/);
    // Once per frame: `scroll` fires continuously while a keyboard animates.
    expect(js).toMatch(/requestAnimationFrame\(measure\)/);
  });

  it('agrees with the stylesheet about what the properties are called', () => {
    for (const prop of ['--visible-height', '--keyboard-inset']) {
      expect(css).toContain(prop);
      expect(js).toContain(prop);
    }
    // The shell keeps its `vh`/`dvh` declarations *before* the measured one, so
    // a browser with no `visualViewport` lands exactly where it did before.
    const body = css.slice(css.indexOf('body {'), css.indexOf('\n}', css.indexOf('body {')));
    const heights = [...body.matchAll(/height:\s*([^;]+);/g)].map((m) => m[1]);
    expect(heights).toEqual(['100vh', '100dvh', 'var(--visible-height, 100dvh)']);
  });

  it('subtracts the keyboard from the safe-area allowance instead of adding it', () => {
    // A keyboard covering the home indicator makes that allowance a gap
    // between the usage strip and the keyboard.
    const usage = css.slice(
      css.indexOf('#usage {'),
      css.indexOf('\n}', css.indexOf('#usage {')),
    );
    expect(usage).toMatch(/env\(safe-area-inset-bottom\)\s*-\s*var\(--keyboard-inset/);
    expect(usage).not.toMatch(/env\(safe-area-inset-bottom\)\s*\+/);
  });

  it('leaves the properties unset when nothing is occluding', () => {
    // Absence is the normal state: a desktop window must resolve to plain
    // `dvh`, byte for byte what it was before any of this existed.
    expect(js).toMatch(/removeProperty\('--visible-height'\)/);
    expect(js).toMatch(/removeProperty\('--keyboard-inset'\)/);
    expect(js).toContain('KEYBOARD_MIN_PX');
  });

  it('keeps the composer ceiling on the same fraction in both languages', () => {
    // 40% of what the reader can see. The CSS caps the box and `sizeInput`
    // caps the height it writes; a disagreement grows one past the other.
    expect(css).toContain('calc(0.4 * var(--visible-height, 100dvh))');
    expect(js).toContain('Math.round(visibleHeight() * 0.4)');
  });
});
