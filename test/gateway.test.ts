import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FakeLlama } from './fake-llama.js';
import { gatewayFor, RecordingDispatcher } from './model-stack.js';
import { MemoryTraceSink, type LlmCallTrace } from '../src/model/types.js';
import type { ModelGateway } from '../src/model/gateway.js';

describe('ModelGateway against a llama.cpp-shaped endpoint', () => {
  let fake: FakeLlama;
  let url: string;
  let gw: ModelGateway;

  beforeEach(async () => {
    fake = new FakeLlama();
    url = await fake.startV1();
    gw = gatewayFor(url);
  });
  afterEach(async () => {
    await fake.stop();
  });

  it('completes a non-streaming turn and traces it', async () => {
    fake.script({ text: 'Hello there.', usage: { prompt: 120, completion: 7 } });
    const trace = new MemoryTraceSink();
    const r = await gw.turn({
      selector: { class: 'fast' },
      priority: 'interactive',
      system: 'be brief',
      messages: [{ role: 'user', content: 'hi' }],
      trace,
    });
    expect(r.text).toBe('Hello there.');
    expect(r.tokensIn).toBe(120);
    expect(r.tokensOut).toBe(7);
    expect(r.finishReason).toBe('stop');
    expect(r.endpoint.name).toBe('fake');

    const [rec] = trace.ofKind('llm_call') as LlmCallTrace[];
    expect(rec?.model).toBe('fake');
    expect(rec?.priority).toBe('interactive');
    expect(rec?.tokens_in).toBe(120);
    expect(rec?.queue_wait_ms).toBe(0);
    expect(rec?.duration_ms).toBeGreaterThanOrEqual(0);
  });

  it('streams deltas as they arrive', async () => {
    fake.script({ text: 'one two three four' });
    const deltas: string[] = [];
    const r = await gw.turn({
      selector: {},
      priority: 'interactive',
      system: 's',
      messages: [{ role: 'user', content: 'go' }],
      onDelta: (t) => deltas.push(t),
    });
    expect(deltas.length).toBeGreaterThan(1);
    expect(deltas.join('')).toBe('one two three four');
    expect(r.text).toBe('one two three four');
    expect(fake.requests.at(-1)?.body.stream).toBe(true);
  });

  it('sends the system prompt and messages in OpenAI shape', async () => {
    fake.script({ text: 'ack' });
    await gw.turn({
      selector: {},
      priority: 'event',
      system: 'SYSTEM-PREFIX',
      messages: [{ role: 'user', content: 'question' }],
    });
    const body = fake.requests.at(-1)!.body;
    expect(body.messages[0]).toEqual({ role: 'system', content: 'SYSTEM-PREFIX' });
    expect(body.messages[1].role).toBe('user');
    expect(body.cache_prompt).toBe(true);
  });

  it('parses tool calls', async () => {
    fake.script({ toolCalls: [{ name: 'web_search', args: { q: 'oslo' } }] });
    const disp = new RecordingDispatcher({ web_search: () => ({ results: [] }) });
    const r = await gw.turn({
      selector: { caps: ['tools'] },
      priority: 'event',
      system: 's',
      messages: [{ role: 'user', content: 'search' }],
      tools: disp.toolSet(),
    });
    expect(r.toolCalls).toHaveLength(1);
    expect(r.toolCalls[0]?.toolName).toBe('web_search');
    expect(r.toolCalls[0]?.input).toEqual({ q: 'oslo' });
    expect(r.toolCalls[0]?.invalid).toBe(false);
    expect(r.finishReason).toBe('tool-calls');
    expect(fake.requests.at(-1)?.body.tools?.[0]?.function?.name).toBe('web_search');
  });

  /**
   * §11.5. Anthropic and OpenAI pin tool names to `^[a-zA-Z0-9_-]{1,128}$`, so
   * every dotted name in App. F is rejected outright — the failure that made
   * the capability probe report "no tool support" for models that have had it
   * for years.
   */
  it('sends dotted tool names as __ and hands them back dotted (§11.5)', async () => {
    fake.script({ toolCalls: [{ name: 'calendar.create_task', args: { title: 'x' } }] });
    const disp = new RecordingDispatcher({ 'calendar.create_task': () => ({ ok: true }) });
    const r = await gw.turn({
      selector: { caps: ['tools'] },
      priority: 'event',
      system: 's',
      messages: [{ role: 'user', content: 'book it' }],
      tools: disp.toolSet(),
    });
    // What the endpoint was offered: a name its regex accepts.
    const offered = (fake.requests.at(-1)?.body.tools ?? []).map((t: any) => t.function.name);
    expect(offered).toEqual(['calendar__create_task']);
    // What the rest of the system gets back: the name the catalog uses. The
    // underscore inside `create_task` survives, which a single-underscore
    // separator could not have promised.
    expect(r.toolCalls[0]?.toolName).toBe('calendar.create_task');
    expect(r.toolCalls[0]?.invalid).toBe(false);
  });

  /**
   * The reverse cannot depend on the request's own tool set. Under §21.2
   * paging a granted-but-closed namespace opens itself, so the model calls
   * tools that were never offered — and those are exactly the names a refusal
   * or an error is about to quote back at somebody.
   */
  it('reverses a tool name this request never offered', async () => {
    fake.script({ toolCalls: [{ name: 'config.write', args: {} }] });
    const disp = new RecordingDispatcher({ 'time.now': () => ({}) });
    const r = await gw.turn({
      selector: { caps: ['tools'] },
      priority: 'event',
      system: 's',
      messages: [{ role: 'user', content: 'write config' }],
      tools: disp.toolSet(),
    });
    expect(r.toolCalls[0]?.toolName).toBe('config.write');
    expect(r.toolCalls[0]?.unknownTool).toBe(true);
  });

  /** History names tools too, and rides along on every later step. */
  it('translates tool names already in the message history (§11.5)', async () => {
    fake.script({ text: 'done' });
    await gw.turn({
      selector: {},
      priority: 'event',
      system: 's',
      messages: [
        { role: 'user', content: 'go' },
        {
          role: 'assistant',
          content: [
            { type: 'tool-call', toolCallId: 'c1', toolName: 'memory.save', input: {} },
          ],
        },
        {
          role: 'tool',
          content: [
            {
              type: 'tool-result',
              toolCallId: 'c1',
              toolName: 'memory.save',
              output: { type: 'json', value: {} },
            },
          ],
        },
      ],
    });
    const sent = JSON.stringify(fake.requests.at(-1)?.body.messages);
    expect(sent).toContain('memory__save');
    expect(sent).not.toContain('memory.save');
  });

  it('flags a tool call with unparsable arguments instead of throwing', async () => {
    fake.script({ toolCalls: [{ name: 'web_search', args: '{"q": broken' }] });
    const disp = new RecordingDispatcher({ web_search: () => ({}) });
    const r = await gw.turn({
      selector: {},
      priority: 'event',
      system: 's',
      messages: [{ role: 'user', content: 'x' }],
      tools: disp.toolSet(),
    });
    expect(r.toolCalls).toHaveLength(1);
    expect(r.toolCalls[0]?.invalid).toBe(true);
    expect(r.toolCalls[0]?.error).toBeTruthy();
  });

  it('flags a call to a tool that does not exist', async () => {
    fake.script({ toolCalls: [{ name: 'not_a_tool', args: { q: 'x' } }] });
    const disp = new RecordingDispatcher({ web_search: () => ({}) });
    const r = await gw.turn({
      selector: {},
      priority: 'event',
      system: 's',
      messages: [{ role: 'user', content: 'x' }],
      tools: disp.toolSet(),
    });
    expect(r.toolCalls[0]?.invalid).toBe(true);
  });

  it('constrains output with a JSON schema (llama.cpp grammar path)', async () => {
    fake.script({ text: '{"ok":true}' });
    await gw.turn({
      selector: { caps: ['json'] },
      priority: 'event',
      system: 's',
      messages: [{ role: 'user', content: 'x' }],
      jsonSchema: {
        name: 'verdicts',
        schema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] },
      },
    });
    const rf = fake.requests.at(-1)!.body.response_format;
    expect(rf.type).toBe('json_schema');
    expect(rf.json_schema.name).toBe('verdicts');
    expect(rf.json_schema.schema.properties.ok.type).toBe('boolean');
  });

  it('passes a raw GBNF grammar through', async () => {
    fake.script({ text: 'yes' });
    await gw.turn({
      selector: {},
      priority: 'event',
      system: 's',
      messages: [{ role: 'user', content: 'x' }],
      grammar: 'root ::= "yes" | "no"',
    });
    expect(fake.requests.at(-1)?.body.grammar).toBe('root ::= "yes" | "no"');
  });

  it('records a trace row and rethrows when the endpoint errors', async () => {
    fake.always({ errorStatus: 500 });
    const trace = new MemoryTraceSink();
    await expect(
      gw.turn({
        selector: {},
        priority: 'event',
        system: 's',
        messages: [{ role: 'user', content: 'x' }],
        trace,
      }),
    ).rejects.toThrow();
    const rows = trace.ofKind('llm_call') as LlmCallTrace[];
    expect(rows.at(-1)?.stop_reason).toBe('error');
  });

  it('queues concurrent calls on one endpoint and reports the wait', async () => {
    fake.always({ text: 'slow', delayMs: 40 });
    const trace = new MemoryTraceSink();
    const call = (priority: 'interactive' | 'background') =>
      gw.turn({
        selector: {},
        priority,
        system: 's',
        messages: [{ role: 'user', content: priority }],
        trace,
      });
    await Promise.all([call('background'), call('interactive')]);
    const rows = trace.ofKind('llm_call') as LlmCallTrace[];
    expect(rows).toHaveLength(2);
    expect(rows.some((r) => r.queue_wait_ms > 10)).toBe(true);
  });
});
