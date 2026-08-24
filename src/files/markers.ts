import crypto from 'node:crypto';

/** Lines of context either side of a marker in a `file.request` payload (App. B). */
export const MARKER_CONTEXT_LINES = 10;

export interface MarkerHit {
  /** 1-based, as an editor counts. */
  line: number;
  text: string;
  context: string;
  /** sha256(path + normalized line) — the idempotency key (§18.4). */
  key: string;
}

/**
 * Normalise a marker line so that re-saving, re-indenting, moving, or ticking
 * the box in front of it is the *same* line. Only genuinely new text is a new
 * request — the whole point of tier 2 being idempotent on content rather than
 * on position.
 */
export function normaliseMarkerLine(line: string): string {
  return line
    .replace(/^\s*(?:[-*+]|\d+[.)])?\s*(?:\[[ xX~/-]\])?\s*/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function keyFor(filePath: string, line: string): string {
  return crypto
    .createHash('sha256')
    .update(`${filePath}\n${normaliseMarkerLine(line)}`)
    .digest('hex');
}

/**
 * Marker extraction, in code (§18.4 tier 2). Scans the lines that are new or
 * changed relative to the previous snapshot — a file full of old markers that
 * gets re-saved produces nothing, which is what keeps an autosaving editor from
 * becoming an event source.
 */
export function extractMarkers(
  filePath: string,
  previous: string | null,
  current: string,
  markers: readonly string[],
): MarkerHit[] {
  if (!markers.length) return [];
  const lines = current.split('\n');
  const seen = new Set(
    (previous ?? '')
      .split('\n')
      .map(normaliseMarkerLine)
      .filter((l) => l.length > 0),
  );

  const hits: MarkerHit[] = [];
  const emitted = new Set<string>();
  lines.forEach((line, i) => {
    if (!markers.some((m) => line.includes(m))) return;
    const normalised = normaliseMarkerLine(line);
    if (!normalised || seen.has(normalised)) return;
    const key = keyFor(filePath, line);
    // The same new line twice in one file is one request.
    if (emitted.has(key)) return;
    emitted.add(key);
    hits.push({
      line: i + 1,
      text: line.trim(),
      context: lines
        .slice(Math.max(0, i - MARKER_CONTEXT_LINES), i + MARKER_CONTEXT_LINES + 1)
        .join('\n'),
      key,
    });
  });
  return hits;
}
