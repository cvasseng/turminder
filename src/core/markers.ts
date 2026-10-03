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
const RESERVED = ['elided', 'stored', 'run', 'used tools', 'image'] as const;

export const ELIDED_PREFIX = '[[elided:';
export const STORED_PREFIX = '[[stored:';
export const RUN_PREFIX = '[[run:';
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
 * The tools-used annotation for one **legacy** history turn (§20.2): a row
 * persisted before the run record existed. Names only — enough continuity that
 * the model knows it looked something up, without the payload.
 */
export function usedToolsMarker(tools: readonly string[]): string {
  return `${USED_TOOLS_PREFIX} ${tools.map(markerSafe).join(', ')}]]`;
}

/** How a run ended, as the run record says it (§20.2). */
export type RunOutcome = 'done' | 'stopped' | 'cut_short' | 'failed';

/**
 * What a run did and how it ended (§20.2), stored on the assistant turn as
 * `turns.content.record`. Computed once, at persist time, and rendered from
 * the stored value — so the history line is the same bytes on every later
 * request and the prefix cache holds (§20.5).
 *
 * `effects` are what the run's successful `se` calls changed, one phrase per
 * call in call order; `used` is every tool the run called that produced no
 * effect — the reads, a write that failed, `tools.open` — deduped, in call
 * order. Payloads never cross a turn; this does.
 */
export interface RunRecord {
  outcome: RunOutcome;
  /** With `cut_short`/`failed`: timeout | stalled | context window full | … */
  reason?: string;
  effects: string[];
  used: string[];
}

/** App. A `run_record_max_effects`: shown before `…and N more`. */
export const RUN_RECORD_MAX_EFFECTS = 12;
/** App. A `run_record_max_chars`: the whole line, cut at an effect boundary. */
export const RUN_RECORD_MAX_CHARS = 600;
/** §20.2: one effect phrase is at most this long. */
export const EFFECT_MAX_CHARS = 120;
/** §20.2: a fallback effect's target, in stable JSON, is cut to this. */
const EFFECT_TARGET_MAX_CHARS = 80;

/** Key-order-independent serialization, so "the same call" means the same call. */
export function stableJson(value: unknown): string {
  return (
    JSON.stringify(value, (_key, v) =>
      v && typeof v === 'object' && !Array.isArray(v)
        ? Object.fromEntries(
            Object.entries(v as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : 1)),
          )
        : v,
    ) ?? 'null'
  );
}

/**
 * Content made safe to sit inside the run line (§20.2): one line, and no two
 * adjacent brackets of either kind anywhere — `[[[` becomes `[ [ [`. Breaking
 * only `]]` and `[[` as pairs is not enough: a run of three (`a]]] [[[run:`)
 * leaves a closing pair and an opening marker behind once the first pair is
 * split. Idempotent, so the stored phrase and the rendered one agree.
 */
export function runLineSafe(text: string): string {
  return text
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\[(?=\[)/g, '[ ')
    .replace(/\](?=\])/g, '] ');
}

function cut(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/**
 * One effect phrase made fit for the run line: marker-safe (`runLineSafe`) —
 * an embed titled after a marker must not end the line early or open a forged
 * one — and at most `EFFECT_MAX_CHARS`. The tool writes ids first, so the cut never
 * reaches them.
 */
export function effectPhrase(text: string): string {
  return cut(runLineSafe(text), EFFECT_MAX_CHARS);
}

/**
 * The effect of a `se` call whose tool declares no phrase (§20.2): `<tool>
 * <target>`, the target being its args minus `bulkArgs` — §20.7's notion of
 * "the same target" — in stable JSON, cut to 80 chars. Args that were all bulk
 * (or none at all) have no target, and the tool name says what there is.
 */
export function fallbackEffect(
  tool: string,
  args: unknown,
  bulkArgs: readonly string[] = [],
): string {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return effectPhrase(tool);
  const target = { ...(args as Record<string, unknown>) };
  for (const field of bulkArgs) delete target[field];
  if (!Object.keys(target).length) return effectPhrase(tool);
  return effectPhrase(`${tool} ${cut(stableJson(target), EFFECT_TARGET_MAX_CHARS)}`);
}

function outcomePhrase(record: RunRecord): string {
  // The reason can carry an endpoint's own error text: safe like any phrase.
  const reason = record.reason ? runLineSafe(record.reason) : '';
  switch (record.outcome) {
    case 'done':
      return 'done';
    case 'stopped':
      return 'stopped by the user';
    case 'cut_short':
      return `cut short (${reason})`;
    case 'failed':
      return `failed (${reason})`;
  }
}

/**
 * The run record as one history line (§20.2), exactly:
 * `[[run: <outcome phrase>[ · <effect>]…[ · used tools: a, b]]]`.
 *
 * At most `RUN_RECORD_MAX_EFFECTS` effects, then `…and N more`; the whole line
 * at most `RUN_RECORD_MAX_CHARS`, shortened by moving effects from the end into
 * the count — an effect is shown whole or not at all, because half an id is
 * worse than none. `null` for a plain `done` with nothing to report: that run
 * needs no line, and a line saying nothing is tokens on every later request.
 */
export function runRecordMarker(record: RunRecord): string | null {
  // Made safe again at render, not only when stored: a row is data, and an
  // MCP tool's name is somebody else's text.
  const effects = record.effects.map(runLineSafe);
  const used = record.used.map(runLineSafe);
  if (record.outcome === 'done' && !effects.length && !used.length) return null;
  const head = `${RUN_PREFIX} ${outcomePhrase(record)}`;
  const compose = (shown: number, tools: readonly string[], toolsCut: boolean): string => {
    const more = effects.length - shown;
    const body =
      head +
      effects
        .slice(0, shown)
        .map((e) => ` · ${e}`)
        .join('') +
      (more > 0 ? ` · …and ${more} more` : '') +
      (tools.length ? ` · used tools: ${tools.join(', ')}${toolsCut ? ', …' : ''}` : '');
    // Content ending in `]` would make the close `]]]`, and a scanner would
    // end the marker one character early.
    return `${body}${body.endsWith(']') ? ' ' : ''}]]`;
  };
  let shown = Math.min(effects.length, RUN_RECORD_MAX_EFFECTS);
  let line = compose(shown, used, false);
  while (line.length > RUN_RECORD_MAX_CHARS && shown > 0) {
    shown -= 1;
    line = compose(shown, used, false);
  }
  // Only a run that called dozens of distinct tools gets here; the names go
  // from the end, so the line still fits and still says it was cut.
  let tools = used;
  while (line.length > RUN_RECORD_MAX_CHARS && tools.length > 1) {
    tools = tools.slice(0, -1);
    line = compose(shown, tools, true);
  }
  return line;
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
 * Is this value a transcript *placeholder* — a `[[stored:` or `[[elided:`
 * marker standing where content used to be — rather than content? These two
 * forms are stand-ins for the model's own bytes (§20.4, §20.6); the other
 * markers annotate history and can legitimately be *mentioned*. A model that
 * re-sends a placeholder as a tool argument has mistaken the stub for a failed
 * write (2026-08-30: two `memory.update` calls stored the marker itself), so
 * the hub refuses exactly this shape and nothing broader (§20.8's limitation).
 */
export function isTranscriptPlaceholder(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  const head = value.trimStart().toLowerCase();
  return head.startsWith(STORED_PREFIX) || head.startsWith(ELIDED_PREFIX);
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
