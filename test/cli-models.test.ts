import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runCli as turminder, tmpDir, write } from './helpers.js';
import { ROUTABLE_PURPOSES } from '../src/model/routes.js';

/** `turminder models` (§10.6): the endpoint table plus the purpose table. */
describe('turminder models', () => {
  let t: { dir: string; cleanup: () => void };
  let root: string;

  beforeEach(async () => {
    t = tmpDir('turminder-models-cli-');
    root = path.join(t.dir, 'home');
    await turminder(['--data-dir', root, 'doctor']);
    write(
      path.join(root, 'config', 'models.yaml'),
      `endpoints:
  - name: quick
    url: http://a/v1
    classes: [fast]
    caps: [json]
  - name: big
    url: http://b/v1
    classes: [best]
    caps: [json, tools]
  - name: emb
    url: http://c
    kind: embedding
  - name: whisper
    url: http://d/v1
    kind: stt
    model: large-v3
    language: nb
  - name: piper
    url: http://e/v1
    kind: tts
    model: tts-1
    voice: alloy
    cost: { per_kchar: 0.015, currency: USD }
routes:
  handler: { endpoint: quick }
`,
    );
  });
  afterEach(() => t.cleanup());

  function purposeLine(stdout: string, purpose: string): string {
    const line = stdout.split('\n').find((l) => l.trim().startsWith(`${purpose} `));
    if (!line) throw new Error(`no line for purpose "${purpose}" in:\n${stdout}`);
    return line;
  }

  it('shows a kind column on the endpoint table', async () => {
    const r = await turminder(['--data-dir', root, 'models']);
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/NAME\s+KIND/);
    expect(r.stdout).toMatch(/emb\s+embedding/);
    expect(r.stdout).toMatch(/quick\s+chat/);
  });

  it('prints every routable purpose exactly once', async () => {
    const r = await turminder(['--data-dir', root, 'models']);
    for (const purpose of ROUTABLE_PURPOSES) {
      const lines = r.stdout.split('\n').filter((l) => l.trim().startsWith(`${purpose} `));
      expect(lines, purpose).toHaveLength(1);
    }
  });

  it('shows source=config for a route the file sets, source=default otherwise', async () => {
    const r = await turminder(['--data-dir', root, 'models']);
    expect(purposeLine(r.stdout, 'handler')).toContain('source=config');
    expect(purposeLine(r.stdout, 'handler')).toContain('→ quick');
    expect(purposeLine(r.stdout, 'chat')).toContain('source=default');
    expect(purposeLine(r.stdout, 'chat')).toContain('→ big');
  });

  it('resolves embedding to the first kind: embedding endpoint with no configured route', async () => {
    const r = await turminder(['--data-dir', root, 'models']);
    const line = purposeLine(r.stdout, 'embedding');
    expect(line).toContain('source=default');
    expect(line).toContain('→ emb');
  });

  it('lists the speech kinds with their voice and language in the note column (§10.9)', async () => {
    const r = await turminder(['--data-dir', root, 'models']);
    expect(r.stdout).toMatch(/NAME\s+KIND/);
    expect(r.stdout).toMatch(/NOTE/);
    expect(r.stdout).toMatch(/whisper\s+stt/);
    expect(r.stdout).toMatch(/piper\s+tts/);
    // Priced in its own unit, not per Mtok (§10.9).
    expect(r.stdout).toContain('0.015 USD per kchar');
    expect(r.stdout).toContain('language=nb');
    expect(r.stdout).toMatch(/piper.*alloy/);
  });

  it('resolves stt and tts to the first endpoint of the kind', async () => {
    const r = await turminder(['--data-dir', root, 'models']);
    expect(purposeLine(r.stdout, 'stt')).toContain('source=default');
    expect(purposeLine(r.stdout, 'stt')).toContain('→ whisper');
    expect(purposeLine(r.stdout, 'tts')).toContain('→ piper');
  });

  it('says (none) for a kind this install has no endpoint for', async () => {
    write(
      path.join(root, 'config', 'models.yaml'),
      `endpoints:
  - name: quick
    url: http://a/v1
    classes: [fast, best]
`,
    );
    const r = await turminder(['--data-dir', root, 'models']);
    expect(purposeLine(r.stdout, 'stt')).toContain('→ (none)');
    expect(purposeLine(r.stdout, 'tts')).toContain('→ (none)');
  });
});
