import { stripReservedMarkers } from '../core/markers.js';
import type { Delivery } from '../db/repos/deliveries.js';

/**
 * What a delivery sounds like (§33.3).
 *
 * **The server composes every word.** A `voice` device asks for a delivery by
 * id and gets audio back; it never assembles the sentence itself and it never
 * sends text to be spoken. That is the same rule §14.2 applies to a confirm's
 * title — a client that writes the words is a client that can be made to say
 * anything.
 */
export function spokenForm(delivery: Delivery): string {
  const p = delivery.payload as {
    title?: unknown;
    body?: unknown;
    spoken?: unknown;
    args_summary?: unknown;
  };
  const title = text(p.title);

  if (delivery.intent === 'confirm') {
    // Composed entirely here, from the fields D.3 already fills: the title
    // names who wants what, `args_summary` is `details` as one plain block —
    // and neither can carry a secret, which is why this may be spoken aloud.
    const parts = [title, text(p.args_summary), 'Approve or deny on a screen.'];
    return join(parts);
  }

  // A handler that supplied one knows the difference between what to read and
  // what to hear: "Invoice from Hafslund, two thousand three hundred kroner,
  // due Friday — filed under bills" is not the three-line body it wrote.
  const spoken = text(p.spoken);
  if (spoken) return spoken;
  return join([title, text(p.body)]);
}

/** A field, as speakable prose: never `JSON.stringify`, never a marker. */
function text(value: unknown): string {
  if (typeof value !== 'string') return '';
  return stripReservedMarkers(value).replace(/\s+/g, ' ').trim();
}

/** Sentences, each ending in punctuation so a synthesiser pauses between them. */
function join(parts: string[]): string {
  return parts
    .filter(Boolean)
    .map((s) => (/[.!?…]$/.test(s) ? s : `${s}.`))
    .join(' ');
}
