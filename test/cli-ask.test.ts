import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FakeLlama } from './fake-llama.js';
import { runCli as turminder, tmpDir, write } from './helpers.js';

describe('turminder ask (phase 1 exit criteria)', () => {
  let t: { dir: string; cleanup: () => void };
  let fake: FakeLlama;
  let root: string;

  beforeEach(async () => {
    t = tmpDir('turminder-ask-');
    root = path.join(t.dir, 'home');
    fake = new FakeLlama();
    const url = await fake.startV1();
    await turminder(['--data-dir', root, 'doctor']);
    write(
      path.join(root, 'config', 'models.yaml'),
      `endpoints:\n  - name: main\n    url: ${url}\n    classes: [fast, best]\n    caps: [json, tools]\n    context_size: 32768\n`,
    );
  });
  afterEach(async () => {
    await fake.stop();
    t.cleanup();
  });

  it('streams a completion through the scheduler', async () => {
    fake.always({ text: 'The capital of Norway is Oslo.' });
    const r = await turminder(['--data-dir', root, 'ask', 'what is the capital of Norway?']);
    expect(r.code).toBe(0);
    expect(r.stdout.trim()).toBe('The capital of Norway is Oslo.');
    expect(fake.requests.at(-1)?.body.stream).toBe(true);
  });

  it('reports the trace on request, including queue wait', async () => {
    fake.always({ text: 'traced', usage: { prompt: 33, completion: 2 } });
    const r = await turminder(['--data-dir', root, 'ask', '--trace', 'hello']);
    expect(r.code).toBe(0);
    const json = JSON.parse(r.stderr.slice(r.stderr.indexOf('{')));
    expect(json.endpoint).toBe('main');
    expect(json.tokens).toEqual({ in: 33, out: 2 });
    expect(json.llm_calls[0].queue_wait_ms).toBe(0);
    expect(json.llm_calls[0].priority).toBe('interactive');
  });

  it('honours --no-stream and --priority', async () => {
    fake.always({ text: 'buffered' });
    const r = await turminder([
      '--data-dir',
      root,
      'ask',
      '--no-stream',
      '--priority',
      'background',
      '--trace',
      'hi',
    ]);
    expect(r.stdout.trim()).toBe('buffered');
    expect(fake.requests.at(-1)?.body.stream).toBeUndefined();
    expect(r.stderr).toContain('"priority": "background"');
  });

  it('refuses an unknown priority', async () => {
    const r = await turminder(['--data-dir', root, 'ask', '--priority', 'urgent', 'hi']);
    expect(r.code).toBe(1);
    expect(r.stdout + r.stderr).toMatch(/bad_option/);
  });

  it('explains itself when no models are configured', async () => {
    const other = path.join(t.dir, 'unconfigured');
    const r = await turminder(['--data-dir', other, 'ask', 'hello?']);
    expect(r.code).toBe(1);
    expect(r.stdout + r.stderr).toMatch(/models_unconfigured/);
  });

  it('exits non-zero when the run hits a budget wall', async () => {
    fake.always({ errorStatus: 500 });
    const r = await turminder(['--data-dir', root, 'ask', 'hello?']);
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/stopped: error/);
  });
});
