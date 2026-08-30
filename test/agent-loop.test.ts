import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FakeLlama } from './fake-llama.js';
import { gatewayFor, RecordingDispatcher } from './model-stack.js';
import { runAgent } from '../src/model/agent-loop.js';
import { MemoryTraceSink } from '../src/model/types.js';
import type { ModelGateway } from '../src/model/gateway.js';

describe('agent loop', () => {
  let fake: FakeLlama;
  let gw: ModelGateway;

  beforeEach(async () => {
    fake = new FakeLlama();
    gw = gatewayFor(await fake.startV1());
  });
  afterEach(async () => {
    await fake.stop();
  });

  const base = {
    selector: { purpose: 'chat' as const },
    priority: 'event' as const,
    system: 'system prompt',
    messages: [{ role: 'user' as const, content: 'do the thing' }],
  };

  it('returns after one turn when the model just answers', async () => {
    fake.script({ text: 'done', usage: { prompt: 50, completion: 3 } });
    const trace = new MemoryTraceSink();
    const r = await runAgent(gw, { ...base, trace });
    expect(r.text).toBe('done');
    expect(r.turns).toBe(1);
    expect(r.stopReason).toBe('stop');
    expect(r.tokensIn).toBe(50);
    expect(r.tokensOut).toBe(3);
    expect(r.endpoint).toBe('fake');
    expect(trace.ofKind('llm_call')).toHaveLength(1);
  });

  it('executes tool calls through the dispatcher and feeds results back', async () => {
    fake.script(
      { toolCalls: [{ name: 'lookup', args: { q: 'weather' } }] },
      { text: 'It is raining.' },
    );
    const disp = new RecordingDispatcher({ lookup: (a) => ({ answer: `about ${a.q}` }) });
    const trace = new MemoryTraceSink();
    const r = await runAgent(gw, { ...base, dispatcher: disp, trace });

    expect(disp.calls).toHaveLength(1);
    expect(disp.calls[0]?.args).toEqual({ q: 'weather' });
    expect(r.turns).toBe(2);
    expect(r.toolCallCount).toBe(1);
    expect(r.text).toBe('It is raining.');
    expect(r.stopReason).toBe('stop');

    // The tool result reached the model on the second call.
    const second = fake.requests.at(-1)!.body;
    const toolMsg = second.messages.find((m: any) => m.role === 'tool');
    expect(JSON.stringify(toolMsg)).toContain('about weather');

    const toolTrace = trace.ofKind('tool_call') as any[];
    expect(toolTrace[0].tool).toBe('lookup');
    expect(toolTrace[0].ok).toBe(true);
    expect(toolTrace[0].result_excerpt).toContain('about weather');
  });

  it('flags identical repeated calls and serves the 4th from cache (§20.7)', async () => {
    // The circling backstop: a model that lost the thread re-issues the same
    // call. Repeats 2–3 execute but say so; from the 4th the cached result
    // comes back without touching the tool.
    const same = { toolCalls: [{ name: 'lookup', args: { q: 'NO5' } }] };
    fake.script(same, same, same, same, same, { text: 'ok I will stop' });
    const disp = new RecordingDispatcher({ lookup: () => ({ price: 1.49 }) });
    const r = await runAgent(gw, { ...base, dispatcher: disp });

    expect(r.stopReason).toBe('stop');
    // 5 calls issued by the model, but the tool ran only 3 times.
    expect(r.toolCallCount).toBe(5);
    expect(disp.calls).toHaveLength(3);

    const finalMessages = fake.requests.at(-1)!.body.messages as any[];
    const wire = JSON.stringify(finalMessages);
    expect(wire).toContain('identical to your earlier lookup call');
    expect(wire).toContain('Stop repeating it');
    // The data still reaches the model every time — the note wraps, never hides.
    expect(wire).toContain('1.49');
  });

  it('leaves zero-arg calls out of the repeat backstop — time passes', async () => {
    const same = { toolCalls: [{ name: 'now', args: {} }] };
    fake.script(same, same, same, same, { text: 'done' });
    let tick = 0;
    const disp = new RecordingDispatcher({ now: () => ({ t: (tick += 1) }) });
    const r = await runAgent(gw, { ...base, dispatcher: disp });
    expect(r.stopReason).toBe('stop');
    // Every call executed — no wrapping, no cache.
    expect(disp.calls).toHaveLength(4);
    expect(JSON.stringify(fake.requests.at(-1)!.body.messages)).not.toContain('repeated_call');
  });

  it('stops a runaway loop at max_turns', async () => {
    fake.always({ toolCalls: [{ name: 'lookup', args: { q: 'again' } }] });
    const disp = new RecordingDispatcher({ lookup: () => ({ more: true }) });
    const r = await runAgent(gw, {
      ...base,
      dispatcher: disp,
      budgets: { maxTurns: 3 },
    });
    expect(r.stopReason).toBe('max_turns');
    expect(r.turns).toBe(3);
    expect(disp.calls).toHaveLength(3);
  });

  it('stops on the token budget', async () => {
    fake.always({
      toolCalls: [{ name: 'lookup', args: { q: 'x' } }],
      usage: { prompt: 400, completion: 100 },
    });
    const disp = new RecordingDispatcher({ lookup: () => ({}) });
    const r = await runAgent(gw, {
      ...base,
      dispatcher: disp,
      budgets: { maxTokens: 1200, maxTurns: 50 },
    });
    expect(r.stopReason).toBe('max_tokens');
    // New tokens, not re-sent prompts: one 400-token prompt plus 100 output a
    // turn crosses 1200 on the eighth check.
    expect(r.turns).toBe(8);
    expect(r.promptTokens + r.tokensOut).toBeGreaterThanOrEqual(1200);
  });

  it('stops on the wall-clock timeout', async () => {
    fake.always({ text: 'eventually', delayMs: 400 });
    const started = Date.now();
    const r = await runAgent(gw, { ...base, budgets: { timeoutS: 0.15 } });
    expect(r.stopReason).toBe('timeout');
    expect(r.error).toMatch(/timeout/);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('survives a malformed tool call and gives the model a correction', async () => {
    fake.script(
      { toolCalls: [{ name: 'lookup', args: '{"q": oops' }] },
      { text: 'recovered without the tool' },
    );
    const disp = new RecordingDispatcher({ lookup: () => ({}) });
    const trace = new MemoryTraceSink();
    const r = await runAgent(gw, { ...base, dispatcher: disp, trace });

    expect(disp.calls).toHaveLength(0);
    expect(r.stopReason).toBe('stop');
    expect(r.text).toBe('recovered without the tool');
    const lastUser = fake.requests
      .at(-1)!
      .body.messages.filter((m: any) => m.role === 'user')
      .at(-1);
    expect(JSON.stringify(lastUser)).toMatch(/could not be parsed/);
    expect((trace.ofKind('tool_call') as any[])[0].ok).toBe(false);
  });

  it('sends a name it does not render to the dispatcher, not back as a correction', async () => {
    /**
     * The SDK rejects an unknown tool name before we see it. Treating that as
     * malformed arguments would make F.7.3's `not_granted` refusal unreachable
     * — and, once paging exists, would refuse a granted-but-closed tool
     * (§21.2.4). So it is dispatched, and the dispatcher decides.
     */
    fake.script(
      { toolCalls: [{ name: 'not_in_the_set', args: { q: 'x' } }] },
      { text: 'fair enough' },
    );
    const disp = new RecordingDispatcher({ lookup: () => ({}) });
    const trace = new MemoryTraceSink();
    const r = await runAgent(gw, { ...base, dispatcher: disp, trace });

    expect(disp.calls.map((c) => c.name)).toEqual(['not_in_the_set']);
    expect(r.stopReason).toBe('stop');
    const rec = (trace.ofKind('tool_call') as any[])[0];
    expect(rec.ok).toBe(false);
    expect(rec.denied).toBe('not_granted');
    // It comes back as a tool result, so the transcript stays well-formed.
    const toolMsg = fake.requests.at(-1)!.body.messages.find((m: any) => m.role === 'tool');
    expect(JSON.stringify(toolMsg)).toContain('unknown_tool');
  });

  it('keeps going when the dispatcher itself throws', async () => {
    fake.script({ toolCalls: [{ name: 'boom', args: { q: 'x' } }] }, { text: 'handled' });
    const disp = new RecordingDispatcher({ boom: () => ({}) }, { throwOn: 'boom' });
    const r = await runAgent(gw, { ...base, dispatcher: disp });
    expect(r.stopReason).toBe('stop');
    expect(r.text).toBe('handled');
    const toolMsg = fake.requests.at(-1)!.body.messages.find((m: any) => m.role === 'tool');
    expect(JSON.stringify(toolMsg)).toContain('tool_failed');
  });

  it('reports an endpoint failure as stopReason error, with a trace row', async () => {
    fake.always({ errorStatus: 500 });
    const trace = new MemoryTraceSink();
    const r = await runAgent(gw, { ...base, trace });
    expect(r.stopReason).toBe('error');
    expect(r.error).toBeTruthy();
    expect(trace.ofKind('error')).toHaveLength(1);
  });

  it('honours an external abort signal', async () => {
    fake.always({ text: 'slow', delayMs: 300 });
    const ac = new AbortController();
    setTimeout(() => ac.abort(new Error('user left')), 40);
    const r = await runAgent(gw, { ...base, abortSignal: ac.signal });
    expect(r.stopReason).toBe('aborted');
  });

  it('streams deltas from the loop when asked', async () => {
    fake.script({ text: 'streamed answer here' });
    const chunks: string[] = [];
    const r = await runAgent(gw, { ...base, onDelta: (t) => chunks.push(t) });
    expect(chunks.join('')).toBe('streamed answer here');
    expect(r.text).toBe('streamed answer here');
  });

  it('cannot call tools when no dispatcher is given (ingress agent, §5.3)', async () => {
    fake.script({ text: 'classified' });
    await runAgent(gw, { ...base });
    expect(fake.requests.at(-1)?.body.tools).toBeUndefined();
  });
});

describe('token budget accounting', () => {
  let fake: FakeLlama;
  let gw: ModelGateway;

  beforeEach(async () => {
    fake = new FakeLlama();
    gw = gatewayFor(await fake.startV1());
  });
  afterEach(async () => {
    await fake.stop();
  });

  const base = {
    selector: { purpose: 'chat' as const },
    priority: 'event' as const,
    system: 'system prompt',
    messages: [{ role: 'user' as const, content: 'do the thing' }],
  };

  it('does not charge the same prompt once per turn', async () => {
    // A prompt of ~7.5k re-sent four times is 7.5k of context, not 30k of work.
    fake.always({
      toolCalls: [{ name: 'lookup', args: { q: 'again' } }],
      usage: { prompt: 7500, completion: 100 },
    });
    const disp = new RecordingDispatcher({ lookup: () => ({}) });
    const r = await runAgent(gw, {
      ...base,
      dispatcher: disp,
      budgets: { maxTurns: 4, maxTokens: 30_000 },
    });
    // Four turns run to completion: the budget was never the limit.
    expect(r.stopReason).toBe('max_turns');
    expect(r.turns).toBe(4);
    // Cost is still reported in full — you pay per call.
    expect(r.tokensIn).toBe(30_000);
    // But context use is one prompt.
    expect(r.promptTokens).toBe(7500);
  });

  it('still stops a genuine runaway, counting output', async () => {
    fake.always({
      toolCalls: [{ name: 'lookup', args: { q: 'x' } }],
      usage: { prompt: 1000, completion: 4000 },
    });
    const disp = new RecordingDispatcher({ lookup: () => ({}) });
    const r = await runAgent(gw, {
      ...base,
      dispatcher: disp,
      budgets: { maxTurns: 50, maxTokens: 10_000 },
    });
    expect(r.stopReason).toBe('max_tokens');
    // 1000 prompt + n*4000 output crosses 10k on the third check.
    expect(r.turns).toBeLessThan(5);
    expect(r.tokensOut).toBeGreaterThanOrEqual(8000);
  });

  it('stops immediately when the prompt alone exceeds the budget', async () => {
    fake.always({
      toolCalls: [{ name: 'lookup', args: { q: 'x' } }],
      usage: { prompt: 50_000, completion: 10 },
    });
    const disp = new RecordingDispatcher({ lookup: () => ({}) });
    const r = await runAgent(gw, {
      ...base,
      dispatcher: disp,
      budgets: { maxTurns: 10, maxTokens: 20_000 },
    });
    expect(r.stopReason).toBe('max_tokens');
    expect(r.turns).toBe(1);
    expect(r.promptTokens).toBe(50_000);
  });
});
/**
 * The fabrication guard (§20.8). The adversarial suite that stays in CI: a
 * scripted model that *narrates* tool use instead of calling it must not get
 * that text into the run's output, whatever else happens to the run.
 */
describe('reserved markers in fresh output (§20.8)', () => {
  let fake: FakeLlama;
  let gw: ModelGateway;

  beforeEach(async () => {
    fake = new FakeLlama();
    gw = gatewayFor(await fake.startV1());
  });
  afterEach(async () => {
    await fake.stop();
  });

  const base = {
    selector: { purpose: 'chat' as const },
    priority: 'event' as const,
    system: 'system prompt',
    messages: [{ role: 'user' as const, content: 'add mobile chat to the todo' }],
  };

  it('rejects the legacy prose form, retries once, and keeps the second answer', async () => {
    fake.script(
      { text: '(used tools: files.append)\nAdded:\n\n```\n- [ ] Mobile chat\n```' },
      { text: 'Added it.' },
    );
    const trace = new MemoryTraceSink();
    const r = await runAgent(gw, { ...base, trace });

    expect(r.turns).toBe(2);
    expect(r.stopReason).toBe('stop');
    // Neither display nor context carries the rejected text: it was never said.
    expect(r.assistantText).toBe('Added it.');
    expect(r.contextText).toBe('Added it.');
    expect(r.text).toBe('Added it.');
    expect(JSON.stringify(r.messages)).not.toContain('Mobile chat');
    // The only place the pattern survives is the corrective note — a user-role
    // system message forbidding it. No assistant turn models it.
    const assistantVoice = r.messages.filter((m) => m.role === 'assistant');
    expect(JSON.stringify(assistantVoice)).not.toContain('used tools');

    const note = fake.requests[1]!.body.messages.at(-1);
    expect(note.role).toBe('user');
    expect(note.content).toContain('claiming tool use is not tool use');
    // The way out for the reply that meant to discuss a marker (§20.8).
    expect(note.content).toContain('describe it without writing it verbatim');
    // The excerpt is the forensic half: what the model tried to fabricate,
    // recorded where only the trace can see it (§20.8, C.1).
    expect(trace.ofKind('error')).toEqual([
      {
        message: 'reserved_marker_in_output',
        markers: ['(used tools:'],
        outcome: 'retried',
        excerpt: '(used tools: files.append)\nAdded:\n\n```\n- [ ] Mobile chat\n```',
      },
    ]);
  });

  /**
   * The loop already claims, in a comment beside the strip, that "the turn the
   * user sees and the turn the model re-reads are both clean". That was true of
   * the *settled* turn and false of the streamed one: deltas go out while the
   * text is still arriving, so a rejected turn had already been shown before
   * anything examined it. Reported from live use as "the chat often outputs
   * internal [[...]] tags".
   */
  it('does not leave a rejected turn on the screen it already streamed to', async () => {
    fake.script({ text: 'Added it.\n[[used tools: files.append]]' }, { text: 'Added it.' });
    const seen: string[] = [];
    let retracted = 0;
    const r = await runAgent(gw, {
      ...base,
      onDelta: (t) => seen.push(t),
      onRetract: () => {
        retracted += 1;
        seen.length = 0;
      },
    });
    expect(r.turns).toBe(2);
    // The retry's answer is what the caller is left holding.
    expect(seen.join('')).toBe('Added it.');
    // And the rejected turn was taken back rather than simply followed by the
    // replacement, which is what put two answers on screen.
    expect(retracted).toBe(1);
    expect(seen.join('')).not.toContain('[[used tools:');
  });

  it('rejects the marker form too, wherever it sits in the reply', async () => {
    fake.script({ text: 'Done.\n[[used tools: files.append]]' }, { text: 'Done.' });
    const trace = new MemoryTraceSink();
    const r = await runAgent(gw, { ...base, trace });
    expect(r.turns).toBe(2);
    expect(r.contextText).toBe('Done.');
    expect((trace.ofKind('error')[0] as any).markers).toEqual(['[[used tools:']);
  });

  it('drops the rejected response whole — its tool calls are never dispatched', async () => {
    // The dangerous shape: a marker AND a real call. Executing the call and
    // then asking again is how one append becomes two.
    fake.script(
      {
        text: '[[used tools: lookup]]\nLooked it up.',
        toolCalls: [{ name: 'lookup', args: { q: 'NO5' } }],
      },
      { text: 'Nothing to look up.' },
    );
    const disp = new RecordingDispatcher({ lookup: () => ({ price: 1.49 }) });
    const r = await runAgent(gw, { ...base, dispatcher: disp });

    expect(disp.calls).toEqual([]);
    expect(r.toolCallCount).toBe(0);
    expect(r.toolsUsed).toEqual([]);
    expect(r.contextText).toBe('Nothing to look up.');
  });

  it('replaces what it streamed when a repeat offence is stripped', async () => {
    // The offender streams twice and there is no third attempt, so retracting
    // alone would leave the turn blank. The cleaned remains have to be put
    // where the offending text was.
    fake.always({ text: '[[used tools: files.append]]\nAdded it, honestly.' });
    let shown = '';
    const r = await runAgent(gw, {
      ...base,
      onDelta: (t) => {
        shown += t;
      },
      onRetract: () => {
        shown = '';
      },
    });
    expect(r.turns).toBe(2);
    expect(shown).toBe('Added it, honestly.');
    expect(shown).not.toContain('[[used tools:');
    // What the screen ends up with and what the model re-reads agree, which is
    // what the guard claimed all along.
    expect(shown).toBe(r.contextText);
  });

  it('strips a repeat offence, delivers what is left, and traces it', async () => {
    fake.always({ text: '[[used tools: files.append]]\nAdded it, honestly.' });
    const trace = new MemoryTraceSink();
    const r = await runAgent(gw, { ...base, trace });

    // One retry, then the second offence is stripped rather than killing the run.
    expect(r.turns).toBe(2);
    expect(r.stopReason).toBe('stop');
    expect(r.contextText).toBe('Added it, honestly.');
    expect(r.assistantText).not.toContain('used tools');
    // Both rows carry the offending text as the model wrote it — the stripped
    // branch excerpts pre-strip, not the cleaned remains the user sees.
    const offence = '[[used tools: files.append]]\nAdded it, honestly.';
    expect(trace.ofKind('error')).toEqual([
      {
        message: 'reserved_marker_in_output',
        markers: ['[[used tools:'],
        outcome: 'retried',
        excerpt: offence,
      },
      {
        message: 'reserved_marker_in_output',
        markers: ['[[used tools:'],
        outcome: 'stripped',
        excerpt: offence,
      },
    ]);
  });

  it('caps the traced excerpt at C.1 length, so a long fabrication cannot bloat the trace', async () => {
    const long = `[[used tools: files.append]]\n${'a'.repeat(3000)}`;
    fake.always({ text: long });
    const trace = new MemoryTraceSink();
    await runAgent(gw, { ...base, trace });

    const rows = trace.ofKind('error') as { excerpt: string }[];
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.excerpt).toHaveLength(1000);
      expect(row.excerpt).toBe(long.slice(0, 1000));
    }
  });

  it('gives back the retry after a clean response (App. A: one per response)', async () => {
    fake.script(
      { text: '[[used tools: lookup]]\nfirst offence' },
      { toolCalls: [{ name: 'lookup', args: { q: 'x' } }] },
      { text: '[[used tools: lookup]]\nsecond offence' },
      { text: 'clean at last' },
    );
    const disp = new RecordingDispatcher({ lookup: () => ({ ok: true }) });
    const trace = new MemoryTraceSink();
    const r = await runAgent(gw, { ...base, dispatcher: disp, trace });

    expect(r.contextText).toBe('clean at last');
    // Both offences were retried; neither was stripped, because the clean turn
    // in between restored the budget.
    expect(trace.ofKind('error').map((e: any) => e.outcome)).toEqual(['retried', 'retried']);
  });

  it('leaves an ordinary reply untouched, brackets and all', async () => {
    fake.script({ text: 'See [[the docs]] — nothing reserved about that.' });
    const trace = new MemoryTraceSink();
    const r = await runAgent(gw, { ...base, trace });
    expect(r.turns).toBe(1);
    expect(r.contextText).toBe('See [[the docs]] — nothing reserved about that.');
    expect(trace.ofKind('error')).toEqual([]);
  });
});
