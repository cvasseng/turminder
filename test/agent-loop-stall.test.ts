import { describe, expect, it } from 'vitest';
import { ModelsYamlSchema } from '../src/core/config-schemas.js';
import { DEFAULT_SETTINGS } from '../src/core/config.js';
import { runAgent } from '../src/model/agent-loop.js';
import { ModelGateway } from '../src/model/gateway.js';
import { ModelRouter } from '../src/model/router.js';
import { InferenceScheduler } from '../src/model/scheduler.js';
import { MemoryTraceSink } from '../src/model/types.js';
import { RecordingDispatcher } from './model-stack.js';

/**
 * The §9 stall clock and ceiling. FakeLlama sends a tool call in one piece and
 * cannot go quiet halfway through a stream, and both of those are the point
 * here — so these tests speak SSE through an injected fetch whose every chunk
 * is placed in time. Timings are scaled down; the ratios are what matter.
 */

type Delta = Record<string, unknown>;
interface Step {
  /** Wait this long before sending the chunk. */
  delayMs?: number;
  delta?: Delta;
  /** Sends the final chunk (with usage) instead of a delta. */
  finish?: string;
}
interface Call {
  /** Before the response headers: the endpoint has accepted, not yet spoken. */
  headerDelayMs?: number;
  steps: Iterable<Step>;
}

const sleep = (ms: number, signal?: AbortSignal | null) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(t);
        reject(signal.reason);
      },
      { once: true },
    );
  });

const base = { id: 'chatcmpl-x', object: 'chat.completion.chunk', created: 1, model: 'm' };
const frame = (s: Step) =>
  s.finish
    ? {
        ...base,
        choices: [{ index: 0, delta: {}, finish_reason: s.finish }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      }
    : { ...base, choices: [{ index: 0, delta: s.delta ?? {}, finish_reason: null }] };

const reasoning = (text: string, delayMs = 0): Step => ({
  delayMs,
  delta: { reasoning_content: text },
});
const content = (text: string, delayMs = 0): Step => ({ delayMs, delta: { content: text } });
const done = (finish = 'stop', delayMs = 0): Step => ({ delayMs, finish });

/** A reasoning stream: `n` chunks, `everyMs` apart, then the text. */
function thinking(n: number, everyMs: number, text: string): Step[] {
  return [
    ...Array.from({ length: n }, () => reasoning('hmm ', everyMs)),
    content(text),
    done(),
  ];
}

/** A tool call whose arguments arrive as `pieces`, `everyMs` apart. */
function toolCall(name: string, pieces: string[], everyMs: number): Step[] {
  return [
    {
      delta: {
        tool_calls: [
          { index: 0, id: `call_${name}`, type: 'function', function: { name, arguments: '' } },
        ],
      },
    },
    ...pieces.map((p) => ({
      delayMs: everyMs,
      delta: { tool_calls: [{ index: 0, function: { arguments: p } }] },
    })),
    done('tool_calls'),
  ];
}

class ScriptedSse {
  readonly requests: { at: number }[] = [];
  private queue: Call[] = [];
  script(...calls: Call[]): this {
    this.queue.push(...calls);
    return this;
  }
  readonly fetch: typeof globalThis.fetch = async (_input, init) => {
    this.requests.push({ at: Date.now() });
    const call = this.queue.shift() ?? { steps: [content('ok'), done()] };
    const signal = init?.signal;
    if (call.headerDelayMs) await sleep(call.headerDelayMs, signal);
    // A non-streamed request gets one JSON answer built from the script's text.
    const streamed = JSON.parse(String(init?.body ?? '{}')).stream === true;
    if (!streamed) {
      const text = [...call.steps].map((st) => st.delta?.content ?? '').join('');
      return Response.json({
        id: 'chatcmpl-x',
        object: 'chat.completion',
        created: 1,
        model: 'm',
        choices: [
          { index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      });
    }
    const enc = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      async start(controller) {
        try {
          for (const step of call.steps) {
            if (step.delayMs) await sleep(step.delayMs, signal);
            controller.enqueue(enc.encode(`data: ${JSON.stringify(frame(step))}\n\n`));
          }
          controller.enqueue(enc.encode('data: [DONE]\n\n'));
          controller.close();
        } catch (e) {
          controller.error(e);
        }
      },
    });
    return new Response(body, {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    });
  };
}

function gatewayWith(sse: ScriptedSse): ModelGateway {
  const router = new ModelRouter(
    ModelsYamlSchema.parse({
      endpoints: [
        {
          name: 'fake',
          url: 'http://fake.invalid/v1',
          classes: ['fast', 'best'],
          caps: ['tools'],
        },
      ],
    }),
  );
  return new ModelGateway(router, new InferenceScheduler(1), { fetch: sse.fetch });
}

const req = {
  selector: { purpose: 'chat' as const },
  priority: 'interactive' as const,
  system: 'system prompt',
  messages: [{ role: 'user' as const, content: 'do the thing' }],
  // Chat always streams; the stall clock is defined over the stream.
  onDelta: () => {},
};

describe('the stall clock (§9)', () => {
  it('ships the App. A chat budgets as defaults', () => {
    expect(DEFAULT_SETTINGS.chatStallS).toBe(240);
    expect(DEFAULT_SETTINGS.chatTimeoutS).toBe(1800);
    expect(DEFAULT_SETTINGS.chatMaxTurns).toBe(16);
    expect(DEFAULT_SETTINGS.chatMaxTokens).toBe(120_000);
  });

  it('does not stall a call that keeps reasoning for longer than stall_s in total', async () => {
    const sse = new ScriptedSse().script({ steps: thinking(12, 50, 'answer') });
    const r = await runAgent(gatewayWith(sse), {
      ...req,
      budgets: { stallS: 0.2, timeoutS: 5 },
    });
    // 600 ms of reasoning, never more than 50 ms between chunks.
    expect(r.stopReason).toBe('stop');
    expect(r.text).toBe('answer');
  });

  it('stalls a call that goes quiet for stall_s, with the exact strings', async () => {
    const sse = new ScriptedSse().script({
      headerDelayMs: 2000,
      steps: [content('late'), done()],
    });
    const trace = new MemoryTraceSink();
    const started = Date.now();
    const r = await runAgent(gatewayWith(sse), {
      ...req,
      trace,
      budgets: { stallS: 0.2, timeoutS: 5 },
    });
    expect(r.stopReason).toBe('stalled');
    expect(r.error).toBe('stalled: nothing streamed for 0.2s');
    expect(Date.now() - started).toBeLessThan(1500);
    const llm = trace.ofKind('llm_call') as {
      stop_reason: string;
      error?: { message: string };
    }[];
    expect(llm).toHaveLength(1);
    expect(llm[0]!.stop_reason).toBe('error');
    expect(llm[0]!.error?.message).toBe('agent run stalled: nothing streamed for stall_s=0.2');
  });

  it('ends a stream that hangs mid-way stall_s after its last chunk, not at the ceiling', async () => {
    const sse = new ScriptedSse().script({
      steps: [reasoning('a'), reasoning('b', 50), content('partial', 50), done('stop', 10_000)],
    });
    const trace = new MemoryTraceSink();
    const started = Date.now();
    const r = await runAgent(gatewayWith(sse), {
      ...req,
      trace,
      budgets: { stallS: 0.3, timeoutS: 5 },
    });
    const elapsed = Date.now() - started;
    expect(r.stopReason).toBe('stalled');
    expect(r.error).toBe('stalled: nothing streamed for 0.3s');
    const llm = trace.ofKind('llm_call') as { error?: { message: string } }[];
    expect(llm.at(-1)?.error?.message).toBe(
      'agent run stalled: nothing streamed for stall_s=0.3',
    );
    // The user watched it arrive, so it is kept (§9).
    expect(r.text).toBe('partial');
    expect(r.assistantText).toBe('partial');
    // ~100 ms of chunks, then 300 ms of silence.
    expect(elapsed).toBeGreaterThanOrEqual(380);
    expect(elapsed).toBeLessThan(2000);
  });

  it('keeps a call alive on tool-argument deltas alone', async () => {
    // A model writing a long embed into a tool argument: no text, no
    // reasoning, only argument pieces — working, not stalled.
    const pieces = ['{"q":"', ...Array.from({ length: 10 }, () => 'xxxx'), '"}'];
    const sse = new ScriptedSse().script(
      { steps: toolCall('lookup', pieces, 60) },
      { steps: [content('written'), done()] },
    );
    const disp = new RecordingDispatcher({ lookup: (a) => ({ len: String(a.q).length }) });
    const r = await runAgent(gatewayWith(sse), {
      ...req,
      dispatcher: disp,
      budgets: { stallS: 0.2, timeoutS: 5 },
    });
    expect(r.stopReason).toBe('stop');
    expect(disp.calls).toHaveLength(1);
    expect(disp.calls[0]!.args).toEqual({ q: 'x'.repeat(40) });
    expect(r.text).toBe('written');
  });

  it('is disarmed while a tool runs longer than stall_s', async () => {
    const sse = new ScriptedSse().script(
      { steps: toolCall('slow', ['{"q":"a"}'], 0) },
      { steps: [content('finished'), done()] },
    );
    const disp = new RecordingDispatcher({
      slow: async () => {
        await sleep(600);
        return { ok: true };
      },
    });
    const r = await runAgent(gatewayWith(sse), {
      ...req,
      dispatcher: disp,
      budgets: { stallS: 0.2, timeoutS: 5 },
    });
    expect(r.stopReason).toBe('stop');
    expect(r.text).toBe('finished');
  });

  it('does not count queue wait (§10.4)', async () => {
    // One slot: the second run waits behind the first for longer than
    // stall_s before its call ever leaves the queue.
    const sse = new ScriptedSse().script(
      { steps: thinking(10, 50, 'first') },
      { steps: [content('second'), done()] },
    );
    const gw = gatewayWith(sse);
    const budgets = { stallS: 0.2, timeoutS: 5 };
    const [a, b] = await Promise.all([
      runAgent(gw, { ...req, budgets }),
      runAgent(gw, { ...req, budgets }),
    ]);
    expect(a.stopReason).toBe('stop');
    expect(b.stopReason).toBe('stop');
    expect(b.text).toBe('second');
  });

  it('still lets the ceiling fire on a run that streams forever', async () => {
    function* forever(): Generator<Step> {
      yield content('so far');
      for (;;) yield reasoning('… ', 30);
    }
    const sse = new ScriptedSse().script({ steps: forever() });
    const started = Date.now();
    const r = await runAgent(gatewayWith(sse), {
      ...req,
      budgets: { stallS: 0.2, timeoutS: 0.6 },
    });
    expect(r.stopReason).toBe('timeout');
    expect(r.error).toBe('timeout after 0.6s');
    // The ceiling salvages the call in flight just as the stall clock does.
    expect(r.text).toBe('so far');
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('salvages a timed-out partial with reserved markers stripped (§20.8)', async () => {
    const sse = new ScriptedSse().script({
      steps: [
        content('Half an answer'),
        content('\n[[used tools: files.append]]'),
        done('stop', 5000),
      ],
    });
    const r = await runAgent(gatewayWith(sse), { ...req, budgets: { timeoutS: 0.3 } });
    expect(r.stopReason).toBe('timeout');
    expect(r.text).toBe('Half an answer');
    expect(r.assistantText).not.toContain('[[');
  });

  it('gives a non-streamed call no stall clock, even when stallS is passed', async () => {
    const sse = new ScriptedSse().script({
      headerDelayMs: 500,
      steps: [content('slow'), done()],
    });
    const { onDelta: _streams, ...unstreamed } = req;
    const r = await runAgent(gatewayWith(sse), {
      ...unstreamed,
      budgets: { stallS: 0.1, timeoutS: 5 },
    });
    expect(r.stopReason).toBe('stop');
    expect(r.text).toBe('slow');
  });

  it('lets the first clock name the stop: a later timer never relabels it', async () => {
    // Stopped by the user during a tool that ignores the signal and outlives
    // the ceiling; the ceiling then fires on a run that has already ended.
    const sse = new ScriptedSse().script({ steps: toolCall('slow', ['{"q":"a"}'], 0) });
    const disp = new RecordingDispatcher({
      slow: async () => {
        await sleep(400);
        return { ok: true };
      },
    });
    const stop = new AbortController();
    setTimeout(() => stop.abort(), 50);
    const r = await runAgent(gatewayWith(sse), {
      ...req,
      dispatcher: disp,
      abortSignal: stop.signal,
      budgets: { stallS: 0.2, timeoutS: 0.2 },
    });
    expect(r.stopReason).toBe('aborted');
  });

  it('never stalls a run that asked for no stall clock (handlers, §5.4)', async () => {
    const sse = new ScriptedSse().script({
      headerDelayMs: 500,
      steps: [content('slow'), done()],
    });
    const r = await runAgent(gatewayWith(sse), {
      ...req,
      priority: 'event',
      budgets: { timeoutS: 5 },
    });
    expect(r.stopReason).toBe('stop');
    expect(r.text).toBe('slow');
  });
});

describe('the run that died (2026-10-02), replayed at 1/400 scale', () => {
  // Four calls of 133–190 s reasoning at ~1 chunk/s, with tool rounds between.
  // The defaults 240 s / 1800 s become 0.6 s / 4.5 s; the old flat 600 s
  // becomes 1.5 s.
  const SCALE = 400;
  const callOf = (seconds: number): Step[] => {
    const n = Math.round((seconds * 1000) / SCALE / 25);
    return Array.from({ length: n }, () => reasoning('thinking ', 25));
  };
  const gather = (s: number, q: string): Call => ({
    steps: [...callOf(s), ...toolCall('lookup', [`{"q":"${q}"}`], 0)],
  });
  const script = (): Call[] => [
    gather(174, 'a'),
    gather(133, 'b'),
    gather(161, 'c'),
    { steps: [...callOf(190), content('Here is your template.'), done()] },
  ];
  const disp = () => new RecordingDispatcher({ lookup: (a) => ({ data: a.q }) });

  it('now ends done under the default clocks', async () => {
    const sse = new ScriptedSse().script(...script());
    const r = await runAgent(gatewayWith(sse), {
      ...req,
      dispatcher: disp(),
      budgets: {
        maxTurns: DEFAULT_SETTINGS.chatMaxTurns,
        maxTokens: DEFAULT_SETTINGS.chatMaxTokens,
        stallS: DEFAULT_SETTINGS.chatStallS / SCALE,
        timeoutS: DEFAULT_SETTINGS.chatTimeoutS / SCALE,
      },
    });
    expect(r.stopReason).toBe('stop');
    expect(r.turns).toBe(4);
    expect(r.text).toBe('Here is your template.');
  });

  it('died under the old flat wall clock', async () => {
    const sse = new ScriptedSse().script(...script());
    const r = await runAgent(gatewayWith(sse), {
      ...req,
      dispatcher: disp(),
      budgets: { maxTurns: 16, maxTokens: 120_000, timeoutS: 600 / SCALE },
    });
    expect(r.stopReason).toBe('timeout');
  });
});
