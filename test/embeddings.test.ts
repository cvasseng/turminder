import { afterEach, describe, expect, it } from 'vitest';
import { EmbeddingClient } from '../src/rag/embeddings.js';
import { InferenceScheduler } from '../src/model/scheduler.js';
import { FakeLlama } from './fake-llama.js';

/**
 * `EmbeddingClient` (§8.3, §10.6 v2): the `embedding` purpose's endpoint,
 * which may be absent (lexical fallback), and is reconfigured — not
 * rebuilt — when models.yaml reloads.
 */
describe('EmbeddingClient', () => {
  let fake: FakeLlama | null = null;
  afterEach(async () => {
    await fake?.stop();
    fake = null;
  });

  it('with no endpoint, reports unavailable and embeds nothing — no network call', async () => {
    const client = new EmbeddingClient(null, new InferenceScheduler(1));
    expect(client.url).toBeNull();
    expect(await client.available()).toBe(false);
    expect(await client.embed(['x'])).toEqual([]);
  });

  it('strips a trailing /v1 so both url forms name the same server (G.2)', async () => {
    fake = new FakeLlama();
    const base = await fake.startV1();
    const root = base.replace(/\/v1$/, '');

    const withV1 = new EmbeddingClient(
      { url: base, model: 'default' },
      new InferenceScheduler(1),
    );
    const withoutV1 = new EmbeddingClient(
      { url: root, model: 'default' },
      new InferenceScheduler(1),
    );
    expect(withV1.url).toBe(root);
    expect(withoutV1.url).toBe(root);
    expect(await withV1.available()).toBe(true);
    expect(await withoutV1.available()).toBe(true);
  });

  it('reconfigure resets availability so a changed endpoint is re-probed', async () => {
    fake = new FakeLlama();
    const base = await fake.startV1();
    const client = new EmbeddingClient(
      { url: base, model: 'default' },
      new InferenceScheduler(1),
    );
    expect(await client.available()).toBe(true);

    // Availability is cached until something resets it.
    fake.embeddings = false;
    expect(await client.available()).toBe(true);

    client.reconfigure({ url: base, model: 'default' });
    expect(await client.available()).toBe(false);

    fake.embeddings = true;
    client.reconfigure({ url: base, model: 'default' });
    expect(await client.available()).toBe(true);
  });

  it('reconfigure to null degrades to lexical fallback, cleanly', async () => {
    fake = new FakeLlama();
    const base = await fake.startV1();
    const client = new EmbeddingClient(
      { url: base, model: 'default' },
      new InferenceScheduler(1),
    );
    expect(await client.available()).toBe(true);

    client.reconfigure(null);
    expect(client.url).toBeNull();
    expect(await client.available()).toBe(false);
    expect(await client.embed(['x'])).toEqual([]);
  });
});
