import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ModelMessage } from 'ai';
import { FakeLlama, type ScriptedTurn } from './fake-llama.js';
import { gatewayFor, RecordingDispatcher } from './model-stack.js';
import { ModelsYamlSchema } from '../src/core/config-schemas.js';
import { openDb } from '../src/db/index.js';
import { MetaRepo } from '../src/db/repos/meta.js';
import { runAgent } from '../src/model/agent-loop.js';
import { compactRung, elideStaleResults } from '../src/model/elide.js';
import {
  ModelGateway,
  parseContextRefusal,
  recordObservedContext,
} from '../src/model/gateway.js';
import { observeServedContext, servedContextSize } from '../src/model/probe.js';
import { ModelRouter } from '../src/model/router.js';
import { InferenceScheduler } from '../src/model/scheduler.js';
import type { DispatchCall, DispatchResult } from '../src/model/dispatcher.js';
import {
  MemoryTraceSink,
  type ObservedContext,
  type ObservedContextStore,
  type ResolvedEndpoint,
} from '../src/model/types.js';

/**
 * §20.11 — the window is a budget. The sizes below replay the two runs that
 * motivated it: a 32,768-token endpoint configured as 65,536, an output that
 * ran into the wall at 27,559 + 5,209, and a large feed fetched into a full
 * context.
 */

const VLLM_REFUSAL = JSON.stringify({
  object: 'error',
  message:
    "This model's maximum context length is 32768 tokens. However, you requested " +
    '40000 tokens (34000 in the messages, 6000 in the completion). Please reduce the ' +
    'length of the messages or completion.',
  type: 'BadRequestError',
  param: null,
  code: 400,
});

/** A gateway on the fake with a configured window and an optional fetch seam. */
function windowGateway(
  baseUrl: string,
  opts: {
    contextSize?: number;
    maxOutputTokens?: number;
    fetch?: typeof globalThis.fetch;
    observed?: ObservedContextStore;
  } = {},
): ModelGateway {
  const router = new ModelRouter(
    ModelsYamlSchema.parse({
      endpoints: [
        {
          name: 'fake',
          url: baseUrl,
          classes: ['fast', 'best'],
          caps: ['json', 'tools'],
          ...(opts.contextSize ? { context_size: opts.contextSize } : {}),
          ...(opts.maxOutputTokens ? { max_output_tokens: opts.maxOutputTokens } : {}),
        },
      ],
    }),
  );
  return new ModelGateway(router, new InferenceScheduler(1), {
    ...(opts.fetch ? { fetch: opts.fetch } : {}),
    ...(opts.observed ? { observedContext: opts.observed } : {}),
  });
}

/**
 * Refuses the next chat calls with HTTP 400 and the given bodies, then passes
 * through to the fake. The refused requests are kept, because the fake never
 * sees them.
 */
function refusingFetch(bodies: string[]): {
  fetch: typeof globalThis.fetch;
  refused: Record<string, any>[];
} {
  const refused: Record<string, any>[] = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url =
      typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url.endsWith('/chat/completions') && bodies.length) {
      refused.push(JSON.parse(String(init?.body ?? '{}')));
      return new Response(bodies.shift()!, {
        status: 400,
        headers: { 'content-type': 'application/json' },
      });
    }
    return globalThis.fetch(input, init);
  };
  return { fetch, refused };
}

/** An in-memory store; `sizes` is the size view, `entries` the whole record. */
function memoryStore(seed: Record<string, ObservedContext> = {}): ObservedContextStore & {
  sizes: Map<string, number>;
  entries: Map<string, ObservedContext>;
} {
  const entries = new Map(Object.entries(seed));
  return {
    entries,
    get sizes() {
      return new Map([...entries].map(([k, v]) => [k, v.size]));
    },
    get: (name) => entries.get(name) ?? null,
    set: (name, observed) => void entries.set(name, observed),
    delete: (name) => void entries.delete(name),
  };
}

const objectSchema = (field: string) => ({
  type: 'object',
  properties: { [field]: { type: 'string' } },
  required: [field],
  additionalProperties: false,
});

/** RecordingDispatcher, plus the one declaration it lacks: skill bodies are
 *  `neverElide` (§20.4), reported per call like the real dispatcher does. */
class SkillDispatcher extends RecordingDispatcher {
  override async dispatch(call: DispatchCall): Promise<DispatchResult> {
    const r = await super.dispatch(call);
    return call.name === 'skills.fetch' ? { ...r, neverElide: true } : r;
  }
}

/** Starts and ends with a sentinel, so "how many copies" is a substring count. */
const skillBody = (name: string, chars: number) =>
  `SKILL-${name}-START ` +
  `${name} instructions. `.repeat(Math.ceil(chars / 20)).slice(0, chars) +
  ` SKILL-${name}-END`;
const copies = (wire: string, name: string) => wire.split(`SKILL-${name}-START`).length - 1;

const errors = (trace: MemoryTraceSink, message: string) =>
  (trace.ofKind('error') as any[]).filter((r) => r.message === message);

const base = {
  selector: { purpose: 'chat' as const },
  priority: 'event' as const,
  system: 'system prompt',
  messages: [{ role: 'user' as const, content: 'build the digest embed' } as ModelMessage],
  // The run budget is not what is under test here; the window is.
  budgets: { maxTokens: 1_000_000 },
};

describe('the window is a budget (§20.11)', () => {
  let fake: FakeLlama;
  let url: string;

  beforeEach(async () => {
    fake = new FakeLlama();
    url = await fake.startV1();
  });
  afterEach(async () => {
    await fake.stop();
  });

  /**
   * Run 01M3Z8R3WN…'s shape: a big early fetch, a second large read that fills
   * the context, then the embed. Sizes are real characters; the endpoint
   * counts them (`enforcingFetch`), so the usage the loop anchors on is what
   * was actually sent.
   */
  const replayRunOne = (): ScriptedTurn[] => [
    { toolCalls: [{ name: 'feed', args: { q: 'news' } }] },
    { toolCalls: [{ name: 'lookup', args: { q: 'calendar' } }] },
    {
      toolCalls: [{ name: 'embeds.create', args: { html: '<div>digest</div>' } }],
      usage: { prompt: 10, completion: 5209 },
    },
    { text: 'The digest embed is ready.' },
  ];
  const runOneTools = () =>
    new RecordingDispatcher(
      {
        feed: () => ({ items: 'feed item text '.repeat(4000) }),
        lookup: () => ({ events: 'standup at nine; review at two. '.repeat(780) }),
        'embeds.create': () => ({ id: 'emb_1', created: true }),
      },
      { schema: { 'embeds.create': objectSchema('html') } },
    );

  it('compacts a 32k replay of run 1 and finishes with the embed created', async () => {
    const server = enforcingFetch(32768);
    const gw = windowGateway(url, { contextSize: 32768, fetch: server.fetch });
    fake.script(...replayRunOne());
    const disp = runOneTools();
    const trace = new MemoryTraceSink();
    const r = await runAgent(gw, {
      ...base,
      system: 'You are the assistant. '.repeat(430),
      dispatcher: disp,
      trace,
    });

    expect(r.stopReason).toBe('stop');
    expect(r.text).toBe('The digest embed is ready.');
    expect(disp.calls.map((c) => c.name)).toEqual(['feed', 'lookup', 'embeds.create']);
    expect(r.contextWindow).toBe(32768);

    // Rung 1 ran before the third call, and the estimate came down under the
    // window with room for the reserve.
    const compacted = errors(trace, 'compacted');
    // Once, before the embed call: the feed goes, the calendar read stays.
    expect(compacted.map((c) => c.rung)).toEqual([1]);
    expect(compacted[0]).toMatchObject({ rung: 1, window: 32768 });
    expect(compacted[0].estimate_before).toBeGreaterThan(32768 - 6554);
    expect(compacted[0].estimate_after + 6554).toBeLessThanOrEqual(32768);

    // The old feed was elided; the latest round (lookup) was left alone.
    const third = fake.requests.filter((q) => q.path.endsWith('/chat/completions'))[2]!.body;
    const wire = JSON.stringify(third.messages);
    expect(wire).toContain('[[elided: feed result');
    expect(wire).not.toContain('feed item text feed item text');
    expect(wire).toContain('standup at nine');

    // Every call that knew the window sent an honest max_tokens, and the
    // server never had to refuse one.
    expect(server.refused).toBe(0);
    for (const q of fake.requests.filter((q) => q.path.endsWith('/chat/completions'))) {
      expect(q.body.max_tokens).toBeGreaterThanOrEqual(1024);
      expect(q.body.max_tokens).toBeLessThanOrEqual(32768 - 984);
    }
    // The third call's output room is what the compacted estimate leaves,
    // less the margin: max(256, 3% of 32768, rounded up) = 984.
    expect(third.max_tokens).toBe(32768 - compacted[0].estimate_after - 984);
  });

  it('measures a denser tokenizer instead of being refused by it', async () => {
    // 2.5 chars a token, and a configured window that is right: at the
    // default 3 every growth step is under-estimated, and the margin alone
    // does not cover a 30k-character read. The measured ratio does.
    const server = enforcingFetch(32768, 2.5);
    const gw = windowGateway(url, { contextSize: 32768, fetch: server.fetch });
    fake.script(
      { toolCalls: [{ name: 'lookup', args: { q: 'a' } }] },
      { toolCalls: [{ name: 'feed', args: { q: 'b' } }] },
      { text: 'done' },
    );
    const disp = new RecordingDispatcher({
      lookup: () => ({ rows: 'row data '.repeat(1000) }),
      feed: () => ({ items: 'feed item text '.repeat(2000) }),
    });
    const r = await runAgent(gw, {
      ...base,
      system: 'You are the assistant. '.repeat(1000),
      dispatcher: disp,
    });
    expect(r.stopReason).toBe('stop');
    // Only the first call, which has nothing measured yet, is refused; after
    // that the ratio is the server's and nothing else is. (At a fixed 3 the
    // later growth is refused too, and the run ends context_full.)
    expect(server.refused).toBe(1);
  });

  it('does nothing at all when the window is unknown — exactly as before', async () => {
    const gw = gatewayFor(url);
    fake.script(...replayRunOne());
    const trace = new MemoryTraceSink();
    const r = await runAgent(gw, { ...base, dispatcher: runOneTools(), trace });

    expect(r.stopReason).toBe('stop');
    expect(r.contextWindow).toBeUndefined();
    expect(errors(trace, 'compacted')).toHaveLength(0);
    const calls = fake.requests.filter((q) => q.path.endsWith('/chat/completions'));
    for (const q of calls) expect(q.body).not.toHaveProperty('max_tokens');
    expect(JSON.stringify(calls[2]!.body.messages)).not.toContain('[[elided:');
  });

  it('keeps a margin of max(256, 3% of W) between the estimate and the window', async () => {
    // The same request against two windows: the difference in max_tokens is
    // the difference in windows less the difference in margins.
    const small = windowGateway(url, { contextSize: 8192 });
    const large = windowGateway(url, { contextSize: 100_000 });
    fake.script({ text: 'a' }, { text: 'b' });
    await runAgent(small, { ...base });
    await runAgent(large, { ...base });
    const [a, b] = fake.requests
      .filter((q) => q.path.endsWith('/chat/completions'))
      .map((q) => q.body.max_tokens as number);
    // 8192 → margin 256 (3% is 246); 100000 → margin 3000.
    expect(b! - a!).toBe(100_000 - 3000 - (8192 - 256));
  });

  it('never sends more than G.2 max_output_tokens', async () => {
    const gw = windowGateway(url, { contextSize: 32768, maxOutputTokens: 2000 });
    fake.script({ text: 'short' });
    await runAgent(gw, { ...base, maxOutputTokens: 3000 });
    expect(fake.requests.at(-1)!.body.max_tokens).toBe(2000);
  });

  it('never sends more than the caller asked for', async () => {
    const gw = windowGateway(url, { contextSize: 32768 });
    fake.script({ text: 'short' });
    await runAgent(gw, { ...base, maxOutputTokens: 300 });
    expect(fake.requests.at(-1)!.body.max_tokens).toBe(300);
  });

  it('ends context_full when even rung 3 leaves under 1024 tokens of room', async () => {
    // A ~14k-token prompt, then a 55k-character read in the latest round —
    // which no rung may touch, and which alone leaves no room to answer.
    const server = enforcingFetch(32768);
    const gw = windowGateway(url, { contextSize: 32768, fetch: server.fetch });
    fake.script({ text: 'Looking.', toolCalls: [{ name: 'lookup', args: { q: 'x' } }] });
    const disp = new RecordingDispatcher({
      lookup: () => ({ rows: 'row data '.repeat(6100) }),
    });
    const trace = new MemoryTraceSink();
    const r = await runAgent(gw, {
      ...base,
      system: 'You are the assistant. '.repeat(2170),
      dispatcher: disp,
      trace,
    });

    expect(r.stopReason).toBe('context_full');
    expect(r.error).toMatch(/^context window full: \d+ of 32768 tokens$/);
    // Only the first call was made; the second never left.
    expect(fake.requests.filter((q) => q.path.endsWith('/chat/completions'))).toHaveLength(1);
    expect(errors(trace, 'compacted').map((c) => c.rung)).toEqual([1, 2, 3]);
    expect(r.assistantText).toBe('Looking.');
    expect(server.refused).toBe(0);
  });

  it('does not measure the tokenizer on a request carrying an image', async () => {
    // ~2.4k characters of text and an image the endpoint bills ~3000 tokens
    // for. Measured, that is under one character a token, and the next
    // estimate of a 25.5k-character result would be ~47k: a false context_full
    // on an endpoint that has plenty of room (reviewer repro).
    const gw = windowGateway(url, { contextSize: 32768 });
    fake.script(
      {
        toolCalls: [{ name: 'lookup', args: { q: 'x' } }],
        usage: { prompt: 3800, completion: 20 },
      },
      { text: 'Here is what the picture shows.', usage: { prompt: 12400, completion: 20 } },
    );
    const disp = new RecordingDispatcher({
      lookup: () => ({ rows: 'row data '.repeat(2830) }),
    });
    const image: ModelMessage = {
      role: 'user',
      content: [
        { type: 'text', text: 'What is in this picture? '.repeat(90) },
        { type: 'image', image: new Uint8Array(4096), mediaType: 'image/png' },
      ],
    };
    const r = await runAgent(gw, { ...base, messages: [image], dispatcher: disp });
    expect(r.stopReason).toBe('stop');
    expect(r.text).toBe('Here is what the picture shows.');
  });

  it('reports the effective window on usage activity', async () => {
    const store = memoryStore({ fake: { size: 32768, configured: 65536 } });
    const gw = windowGateway(url, { contextSize: 65536, observed: store });
    fake.script({ text: 'hi' });
    const usage: any[] = [];
    await runAgent(gw, {
      ...base,
      onActivity: (a) => a.kind === 'usage' && usage.push(a),
    });
    expect(usage[0].context_size).toBe(32768);
    // Observed beats configured in the budget, too.
    expect(fake.requests.at(-1)!.body.max_tokens).toBeLessThanOrEqual(32768 - 256);
  });
});

describe('a call refused for length (§20.11)', () => {
  let fake: FakeLlama;
  let url: string;

  beforeEach(async () => {
    fake = new FakeLlama();
    url = await fake.startV1();
  });
  afterEach(async () => {
    await fake.stop();
  });

  it('learns the vllm limit, records it, retries once and succeeds', async () => {
    const seam = refusingFetch([VLLM_REFUSAL]);
    const store = memoryStore();
    const gw = windowGateway(url, { contextSize: 65536, fetch: seam.fetch, observed: store });
    fake.script({ text: 'fits now' });
    const trace = new MemoryTraceSink();
    const r = await runAgent(gw, { ...base, trace });

    expect(r.stopReason).toBe('stop');
    expect(r.text).toBe('fits now');
    expect(store.sizes.get('fake')).toBe(32768);
    expect(r.contextWindow).toBe(32768);
    expect(errors(trace, 'context_overflow')).toEqual([
      { message: 'context_overflow', limit: 32768, outcome: 'retried' },
    ]);
    // The refused call budgeted against the configured 65k; the retry against
    // what the server said.
    expect(seam.refused[0]!.max_tokens).toBeGreaterThan(32768);
    expect(fake.requests.at(-1)!.body.max_tokens).toBeLessThanOrEqual(32768 - 256);
  });

  it('learns a window even when none was configured', async () => {
    const seam = refusingFetch([VLLM_REFUSAL]);
    const gw = windowGateway(url, { fetch: seam.fetch });
    fake.script({ text: 'ok' });
    const r = await runAgent(gw, { ...base });
    expect(r.stopReason).toBe('stop');
    expect(seam.refused[0]).not.toHaveProperty('max_tokens');
    expect(fake.requests.at(-1)!.body.max_tokens).toBeLessThanOrEqual(32768 - 256);
  });

  it('ends context_full on a second refusal', async () => {
    const seam = refusingFetch([VLLM_REFUSAL, VLLM_REFUSAL]);
    const gw = windowGateway(url, {
      contextSize: 65536,
      fetch: seam.fetch,
      observed: memoryStore(),
    });
    const trace = new MemoryTraceSink();
    const r = await runAgent(gw, { ...base, trace });

    expect(r.stopReason).toBe('context_full');
    expect(r.error).toMatch(/^context window full: \d+ of 32768 tokens$/);
    expect(errors(trace, 'context_overflow').map((e) => e.outcome)).toEqual([
      'retried',
      'gave_up',
    ]);
    expect(seam.refused).toHaveLength(2);
  });

  it('does not count a refused call as a turn: a one-turn run gets its retry', async () => {
    // Ingress's shape: one turn, no output cap of its own. G.2 says 65k, the
    // server has 32k, so the first max_tokens is above the server's window.
    const seam = refusingFetch([VLLM_REFUSAL]);
    const gw = windowGateway(url, { contextSize: 65536, fetch: seam.fetch });
    fake.script({ text: '{"summary":"an event"}' });
    const r = await runAgent(gw, { ...base, budgets: { maxTurns: 1, maxTokens: 1_000_000 } });
    expect(r.stopReason).toBe('stop');
    expect(r.turns).toBe(1);
    expect(r.text).toBe('{"summary":"an event"}');
  });

  it('budgets a one-turn run against a size observed earlier', async () => {
    const store = memoryStore({ fake: { size: 16384, configured: 65536 } });
    const gw = windowGateway(url, { contextSize: 65536, observed: store });
    fake.script({ text: 'classified' });
    await runAgent(gw, { ...base, budgets: { maxTurns: 1, maxTokens: 1_000_000 } });
    const sent = fake.requests.at(-1)!.body.max_tokens;
    expect(sent).toBeGreaterThan(1024);
    expect(sent).toBeLessThanOrEqual(16384 - 256);
  });

  it('compacts at least once on the retry, re-anchored on the prompt size vllm states', async () => {
    const stated = JSON.stringify({
      object: 'error',
      message:
        "This model's maximum context length is 32768 tokens. However, your prompt " +
        'contains at least 30000 input tokens and you asked for 2000 output tokens.',
      type: 'BadRequestError',
      code: 400,
    });
    const seam = refusingFetch([stated]);
    const gw = windowGateway(url, { contextSize: 65536, fetch: seam.fetch });
    fake.script({ text: 'ok' });
    const trace = new MemoryTraceSink();
    const r = await runAgent(gw, { ...base, trace });
    expect(r.stopReason).toBe('stop');
    const compacted = errors(trace, 'compacted');
    // Rung 1 ran even though nothing in a fresh run is elidable, and the
    // estimate it measured from is the server's 30000, not our guess.
    expect(compacted[0]).toMatchObject({ rung: 1, window: 32768 });
    expect(compacted[0].estimate_before).toBeGreaterThanOrEqual(30000);
  });

  it('treats an unrelated 400 as the error it is', async () => {
    const seam = refusingFetch([
      JSON.stringify({ error: { message: 'tools[3].function.name is invalid', code: 400 } }),
    ]);
    const store = memoryStore();
    const gw = windowGateway(url, { contextSize: 32768, fetch: seam.fetch, observed: store });
    const trace = new MemoryTraceSink();
    const r = await runAgent(gw, { ...base, trace });

    expect(r.stopReason).toBe('error');
    expect(store.sizes.size).toBe(0);
    expect(errors(trace, 'context_overflow')).toHaveLength(0);
    expect(seam.refused).toHaveLength(1);
  });
});

describe('parseContextRefusal', () => {
  it('reads vllm and OpenAI-style refusals', () => {
    expect(parseContextRefusal(400, VLLM_REFUSAL)).toBe(32768);
  });

  it('reads llama.cpp refusals, with n_ctx in the body or n_ctx_slot in the text', () => {
    expect(
      parseContextRefusal(
        400,
        '{"error":{"code":400,"message":"the request exceeds the available context size, try increasing it","type":"exceed_context_size_error","n_prompt_tokens":40000,"n_ctx":32768}}',
      ),
    ).toBe(32768);
    expect(
      parseContextRefusal(
        400,
        'the request exceeds the available context size, n_ctx_slot = 8192',
      ),
    ).toBe(8192);
  });

  it('ignores other statuses, other 400s, and a llama.cpp refusal with no number', () => {
    expect(parseContextRefusal(500, VLLM_REFUSAL)).toBeUndefined();
    expect(parseContextRefusal(400, 'invalid tool schema; n_ctx: 4096')).toBeUndefined();
    expect(parseContextRefusal(400, 'exceeds the available context size')).toBeUndefined();
  });
});

describe('a length finish is never done (§20.11)', () => {
  let fake: FakeLlama;
  let gw: ModelGateway;

  beforeEach(async () => {
    fake = new FakeLlama();
    gw = windowGateway(await fake.startV1(), { contextSize: 32768 });
  });
  afterEach(async () => {
    await fake.stop();
  });

  const halfCall: ScriptedTurn = {
    text: 'Writing the embed now.',
    // Cut mid-argument: what a model writing a large embed leaves behind.
    toolCalls: [{ name: 'embeds.create', args: '{"html": "<div class=\\"digest\\">' }],
    finishReason: 'length',
    usage: { prompt: 10, completion: 5209 },
  };

  it('executes nothing, retracts, compacts and asks again once with the note', async () => {
    fake.script(halfCall, { text: 'Done, in one call this time.' });
    const disp = new RecordingDispatcher(
      { 'embeds.create': () => ({ id: 'emb_1' }) },
      { schema: { 'embeds.create': objectSchema('html') } },
    );
    const trace = new MemoryTraceSink();
    let retracts = 0;
    const deltas: string[] = [];
    const r = await runAgent(gw, {
      ...base,
      dispatcher: disp,
      trace,
      onDelta: (t) => deltas.push(t),
      onRetract: () => (retracts += 1),
    });

    expect(r.stopReason).toBe('stop');
    expect(disp.calls).toHaveLength(0);
    expect(retracts).toBe(1);
    expect(r.assistantText).toBe('Done, in one call this time.');
    expect(errors(trace, 'output_cut')).toEqual([
      { message: 'output_cut', tokens_out: 5209, outcome: 'retried' },
    ]);
    // Compaction ran before the retry, even though the estimate fit.
    expect(errors(trace, 'compacted').map((c) => c.rung)).toEqual([1]);

    const retry = fake.requests.filter((q) => q.path.endsWith('/chat/completions'))[1]!.body;
    const note = retry.messages.at(-1);
    expect(note.role).toBe('user');
    expect(note.content).toBe(
      `System note: your last output was cut off after 5209 tokens because the context ` +
        `window was full, so nothing in it was executed. ${retry.max_tokens} tokens of ` +
        `output fit now. If you were writing something large, put it in one tool call and ` +
        `keep the prose around it short.`,
    );
    // The cut turn never became part of the transcript.
    expect(JSON.stringify(retry.messages)).not.toContain('Writing the embed now.');
  });

  it('ends output_cut on a second cut, and never reports it done', async () => {
    fake.script(halfCall, halfCall);
    const trace = new MemoryTraceSink();
    let retracts = 0;
    const r = await runAgent(gw, {
      ...base,
      dispatcher: new RecordingDispatcher({}),
      trace,
      onRetract: () => (retracts += 1),
    });

    expect(r.stopReason).toBe('output_cut');
    expect(r.error).toBe('output cut off at the context window');
    expect(r.assistantText).toBe('');
    expect(retracts).toBe(2);
    expect(errors(trace, 'output_cut').map((e) => e.outcome)).toEqual(['retried', 'gave_up']);
  });

  it("leaves a cut at the caller's own cap alone — that is its budget, not the window", async () => {
    fake.script({ text: 'A title that ran lon', finishReason: 'length' });
    const trace = new MemoryTraceSink();
    const r = await runAgent(gw, { ...base, trace, maxOutputTokens: 30 });
    expect(r.stopReason).toBe('stop');
    expect(r.text).toBe('A title that ran lon');
    expect(errors(trace, 'output_cut')).toHaveLength(0);
  });

  it('leaves a cut at a G.2 max_output_tokens below the room alone too', async () => {
    const capped = windowGateway(fake.baseUrl + '/v1', {
      contextSize: 32768,
      maxOutputTokens: 512,
    });
    fake.script({ text: 'partial', finishReason: 'length' });
    const r = await runAgent(capped, { ...base });
    expect(r.stopReason).toBe('stop');
    expect(fake.requests.filter((q) => q.path.endsWith('/chat/completions'))).toHaveLength(1);
  });

  it('never calls a cut-off answer done when the window is unknown either', async () => {
    const plain = gatewayFor(fake.baseUrl + '/v1');
    fake.script(
      {
        text: 'a truncated answ',
        finishReason: 'length',
        usage: { prompt: 50, completion: 700 },
      },
      { text: 'A short answer.' },
    );
    const trace = new MemoryTraceSink();
    let retracts = 0;
    const r = await runAgent(plain, { ...base, trace, onRetract: () => (retracts += 1) });

    expect(r.stopReason).toBe('stop');
    expect(r.assistantText).toBe('A short answer.');
    expect(retracts).toBe(1);
    // Nothing to compact against, and no room figure to promise.
    expect(errors(trace, 'compacted')).toHaveLength(0);
    const retry = fake.requests.filter((q) => q.path.endsWith('/chat/completions'))[1]!.body;
    expect(retry).not.toHaveProperty('max_tokens');
    expect(retry.messages.at(-1).content).toBe(
      'System note: your last output was cut off after 700 tokens because the context ' +
        'window was full, so nothing in it was executed. If you were writing something ' +
        'large, put it in one tool call and keep the prose around it short.',
    );
  });

  it('ends output_cut on a second cut with the window unknown', async () => {
    const plain = gatewayFor(fake.baseUrl + '/v1');
    const cut = { text: 'a truncated answ', finishReason: 'length' };
    fake.script(cut, cut);
    const r = await runAgent(plain, { ...base });
    expect(r.stopReason).toBe('output_cut');
    expect(r.error).toBe('output cut off at the context window');
    expect(r.contextWindow).toBeUndefined();
  });
});

describe('compaction rungs (§20.11)', () => {
  const result = (toolCallId: string, toolName: string, value: unknown) => ({
    type: 'tool-result' as const,
    toolCallId,
    toolName,
    output: { type: 'json' as const, value: value as never },
  });
  const call = (toolCallId: string, toolName: string) => ({
    role: 'assistant' as const,
    content: [{ type: 'tool-call' as const, toolCallId, toolName, input: {} }],
  });
  const transcript = (): ModelMessage[] => [
    { role: 'user', content: 'go' },
    call('a', 'skills.fetch'),
    {
      role: 'tool',
      content: [result('a', 'skills.fetch', { name: 'alpha', content: 'A'.repeat(6000) })],
    },
    call('b', 'web.fetch'),
    { role: 'tool', content: [result('b', 'web.fetch', { text: 'B'.repeat(5000) })] },
    call('c', 'memory.query'),
    {
      role: 'tool',
      content: [result('c', 'memory.query', { results: ['tiny'], note: 'C'.repeat(400) })],
    },
    call('d', 'skills.fetch'),
    {
      role: 'tool',
      content: [result('d', 'skills.fetch', { name: 'beta', content: 'D'.repeat(6000) })],
    },
    call('e', 'web.fetch'),
    // The latest round: the model has not answered it yet.
    { role: 'tool', content: [result('e', 'web.fetch', { text: 'E'.repeat(9000) })] },
  ];
  const values = (m: ModelMessage[]) =>
    m.filter((x) => x.role === 'tool').map((x) => (x.content as any[])[0].output.value);
  const skills = new Set(['skills.fetch']);

  it('rung 1 elides large data results, never skill bodies, never the latest round', () => {
    const m = transcript();
    expect(compactRung(m, 1, 2000, skills)).toBe(1);
    const [a, b, c, d, e] = values(m);
    expect(typeof a).toBe('object');
    expect(b).toMatch(/^\[\[elided: web\.fetch result, \d+ chars/);
    expect(typeof c).toBe('object');
    expect(typeof d).toBe('object');
    expect(e.text).toHaveLength(9000);
  });

  it('rung 2 stubs every skill body but the newest, and still not the latest round', () => {
    const m = transcript();
    compactRung(m, 1, 2000, skills);
    expect(compactRung(m, 2, 2000, skills)).toBe(1);
    const [a, , c, d, e] = values(m);
    expect(a).toMatch(
      /^\[\[elided: skill alpha, \d+ chars — fetch it again with skills\.fetch if you need it\]\]$/,
    );
    expect(typeof c).toBe('object');
    expect(d.content).toHaveLength(6000);
    expect(e.text).toHaveLength(9000);
  });

  it('rung 3 elides everything older than the latest round, whatever its size', () => {
    const m = transcript();
    compactRung(m, 1, 2000, skills);
    compactRung(m, 2, 2000, skills);
    compactRung(m, 3, 2000, skills);
    const [, , c, d, e] = values(m);
    expect(c).toMatch(/^\[\[elided: memory\.query result/);
    expect(d).toMatch(/^\[\[elided: skill beta/);
    expect(e.text).toHaveLength(9000);
  });

  it('treats a skill delivered by tools.open as a skill body (§20.4, rung 2)', () => {
    const opened = (id: string, name: string) => ({
      role: 'tool' as const,
      content: [
        result(id, 'tools.open', {
          opened: name,
          tools: [`${name}.create`],
          skill: { name, content: name.toUpperCase().repeat(3000), note: 'guide' },
        }),
      ],
    });
    const m: ModelMessage[] = [
      { role: 'user', content: 'go' },
      call('a', 'tools.open'),
      opened('a', 'embeds'),
      call('b', 'tools.open'),
      opened('b', 'asana'),
      call('c', 'memory.query'),
      { role: 'tool', content: [result('c', 'memory.query', { results: [] })] },
    ];
    // §20.4 elision leaves it alone, however old and large.
    expect(elideStaleResults(m, { thresholdChars: 2000, afterTurns: 0 }, new Set())).toEqual(
      [],
    );
    // Rung 1 too; rung 2 stubs all but the newest, in the skill stub form.
    expect(compactRung(m, 1, 2000, new Set())).toBe(0);
    expect(compactRung(m, 2, 2000, new Set())).toBe(1);
    const [embeds, asana] = values(m);
    // Only the skill field goes; `opened` and `tools` survive, and `<n>` is
    // the body's own length.
    expect(embeds.opened).toBe('embeds');
    expect(embeds.tools).toEqual(['embeds.create']);
    expect(embeds.skill).toBe(
      '[[elided: skill embeds, 18000 chars — fetch it again with skills.fetch if you need it]]',
    );
    expect(asana.skill.content).toHaveLength(15000);
  });

  it('is monotonic: a second pass replaces nothing', () => {
    const m = transcript();
    for (const rung of [1, 2, 3] as const) compactRung(m, rung, 2000, skills);
    const before = JSON.stringify(m);
    for (const rung of [1, 2, 3] as const) expect(compactRung(m, rung, 2000, skills)).toBe(0);
    expect(JSON.stringify(m)).toBe(before);
  });
});

describe('a skill body is delivered once per run (§20.11)', () => {
  let fake: FakeLlama;
  let url: string;

  beforeEach(async () => {
    fake = new FakeLlama();
    url = await fake.startV1();
  });
  afterEach(async () => {
    await fake.stop();
  });

  const skillTools = (bodies: Record<string, string>) =>
    new SkillDispatcher(
      {
        'skills.fetch': (a: { name: string }) => ({
          name: a.name,
          description: `the ${a.name} skill`,
          content: bodies[a.name],
        }),
        'tools.open': (a: { namespace: string }) => ({
          opened: a.namespace,
          tools: [`${a.namespace}.create`],
          skill: { name: a.namespace, content: bodies[a.namespace], note: 'the usage guide' },
        }),
        lookup: () => ({ rows: 'row data '.repeat(2800) }),
      },
      {
        schema: {
          'skills.fetch': objectSchema('name'),
          'tools.open': objectSchema('namespace'),
        },
      },
    );

  it('answers a duplicate skills.fetch with already_loaded, and the trace keeps the body', async () => {
    const gw = gatewayFor(url);
    const body = skillBody('embeds', 3000);
    fake.script(
      { toolCalls: [{ name: 'tools.open', args: { namespace: 'embeds' } }] },
      { toolCalls: [{ name: 'skills.fetch', args: { name: 'embeds' } }] },
      { text: 'done' },
    );
    const trace = new MemoryTraceSink();
    await runAgent(gw, { ...base, dispatcher: skillTools({ embeds: body }), trace });

    const wire = JSON.stringify(fake.requests.at(-1)!.body.messages);
    expect(copies(wire, 'embeds')).toBe(1);
    expect(wire).toContain('already_loaded');
    expect(wire).toContain('this skill is already in your context above; use that copy');
    const rows = trace.ofKind('tool_call') as any[];
    expect(rows[1].result_excerpt).toContain('SKILL-embeds-START');
  });

  it('drops the skill from a tools.open whose body was already fetched', async () => {
    const gw = gatewayFor(url);
    const body = skillBody('asana', 3000);
    fake.script(
      // Same round: the second delivery sees the first before it is sent.
      {
        toolCalls: [
          { name: 'skills.fetch', args: { name: 'asana' } },
          { name: 'tools.open', args: { namespace: 'asana' } },
        ],
      },
      { text: 'done' },
    );
    await runAgent(gw, { ...base, dispatcher: skillTools({ asana: body }) });
    const tool = fake.requests.at(-1)!.body.messages.filter((m: any) => m.role === 'tool');
    const wire = JSON.stringify(tool);
    expect(copies(wire, 'asana')).toBe(1);
    expect(wire).toContain('skill_already_loaded');
    expect(wire).toContain('asana.create');
  });

  it('re-delivers a body in full once compaction has stubbed it', async () => {
    const server = enforcingFetch(32768);
    const gw = windowGateway(url, { contextSize: 32768, fetch: server.fetch });
    const alpha = skillBody('alpha', 15000);
    const beta = skillBody('beta', 15000);
    fake.script(
      { toolCalls: [{ name: 'skills.fetch', args: { name: 'alpha' } }] },
      { toolCalls: [{ name: 'skills.fetch', args: { name: 'beta' } }] },
      { toolCalls: [{ name: 'lookup', args: { q: 'x' } }] },
      { toolCalls: [{ name: 'skills.fetch', args: { name: 'alpha' } }] },
      { toolCalls: [{ name: 'skills.fetch', args: { name: 'beta' } }] },
      { text: 'done' },
    );
    const trace = new MemoryTraceSink();
    const r = await runAgent(gw, {
      ...base,
      system: 'You are the assistant. '.repeat(1740),
      dispatcher: skillTools({ alpha, beta }),
      trace,
    });

    expect(r.stopReason).toBe('stop');
    // Rung 2 stubbed alpha before the re-fetch; later pressure was data.
    expect(errors(trace, 'compacted').map((c) => c.rung)).toEqual([1, 2, 1]);
    const wire = JSON.stringify(fake.requests.at(-1)!.body.messages);
    // alpha: stubbed, then delivered again in full.
    expect(wire).toContain('[[elided: skill alpha');
    expect(copies(wire, 'alpha')).toBe(1);
    expect(wire).toContain('SKILL-alpha-END');
    // beta: never stubbed, so the second fetch is a pointer.
    expect(copies(wire, 'beta')).toBe(1);
    expect(wire).toContain('already_loaded');
  });
});

describe('observed context sizes (§10.7, App. C meta)', () => {
  it('round-trips through meta, and reads garbage as unknown', () => {
    const meta = new MetaRepo(openDb(':memory:'));
    expect(meta.observedContext('main')).toBeNull();
    meta.setObservedContext('main', { size: 32768, configured: 65536 });
    expect(meta.observedContext('main')).toEqual({ size: 32768, configured: 65536 });
    expect(JSON.parse(meta.get('observed_context_size:main')!)).toEqual({
      size: 32768,
      configured: 65536,
    });
    meta.set('observed_context_size:other', 'lots');
    expect(meta.observedContext('other')).toBeNull();
    meta.set('observed_context_size:other', '{"size":0}');
    expect(meta.observedContext('other')).toBeNull();
    meta.deleteObservedContext('main');
    expect(meta.observedContext('main')).toBeNull();
  });

  it('reads a legacy plain integer as learned against no configured size', () => {
    const meta = new MetaRepo(openDb(':memory:'));
    meta.set('observed_context_size:main', '32768');
    expect(meta.observedContext('main')).toEqual({ size: 32768, configured: null });
  });

  it('drops an observation once the configured context_size changes', async () => {
    const store = memoryStore();
    // Learned 16384 against a configured 65536…
    recordObservedContext(store, 'fake', 65536, 16384);
    expect(store.entries.get('fake')).toEqual({ size: 16384, configured: 65536 });
    const same = windowGateway('http://unused.invalid/v1', {
      contextSize: 65536,
      observed: store,
    });
    expect(same.contextWindow({ name: 'fake', contextSize: 65536 })).toBe(16384);
    // …then someone edits models.yaml to 131072: the edit wins, the
    // observation is gone.
    const edited = windowGateway('http://unused.invalid/v1', {
      contextSize: 131072,
      observed: store,
    });
    expect(edited.contextWindow({ name: 'fake', contextSize: 131072 })).toBe(131072);
    expect(store.entries.has('fake')).toBe(false);
  });

  it('honours a null configured only while the config still has none', () => {
    const store = memoryStore({ fake: { size: 32768, configured: null } });
    const gw = windowGateway('http://unused.invalid/v1', { observed: store });
    expect(gw.contextWindow({ name: 'fake' })).toBe(32768);
    expect(gw.contextWindow({ name: 'fake', contextSize: 65536 })).toBe(65536);
    expect(store.entries.has('fake')).toBe(false);
  });

  const endpoint = (over: Partial<ResolvedEndpoint> = {}): ResolvedEndpoint => ({
    name: 'main',
    url: 'http://served.invalid/v1',
    model: 'served-model',
    kind: 'chat',
    classes: ['best'],
    caps: ['tools'],
    contextSize: 65536,
    concurrency: 1,
    ...over,
  });
  const listing =
    (data: unknown[]): typeof globalThis.fetch =>
    async () =>
      new Response(JSON.stringify({ object: 'list', data }), {
        headers: { 'content-type': 'application/json' },
      });

  it('reads vllm max_model_len and llama.cpp meta.n_ctx for the configured model', async () => {
    expect(
      await servedContextSize(endpoint(), {
        fetch: listing([
          { id: 'other', max_model_len: 4096 },
          { id: 'served-model', max_model_len: 32768 },
        ]),
      }),
    ).toBe(32768);
    expect(
      await servedContextSize(endpoint(), {
        fetch: listing([{ id: 'served-model', meta: { n_ctx: 16384 } }]),
      }),
    ).toBe(16384);
    expect(
      await servedContextSize(endpoint(), { fetch: listing([{ id: 'served-model' }]) }),
    ).toBeUndefined();
  });

  it('records what the drift check sees as observed, and leaves config alone', async () => {
    const store = memoryStore();
    await observeServedContext([endpoint(), endpoint({ name: 'speech', kind: 'stt' })], store, {
      fetch: listing([{ id: 'served-model', max_model_len: 32768 }]),
    });
    expect([...store.sizes]).toEqual([['main', 32768]]);
  });

  it('records nothing when the endpoint does not answer', async () => {
    const store = memoryStore();
    await observeServedContext([endpoint()], store, {
      fetch: async () => {
        throw new Error('connect ECONNREFUSED');
      },
    });
    expect(store.sizes.size).toBe(0);
  });
});

/**
 * A 32k endpoint that enforces its window the way vllm does: it counts the
 * prompt itself (3.5 characters a token — a real tokenizer on English and
 * JSON, and fewer tokens than the loop's pessimistic 3 assume),
 * refuses anything over the window with vllm's message, and reports the
 * prompt it counted as `usage.prompt_tokens`. Non-streaming, so the usage can
 * be rewritten on the way back.
 */
function enforcingFetch(
  window: number,
  charsPerToken = 3.5,
): {
  fetch: typeof globalThis.fetch;
  refused: number;
  served: { prompt: number; maxTokens: number }[];
} {
  const state = { refused: 0, served: [] as { prompt: number; maxTokens: number }[] };
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url =
      typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (!url.endsWith('/chat/completions')) return globalThis.fetch(input, init);
    const body = JSON.parse(String(init?.body ?? '{}'));
    const prompt = Math.ceil(
      JSON.stringify({ messages: body.messages, tools: body.tools }).length / charsPerToken,
    );
    const maxTokens: number = body.max_tokens ?? 0;
    if (prompt + maxTokens > window) {
      state.refused += 1;
      return new Response(
        JSON.stringify({
          object: 'error',
          message:
            `This model's maximum context length is ${window} tokens. However, your prompt ` +
            `contains at least ${prompt} input tokens and you asked for ${maxTokens} output tokens.`,
          type: 'BadRequestError',
          code: 400,
        }),
        { status: 400, headers: { 'content-type': 'application/json' } },
      );
    }
    state.served.push({ prompt, maxTokens });
    const res = await globalThis.fetch(input, init);
    const json = (await res.json()) as {
      usage: { prompt_tokens: number; total_tokens: number };
    };
    json.usage.prompt_tokens = prompt;
    json.usage.total_tokens = prompt + 10;
    return new Response(JSON.stringify(json), {
      headers: { 'content-type': 'application/json' },
    });
  };
  return {
    fetch,
    get refused() {
      return state.refused;
    },
    served: state.served,
  };
}

describe('replay of run 01M3Z967H8… against an enforcing 32k endpoint (§20.11)', () => {
  let fake: FakeLlama;
  let url: string;

  beforeEach(async () => {
    fake = new FakeLlama();
    url = await fake.startV1();
  });
  afterEach(async () => {
    await fake.stop();
  });

  it.each([
    ['3.5 chars a token (English and JSON)', 3.5],
    ['2.5 chars a token (a denser tokenizer than the estimate assumes)', 2.5],
  ])('survives a large feed landing on a full context, at %s', async (_label, ratio) => {
    const server = enforcingFetch(32768, ratio);
    // G.2 said 65,536; the server has 32,768.
    const gw = windowGateway(url, { contextSize: 65536, fetch: server.fetch });
    fake.script(
      { toolCalls: [{ name: 'skills.fetch', args: { name: 'embeds' } }] },
      { toolCalls: [{ name: 'calendar', args: { q: 'week' } }] },
      { toolCalls: [{ name: 'feed', args: { q: 'news' } }] },
      { toolCalls: [{ name: 'embeds.create', args: { html: '<div>digest</div>' } }] },
      { text: 'The digest is ready.' },
    );
    const disp = new SkillDispatcher(
      {
        'skills.fetch': () => ({
          name: 'embeds',
          description: 'the embeds skill',
          content: skillBody('embeds', 12000),
        }),
        calendar: () => ({ events: 'standup at nine; review at two. '.repeat(330) }),
        feed: () => ({ items: 'feed item text '.repeat(2000) }),
        'embeds.create': () => ({ id: 'emb_2', created: true }),
      },
      {
        schema: {
          'skills.fetch': objectSchema('name'),
          'embeds.create': objectSchema('html'),
        },
      },
    );
    const trace = new MemoryTraceSink();
    const r = await runAgent(gw, {
      ...base,
      system: 'You are the assistant. '.repeat(1500),
      dispatcher: disp,
      trace,
    });

    expect(r.stopReason).toBe('stop');
    expect(r.text).toBe('The digest is ready.');
    expect(disp.calls.map((c) => c.name)).toEqual([
      'skills.fetch',
      'calendar',
      'feed',
      'embeds.create',
    ]);
    // The context really was full: the feed landed on top of ~26k.
    expect(Math.max(...server.served.map((s) => s.prompt))).toBeGreaterThan(20000);
    // Every call the server accepted fit its window.
    for (const s of server.served) expect(s.prompt + s.maxTokens).toBeLessThanOrEqual(32768);
    expect(errors(trace, 'compacted').length).toBeGreaterThan(0);
    // G.2's 65k was learned down to 32k from the first refusal, once.
    expect(server.refused).toBe(1);
    expect(r.contextWindow).toBe(32768);
    // The feed result (the latest round when it arrived) reached the model whole.
    const afterFeed = fake.requests.filter((q) => q.path.endsWith('/chat/completions'))[3]!;
    expect(JSON.stringify(afterFeed.body.messages)).toContain('feed item text feed item text');
  });
});
