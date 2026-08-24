import { afterEach, describe, expect, it } from 'vitest';
import { openDataHome } from '../src/core/datadir.js';
import { openDb } from '../src/db/index.js';
import { ConversationsRepo } from '../src/db/repos/conversations.js';
import { toModelMessages } from '../src/chat/history.js';
import { capResult, budgeted, TRUNCATION_HINT } from '../src/tools/budget.js';
import { elideStaleResults, stubBulkArgs } from '../src/model/elide.js';
import { reservedMarkers } from '../src/core/markers.js';
import type { ToolHandle } from '../src/tools/types.js';
import type { ModelMessage } from 'ai';
import { bootService, type ServiceHarness } from './service-harness.js';
import { tmpDir } from './helpers.js';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

let h: ServiceHarness;
afterEach(async () => {
  await h?.cleanup();
});

const drain = (harness: ServiceHarness) => harness.service.queue.drain();

function repoEnv() {
  const t = tmpDir('turminder-ctx-');
  const { home } = openDataHome(path.join(t.dir, 'home'));
  const db = openDb(home.dbPath);
  const repo = new ConversationsRepo(db);
  return {
    repo,
    cleanup: () => {
      db.close();
      t.cleanup();
    },
  };
}

/* ── §20.2 display vs context ─────────────────────────────────────────────── */

describe('display text vs context text (§20.2)', () => {
  it('stores both, and returns both', () => {
    const e = repoEnv();
    const conv = e.repo.create();
    const turn = e.repo.addTurn({
      conversationId: conv.id,
      role: 'assistant',
      text: 'Let me check…\n\nIt is 12 degrees in Bergen.',
      contextText: 'It is 12 degrees in Bergen.',
      toolsUsed: ['weather.forecast'],
    });
    expect(turn.text).toContain('Let me check');
    expect(turn.contextText).toBe('It is 12 degrees in Bergen.');

    const [read] = e.repo.history(conv.id);
    expect(read!.text).toContain('Let me check');
    expect(read!.contextText).toBe('It is 12 degrees in Bergen.');
    expect(read!.toolsUsed).toEqual(['weather.forecast']);
    e.cleanup();
  });

  it('falls back to text for rows written before the split — no migration', () => {
    const e = repoEnv();
    const conv = e.repo.create();
    // Exactly what an old row looks like: {text} and nothing else.
    e.repo.addTurn({ conversationId: conv.id, role: 'assistant', text: 'An older answer.' });
    const [read] = e.repo.history(conv.id);
    expect(read!.contextText).toBe('An older answer.');
    expect(read!.toolsUsed).toEqual([]);
    e.cleanup();
  });

  it('keeps user turns as one string for both purposes', () => {
    const e = repoEnv();
    const conv = e.repo.create();
    const turn = e.repo.addTurn({ conversationId: conv.id, role: 'user', text: 'hello' });
    expect(turn.contextText).toBe('hello');
    expect(toModelMessages([turn])).toEqual([{ role: 'user', content: 'hello' }]);
    e.cleanup();
  });

  it('composes the [[used tools: …]] marker at read time, never storing it', () => {
    const e = repoEnv();
    const conv = e.repo.create();
    e.repo.addTurn({ conversationId: conv.id, role: 'user', text: 'weather?' });
    e.repo.addTurn({
      conversationId: conv.id,
      role: 'assistant',
      text: 'Checking…\n\n12 degrees.',
      contextText: '12 degrees.',
      toolsUsed: ['weather.forecast', 'time.now'],
    });
    const messages = toModelMessages(e.repo.history(conv.id));
    // The system voice of §20.8, not prose the model could have written: the
    // prose form is what taught it to fabricate tool use.
    expect(messages).toEqual([
      { role: 'user', content: 'weather?' },
      { role: 'assistant', content: '[[used tools: weather.forecast, time.now]]\n12 degrees.' },
    ]);
    // The stored row has no such line: it is composed, not persisted.
    expect(e.repo.history(conv.id)[1]!.text).not.toContain('used tools');
    e.cleanup();
  });

  it('drops an assistant turn that said nothing and used nothing', () => {
    const e = repoEnv();
    const conv = e.repo.create();
    e.repo.addTurn({ conversationId: conv.id, role: 'user', text: 'hi' });
    e.repo.addTurn({
      conversationId: conv.id,
      role: 'assistant',
      text: 'narration only',
      contextText: '',
    });
    expect(toModelMessages(e.repo.history(conv.id))).toEqual([{ role: 'user', content: 'hi' }]);
    e.cleanup();
  });

  it('re-reads only the final answer on the next turn', async () => {
    h = await bootService({ onboarded: true, watchFiles: false });
    let asked = false;
    h.fake.always((req) => {
      if (req.body.tools && !asked) {
        asked = true;
        return {
          text: 'Let me look that up for you.',
          toolCalls: [{ name: 'time.now', args: {} }],
        };
      }
      return { text: 'It is Friday.' };
    });
    const first = h.service.chat.send({ text: 'what day is it?' });
    await drain(h);

    // Display keeps the narration the user watched stream.
    const stored = h.service.repos.conversations.history(first.conversationId);
    expect(stored[1]!.text).toContain('Let me look that up');
    expect(stored[1]!.contextText).toBe('It is Friday.');
    expect(stored[1]!.toolsUsed).toEqual(['time.now']);

    // The next turn re-reads the answer and the tool name, not the narration.
    h.fake.always({ text: 'Still Friday.' });
    h.service.chat.send({ conversationId: first.conversationId, text: 'and tomorrow?' });
    await drain(h);
    const messages = h.fake.requests.at(-1)!.body.messages as {
      role: string;
      content: string;
    }[];
    const history = messages.map((m) => m.content).join('\n');
    expect(history).not.toContain('Let me look that up');
    expect(history).toContain('It is Friday.');
    expect(history).toContain('[[used tools: time.now]]');
    expect(history).not.toContain('(used tools:');
  });
});

/* ── §20.3 tool-result budget ─────────────────────────────────────────────── */

const handle = (name: string, output: unknown, max?: number): ToolHandle => ({
  name,
  description: name,
  tier: 'ro',
  inputSchema: { type: 'object', properties: {} },
  source: name.split('.')[0]!,
  ...(max !== undefined ? { maxResultChars: max } : {}),
  call: async () => ({ ok: true, output }),
});

describe('tool-result budget at the hub boundary (§20.3)', () => {
  it('passes a result that fits through untouched', () => {
    const output = { ok: true, body: 'short' };
    const capped = capResult(output, 4000);
    // Identity, not a copy: the common case must not allocate.
    expect(capped.output).toBe(output);
    expect(capped.traceOutput).toBeUndefined();
  });

  it('replaces an oversized result with the truncation shape', () => {
    const output = { body: 'x'.repeat(50_000) };
    const capped = capResult(output, 4000) as {
      output: { _truncated: boolean; total_chars: number; excerpt: string; hint: string };
      traceOutput: unknown;
    };
    expect(capped.output._truncated).toBe(true);
    expect(capped.output.total_chars).toBe(JSON.stringify(output).length);
    expect(capped.output.excerpt).toHaveLength(4000);
    expect(capped.output.hint).toBe(TRUNCATION_HINT);
    // The original rides along for the trace.
    expect(capped.traceOutput).toBe(output);
  });

  it('measures a string result by its own length, not its JSON form', () => {
    expect(capResult('a'.repeat(100), 200).output).toBe('a'.repeat(100));
    expect((capResult('a'.repeat(300), 200).output as any)._truncated).toBe(true);
  });

  it('honours a per-tool override, and the default otherwise', async () => {
    const big = { body: 'y'.repeat(9000) };
    const capped = await budgeted(handle('web.fetch', big), 4000).call(
      {},
      {
        runId: null,
        eventId: null,
      },
    );
    expect((capped.output as any)._truncated).toBe(true);

    const raised = await budgeted(handle('files.read', big, 20_000), 4000).call(
      {},
      {
        runId: null,
        eventId: null,
      },
    );
    expect(raised.output).toBe(big);
    expect(raised.traceOutput).toBeUndefined();
  });

  it('raises the cap only for the tools whose job is returning a document', async () => {
    h = await bootService({ onboarded: true, watchFiles: false });
    const overrides = h.service.tools
      .handles()
      .filter((t) => t.maxResultChars !== undefined)
      .map((t) => t.name)
      .sort();
    // A deliberate, short list — every other tool, and everything external,
    // lives at the default (§20.3). `setup.list_integrations` joined it when
    // the roster outgrew 4000 chars: a half-listed capability list reads as
    // "those integrations do not exist", which is worse than a long result.
    expect(overrides).toEqual([
      'docs.outline',
      'docs.read',
      'embeds.read',
      'files.read',
      'setup.list_integrations',
      'web.fetch',
    ]);
  });

  it('caps an external MCP result at the default — the trace keeps the original', async () => {
    h = await bootService({ onboarded: true, watchFiles: false });
    const huge = 'z'.repeat(100_000);
    // An external server has no maxResultChars: overrides are bundled-only.
    const external: ToolHandle = {
      name: 'bulky.dump',
      description: 'returns far too much',
      tier: 'ro',
      inputSchema: { type: 'object', properties: {} },
      source: 'bulky',
      call: async () => ({ ok: true, output: { text: huge } }),
    };
    const wrapped = budgeted(external, h.app.config.settings.toolResultMaxChars);
    const result = await wrapped.call({}, { runId: null, eventId: null });
    const capped = result.output as { _truncated: boolean; excerpt: string };
    expect(capped._truncated).toBe(true);
    expect(capped.excerpt).toHaveLength(4000);
    expect(JSON.stringify(result.traceOutput)).toContain(huge);
  });

  it('order of operations: the trace shows the tool, the transcript shows the cap', async () => {
    h = await bootService({ onboarded: true, watchFiles: false, dataDefaults: {} });
    // web.fetch returns a page far over the budget.
    const page = `<html><body>${'q'.repeat(30_000)}</body></html>`;
    const fetchImpl = (async (url: any) => {
      if (String(url).includes('example.test')) {
        return new Response(page, { headers: { 'content-type': 'text/html' } });
      }
      return globalThis.fetch(url);
    }) as unknown as typeof globalThis.fetch;
    await h.cleanup();
    h = await bootService({ onboarded: true, watchFiles: false, fetch: fetchImpl });

    let asked = false;
    h.fake.always((req) => {
      if (req.body.tools && !asked) {
        asked = true;
        return {
          toolCalls: [{ name: 'web.fetch', args: { url: 'http://example.test/big' } }],
        };
      }
      return { text: 'That page was long.' };
    });
    const sent = h.service.chat.send({ text: 'read example.test' });
    await drain(h);

    // The trace records what the tool returned…
    const call = h.service.repos.trace
      .forEvent(sent.eventId)
      .find((t) => t.kind === 'tool_call')!.data as any;
    expect(call.result_excerpt).not.toContain('_truncated');
    expect(call.result_excerpt).toContain('qqqq');

    // …while the transcript the model saw got the capped shape.
    const toolMessage = (h.fake.requests.at(-1)!.body.messages as any[]).find(
      (m) => m.role === 'tool',
    );
    expect(JSON.stringify(toolMessage)).toContain('_truncated');
    expect(JSON.stringify(toolMessage)).toContain(TRUNCATION_HINT);
  });
});

/* ── §20.4 mid-run elision ────────────────────────────────────────────────── */

function toolResult(name: string, value: unknown): ModelMessage {
  return {
    role: 'tool',
    content: [
      {
        type: 'tool-result',
        toolCallId: `c-${name}`,
        toolName: name,
        output: { type: 'json', value: value as never },
      },
    ],
  };
}

const assistant = (text: string): ModelMessage => ({ role: 'assistant', content: text });

describe('mid-run elision of stale large results (§20.4)', () => {
  const settings = { thresholdChars: 2000, afterTurns: 2 };

  it('elides a big old result and leaves a recent one alone', () => {
    const messages: ModelMessage[] = [
      { role: 'user', content: 'go' },
      assistant('calling'),
      toolResult('web.fetch', { body: 'a'.repeat(3000) }),
      assistant('calling again'),
      toolResult('web.fetch', { body: 'b'.repeat(3000) }),
      assistant('and again'),
    ];
    const elided = elideStaleResults(messages, settings);
    expect(elided).toEqual(['web.fetch']);

    const first = (messages[2] as any).content[0].output.value;
    // A STRING marker, not an object (§20.4): objects sitting where data used
    // to be got pasted into tool calls. The digest keeps the model oriented.
    expect(typeof first).toBe('string');
    expect(first).toMatch(/^\[\[elided: web\.fetch result, \d+ chars/);
    expect(first).toContain('keys: body');
    expect(first).toContain('Never copy this marker');
    // Only one assistant turn after it: still fresh.
    expect((messages[4] as any).content[0].output.value.body).toContain('bbb');
  });

  it('leaves a small result alone however old it is', () => {
    const messages: ModelMessage[] = [
      toolResult('time.now', { iso: '2026-08-21T12:00:00.000Z' }),
      assistant('a'),
      assistant('b'),
      assistant('c'),
    ];
    expect(elideStaleResults(messages, settings)).toEqual([]);
    expect((messages[0] as any).content[0].output.value.iso).toBeTruthy();
  });

  it('is monotonic: an elided result never comes back', () => {
    const messages: ModelMessage[] = [
      toolResult('files.read', { body: 'c'.repeat(3000) }),
      assistant('one'),
      assistant('two'),
    ];
    expect(elideStaleResults(messages, settings)).toEqual(['files.read']);
    const stub = (messages[0] as any).content[0].output.value;
    // A second and third pass find nothing new and change nothing.
    expect(elideStaleResults(messages, settings)).toEqual([]);
    expect(elideStaleResults(messages, settings)).toEqual([]);
    expect((messages[0] as any).content[0].output.value).toBe(stub);
  });

  it('never touches tool calls, assistant text or user messages', () => {
    const call: ModelMessage = {
      role: 'assistant',
      content: [
        { type: 'text', text: 'thinking about it' },
        { type: 'tool-call', toolCallId: 'c1', toolName: 'web.fetch', input: { url: 'x' } },
      ],
    };
    const messages: ModelMessage[] = [
      { role: 'user', content: 'u'.repeat(5000) },
      call,
      toolResult('web.fetch', { body: 'd'.repeat(3000) }),
      assistant('a'),
      assistant('b'),
    ];
    const before = JSON.stringify([messages[0], messages[1]]);
    elideStaleResults(messages, settings);
    expect(JSON.stringify([messages[0], messages[1]])).toBe(before);
  });

  it('a tool-heavy run ends with stubs where the early results were', async () => {
    h = await bootService({ onboarded: true, watchFiles: false });
    // Six turns, each fetching something large, then an answer.
    const page = 'p'.repeat(3000);
    const fetchImpl = (async (url: any) => {
      if (String(url).includes('example.test')) {
        return new Response(page, { headers: { 'content-type': 'text/plain' } });
      }
      return globalThis.fetch(url);
    }) as unknown as typeof globalThis.fetch;
    await h.cleanup();
    h = await bootService({ onboarded: true, watchFiles: false, fetch: fetchImpl });

    let calls = 0;
    h.fake.always((req) => {
      if (req.body.tools && calls < 4) {
        calls += 1;
        return {
          toolCalls: [{ name: 'web.fetch', args: { url: `http://example.test/${calls}` } }],
        };
      }
      return { text: 'Read them all.' };
    });
    const sent = h.service.chat.send({ text: 'read four pages' });
    await drain(h);

    // The wire format the endpoint actually received: one tool message per
    // result, its content the serialized value.
    const final = h.fake.requests.at(-1)!.body.messages as { role: string; content: string }[];
    const results = final
      .filter((m) => m.role === 'tool')
      .map((m) => JSON.parse(m.content) as Record<string, unknown>);
    expect(results.length).toBe(4);
    const serialized = JSON.stringify(results);
    // The early ones are stubs; the most recent are still there in full.
    expect(serialized).toContain('[[elided:');
    expect(results.filter((r: any) => typeof r === 'string').length).toBeGreaterThan(0);
    expect(results.filter((r: any) => typeof r !== 'string').length).toBeGreaterThan(0);

    // And the trace still has the originals (§20.3/§20.4).
    const traced = h.service.repos.trace
      .forEvent(sent.eventId)
      .filter((t) => t.kind === 'tool_call')
      .map((t) => (t.data as any).result_excerpt)
      .join('\n');
    expect(traced).toContain('pppp');
    expect(traced).not.toContain('[[elided:');
  });
});

/* ── §20.6 bulk-content args ──────────────────────────────────────────────── */

describe('bulk-content tool args are elided too (§20.6)', () => {
  const toolCall = (id: string, name: string, input: unknown): ModelMessage => ({
    role: 'assistant',
    content: [
      { type: 'text', text: 'writing it' },
      { type: 'tool-call', toolCallId: id, toolName: name, input },
    ],
  });

  it('stubs the declared field and leaves every other arg verbatim', () => {
    const html = '<div>' + 'x'.repeat(30_000) + '</div>';
    const messages: ModelMessage[] = [
      { role: 'user', content: 'build me a chart' },
      toolCall('c1', 'files.write', { path: 'notes/a.md', content: html, message: 'add' }),
    ];
    expect(stubBulkArgs(messages, 'c1', ['content'])).toEqual(['content']);
    const input = (messages[1] as any).content[1].input;
    expect(input.path).toBe('notes/a.md');
    expect(input.message).toBe('add');
    expect(typeof input.content).toBe('string');
    expect(input.content).toMatch(/^\[\[stored: \d+ chars/);
    expect(input.content).toContain('Never copy this marker');
  });

  it('is monotonic: a stubbed field never comes back', () => {
    const messages: ModelMessage[] = [
      toolCall('c1', 'memory.save', { description: 'd', content: 'y'.repeat(4000) }),
    ];
    expect(stubBulkArgs(messages, 'c1', ['content'])).toEqual(['content']);
    const stub = (messages[0] as any).content[1].input.content;
    expect(stubBulkArgs(messages, 'c1', ['content'])).toEqual([]);
    expect((messages[0] as any).content[1].input.content).toBe(stub);
  });

  it('ignores fields the call never sent, and unknown call ids', () => {
    const messages: ModelMessage[] = [toolCall('c1', 'memory.update', { name: 'kettle' })];
    expect(stubBulkArgs(messages, 'c1', ['content'])).toEqual([]);
    expect(stubBulkArgs(messages, 'nope', ['content'])).toEqual([]);
    expect((messages[0] as any).content[1].input).toEqual({ name: 'kettle' });
  });

  it('leaves the object the trace is holding untouched', () => {
    const original = { path: 'a.md', content: 'z'.repeat(3000), message: 'm' };
    const messages: ModelMessage[] = [toolCall('c1', 'files.write', original)];
    stubBulkArgs(messages, 'c1', ['content']);
    // The trace row and the activity line hold this object (§20.6).
    expect(original.content).toBe('z'.repeat(3000));
    expect((messages[0] as any).content[1].input).not.toBe(original);
  });

  it('a big files.write is a stub in later request bodies, with the original traced', async () => {
    h = await bootService({ onboarded: true, watchFiles: false });
    const body = 'q'.repeat(6000);
    let wrote = false;
    h.fake.always((req) => {
      if (req.body.tools && !wrote) {
        wrote = true;
        return {
          toolCalls: [
            {
              name: 'files.write',
              args: { path: 'notes/big.md', content: body, message: 'store the draft' },
            },
          ],
        };
      }
      return { text: 'Stored it.' };
    });
    const sent = h.service.chat.send({ text: 'save this draft' });
    await drain(h);

    // Not simply the last request: writing the file also triggers an embedding
    // call, which has no messages at all.
    const chats = h.fake.requests.filter((r) => Array.isArray(r.body.messages));
    const wire = JSON.stringify(chats.at(-1)!.body.messages);
    expect(wire).toContain('[[stored:');
    expect(wire).not.toContain('qqqqqqqqqq');
    // The path is still legible — only the content field went away.
    expect(wire).toContain('notes/big.md');

    const traced = h.service.repos.trace
      .forEvent(sent.eventId)
      .filter((t) => t.kind === 'tool_call')
      .map((t) => JSON.stringify((t.data as any).args))
      .join('\n');
    expect(traced).toContain('qqqqqqqqqq');
    expect(traced).not.toContain('[[stored:');
  });
});

/* ── §20.5 prefix stability ───────────────────────────────────────────────── */

describe('prefix stability (§20.5)', () => {
  it('consecutive requests share a structural prefix', async () => {
    h = await bootService({ onboarded: true, watchFiles: false });
    // A memory exists, so the volatile recall message is in play every turn.
    await h.service.memory.save({
      type: 'preference',
      description: 'Coffee preference',
      content: 'Oat milk in coffee, never dairy.',
    });
    h.fake.always({ text: 'Noted.' });

    const first = h.service.chat.send({ text: 'first question' });
    await drain(h);
    const requestA = h.fake.requests.at(-1)!.body;

    h.service.chat.send({ conversationId: first.conversationId, text: 'second question' });
    await drain(h);
    const requestB = h.fake.requests.at(-1)!.body;

    // The system prompt is byte-identical: nothing volatile lives there.
    expect(requestB.messages[0].content).toBe(requestA.messages[0].content);

    /**
     * Request B's messages begin with request A's minus A's volatile tail: the
     * memory-recall message and the latest exchange. This is the assertion that
     * stops a future refactor quietly moving volatile content forward again.
     */
    const volatileTail = (messages: { content: string }[]) => {
      const recall = messages.findIndex((m) => m.content.startsWith('<memory-recall>'));
      return recall >= 0 ? recall : messages.length;
    };
    const stableA = requestA.messages.slice(0, volatileTail(requestA.messages));
    expect(requestB.messages.slice(0, stableA.length)).toEqual(stableA);

    // And the tail really is what we said it was: recall, then the new message.
    const tailB = requestB.messages.slice(volatileTail(requestB.messages));
    expect(tailB[0].content).toContain('<memory-recall>');
    expect(tailB.at(-1)).toMatchObject({ role: 'user', content: 'second question' });

    /**
     * §21.2.7 rides on the same assertion: the tool definitions live at the
     * prompt head too, so an unchanged open set must render the same bytes.
     * (The open-set-changed case is in context-economics.test.ts.)
     */
    expect(JSON.stringify(requestB.tools)).toBe(JSON.stringify(requestA.tools));
  });

  it('keeps the system prompt stable across different handlers', async () => {
    h = await bootService({ onboarded: true, watchFiles: false });
    for (const name of ['alpha', 'beta']) {
      const { write } = await import('./helpers.js');
      write(
        path.join(h.dataDir, 'handlers', `${name}.md`),
        `---\nname: ${name}\ndescription: Use for ${name} things.\ntools: []\n---\n\nDo the ${name} thing.\n`,
      );
    }
    h.service.handlers.reload();
    h.fake.always((req) => {
      if (req.body.response_format) {
        return {
          text: JSON.stringify({
            summary: 'a thing',
            verdicts: [
              { handler: 'alpha', matched: true, reason: 'yes' },
              { handler: 'beta', matched: true, reason: 'yes' },
            ],
          }),
        };
      }
      return { text: 'done' };
    });
    h.service.intake.submit({ type: 'webhook.thing', source: 'http', payload: { a: 1 } });
    await drain(h);

    // Two different handlers ran; their system prompts are the same bytes, so
    // the prefix cache covers everything up to the handler's own instructions.
    const handlerRequests = h.fake.requests.filter((r) => !r.body.response_format);
    const systems = new Set(handlerRequests.map((r) => r.body.messages[0].content));
    expect(handlerRequests.length).toBeGreaterThanOrEqual(2);
    expect(systems.size).toBe(1);
    // The instructions did arrive — message-side.
    const bodies = handlerRequests.map((r) => JSON.stringify(r.body.messages)).join('\n');
    expect(bodies).toContain('Do the alpha thing.');
    expect(bodies).toContain('Do the beta thing.');
  });
});

/* ── §20.1 reasoning never reaches anything durable ───────────────────────── */

describe('reasoning is never context (§20.1)', () => {
  it('keeps inline think blocks out of the turn, the stream and the history', async () => {
    h = await bootService({ onboarded: true, watchFiles: false });
    h.fake.always({
      text: '<think>The user is asking about Norway. Consider Oslo.</think>Oslo.',
    });
    const sent = h.service.chat.send({ text: 'capital of Norway?' });
    await drain(h);

    const turns = h.service.repos.conversations.history(sent.conversationId);
    expect(turns[1]!.text).toBe('Oslo.');
    expect(turns[1]!.contextText).toBe('Oslo.');
    expect(JSON.stringify(turns)).not.toContain('Consider Oslo');

    // And it is not re-fed on the next turn either.
    h.fake.always({ text: 'Bergen is second.' });
    h.service.chat.send({ conversationId: sent.conversationId, text: 'and the second city?' });
    await drain(h);
    expect(JSON.stringify(h.fake.requests.at(-1)!.body.messages)).not.toContain(
      'Consider Oslo',
    );
  });

  it('accumulates the run total across turns', async () => {
    h = await bootService({ onboarded: true, watchFiles: false });
    let asked = false;
    h.fake.always((req) => {
      if (req.body.tools && !asked) {
        asked = true;
        return {
          text: '<think>0123456789</think>looking it up',
          toolCalls: [{ name: 'time.now', args: {} }],
        };
      }
      return { text: '<think>01234</think>It is Friday.' };
    });
    const sent = h.service.chat.send({ text: 'what day is it?' });
    await drain(h);
    const perCall = h.service.repos.trace
      .forEvent(sent.eventId)
      .filter((t) => t.kind === 'llm_call')
      .map((t) => (t.data as any).reasoning_chars);
    expect(perCall).toEqual([10, 5]);
    // Neither turn's think content survived into the transcript.
    const turns = h.service.repos.conversations.history(sent.conversationId);
    expect(JSON.stringify(turns)).not.toContain('0123456789');
    expect(turns[1]!.contextText).toBe('It is Friday.');
  });

  it('records the size of what it stripped, and nothing else', async () => {
    h = await bootService({ onboarded: true, watchFiles: false });
    h.fake.always({ text: '<think>0123456789</think>Done.' });
    const sent = h.service.chat.send({ text: 'go' });
    await drain(h);
    const llm = h.service.repos.trace.forEvent(sent.eventId).find((t) => t.kind === 'llm_call')!
      .data as any;
    expect(llm.reasoning_chars).toBe(10);
    expect(JSON.stringify(llm)).not.toContain('0123456789');
  });
});
/* ── §20.8 reserved markers & the fabrication guard ───────────────────────── */

/**
 * The sentinel that stays in CI forever: no persisted turn may carry a reserved
 * form. Read straight out of the turns table rather than through the repository,
 * because a repository that stopped stripping is exactly what this has to catch.
 */
function poisonedTurns(h: ServiceHarness): { seq: number; found: string[] }[] {
  const rows = h.app.db.prepare(`SELECT seq, content FROM turns`).all() as {
    seq: number;
    content: string;
  }[];
  const poisoned: { seq: number; found: string[] }[] = [];
  for (const row of rows) {
    let parsed: { text?: string; context_text?: string };
    try {
      parsed = JSON.parse(row.content) as typeof parsed;
    } catch {
      parsed = { text: row.content };
    }
    // Both stored halves: display and model context are separate strings and a
    // marker in either one rides back into a later prompt.
    const found = [
      ...new Set([
        ...reservedMarkers(parsed.text ?? ''),
        ...reservedMarkers(parsed.context_text ?? ''),
      ]),
    ];
    if (found.length) poisoned.push({ seq: row.seq, found });
  }
  return poisoned;
}

describe('reserved markers and the fabrication guard (§20.8)', () => {
  it('strips the legacy prose prefix out of poisoned history at render time', () => {
    const e = repoEnv();
    const conv = e.repo.create();
    // The graf_todo shape, written straight into the row the way the pre-guard
    // executor did — the fence is not in the way of a raw insert.
    e.repo.addTurn({ conversationId: conv.id, role: 'user', text: 'add mobile chat' });
    const poisoned = '(used tools: files.append)\nAdded:\n\n```\n- [ ] Mobile chat\n```';
    e.repo['db']
      .prepare(
        `INSERT INTO turns (conversation_id, role, content, event_id, run_id, created_at)
         VALUES (?, 'assistant', ?, NULL, NULL, ?)`,
      )
      .run(conv.id, JSON.stringify({ text: poisoned }), '2026-08-22T08:09:52.951Z');

    const messages = toModelMessages(e.repo.history(conv.id));
    const rendered = messages.at(-1)!.content as string;
    expect(rendered).not.toContain('used tools');
    // Only the annotation goes: what the assistant actually said survives.
    expect(rendered).toContain('- [ ] Mobile chat');
    e.cleanup();
  });

  it('never writes a reserved pattern into turns, whatever the caller says', () => {
    const e = repoEnv();
    const conv = e.repo.create();
    const turn = e.repo.addTurn({
      conversationId: conv.id,
      role: 'assistant',
      text: '[[used tools: files.append]]\nAdded it.',
      contextText: '(used tools: files.append)\nAdded it.',
      toolsUsed: ['files.append'],
    });
    expect(turn.text).toBe('Added it.');
    expect(turn.contextText).toBe('Added it.');
    expect(JSON.stringify(e.repo.history(conv.id))).not.toContain('used tools');

    // Both roles: a marker in a user turn teaches the same lesson on re-read.
    const user = e.repo.addTurn({
      conversationId: conv.id,
      role: 'user',
      text: 'what does [[elided: web.fetch result, 900 chars]] mean?',
    });
    expect(user.text).toBe('what does  mean?');
    e.cleanup();
  });

  it('leaves ordinary text byte-identical', () => {
    const e = repoEnv();
    const conv = e.repo.create();
    const text = 'Two brackets [[ and a note ]] but no marker.\n\nStill fine.\n';
    expect(e.repo.addTurn({ conversationId: conv.id, role: 'assistant', text }).text).toBe(
      text,
    );
    e.cleanup();
  });

  it('retries a narrated append, then does the real one (the graf_todo replay)', async () => {
    h = await bootService({ onboarded: true, watchFiles: false });
    // Exactly what the live install did on 2026-08-22: text claiming an append,
    // zero tool calls. Then, once corrected, the call it should have made.
    h.fake.script(
      { text: '(used tools: files.append)\nAdded:\n\n```\n- [ ] Mobile chat\n```' },
      {
        toolCalls: [
          {
            name: 'files.append',
            args: {
              path: 'graf_todo.md',
              content: '- [ ] Mobile chat\n',
              message: 'add mobile chat item',
            },
          },
        ],
      },
      { text: 'Added:\n\n```\n- [ ] Mobile chat\n```' },
    );
    const sent = h.service.chat.send({ text: 'add mobile chat to the todo' });
    await drain(h);

    // The corrective note reached the model, in the system voice.
    const retried = h.fake.requests[1]!.body.messages as { role: string; content: any }[];
    const note = retried.at(-1)!;
    expect(note.role).toBe('user');
    expect(String(note.content)).toContain('written by the system, never by you');
    expect(String(note.content)).toContain('(used tools:');
    // The rejected text did not survive into the retry's context.
    expect(JSON.stringify(retried)).not.toContain('Added:');

    // The claim, the disk and the data repo now agree — which is exactly what
    // the incident broke: four turns claimed appends git could not show.
    const onDisk = fs.readFileSync(path.join(h.dataDir, 'files', 'graf_todo.md'), 'utf8');
    expect(onDisk).toContain('- [ ] Mobile chat');
    const gitLog = spawnSync('git', ['log', '--oneline'], {
      cwd: h.dataDir,
      encoding: 'utf8',
    }).stdout;
    expect(gitLog).toContain('add mobile chat item');

    const turns = h.service.repos.conversations.history(sent.conversationId);
    expect(turns[1]!.toolsUsed).toEqual(['files.append']);
    expect(turns[1]!.text).not.toContain('used tools');
    expect(poisonedTurns(h)).toEqual([]);

    const traced = h.service.repos.trace
      .forEvent(sent.eventId)
      .filter((t) => t.kind === 'error')
      .map((t) => t.data as any);
    expect(traced).toEqual([
      {
        message: 'reserved_marker_in_output',
        markers: ['(used tools:'],
        outcome: 'retried',
        // The one place the fabrication survives: the trace, capped per C.1,
        // so what the model tried to write is measurable after the fact.
        excerpt: '(used tools: files.append)\nAdded:\n\n```\n- [ ] Mobile chat\n```',
      },
    ]);
  });

  it('has teeth: the sentinel finds a pre-fix turn written behind its back', async () => {
    h = await bootService({ onboarded: true, watchFiles: false });
    h.fake.always({ text: 'fine' });
    const sent = h.service.chat.send({ text: 'hello' });
    await drain(h);
    expect(poisonedTurns(h)).toEqual([]);

    // The forensic record from the live install, replayed as a raw row: text
    // claiming the reserved form with zero tool_call rows for its run.
    const conv = sent.conversationId;
    h.app.db
      .prepare(
        `INSERT INTO turns (conversation_id, role, content, event_id, run_id, created_at)
         VALUES (?, 'assistant', ?, NULL, NULL, ?)`,
      )
      .run(
        conv,
        JSON.stringify({ text: '(used tools: files.append)\nAdded all three.' }),
        '2026-08-22T08:05:14.355Z',
      );
    expect(poisonedTurns(h)).toHaveLength(1);
    expect(poisonedTurns(h)[0]!.found).toEqual(['(used tools:']);
  });
});

/**
 * The client half of the guard (§20.8). Guarded as source text, since `app.js`
 * cannot be evaluated in a test — and the failure it prevents is the one that
 * was reported from live use: a rejected turn left on screen with the
 * replacement appended under it.
 */
describe('the chat UI takes back a retracted turn', () => {
  const app = fs.readFileSync(new URL('../ui/app.js', import.meta.url), 'utf8');

  it('drops the whole message, not just its body', () => {
    const handler = app.slice(
      app.indexOf("case 'chat.retract':"),
      app.indexOf("case 'chat.done':"),
    );
    // `state.streaming` is the body element; removing that alone would leave a
    // bare speaker label where the retracted answer was.
    expect(handler).toContain('state.streaming.parentElement');
    // Cleared, so the replacement deltas open a fresh message rather than
    // continuing into the one that was just withdrawn.
    expect(handler).toContain('state.streaming = null');
  });

  it('does not refund the tokens the rejected turn spent', () => {
    const handler = app.slice(
      app.indexOf("case 'chat.retract':"),
      app.indexOf("case 'chat.done':"),
    );
    // The text is unsaid; the cost is not. §20.8 says the rejected turn still
    // counts against the run, so the usage estimate must not be rewound.
    expect(handler).not.toContain('streamedChars -=');
    expect(handler).not.toContain('streamedChars = 0');
  });

  it('insists the server can retract, because one that cannot will show markers', () => {
    const expected = /const EXPECTED_FROM_SERVER = \[([\s\S]*?)\]/.exec(app)?.[1] ?? '';
    expect(expected).toContain('chat.retract');
  });
});
