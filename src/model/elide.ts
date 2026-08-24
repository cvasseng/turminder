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

export function storedMarker(chars: number): string {
  return (
    `${STORED_PREFIX} ${chars} chars — the content was written and is stored. ` +
    `Read it back with the tool if needed. Never copy this marker into a tool call]]`
  );
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
 */
export function elideStaleResults(
  messages: ModelMessage[],
  settings: ElisionSettings,
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
      const output = part.output;
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
