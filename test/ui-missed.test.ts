import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * "While you were away" (§7.1, App. D `delivery.missed`), guarded from the
 * only side a vitest suite can reach: the source. There is no DOM here and
 * App. J has no room for one, so this makes no claim about how the drawer
 * looks. It stops the failures that would undo the feature quietly: a missed
 * list rendered as toasts, a row that is read but never acked (so it comes
 * back on every hello), and the list living anywhere but the activity drawer.
 */
const root = path.resolve(import.meta.dirname, '..');
const read = (rel: string): string => fs.readFileSync(path.join(root, rel), 'utf8');
const js = read('ui/app.js');
const css = read('ui/style.css');
const spec = read('spec.md');

const handler = (): string => {
  const start = js.indexOf("case 'delivery.missed'");
  return js.slice(start, js.indexOf('case ', start + 10));
};
const fn = (name: string): string => {
  const start = js.indexOf(`function ${name}(`);
  return js.slice(start, js.indexOf('\n}\n', start));
};

describe('missed notifications wait in the drawer (§7.1)', () => {
  it('is a frame App. D catalogs, and one this page expects', () => {
    expect(spec).toMatch(/^\| `delivery\.missed` \|/m);
    const expected = js.slice(
      js.indexOf('const EXPECTED_FROM_SERVER'),
      js.indexOf('];', js.indexOf('const EXPECTED_FROM_SERVER')),
    );
    expect(expected).toContain("'delivery.missed'");
  });

  it('never toasts: the list goes to the activity state, not the transcript', () => {
    const body = handler();
    expect(body).toContain('state.activity.missed =');
    expect(body).not.toContain('showDelivery');
    expect(body).not.toContain("$('messages')");
    expect(body).toContain('refreshActivityTab()');
  });

  it('acks a missed row when it is opened or dismissed, once', () => {
    const settle = fn('readMissed');
    expect(settle).toMatch(/if \(entry\.read\) return;/);
    expect(settle).toContain("send('ack', { delivery_id: entry.frame.delivery_id })");
    const row = fn('missedRow');
    expect(row.match(/readMissed\(entry\)/g)).toHaveLength(2);
    // Its moment has passed: a missed row offers no action buttons.
    expect(row).not.toContain('notification.action');
  });

  it('heads the list "While you were away" and counts unread rows on the tab', () => {
    expect(fn('renderActivity')).toContain("'While you were away'");
    expect(fn('refreshActivityTab')).toMatch(/state\.activity\.missed\.filter\(/);
    expect(css).toMatch(/\.act-row\.missed \.missed-body\[hidden\]\s*\{[^}]*display:\s*none/);
  });
});
