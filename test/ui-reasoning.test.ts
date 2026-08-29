import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The reasoning block, guarded from the only side a vitest suite can reach:
 * the source. Whether a minute-long think stays readable is a question for a
 * live service and a real GPU, and F1's exit criteria own it. What this file
 * stops is the regression that is one line wide — the *body* of the chain
 * getting a cap again, or the box losing the bound that makes an uncapped body
 * safe. The two only make sense together: either alone is the bug.
 */
const root = path.resolve(import.meta.dirname, '..');
const js = fs.readFileSync(path.join(root, 'ui', 'app.js'), 'utf8');
const css = fs.readFileSync(path.join(root, 'ui', 'style.css'), 'utf8');

/** A top-level function's source, from its declaration to its closing brace. */
function functionSource(name: string): string {
  const start = js.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`ui/app.js should declare ${name}()`);
  const end = js.indexOf('\n}\n', start);
  if (end < 0) throw new Error(`${name}() should end at a top-level brace`);
  return js.slice(start, end + 2);
}

/** A single CSS rule's declarations, by selector. */
function rule(selector: string): string {
  const start = css.indexOf(`${selector} {`);
  if (start < 0) throw new Error(`ui/style.css should carry a rule for ${selector}`);
  return css.slice(start, css.indexOf('\n}', start));
}

const showReasoning = functionSource('showReasoning');

describe('the reasoning body is not capped (§20.1)', () => {
  it('appends into a text node rather than reassigning the whole string', () => {
    expect(showReasoning).toContain('appendData(');
    // The two shapes that made it quadratic, and that a helpful edit would
    // reintroduce without noticing.
    expect(showReasoning).not.toMatch(/reasoningEl\.textContent\s*=/);
    expect(showReasoning).not.toMatch(/reasoningEl\.innerHTML/);
  });

  it('caps the summary buffer and nothing else', () => {
    const slices = [...showReasoning.matchAll(/\.slice\(([^)]*)\)/g)].map((m) => m[1]);
    expect(slices).toEqual(['-REASONING_TAIL_CAP']);
    // …and that buffer exists only to feed the collapsed header: its own
    // read-modify-write, then the summary. It never reaches the DOM.
    expect([...showReasoning.matchAll(/group\.reasoningTail/g)]).toHaveLength(3);
    expect(showReasoning).toContain('tail(group.reasoningTail');
    expect(showReasoning).not.toMatch(/reasoningNode.*reasoningTail/);
  });

  it('holds the box at its own bottom without touching the transcript', () => {
    expect(showReasoning).toContain('reasoningPinned');
    // The transcript's follow logic is asked, never overridden: scrollMessages
    // decides whether the page moves (see its own comment about the fight).
    expect(showReasoning).not.toMatch(/\$\('messages'\)/);
  });

  it('does not persist the chain', () => {
    // §20.1: reasoning is activity. It reaches the DOM and stops there — no
    // storage, no frame going back to the server, nothing to survive a reload.
    expect(showReasoning).not.toMatch(/localStorage|sessionStorage|indexedDB/);
    expect(showReasoning).not.toMatch(/\bsend\(/);
  });
});

/**
 * What the think cost, on the block that did it (§9, §20.1).
 *
 * The regression this guards is a second `/ 4` appearing somewhere: the strip
 * and the block header describe the same output, and two copies of the same
 * magic number are two numbers for one think the day someone tunes one of them.
 */
describe('the block header estimates its own output (§9)', () => {
  it('shares one chars-per-token estimate with the usage strip', () => {
    expect(js).toContain('const CHARS_PER_TOKEN = 4');
    // Every estimate goes through the one helper. A bare `/ 4` is the bug.
    expect([...js.matchAll(/estTokens\(/g)].length).toBeGreaterThanOrEqual(3);
    expect(js).not.toMatch(/Math\.round\([A-Za-z.]+ \/ 4\)/);
  });

  it("counts this block's reasoning, not the turn's output", () => {
    // `state.reasoningChars` is the turn's running total and resets with it;
    // the header belongs to one stretch of work, so it keeps its own.
    expect(showReasoning).toContain('group.reasoningChars += text.length');
    const fn = functionSource('showGroupTokens');
    expect(fn).toContain('group.reasoningChars');
    expect(fn).not.toContain('state.reasoningChars');
    expect(fn).not.toContain('turnTokensOut');
  });

  it('says nothing on a block that only called tools', () => {
    expect(functionSource('showGroupTokens')).toMatch(/if \(!group\.reasoningChars\) return;/);
  });

  it('is marked as an estimate, because nothing ever replaces it', () => {
    // Token counts arrive per turn, never per block: there is no settled
    // figure to swap in, so the tilde is permanent rather than provisional.
    expect(functionSource('showGroupTokens')).toContain('`~${compact(');
    expect(functionSource('settleGroup')).not.toContain('tokens');
  });
});

describe('the box is bounded instead (§9.1)', () => {
  it('gives the reasoning line a viewport-relative ceiling it can scroll in', () => {
    const reasoning = rule('.act-line.reasoning');
    // A scroller only while the block is open: collapsed, it is clipped to
    // nothing, and a zero-height scroll container is a tab stop that goes
    // nowhere.
    expect(reasoning).toMatch(/overflow:\s*hidden/);
    expect(rule('.act-group.open .act-line.reasoning')).toMatch(/overflow-y:\s*auto/);
    // The last max-height wins, and it is the `dvh` one: `vh` on a phone means
    // the viewport with the address bar retracted, which is taller than the
    // viewport the reader has.
    const heights = [...reasoning.matchAll(/max-height:\s*([^;]+);/g)].map((m) => m[1] ?? '');
    expect(heights.length).toBeGreaterThan(0);
    expect(heights.at(-1)).toContain('dvh');
    // Reading back through the chain must not chain into the transcript and
    // drop follow mode mid-run.
    expect(reasoning).toMatch(/overscroll-behavior:\s*contain/);
  });
});
