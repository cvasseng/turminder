import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { STT_FIXTURE_TXT, STT_FIXTURE_WAV } from '../src/model/probe.js';
import { readWavHeader } from '../src/model/wav.js';

/**
 * The `stt` probe's stimulus, walked byte by byte (§10.2, §10.9).
 *
 * This is the green-PNG lesson transplanted: that fixture once shipped with a
 * corrupt IDAT CRC, a sighted endpoint honestly reported the smear it saw, and
 * a working model was tagged blind for two days. **A probe validates its own
 * stimulus** — if this clip is silence, or 44 100 Hz, or truncated, then every
 * transcriber in the world fails the probe and the config written is a lie
 * about the wrong party. Nothing here decodes audio; a header walk is the
 * honest check that needs no decoder in CI.
 */
describe('the stt probe fixture (§10.9, V1.5)', () => {
  const wav = fs.readFileSync(STT_FIXTURE_WAV);

  it('is a 16 kHz mono 16-bit PCM WAV', () => {
    const info = readWavHeader(wav);
    expect(info).not.toBeNull();
    expect(info).toMatchObject({
      format: 1, // PCM, not a compressed payload wearing a WAV hat
      channels: 1,
      sampleRate: 16_000,
      bitsPerSample: 16,
    });
  });

  it('declares exactly the samples it carries', () => {
    const info = readWavHeader(wav)!;
    // Not `0xFFFFFFFF` and not a lie: the checked-in file is complete, unlike
    // the streaming bodies a live synthesiser sends (JUDGMENT, 2026-08-30).
    expect(wav.readUInt32LE(info.dataOffset - 4)).toBe(info.dataBytes);
    expect(info.dataOffset + info.dataBytes).toBe(wav.length);
    expect(wav.readUInt32LE(4)).toBe(wav.length - 8); // RIFF size
  });

  it('is between half a second and four seconds of speech, and small', () => {
    const info = readWavHeader(wav)!;
    expect(info.seconds).toBeGreaterThan(0.5);
    expect(info.seconds).toBeLessThan(4);
    expect(wav.length).toBeLessThanOrEqual(100_000);
  });

  it('is not silence', () => {
    // A clip of nothing would pass every structural check above and fail every
    // endpoint that works. Peak amplitude is the cheapest proof there is sound.
    let peak = 0;
    const info = readWavHeader(wav)!;
    for (let at = info.dataOffset; at + 1 < wav.length; at += 2) {
      peak = Math.max(peak, Math.abs(wav.readInt16LE(at)));
    }
    expect(peak).toBeGreaterThan(2000);
  });

  it('ships the transcript it is scored against', () => {
    const text = fs.readFileSync(STT_FIXTURE_TXT, 'utf8').trim();
    expect(text).toBe('Turminder is ready to help you today.');
    // Seven words, and the probe's 80% threshold tolerates exactly one miss —
    // which is always "Turminder", an invented name no transcriber has heard.
    expect(text.split(/\s+/)).toHaveLength(7);
  });
});
