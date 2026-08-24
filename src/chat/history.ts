import type { ModelMessage } from 'ai';
import { imageMarker, stripReservedMarkers, usedToolsMarker } from '../core/markers.js';
import type { Turn, TurnAttachment } from '../db/repos/conversations.js';

/**
 * How attachments enter a prompt (§26.3). `read` returns the bytes for an
 * image part; returning null (reaped, missing) degrades that one attachment to
 * its marker rather than failing the turn. `window` is how many of the most
 * recent user turns keep their image parts — older ones become markers, which
 * is §20.4-style monotonic elision: a function of turn age, so it never
 * flip-flops back and the prefix stays cache-stable from that point on.
 */
export interface ImageContext {
  read(attachment: TurnAttachment): Buffer | null;
  window: number;
}

/**
 * Conversation history as model context (§20.2). Composed at read time from
 * `contextText` — the final answer of each run — with a single marker naming
 * the tools that were used. Continuity without payloads: the model knows it
 * looked something up without re-reading what came back.
 *
 * The marker is `[[used tools: …]]`, in the system voice of §20.8, and that is
 * the load-bearing detail. The prose form this once used — `(used tools: …)` —
 * read as something the assistant could have written, so the model learned to
 * write it: four turns narrated file appends it never called. Anything rendered
 * into history in the system's voice must look like the system's voice.
 *
 * `text` (the display transcript) is deliberately never rendered here. It holds
 * every "let me check…" the user watched stream, and re-feeding those is how a
 * conversation's prompt grows narration it will never need again.
 */
/** How one turn's attachments enter the prompt (§26.3). */
export type AttachmentMode =
  /** In the window, on a vision endpoint: the bytes ride as image parts. */
  | { kind: 'attach'; images: ImageContext }
  /** Older than the window: the picture is gone, the fact of it is not. */
  | { kind: 'elided' }
  /** No vision-capable endpoint at all: the model is told it cannot see. */
  | { kind: 'no_vision' };

export function toModelMessage(turn: Turn, mode?: AttachmentMode): ModelMessage {
  // Legacy sanitation (§20.2): turns persisted before the §20.8 guard can carry
  // a fabricated prefix inside their stored text. Poisoned history has to stop
  // teaching the pattern, so it is stripped on the way into the prompt — new
  // rows never need this, because persistence is fenced.
  if (turn.role === 'user') {
    const text = stripReservedMarkers(turn.text);
    if (!turn.attachments.length) return { role: 'user', content: text };
    return {
      role: 'user',
      content: userParts(text, turn.attachments, mode ?? { kind: 'no_vision' }),
    };
  }
  const used = turn.toolsUsed.length ? `${usedToolsMarker(turn.toolsUsed)}\n` : '';
  return { role: 'assistant', content: `${used}${stripReservedMarkers(turn.contextText)}` };
}

type UserPart =
  { type: 'text'; text: string } | { type: 'image'; image: Buffer; mediaType: string };

/**
 * A user message carrying images. The bytes are read here, by the server, and
 * put in an image part — never described, never base64'd into text (§26: the
 * anti-telephone rule). What the model cannot see says so in a marker instead,
 * naming which of the two reasons applies, because "you had this and it
 * scrolled off" and "you cannot see pictures at all" call for different
 * behaviour from the model.
 */
function userParts(
  text: string,
  attachments: readonly TurnAttachment[],
  mode: AttachmentMode,
): UserPart[] {
  const parts: UserPart[] = [];
  const markers: string[] = [];
  for (const attachment of attachments) {
    const bytes = mode.kind === 'attach' ? mode.images.read(attachment) : null;
    if (bytes) {
      parts.push({ type: 'image', image: bytes, mediaType: attachment.mime });
      continue;
    }
    // A reaped or missing file in the window is "gone", not "no vision here".
    markers.push(
      imageMarker(attachment.name, mode.kind === 'no_vision' ? 'no_vision' : 'elided'),
    );
  }
  const body = [text, ...markers].filter((line) => line.trim()).join('\n');
  return [{ type: 'text', text: body }, ...parts];
}

export function toModelMessages(turns: Turn[], images?: ImageContext | null): ModelMessage[] {
  // An assistant turn with nothing to say adds a blank message and confuses
  // some chat templates; drop it rather than feed an empty assistant turn.
  // The emptiness test runs on the sanitised text: a legacy turn whose whole
  // stored content was the fabricated line has nothing left to say.
  // Which user turns still carry their pictures: the last `window` **user
  // turns**, counted from the end — not the last `window` turns that happen to
  // have images (§26.3). Counting only image-bearing turns would keep a lone
  // screenshot in context forever, which is the opposite of the intent. The
  // window is a function of position, so a given turn only ever goes from
  // "image" to "marker" as the conversation grows: monotonic, cache-stable.
  const userTurns = turns.filter((t) => t.role === 'user');
  const keep = new Set(
    images ? userTurns.slice(-Math.max(0, images.window)).map((t) => t.seq) : [],
  );
  const modeFor = (turn: Turn): AttachmentMode => {
    if (!images) return { kind: 'no_vision' };
    return keep.has(turn.seq) ? { kind: 'attach', images } : { kind: 'elided' };
  };
  return turns
    .filter(
      (t) =>
        t.role === 'user' || stripReservedMarkers(t.contextText).trim() || t.toolsUsed.length,
    )
    .map((t) => toModelMessage(t, modeFor(t)));
}
