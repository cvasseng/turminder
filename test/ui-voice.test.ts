import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The two voice-shaped things in the chat page (§33.5, §33.1), guarded from
 * the source — `ui/app.js` is a browser script with no build step and no
 * exports by design, so reading it is the only side a vitest suite reaches
 * (the `ui-usage` precedent).
 */
const root = path.resolve(import.meta.dirname, '..');
const js = fs.readFileSync(path.join(root, 'ui', 'app.js'), 'utf8');
const css = fs.readFileSync(path.join(root, 'ui', 'style.css'), 'utf8');

function functionSource(name: string): string {
  const start = js.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`ui/app.js should declare ${name}()`);
  const end = js.indexOf('\n}\n', start);
  if (end < 0) throw new Error(`${name}() should end at a top-level brace`);
  return js.slice(start, end + 2);
}

describe('the voice form field (D.5, §33.5)', () => {
  const preview = functionSource('voicePreviewButton');

  it('renders a `voice` field as a select with a play button', () => {
    // Same element as a select, so a surface that cannot play audio still
    // renders a usable field (D.5).
    expect(js).toContain("field.type === 'select' || field.type === 'voice'");
    expect(js).toContain(
      "if (field.type === 'voice') preview = voicePreviewButton(input, status)",
    );
  });

  it('fetches the preview route with the device token and plays what comes back', () => {
    expect(preview).toContain('/api/voice/preview?voice=');
    expect(preview).toContain('encodeURIComponent(select.value)');
    // The same bearer every other authenticated fetch in this page uses.
    expect(preview).toContain('authorization: `Bearer ${token()}`');
    expect(preview).toContain('URL.createObjectURL');
    expect(preview).toContain('new Audio(url)');
  });

  it('disables the button while it plays, and never leaves it stuck', () => {
    expect(preview).toContain('button.disabled = true');
    // Re-enabled on `ended`, on `error`, on a non-200, and on a throw — four
    // exits, because a button stuck disabled is worse than a silent preview.
    expect(preview.match(/button\.disabled = false/g)?.length).toBeGreaterThanOrEqual(3);
    expect(preview).toContain("audio.addEventListener('ended'");
    expect(preview).toContain("audio.addEventListener('error'");
  });

  it('revokes the object URL rather than leaking one per press', () => {
    expect(preview).toContain('URL.revokeObjectURL');
  });

  it('shows the server error message inline rather than a bare status', () => {
    expect(preview).toContain('body.message ||');
  });
});

describe('the voice conversation label (§33.1)', () => {
  it('marks a voice row with a mic glyph naming the device', () => {
    expect(js).toContain("if (c.mode === 'voice')");
    expect(js).toContain("iconSvg('mic')");
    expect(js).toContain('spoken from ${c.voice_device}');
    expect(css).toContain('.conv-mic');
  });
});

/**
 * The chat UI as a voice client (§33.6): a mic button in `#composer`. There
 * is no browser here, so these guard the source rather than an actual
 * recording — the two failures that would quietly break the feature are a
 * control shown where it cannot work, and a recording sent in a format the
 * server never accepts.
 */
const html = fs.readFileSync(path.join(root, 'ui', 'index.html'), 'utf8');

describe('the mic button exists only where it can work (§24.4, §33.6)', () => {
  it('is hidden in markup, not disabled', () => {
    const button = /<button[^>]*id="mic"[^>]*>/.exec(html)?.[0] ?? '';
    expect(button, 'index.html should carry #mic').not.toBe('');
    expect(button).toContain('hidden');
    expect(button).not.toContain('disabled');
    expect(button).toContain('data-icon="mic"');
  });

  it('is revealed only in a secure context with a microphone to ask for', () => {
    const guard = js.slice(js.indexOf('if (isSecureContext && navigator.mediaDevices'));
    const line = guard.slice(0, guard.indexOf('\n'));
    expect(line).toContain('isSecureContext');
    expect(line).toContain('navigator.mediaDevices');
    expect(line).toContain('window.MediaRecorder');
    const body = guard.slice(0, guard.indexOf('\n}'));
    expect(body).toContain("$('mic').hidden = false");
  });

  it('toggles recording on click rather than needing a press held down', () => {
    const guard = js.slice(js.indexOf('if (isSecureContext && navigator.mediaDevices'));
    const onclick = guard.slice(guard.indexOf('.onclick = () => {'));
    expect(onclick).toContain('if (state.voice.recorder) stopRecording()');
    expect(onclick).toContain('else void startRecording()');
  });
});

describe('a recording is re-encoded before it is sent (§33.2, §33.6)', () => {
  it("never sends what MediaRecorder actually produced — only 'audio/wav'", () => {
    expect(js).toContain(
      "headers: { authorization: `Bearer ${token()}`, 'content-type': 'audio/wav' }",
    );
    // `toVoiceWav` is what stands between the recording and the fetch: no
    // path posts `rawBlob` (the MediaRecorder output) directly.
    const send = functionSource('sendRecording');
    expect(send).toContain('await toVoiceWav(rawBlob)');
    expect(send).not.toMatch(/body:\s*rawBlob/);
  });

  it('decodes, downmixes and resamples to 16 kHz mono before writing a WAV header', () => {
    const toWav = functionSource('toVoiceWav');
    expect(toWav).toContain('decodeAudioData');
    expect(toWav).toContain('downmixToMono(audioBuffer)');
    expect(toWav).toContain('resampleLinear(mono, audioBuffer.sampleRate, 16000)');
    expect(toWav).toContain('encodeWav(');
  });

  it('writes a real RIFF/WAVE header, not a bare PCM dump', () => {
    const encode = functionSource('encodeWav');
    for (const chunk of ["'RIFF'", "'WAVE'", "'fmt '", "'data'"]) {
      expect(encode).toContain(chunk);
    }
    expect(encode).toContain("type: 'audio/wav'");
  });

  it('closes the audio context and stops the mic tracks rather than leaking them', () => {
    expect(functionSource('toVoiceWav')).toMatch(/finally\s*\{\s*void ctx\.close\(\)/);
    const start = functionSource('startRecording');
    expect(start).toContain('for (const track of stream.getTracks()) track.stop()');
  });
});

describe('every /api/voice status is a human sentence (App. E, §33.6)', () => {
  const mapper = functionSource('voiceErrorMessage');

  it('covers every error the route can answer', () => {
    for (const code of [
      'too_long',
      'unsupported_media_type',
      'nothing_heard',
      'speech_failed',
      'no_speech_endpoint',
    ]) {
      expect(mapper, code).toContain(`case '${code}':`);
    }
  });

  it('falls back to the server message, then the status, rather than going silent', () => {
    expect(mapper).toContain('body?.message || `voice request failed: HTTP ${status}`');
  });

  it('shows the mapped message as a transcript error, not a native alert', () => {
    const send = functionSource('sendRecording');
    expect(send).toContain("addMessage('error', voiceErrorMessage(res.status, body), 'error')");
    expect(send).not.toContain('alert(');
  });

  it('reports a network failure and a microphone refusal the same honest way', () => {
    const send = functionSource('sendRecording');
    expect(send).toMatch(
      /catch \(e\) \{\s*addMessage\('error', `voice request failed: \$\{e\.message\}`/,
    );
    const start = functionSource('startRecording');
    expect(start).toContain(
      "addMessage('error', `couldn't reach the microphone: ${e.message}`",
    );
  });
});

describe('a reply lands in its conversation, not just in the speaker (§33.1, §33.6)', () => {
  it('reads both headers off the response before switching', () => {
    const send = functionSource('sendRecording');
    expect(send).toContain("res.headers.get('x-turminder-conversation')");
    expect(send).toContain("decodeRfc8187(res.headers.get('x-turminder-transcript'))");
  });

  it('switches conversation the same way an out-of-band chat.accepted already does', () => {
    const send = functionSource('sendRecording');
    expect(send).toContain('selectConversation(conversationId)');
    expect(send).toContain('refreshConversations()');
  });

  it('plays the reply like the voice-field preview already does (§33.5)', () => {
    const send = functionSource('sendRecording');
    expect(send).toContain('URL.createObjectURL(await res.blob())');
    expect(send).toContain('new Audio(url)');
    expect(send).toContain('URL.revokeObjectURL(url)');
  });
});
