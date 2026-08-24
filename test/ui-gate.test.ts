import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The token gate's two shapes (§24.3).
 *
 * There is no browser here, so this makes no claim about how the gate looks —
 * only about the one thing that made it useless on a phone: it opened on a box
 * for 64 hex characters and pointed at a terminal, on an install whose
 * assistant was one sentence away from connecting the device itself. Pairing
 * leads (§24.4); the terminal is named in the single case where nothing is
 * linked and there is nobody to ask.
 */
const root = path.resolve(import.meta.dirname, '..');
const html = fs.readFileSync(path.join(root, 'ui', 'index.html'), 'utf8');

/** The opening tag of the element a given offset sits inside. */
function enclosingTag(offset: number): string {
  const open = html.lastIndexOf('<', offset);
  const close = html.indexOf('>', open);
  return html.slice(open, close + 1);
}

describe('the token gate leads with pairing (§24.4)', () => {
  it('offers the one button first and folds the token box away', () => {
    const pair = html.indexOf('id="gate-pair"');
    const entry = html.indexOf('id="gate-entry"');
    expect(pair).toBeGreaterThan(-1);
    expect(entry).toBeGreaterThan(pair);
    // Hidden in the markup: the shape a browser gets before /healthz answers is
    // the one that is right for every install that has ever linked a device.
    expect(enclosingTag(entry)).toContain('hidden');
    // And the code only appears once there is one.
    expect(enclosingTag(html.indexOf('id="gate-code-box"'))).toContain('hidden');
  });

  it('points at the assistant on a device that is already linked', () => {
    // Collapsed: a sentence that reads right can be wrapped anywhere, and a
    // test that pins the wrapping is a test that punishes formatting.
    const pair = html
      .slice(html.indexOf('id="gate-pair"'), html.indexOf('id="gate-entry"'))
      .replace(/\s+/g, ' ');
    expect(pair).toMatch(/already linked/);
    expect(pair).toMatch(/Connect this device/);
    // No camera instructions: a plain-HTTP page cannot open one (§24.4), and
    // the copy says as much ("nothing to scan") rather than asking for one.
    expect(pair).not.toMatch(/camera/i);
    // The CLI has no business in the copy someone reads by default (§24.1).
    expect(pair).not.toMatch(/turminder token/);
  });

  it('names the CLI once, inside a hint that ships hidden', () => {
    const cli = [...html.matchAll(/turminder token create/g)].map((m) => m.index ?? -1);
    expect(cli).toHaveLength(1);
    const hint = html.indexOf('id="gate-cli-hint"');
    expect(enclosingTag(hint)).toContain('hidden');
    // …and that is the paragraph the command sits in, not a neighbouring one.
    expect(cli[0]).toBeGreaterThan(hint);
    expect(cli[0]).toBeLessThan(html.indexOf('</p>', hint));
  });
});
