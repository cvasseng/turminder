import type { ModelMessage } from 'ai';
import { ELIDED_PREFIX, markerSafe, STORED_PREFIX } from '../core/markers.js';

/**
 * Mid-run elision of stale large tool results (§20.4) and of bulk-content tool
 * arguments (§20.6) — the same trade, applied to the two halves of a tool call.
 *
 * Within a run `messages` only ever appends, which is what makes the llama.cpp
 * KV prefix cache work. Elision deliberately trades a one-time prefix
 * reprocess for a permanently smaller context, so it fires only where that
 * trade clearly wins: a result big enough to matter, old enough that the model
 * has already used it, and replaced **in place** so the prefix is stable again
 * from that point on.
 *
 * Markers are STRINGS, not objects, deliberately (§20.4): an object stub sits
 * where data used to be and looks like data — models pasted one into
 * `embeds.bind` and it travelled all the way to an external server. A string
 * pasted into structured args fails validation loudly, reads as an
 * instruction, and can carry a digest — enough shape for the model to stay
 * oriented ("24 price rows for the 22nd") without the payload, which is what
 * stops the re-fetch loop.
 */
export interface ElisionSettings {
  thresholdChars: number;
  afterTurns: number;
}

export function isElidedMarker(value: unknown): boolean {
  return typeof value === 'string' && value.startsWith(ELIDED_PREFIX);
}

export function isStoredMarker(value: unknown): boolean {
  return typeof value === 'string' && value.startsWith(STORED_PREFIX);
}

function serializedLength(value: unknown): number {
  if (typeof value === 'string') return value.length;
  try {
    return (JSON.stringify(value) ?? '').length;
  } catch {
    return 0;
  }
}

/**
 * A deterministic one-line shape summary, ≤ ~120 chars: what the value was,
 * not what it said. Keys with array lengths for objects, length + first-item
 * keys for arrays, a short prefix for strings. This is the model's residual
 * working memory after the payload is gone.
 */
export function digest(value: unknown): string {
  if (value === null || value === undefined) return 'empty';
  if (typeof value === 'string') {
    return `text, starts "${markerSafe(value.slice(0, 48))}${value.length > 48 ? '…' : ''}"`;
  }
  if (typeof value !== 'object') return markerSafe(String(value).slice(0, 48));
  if (Array.isArray(value)) {
    const first = value[0];
    const inner =
      first && typeof first === 'object' && !Array.isArray(first)
        ? ` of {${Object.keys(first as object)
            .slice(0, 5)
            .join(', ')}}`
        : '';
    return `${value.length} items${inner}`;
  }
  const parts = Object.entries(value as Record<string, unknown>)
    .slice(0, 6)
    .map(([key, v]) => {
      if (Array.isArray(v)) return `${key}(${v.length} items)`;
      if (v && typeof v === 'object') return `${key}{…}`;
      return `${key}: ${markerSafe(String(v).slice(0, 24))}`;
    });
  return `keys: ${parts.join(', ')}`.slice(0, 120);
}

export function elidedMarker(tool: string, value: unknown): string {
  return (
    `${ELIDED_PREFIX} ${tool} result, ${serializedLength(value)} chars — ${digest(value)}. ` +
    `You received this data earlier; it was removed to save space. ` +
    `Re-call the tool if you need it again. Never copy this marker into a tool call]]`
  );
}

/**
 * The stand-in for a bulk argument after its call ran (§20.6). It says what it
 * is *before* it says what happened: a model that read the old wording as "my
 * content was replaced" re-sent the write eight times in seventy seconds
 * (2026-08-30). Only a successful call is ever stubbed, so "stored" is true
 * whenever this text appears.
 */
export function storedMarker(chars: number): string {
  return (
    `${STORED_PREFIX} ${chars} chars — placeholder for the content you sent in this call; ` +
    `it was written successfully and is stored, and is shown as this marker to save space. ` +
    `Read it back with the tool if needed. Never copy this marker into a tool call]]`
  );
}

/**
 * Is this result a skill body (§20.4, §20.11)? A declared `neverElide` tool's
 * result, or a `tools.open` result carrying the namespace's skill (F.12) —
 * a skill body is a skill body however it arrived, and losing one to
 * elision costs the brief the run is following.
 */
export function isSkillResult(
  toolName: string,
  value: unknown,
  neverElide: ReadonlySet<string>,
): boolean {
  if (neverElide.has(toolName)) return true;
  if (toolName !== 'tools.open' || !value || typeof value !== 'object') return false;
  const skill = (value as { skill?: { content?: unknown } }).skill;
  return typeof skill?.content === 'string';
}

/**
 * Replace stale large tool results with markers, in place. Returns the tools
 * whose results were elided on this pass.
 *
 * Monotonic by construction: the array is mutated, so an elided result can
 * never come back — a flip-flop would invalidate the prefix twice and leave
 * the model looking at content that had already vanished once.
 *
 * Only tool *results* are touched. Tool calls are cheap and removing one would
 * orphan its result; assistant text and user messages are the conversation.
 * `neverElide` names the tools that opted out entirely (§20.4); a `tools.open`
 * result carrying its namespace's skill is left alone the same way (§20.11).
 */
export function elideStaleResults(
  messages: ModelMessage[],
  settings: ElisionSettings,
  neverElide: ReadonlySet<string> = new Set(),
): string[] {
  // How many assistant turns come after each position, counted from the end.
  let assistantsAfter = 0;
  const elided: string[] = [];

  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i]!;
    if (message.role === 'assistant') {
      assistantsAfter += 1;
      continue;
    }
    if (message.role !== 'tool' || assistantsAfter < settings.afterTurns) continue;
    if (!Array.isArray(message.content)) continue;

    for (const part of message.content) {
      if (part.type !== 'tool-result') continue;
      // Declared instructions rather than data (§20.4): a skill body the run
      // is following. Eliding one buys a few hundred tokens and costs a turn
      // spent re-fetching the brief, which is the opposite of the trade.
      const output = part.output;
      if (
        isSkillResult(part.toolName, output?.type === 'json' ? output.value : null, neverElide)
      )
        continue;
      // Only the JSON-valued results this system produces; a media result has
      // no comparable size and nothing sensible to put in a marker.
      if (!output || output.type !== 'json') continue;
      if (isElidedMarker(output.value)) continue;
      const size = serializedLength(output.value);
      if (size <= settings.thresholdChars) continue;

      output.value = elidedMarker(part.toolName, output.value) as never;
      elided.push(part.toolName);
    }
  }
  return elided;
}

/**
 * The stand-in for a skill body that compaction stubbed (§20.11 rung 2). It
 * names the way back, because unlike data a brief is something the run may
 * still need to follow — and a later `skills.fetch` of it is delivered in
 * full again, since the body is no longer in the transcript.
 */
export function skillStubMarker(name: string, chars: number): string {
  return (
    `${ELIDED_PREFIX} skill ${markerSafe(name)}, ${chars} chars — ` +
    `fetch it again with skills.fetch if you need it]]`
  );
}

/** The window-budget compaction ladder (§20.11), one rung per call. */
export type CompactionRung = 1 | 2 | 3;

/**
 * The index of the latest tool round — the results the model has not yet
 * answered — or -1 when the run has made no call. Rungs 1 and 2 never touch
 * it, and rung 3 elides only what is older: the model is about to read it.
 */
function latestRound(messages: ModelMessage[]): number {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i]!.role === 'tool') return i;
  }
  return -1;
}

function skillName(value: unknown, fallback: string): string {
  const v = value as { name?: unknown; skill?: { name?: unknown } } | null;
  // A `tools.open` result names its skill inside `skill`; `skills.fetch` at the top.
  const name = v?.skill?.name ?? v?.name;
  return typeof name === 'string' && name ? name : fallback;
}

/**
 * One rung of §20.11's compaction, in place. Returns how many results it
 * replaced. Monotonic exactly like §20.4 — every replacement is a marker
 * string, and a marker is never replaced again — so it busts the prefix once,
 * at the point of the first edit, for the same reason elision may.
 *
 * 1. Every result above `thresholdChars` older than the latest round,
 *    regardless of age; skill bodies (`neverElide`, or a `tools.open` that
 *    carried one) are left to rung 2.
 * 2. Every skill body except the most recently delivered one, as a stub that
 *    says how to get it back.
 * 3. Every result older than the latest round, whatever its size — skill
 *    bodies as stubs, so the way back is still named.
 *
 * A `tools.open` that carried a skill keeps `opened` and `tools`; only its
 * `skill` field becomes the stub.
 */
export function compactRung(
  messages: ModelMessage[],
  rung: CompactionRung,
  thresholdChars: number,
  neverElide: ReadonlySet<string>,
): number {
  const latest = latestRound(messages);
  // The newest skill body survives rung 2 wherever it sits — it is the brief
  // the run is following right now.
  let newestSkill: unknown = null;
  if (rung === 2) {
    for (let i = messages.length - 1; i >= 0 && newestSkill === null; i -= 1) {
      const m = messages[i]!;
      if (m.role !== 'tool' || !Array.isArray(m.content)) continue;
      for (let j = m.content.length - 1; j >= 0; j -= 1) {
        const part = m.content[j]!;
        if (part.type !== 'tool-result') continue;
        if (part.output?.type !== 'json' || typeof part.output.value === 'string') continue;
        if (!isSkillResult(part.toolName, part.output.value, neverElide)) continue;
        // A pointer to a copy (§20.11 dedupe) is not a body, and must not
        // shield itself at the expense of the copy it points to.
        if (
          (part.output.value as { already_loaded?: unknown } | null)?.already_loaded === true
        ) {
          continue;
        }
        newestSkill = part;
        break;
      }
    }
  }
  let replaced = 0;
  for (let i = 0; i < latest; i += 1) {
    const message = messages[i]!;
    if (message.role !== 'tool' || !Array.isArray(message.content)) continue;
    for (const part of message.content) {
      if (part.type !== 'tool-result') continue;
      const output = part.output;
      if (!output || output.type !== 'json') continue;
      // Already a marker (or a string result, which has no shape to digest).
      if (typeof output.value === 'string') continue;
      const skill = isSkillResult(part.toolName, output.value, neverElide);
      const stubSkill = skill && (rung === 3 || (rung === 2 && part !== newestSkill));
      if (stubSkill) {
        const value = output.value as Record<string, unknown>;
        const name = skillName(value, part.toolName);
        // A `tools.open` keeps `opened` and `tools`: only the body it carried
        // goes (§20.11). `<n>` is the body's length either way.
        const opened = part.toolName === 'tools.open' && !neverElide.has(part.toolName);
        const body = (opened ? (value.skill as { content: string }) : value).content;
        const chars = typeof body === 'string' ? body.length : serializedLength(value);
        const stub = skillStubMarker(name, chars);
        if (stub.length >= chars) continue;
        output.value = (opened ? { ...value, skill: stub } : stub) as never;
        replaced += 1;
        continue;
      }
      if (skill) continue;
      const size = serializedLength(output.value);
      const marker =
        rung === 3 || (rung === 1 && size > thresholdChars)
          ? elidedMarker(part.toolName, output.value)
          : null;
      // A marker longer than what it replaces frees nothing; rung 3's "whatever
      // its size" is about reaching small results, not about growing them.
      if (marker === null || marker.length >= size) continue;
      output.value = marker as never;
      replaced += 1;
    }
  }
  return replaced;
}

/**
 * Content-bearing tool args are elided too (§20.6).
 *
 * A tool whose job is to *store* an artifact carries it in an argument, and the
 * §20.4 pass never looks at arguments — so a 30kb `embeds.create` would ride
 * every subsequent turn of the conversation. The artifact was already paid for
 * once as output tokens; paying for it again as context, forever, is the whole
 * problem. Declared fields are therefore replaced the moment the call has run.
 *
 * The replacement is copy-on-write rather than a mutation of the argument
 * object: the trace row for this call holds a reference to the same object
 * (`MemoryTraceSink` keeps it live), and the trace must keep the originals.
 * The transcript entry itself is still edited in place, so the prefix reprocess
 * is paid once.
 *
 * Returns the fields actually stubbed on this pass — empty when they were
 * already stubbed, which is what makes repeated passes monotonic.
 */
export function stubBulkArgs(
  messages: ModelMessage[],
  toolCallId: string,
  fields: readonly string[],
): string[] {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i]!;
    if (message.role !== 'assistant' || !Array.isArray(message.content)) continue;
    for (const part of message.content) {
      if (part.type !== 'tool-call' || part.toolCallId !== toolCallId) continue;
      const input = part.input;
      // Malformed calls never reach the transcript as calls, so anything that
      // is not an object here is a shape we did not write.
      if (typeof input !== 'object' || input === null || Array.isArray(input)) return [];
      const record = input as Record<string, unknown>;
      const stubbed: string[] = [];
      const next: Record<string, unknown> = { ...record };
      for (const field of fields) {
        const value = record[field];
        if (value === undefined || isStoredMarker(value)) continue;
        next[field] = storedMarker(serializedLength(value));
        stubbed.push(field);
      }
      if (stubbed.length) part.input = next;
      return stubbed;
    }
  }
  return [];
}
