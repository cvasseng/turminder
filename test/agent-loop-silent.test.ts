import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FakeLlama } from './fake-llama.js';
import { gatewayFor, RecordingDispatcher } from './model-stack.js';
import { bootService, type ServiceHarness } from './service-harness.js';
import { runAgent } from '../src/model/agent-loop.js';
import { MemoryTraceSink } from '../src/model/types.js';
import type { ModelGateway } from '../src/model/gateway.js';

/** §20.10 — the shipped text, byte for byte. */
const NOTE =
  'System note: your last turn ended without a reply or a tool call, so ' +
  'nothing happened — reasoning is not seen by anyone. Do what you were ' +
  'working toward now: call the tool, or answer.';

interface ErrorRow {
  message: string;
  outcome?: string;
  reasoning_chars?: number;
}
const silentRows = (trace: MemoryTraceSink) =>
  (trace.ofKind('error') as ErrorRow[]).filter((r) => r.message === 'silent_turn');

describe('the silent turn (§20.10)', () => {
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
    messages: [{ role: 'user' as const, content: 'build the template' }],
  };

  it('nudges once at the tail, and the second call answers', async () => {
    const thought = 'I should call the tool and then write it up. '.repeat(20);
    fake.script({ reasoning: thought }, { text: 'Here it is.' });
    const trace = new MemoryTraceSink();
    const r = await runAgent(gw, { ...base, trace, onDelta: () => {} });

    expect(r.stopReason).toBe('stop');
    expect(r.turns).toBe(2);
    expect(r.text).toBe('Here it is.');
    expect(r.assistantText).toBe('Here it is.');
    expect(r.contextText).toBe('Here it is.');

    // A user-role note appended at the tail; everything before it is the
    // first request, byte for byte — the prefix is untouched (§20.5).
    const first = fake.requests[0]!.body.messages as unknown[];
    const second = fake.requests[1]!.body.messages as { role: string; content: string }[];
    expect(second.slice(0, first.length)).toEqual(first);
    expect(second).toHaveLength(first.length + 1);
    expect(second.at(-1)).toEqual({ role: 'user', content: NOTE });

    expect(silentRows(trace)).toEqual([
      { message: 'silent_turn', outcome: 'nudged', reasoning_chars: thought.length },
    ]);
  });

  it('nudges a non-streamed run the same way (handlers too)', async () => {
    fake.script({ reasoning: 'thinking' }, { text: 'done' });
    const trace = new MemoryTraceSink();
    const r = await runAgent(gw, { ...base, trace });
    expect(r.stopReason).toBe('stop');
    expect(r.text).toBe('done');
    expect(silentRows(trace)[0]?.outcome).toBe('nudged');
  });

  it('gives up on a second silent turn, as before', async () => {
    fake.always({ reasoning: 'still thinking' });
    const trace = new MemoryTraceSink();
    const r = await runAgent(gw, { ...base, trace, onDelta: () => {} });

    expect(r.stopReason).toBe('stop');
    expect(r.turns).toBe(2);
    expect(r.text).toBe('');
    expect(r.assistantText).toBe('');
    expect(fake.requests).toHaveLength(2);
    expect(silentRows(trace).map((x) => x.outcome)).toEqual(['nudged', 'gave_up']);
    // Once per run: the note was sent exactly once.
    const last = JSON.stringify(fake.requests[1]!.body.messages);
    expect(last.split('System note: your last turn').length - 1).toBe(1);
  });

  it('is not restored by a productive turn in between (once per run)', async () => {
    fake.script(
      { reasoning: 'a' },
      { toolCalls: [{ name: 'lookup', args: { q: 'x' } }] },
      { reasoning: 'b' },
    );
    const trace = new MemoryTraceSink();
    const disp = new RecordingDispatcher({ lookup: () => ({ v: 1 }) });
    const r = await runAgent(gw, { ...base, trace, dispatcher: disp });
    expect(r.turns).toBe(3);
    expect(silentRows(trace).map((x) => x.outcome)).toEqual(['nudged', 'gave_up']);
  });

  it('does not nudge on the last allowed turn', async () => {
    fake.always({ reasoning: 'thinking' });
    const trace = new MemoryTraceSink();
    const r = await runAgent(gw, { ...base, trace, budgets: { maxTurns: 1 } });
    expect(fake.requests).toHaveLength(1);
    expect(r.turns).toBe(1);
    expect(silentRows(trace)).toEqual([
      { message: 'silent_turn', outcome: 'gave_up', reasoning_chars: 'thinking'.length },
    ]);
    expect(JSON.stringify(r.messages)).not.toContain('System note: your last turn');
  });

  it('does not nudge with no token budget left', async () => {
    // 10 prompt + 5 out = the whole budget after one call (loop-top check).
    fake.always({ reasoning: 'thinking', usage: { prompt: 10, completion: 5 } });
    const trace = new MemoryTraceSink();
    const r = await runAgent(gw, { ...base, trace, budgets: { maxTokens: 15 } });
    expect(fake.requests).toHaveLength(1);
    expect(r.turns).toBe(1);
    expect(silentRows(trace).map((x) => x.outcome)).toEqual(['gave_up']);
    expect(JSON.stringify(r.messages)).not.toContain('System note: your last turn');
  });

  it('a §20.8-rejected turn is not a silent turn', async () => {
    fake.script({ text: '(used tools: files.append)' }, { text: 'Added it.' });
    const trace = new MemoryTraceSink();
    const r = await runAgent(gw, { ...base, trace });
    expect(r.text).toBe('Added it.');
    expect(silentRows(trace)).toEqual([]);
  });

  it('a §20.8 strip that leaves nothing is not a silent turn either', async () => {
    fake.always({ text: '(used tools: files.append)' });
    const trace = new MemoryTraceSink();
    const r = await runAgent(gw, { ...base, trace });
    expect(r.stopReason).toBe('stop');
    expect(fake.requests).toHaveLength(2);
    expect(silentRows(trace)).toEqual([]);
  });

  it('a turn with only an invalid tool call is not a silent turn', async () => {
    fake.script(
      { reasoning: 'call it', toolCalls: [{ name: 'lookup', args: '{not json' }] },
      { text: 'ok then' },
    );
    const trace = new MemoryTraceSink();
    const disp = new RecordingDispatcher({ lookup: () => ({}) });
    const r = await runAgent(gw, { ...base, trace, dispatcher: disp });
    expect(r.text).toBe('ok then');
    expect(silentRows(trace)).toEqual([]);
    expect(JSON.stringify(fake.requests[1]!.body.messages)).not.toContain(
      'System note: your last turn',
    );
  });

  it('a turn cut off by length is not a silent turn', async () => {
    fake.script({ reasoning: 'long', finishReason: 'length' });
    const trace = new MemoryTraceSink();
    await runAgent(gw, { ...base, trace });
    expect(fake.requests).toHaveLength(1);
    expect(silentRows(trace)).toEqual([]);
  });
});

describe('the silent turn in chat (§20.10, §20.2)', () => {
  let h: ServiceHarness;
  afterEach(async () => {
    await h?.cleanup();
  });

  it('answers after the nudge, and the note is neither persisted nor re-read', async () => {
    h = await bootService({ onboarded: true });
    h.fake.script({ reasoning: 'I will answer Oslo.' }, { text: 'Oslo.' });
    const sent = h.service.chat.send({ text: 'Capital of Norway?' });
    await h.service.queue.drain();

    const run = h.service.repos.runs.forEvent(sent.eventId)[0]!;
    expect(run.status).toBe('done');
    const turns = h.service.repos.conversations.history(sent.conversationId);
    expect(turns.map((t) => [t.role, t.text])).toEqual([
      ['user', 'Capital of Norway?'],
      ['assistant', 'Oslo.'],
    ]);
    expect(JSON.stringify(turns)).not.toContain('System note');
    const rows = h.service.repos.trace.forEvent(sent.eventId);
    expect(
      rows.some(
        (r) =>
          r.kind === 'error' &&
          (r.data as { message?: string; outcome?: string }).message === 'silent_turn' &&
          (r.data as { outcome?: string }).outcome === 'nudged',
      ),
    ).toBe(true);

    h.fake.always({ text: 'ack' });
    h.service.chat.send({ conversationId: sent.conversationId, text: 'thanks' });
    await h.service.queue.drain();
    const next = JSON.stringify(h.fake.requests.at(-1)!.body.messages);
    expect(next).toContain('Oslo.');
    expect(next).not.toContain('System note: your last turn');
  });

  it('fails the run on a second silent turn, as before', async () => {
    h = await bootService({ onboarded: true });
    h.fake.always({ reasoning: 'hmm' });
    const sent = h.service.chat.send({ text: 'hello?' });
    await h.service.queue.drain();
    expect(h.service.repos.conversations.history(sent.conversationId)).toHaveLength(1);
    const run = h.service.repos.runs.forEvent(sent.eventId)[0]!;
    expect(run.status).toBe('failed');
    expect(run.error).toBe('empty response');
  });
});
