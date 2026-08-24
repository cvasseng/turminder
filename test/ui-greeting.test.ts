import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The empty-transcript greeting (§9).
 *
 * `ui/greeting.js` is its own file so this suite can call the one thing worth
 * being sure about — where the bands fall — without lifting a function out of
 * `app.js` by regex, which the architect ruled is a test that punishes
 * formatting (JUDGMENT.md, 2026-08-22). The same argument gave `preview.js`
 * and `connect.js` their own files.
 */
const root = path.resolve(import.meta.dirname, '..');
const read = (rel: string): string => fs.readFileSync(path.join(root, rel), 'utf8');

/** Evaluate the module and hand back what it defines. */
function load(): {
  greetingFor: (hour: number) => string;
  greetingLine: (hour: number, name: string | null) => string;
} {
  return new Function(`${read('ui/greeting.js')}; return { greetingFor, greetingLine };`)() as {
    greetingFor: (hour: number) => string;
    greetingLine: (hour: number, name: string | null) => string;
  };
}

describe('the greeting picks a band by the hour (§9)', () => {
  it('covers all 24 hours with no gap and no overlap', () => {
    const { greetingFor } = load();
    const bands = Array.from({ length: 24 }, (_, h) => greetingFor(h));
    // Every hour answers something — an off-by-one at a boundary would show up
    // here as an undefined rather than as a wrong word.
    expect(bands.filter(Boolean)).toHaveLength(24);
    expect(new Set(bands)).toEqual(new Set(['Good morning', 'Good day', 'Good evening']));
  });

  it('puts the boundaries where they are meant to be', () => {
    const { greetingFor } = load();
    // 05:00 is the first morning hour; 04:59 is still the night before.
    expect(greetingFor(4)).toBe('Good evening');
    expect(greetingFor(5)).toBe('Good morning');
    expect(greetingFor(11)).toBe('Good morning');
    expect(greetingFor(12)).toBe('Good day');
    expect(greetingFor(17)).toBe('Good day');
    expect(greetingFor(18)).toBe('Good evening');
    expect(greetingFor(23)).toBe('Good evening');
    // Midnight is an opening, not a farewell: "good night" would be a goodbye
    // from something that has just been opened.
    expect(greetingFor(0)).toBe('Good evening');
  });

  it('uses the name when there is one, and reads fine without', () => {
    const { greetingLine } = load();
    expect(greetingLine(9, 'Alex')).toBe('Good morning, Alex');
    // Null until onboarding has written an identity (G.3) — the line still has
    // to be a sentence.
    expect(greetingLine(9, null)).toBe('Good morning');
    expect(greetingLine(9, '')).toBe('Good morning');
  });
});

describe('the greeting is wired to a conversation that does not exist yet', () => {
  it('is drawn only when there is no conversation id', () => {
    const app = read('ui/app.js');
    // Both places: clearing the transcript, and `welcome` arriving with the
    // name after the greeting has already been drawn without one.
    expect(app.match(/if \(!state\.conversationId\) showGreeting\(\);/g)?.length).toBe(2);
    expect(app).toContain('state.userName = p.user_name || null;');
  });

  it('hides itself in CSS rather than in four call sites', () => {
    // A message, an activity block, a delivery and a form can each be the
    // first thing in a transcript. One rule covers all of them, and the fifth
    // that someone adds later.
    expect(read('ui/style.css')).toContain('.greeting:not(:only-child)');
  });

  it('is loaded by the chat page before app.js needs it', () => {
    const html = read('ui/index.html');
    expect(html).toContain('<script src="/greeting.js"></script>');
    expect(html.indexOf('/greeting.js')).toBeLessThan(html.indexOf('/app.js'));
  });
});
