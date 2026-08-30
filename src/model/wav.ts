/**
 * The one WAV header reader (§10.9, §33.2). Speech endpoints speak RIFF at
 * both ends: the transcriber is billed by the second and the probe has to know
 * a real recording from a 200 that contains an error page, so somebody has to
 * parse the header — and doing it in three places is how the three quietly
 * disagree.
 *
 * Deliberately minimal: enough of RIFF to answer "is this WAV, at what rate,
 * and how long", not a decoder. It never throws — a malformed body is `null`,
 * which every caller already has to handle for "the endpoint answered with
 * something else entirely".
 */

/** Sizes RIFF writes when it does not know yet — a streaming encoder's header
 *  (openedai-speech writes exactly this). Never a real length. */
const UNKNOWN_SIZE = 0xffffffff;

export interface WavInfo {
  /** 1 = PCM. Anything else is a format this system does not claim to measure. */
  format: number;
  channels: number;
  sampleRate: number;
  bitsPerSample: number;
  /** Byte offset of the first sample. */
  dataOffset: number;
  /**
   * Sample bytes actually present — the `data` chunk's declared size, or what
   * is left in the buffer when the writer declared `0xFFFFFFFF` because it was
   * still generating. The declared size is never trusted past the buffer's end.
   */
  dataBytes: number;
  /** Duration of `dataBytes` at this rate. */
  seconds: number;
}

/** Parse a RIFF/WAVE header. `null` when the bytes are not a WAV this system
 *  can measure — no `fmt ` chunk, no `data` chunk, or not RIFF at all. */
export function readWavHeader(buf: Uint8Array): WavInfo | null {
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const tag = (at: number): string =>
    at + 4 <= buf.length
      ? String.fromCharCode(buf[at]!, buf[at + 1]!, buf[at + 2]!, buf[at + 3]!)
      : '';
  if (buf.length < 12 || tag(0) !== 'RIFF' || tag(8) !== 'WAVE') return null;

  let format = 0;
  let channels = 0;
  let sampleRate = 0;
  let bitsPerSample = 0;
  let haveFmt = false;
  let off = 12;
  while (off + 8 <= buf.length) {
    const id = tag(off);
    const size = view.getUint32(off + 4, true);
    const body = off + 8;
    if (id === 'fmt ' && body + 16 <= buf.length) {
      format = view.getUint16(body, true);
      channels = view.getUint16(body + 2, true);
      sampleRate = view.getUint32(body + 4, true);
      bitsPerSample = view.getUint16(body + 14, true);
      haveFmt = true;
    } else if (id === 'data') {
      if (!haveFmt || !channels || !sampleRate || !bitsPerSample) return null;
      const available = buf.length - body;
      const dataBytes = size === UNKNOWN_SIZE ? available : Math.min(size, available);
      const bytesPerSecond = sampleRate * channels * (bitsPerSample / 8);
      return {
        format,
        channels,
        sampleRate,
        bitsPerSample,
        dataOffset: body,
        dataBytes,
        seconds: bytesPerSecond > 0 ? dataBytes / bytesPerSecond : 0,
      };
    }
    if (size === UNKNOWN_SIZE) return null; // an unknown length on anything but `data` is unwalkable
    off = body + size + (size % 2); // RIFF chunks are word-aligned
  }
  return null;
}

/** Seconds of audio in a WAV body, or 0 when the bytes are not measurable —
 *  used for the `audio_s` a transcription is priced and traced by (§10.9). */
export function wavSeconds(buf: Uint8Array): number {
  return readWavHeader(buf)?.seconds ?? 0;
}
