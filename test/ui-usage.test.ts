import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The usage strip's arithmetic (§21.1), guarded from the source — the only
 * side a vitest suite reaches, since `ui/app.js` is a browser script with no
 * build step and no exports by design.
 *
 * The server has always sent the right numbers, and
 * `test/context-economics.test.ts` proves it does. The bug was one addition on
 * this side: the headline added the run's cumulative output to the peak
 * prompt, re-counting output that turn two onwards already carries *inside*
 * that peak. Measured on the live install at +97% on a sixteen-call run —
 * 19,325 tokens reported as 38,105 against a 98k window. That addition must
 * not come back, and neither must a live estimate that cannot see reasoning.
 */
const root = path.resolve(import.meta.dirname, '..');
const js = fs.readFileSync(path.join(root, 'ui', 'app.js'), 'utf8');

/** A top-level function's source, from its declaration to its closing brace. */
function functionSource(name: string): string {
  const start = js.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`ui/app.js should declare ${name}()`);
  const end = js.indexOf('\n}\n', start);
  if (end < 0) throw new Error(`${name}() should end at a top-level brace`);
  return js.slice(start, end + 2);
}

const renderUsage = functionSource('renderUsage');

describe('the headline is pressure, never billing (§21.1)', () => {
  it('shows the peak prompt with nothing added to it', () => {
    // The shape of the bug, in both branches: a sum where the spec says a peak.
    expect(renderUsage).not.toMatch(/context_used\s*\?\?\s*\w+\.tokens_in\)\s*\+/);
    expect(renderUsage).not.toMatch(/inTokens\s*\+\s*out/);
    expect(renderUsage).toMatch(/const used = u\.context_used \?\? u\.tokens_in;/);
  });

  it('feeds the bar the same figure it prints', () => {
    // A bar computed from one number beside a label printed from another is
    // the failure this whole strip is about.
    const bars = [...renderUsage.matchAll(/bar\(([^)]*)\)/g)].map((m) => m[1]?.trim());
    expect(bars).toEqual(['inTokens / ctx', 'used / u.context_size']);
  });

  it('still shows cumulative billing, as the secondary figure', () => {
    // §21.1: available, labelled as work done, never as context.
    expect(renderUsage).toMatch(/'billed'/);
    expect(renderUsage).toMatch(/'conversation'/);
  });
});

describe('the live estimate can see reasoning (§20.1)', () => {
  it('counts reasoning characters alongside the visible ones', () => {
    // Reasoning never streams into the transcript, and on a thinking model it
    // is most of the billed output — measured at ~68% on the live install. An
    // estimate blind to it under-reports by threefold and then jumps at settle.
    expect(renderUsage).toMatch(
      /const streamedNow = state\.streamedChars \+ state\.reasoningChars;/,
    );
    expect(renderUsage).toMatch(/Math\.round\(streamedNow \/ 4\)/);
    expect(renderUsage).not.toMatch(/state\.streamedChars \/ 4/);
  });

  it('accumulates them where the reasoning deltas arrive', () => {
    // The counter is fed from the `chat.activity` reasoning branch, and reset
    // everywhere its visible sibling is — a counter that resets in three
    // places out of four reads as a leak.
    expect(js).toMatch(/state\.reasoningChars \+= \(activity\.text \|\| ''\)\.length;/);
    const resets = [...js.matchAll(/state\.reasoningChars = 0;/g)];
    const visible = [...js.matchAll(/state\.streamedChars = 0;/g)];
    expect(resets).toHaveLength(visible.length);
  });
});
