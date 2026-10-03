import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { write } from './helpers.js';
import { bootService, TestClient, type ServiceHarness } from './service-harness.js';

/**
 * §20.11 as the chat executor applies it: the verbatim banners and run errors,
 * and an observed window landing in `meta` (never in config) and in the usage
 * frame. The harness endpoint is configured with `context_size: 32768`.
 */

const VLLM_16K = JSON.stringify({
  object: 'error',
  message:
    "This model's maximum context length is 16384 tokens. However, you requested " +
    '20000 tokens. Please reduce the length of the messages or completion.',
  type: 'BadRequestError',
  code: 400,
});

/**
 * A 32k endpoint that counts what it is sent (3.5 characters a token),
 * refuses anything over its window the way vllm does, and reports the prompt
 * it counted — streamed or not — so `context_full` here comes from a working
 * set that genuinely does not fit, not from a scripted number.
 */
function countingFetch(window = 32768): {
  fetch: typeof globalThis.fetch;
  refused: () => number;
} {
  let refused = 0;
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url =
      typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (!url.endsWith('/chat/completions')) return globalThis.fetch(input, init);
    const body = JSON.parse(String(init?.body ?? '{}'));
    const prompt = Math.ceil(
      JSON.stringify({ messages: body.messages, tools: body.tools }).length / 3.5,
    );
    if (prompt + (body.max_tokens ?? 0) > window) {
      refused += 1;
      return new Response(
        JSON.stringify({
          object: 'error',
          message: `This model's maximum context length is ${window} tokens. However, your prompt contains at least ${prompt} input tokens.`,
          type: 'BadRequestError',
          code: 400,
        }),
        { status: 400, headers: { 'content-type': 'application/json' } },
      );
    }
    const res = await globalThis.fetch(input, init);
    const text = (await res.text()).replace(
      /"prompt_tokens":\d+/g,
      `"prompt_tokens":${prompt}`,
    );
    return new Response(text, { status: res.status, headers: res.headers });
  };
  return { fetch, refused: () => refused };
}

describe('the window budget in chat (§20.11, §9)', () => {
  let h: ServiceHarness;
  afterEach(async () => {
    await h?.cleanup();
  });

  it('ends context_full with the verbatim banner, keeping what was said', async () => {
    // A long pasted message (~25k tokens with the base prompt and tools), then
    // a 19k-character file read: the latest round, which no rung touches, and
    // with it there is no room left to answer.
    const server = countingFetch();
    h = await bootService({ onboarded: true, gateway: { fetch: server.fetch } });
    h.service.files.write('notes/big.md', 'A line of notes. '.repeat(1120), 'seed');
    const failures: string[] = [];
    h.service.chat.onStream({ failed: (e) => failures.push(e.message) });
    h.fake.script({
      text: 'Looking.',
      toolCalls: [{ name: 'files.read', args: { path: 'notes/big.md' } }],
    });
    const sent = h.service.chat.send({ text: 'Please read this. '.repeat(3600) });
    await h.service.queue.drain();

    const run = h.service.repos.runs.forEvent(sent.eventId)[0]!;
    expect(run.status).toBe('failed');
    expect(run.error).toMatch(/^context window full: \d+ of 32768 tokens$/);
    expect(failures).toEqual([
      "answer cut short (context full) — this run's working set no longer fits the model's 32768-token window",
    ]);
    const turns = h.service.repos.conversations.history(sent.conversationId);
    expect(turns.at(-1)?.text).toBe('Looking.');
    expect(server.refused()).toBe(0);
  });

  it('shows the banner, not the bare run error, when nothing was said', async () => {
    // A message that alone does not fit the window: nothing to compact, so no
    // call is made at all.
    const server = countingFetch();
    h = await bootService({ onboarded: true, gateway: { fetch: server.fetch } });
    const failures: string[] = [];
    h.service.chat.onStream({ failed: (e) => failures.push(e.message) });
    const sent = h.service.chat.send({ text: 'Please read this. '.repeat(6000) });
    await h.service.queue.drain();

    const run = h.service.repos.runs.forEvent(sent.eventId)[0]!;
    expect(run.status).toBe('failed');
    expect(run.error).toMatch(/^context window full: \d+ of 32768 tokens$/);
    expect(failures).toEqual([
      "answer cut short (context full) — this run's working set no longer fits the model's 32768-token window",
    ]);
    expect(h.fake.requests.filter((r) => r.path.endsWith('/chat/completions'))).toHaveLength(0);
    expect(server.refused()).toBe(0);
  });

  it('ends output_cut with the verbatim banner after a second cut', async () => {
    h = await bootService({ onboarded: true });
    const failures: string[] = [];
    h.service.chat.onStream({ failed: (e) => failures.push(e.message) });
    const cut = {
      text: 'Writing it out',
      finishReason: 'length',
      usage: { prompt: 900, completion: 30000 },
    };
    h.fake.script(
      { text: 'Looking.', toolCalls: [{ name: 'memory.query', args: { query: 'x' } }] },
      cut,
      cut,
    );
    const sent = h.service.chat.send({ text: 'write it' });
    await h.service.queue.drain();

    const run = h.service.repos.runs.forEvent(sent.eventId)[0]!;
    expect(run.status).toBe('failed');
    expect(run.error).toBe('output cut off at the context window');
    expect(failures).toEqual([
      "answer cut short (output cut off) — the model's answer ran into its 32768-token window twice",
    ]);
    // The cut text was retracted and is not persisted.
    const turns = h.service.repos.conversations.history(sent.conversationId);
    expect(turns.at(-1)?.text).toBe('Looking.');
  });

  it('learns a refused window into meta, reports it, and leaves models.yaml alone', async () => {
    let refuse = 1;
    h = await bootService({
      onboarded: true,
      gateway: {
        fetch: async (input, init) => {
          const url =
            typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
          if (url.endsWith('/chat/completions') && refuse > 0) {
            refuse -= 1;
            return new Response(VLLM_16K, {
              status: 400,
              headers: { 'content-type': 'application/json' },
            });
          }
          return globalThis.fetch(input, init);
        },
      },
    });
    const usage: { contextSize: number | null }[] = [];
    h.service.chat.onStream({ usage: (e) => usage.push(e) });
    h.fake.script({ text: 'fits' });
    const sent = h.service.chat.send({ text: 'hello' });
    await h.service.queue.drain();

    expect(h.service.repos.runs.forEvent(sent.eventId)[0]!.status).toBe('done');
    expect(h.service.repos.meta.observedContext('main')?.size ?? null).toBe(16384);
    expect(usage.at(-1)?.contextSize).toBe(16384);
    expect(h.app.config.modelsOrNull().models?.endpoints[0]?.context_size).toBe(32768);

    // The next run budgets against the observed size from the start.
    h.fake.script({ text: 'again' });
    h.service.chat.send({ text: 'and again', conversationId: sent.conversationId });
    await h.service.queue.drain();
    expect(h.fake.requests.at(-1)!.body.max_tokens).toBeLessThanOrEqual(16384 - 256);
  });

  /** The fake's `/v1/models`, plus vllm's `max_model_len` on every entry. */
  const vllmListing =
    (size: number): typeof globalThis.fetch =>
    async (input, init) => {
      const res = await globalThis.fetch(input, init);
      const url =
        typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (!url.endsWith('/models')) return res;
      const body = (await res.json()) as { data: Record<string, unknown>[] };
      return new Response(
        JSON.stringify({
          ...body,
          data: body.data.map((m) => ({ ...m, max_model_len: size })),
        }),
        { headers: { 'content-type': 'application/json' } },
      );
    };

  it('records the served length at startup, and models.list reports it (§10.7)', async () => {
    h = await bootService({
      onboarded: true,
      observeContextOnStart: true,
      gateway: { fetch: vllmListing(16384) },
    });
    await h.service.background.drain();

    expect(h.service.repos.meta.observedContext('main')?.size ?? null).toBe(16384);
    expect(h.app.config.modelsOrNull().models?.endpoints[0]?.context_size).toBe(32768);

    const client = await TestClient.connect(h.baseUrl, h.token);
    await client.hello(['chat']);
    client.send('models.list', {});
    const listed = await client.next('models.list.result');
    const main = (listed.payload.endpoints as { name: string; context_size?: number }[]).find(
      (e) => e.name === 'main',
    );
    expect(main?.context_size).toBe(16384);
  });

  it('leaves startup alone unless the serving process asks for the check', async () => {
    h = await bootService({ onboarded: true, gateway: { fetch: vllmListing(16384) } });
    await h.service.background.drain();
    expect(h.service.repos.meta.observedContext('main')?.size ?? null).toBeNull();
    expect(h.fake.requests.some((r) => r.path.endsWith('/models'))).toBe(false);
  });

  it('records nothing at startup when the endpoint does not report a length', async () => {
    h = await bootService({ onboarded: true, observeContextOnStart: true });
    await h.service.background.drain();
    expect(h.service.repos.meta.observedContext('main')?.size ?? null).toBeNull();

    const client = await TestClient.connect(h.baseUrl, h.token);
    await client.hello(['chat']);
    client.send('models.list', {});
    const listed = await client.next('models.list.result');
    const main = (listed.payload.endpoints as { name: string; context_size?: number }[]).find(
      (e) => e.name === 'main',
    );
    expect(main?.context_size).toBe(32768);
  });

  it('records a window a handler run learned, too (§20.11: handlers included)', async () => {
    let refuse = 1;
    h = await bootService({
      onboarded: true,
      gateway: {
        fetch: async (input, init) => {
          const url =
            typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
          const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
          // The handler's call, not ingress's classification (which is JSON-constrained).
          if (url.endsWith('/chat/completions') && !body.response_format && refuse > 0) {
            refuse -= 1;
            return new Response(VLLM_16K, {
              status: 400,
              headers: { 'content-type': 'application/json' },
            });
          }
          return globalThis.fetch(input, init);
        },
      },
    });
    write(
      path.join(h.dataDir, 'handlers', 'note-taker.md'),
      '---\nname: note-taker\ndescription: Use for notes.\n---\n\nAcknowledge the note.\n',
    );
    h.fake.always((req) =>
      req.body.response_format
        ? {
            text: JSON.stringify({
              summary: 'a note',
              verdicts: [{ handler: 'note-taker', matched: true, reason: 'a note' }],
            }),
          }
        : { text: 'Noted.' },
    );
    const submitted = h.service.intake.submit({
      type: 'note.received',
      source: 'test',
      payload: { text: 'remember the milk' },
    });
    await h.service.queue.drain();

    const run = h.service.repos.runs
      .forEvent(submitted.event.id)
      .find((r) => r.kind === 'handler');
    expect(run?.status).toBe('done');
    expect(refuse).toBe(0);
    expect(h.service.repos.meta.observedContext('main')?.size ?? null).toBe(16384);
  });

  it('budgets an ingress run against a size observed earlier, with no caller wiring', async () => {
    h = await bootService({ onboarded: true });
    h.service.repos.meta.setObservedContext('main', { size: 16384, configured: 32768 });
    // A handler on offer, so ingress has something to classify against.
    write(
      path.join(h.dataDir, 'handlers', 'note-taker.md'),
      '---\nname: note-taker\ndescription: Use for notes.\n---\n\nAcknowledge the note.\n',
    );
    h.fake.always({
      text: JSON.stringify({
        summary: 'an event',
        verdicts: [{ handler: 'note-taker', matched: false, reason: 'no' }],
      }),
    });
    h.service.intake.submit({ type: 'note.received', source: 'test', payload: { text: 'x' } });
    await h.service.queue.drain();

    const ingress = h.fake.requests.find((r) => r.body.response_format)!;
    expect(ingress.body.max_tokens).toBeGreaterThan(1024);
    expect(ingress.body.max_tokens).toBeLessThanOrEqual(16384 - 256);
  });
});
