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
