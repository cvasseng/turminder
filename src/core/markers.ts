/**
 * Reserved markers (§20.8) — annotations written in the system's voice.
 *
 * These strings may appear in model *input* and never in model *output*. The
 * distinction is not cosmetic. §20.2 once rendered the tools-used annotation
 * as the prose line `(used tools: files.append)`; in a rapid add-item cadence
 * the model started emitting that line itself, and four turns narrated file
 * appends that were never called — the fabricated prefix persisting into the
 * turn and teaching the next request the same trick (2026-08-22, conversation
 * `01M0K08T3T27X7W2E4SBHP4GCY`).
 *
 * A format the system speaks in the assistant's own voice is a format the
 * model will learn to speak. So system annotations are `[[…]]`-shaped —
 * visibly not prose — and the *family* is reserved rather than the individual
 * strings: any future prompt-visible annotation joins the guard by using the
 * same form and adding its keyword below.
 *
 * This module is the one vocabulary: the marker builders, the detector the
 * agent loop's guard runs on fresh output, and the strip that fences
 * persistence. It lives in `core` because the layers that need it — the loop,
 * history assembly, and the turns repository — sit on three different levels.
 */

/** The reserved keywords, in `[[<keyword>: …]]`. `image` lands with §26. */
const RESERVED = ['elided', 'stored', 'used tools', 'image'] as const;

export const ELIDED_PREFIX = '[[elided:';
export const STORED_PREFIX = '[[stored:';
export const USED_TOOLS_PREFIX = '[[used tools:';

/**
 * The legacy prose form, recognised only at the start of a line — the exact
 * shape the model learned to fabricate. Poisoned history has to stop teaching
 * it, so this is stripped at render time as well as at persist time (§20.2).
 */
export const LEGACY_USED_TOOLS = '(used tools:';

const OPENING_SOURCE = `\\[\\[(?:${RESERVED.join('|')}):`;
/** Global, for scanning; `search`/`replace` never advance a shared lastIndex. */
const OPENINGS = new RegExp(OPENING_SOURCE, 'gi');
const OPENING = new RegExp(OPENING_SOURCE, 'i');
const LEGACY_LINE = /^\(used tools:[^\n]*\n?/gim;
const LEGACY_OPEN = /^\(used tools:/im;

/** `]]` inside a marker would end it early for anything scanning for markers. */
export function markerSafe(text: string): string {
  return text.replace(/\]\]/g, '] ]');
}

/**
 * The tools-used annotation for one history turn (§20.2). Names only: enough
 * continuity that the model knows it looked something up, without the payload.
 */
export function usedToolsMarker(tools: readonly string[]): string {
  return `${USED_TOOLS_PREFIX} ${tools.map(markerSafe).join(', ')}]]`;
}

/**
 * An image the model cannot see right now (§26.3). Two reasons, two markers,
 * both in the system voice: the part scrolled out of the vision window, or
 * there is no vision-capable endpoint at all. Saying which is the difference
 * between a model that asks for a re-attach and one that invents a
 * description.
 */
export function imageMarker(name: string, reason: 'elided' | 'no_vision'): string {
  const label = markerSafe(name);
  return reason === 'elided'
    ? `[[image: ${label}, attached earlier — re-attach or ask the user if you need it again]]`
    : `[[image: ${label} — no vision-capable endpoint is configured; you cannot see it. Say so rather than guessing]]`;
}

/**
 * The reserved forms present in `text`, deduped and lowercased — the opening
 * token of each, which is what identifies the form in a trace row. Detection
 * is deterministic string matching: this is output *validation*, not a
 * relevance judgement, so the fail-open rule of §1.1 does not apply.
 */
export function reservedMarkers(text: string): string[] {
  if (!text) return [];
  const found = new Set<string>();
  for (const m of text.matchAll(OPENINGS)) found.add(m[0].toLowerCase());
  if (LEGACY_OPEN.test(text)) found.add(LEGACY_USED_TOOLS);
  return [...found];
}

/**
 * Remove every reserved form, leaving the rest of the text intact. Used on
 * fresh output that offended twice (§20.8) and on everything written into
 * `turns`, so no code path can persist a pattern that would teach the next
 * request to imitate it.
 *
 * A marker is a single line by construction, so an unterminated one — a model
 * imitating the form without closing it — is cut to the end of its line rather
 * than swallowing the rest of the reply.
 */
export function stripReservedMarkers(text: string): string {
  // Identity for the overwhelmingly common case: nothing to strip, no
  // reformatting of text that was already fine.
  if (!reservedMarkers(text).length) return text;
  let out = text.replace(LEGACY_LINE, '');
  for (;;) {
    const at = out.search(OPENING);
    if (at < 0) break;
    const close = out.indexOf(']]', at);
    const eol = out.indexOf('\n', at);
    const end = close >= 0 && (eol < 0 || close < eol) ? close + 2 : eol < 0 ? out.length : eol;
    out = out.slice(0, at) + out.slice(end);
  }
  // Removing a line of its own leaves a hole; collapse it rather than shipping
  // the model's text with a gap where the system's annotation used to be.
  return out.replace(/\n{3,}/g, '\n\n').trim();
}
