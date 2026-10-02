import { afterEach, describe, expect, it } from 'vitest';
import { toModelMessages } from '../src/chat/history.js';
import { bootService, type ServiceHarness } from './service-harness.js';

let h: ServiceHarness;
afterEach(async () => {
  await h?.cleanup();
});

/** A conversation with a user turn and an assistant turn tied to a fresh run. */
function seed() {
  const repos = h.service.repos;
  const conv = repos.conversations.create();
  const run = repos.runs.create({ kind: 'chat', model: 'main' });
  repos.conversations.addTurn({ conversationId: conv.id, role: 'user', text: 'do it' });
  repos.conversations.addTurn({
    conversationId: conv.id,
    role: 'assistant',
    text: 'Done.',
    contextText: 'Done.',
    toolsUsed: ['a.one'],
    runId: run,
  });
  return { conv, run };
}

describe('chat.history carries tool activity (§9, App. D.1)', () => {
  it("replays a run's tool calls in seq order with the 200-char cut", async () => {
    h = await bootService({ onboarded: true });
    const { conv, run } = seed();
    const sink = h.service.repos.trace.sink({ runId: run });
    sink.append('tool_call', { tool: 'a.one', args: {}, ok: true, result_excerpt: 'first' });
    sink.append('tool_call', {
      tool: 'b.two',
      args: {},
      ok: false,
      result_excerpt: 'x'.repeat(500),
    });
    sink.append('tool_call', { tool: 'c.three', args: {}, ok: true, result_excerpt: 'third' });

    const { turns } = h.service.chat.history(conv.id);
    const user = turns.find((t) => t.role === 'user')!;
    const assistant = turns.find((t) => t.role === 'assistant')!;
    expect(user).not.toHaveProperty('activity');
    expect(assistant.activity).toEqual([
      { tool: 'a.one', ok: true, summary: 'first' },
      { tool: 'b.two', ok: false, summary: 'x'.repeat(200) },
      { tool: 'c.three', ok: true, summary: 'third' },
    ]);
  });

  it('has no activity key when the run has no trace rows (pruned or no tools)', async () => {
    h = await bootService({ onboarded: true });
    const { conv } = seed();
    const { turns } = h.service.chat.history(conv.id);
    for (const t of turns) expect(t).not.toHaveProperty('activity');
  });

  it("keeps one run's rows off another run's turn", async () => {
    h = await bootService({ onboarded: true });
    const { conv } = seed();
    h.service.repos.trace
      .sink({ runId: h.service.repos.runs.create({ kind: 'chat' }) })
      .append('tool_call', { tool: 'z.z', args: {}, ok: true, result_excerpt: 'no' });
    const { turns } = h.service.chat.history(conv.id);
    expect(turns.find((t) => t.role === 'assistant')).not.toHaveProperty('activity');
  });

  it('never changes what the model re-reads (§20.2)', async () => {
    h = await bootService({ onboarded: true });
    const { conv, run } = seed();
    const before = JSON.stringify(
      toModelMessages(h.service.repos.conversations.history(conv.id)),
    );
    h.service.repos.trace
      .sink({ runId: run })
      .append('tool_call', { tool: 'a.one', args: {}, ok: true, result_excerpt: 'payload' });
    const after = JSON.stringify(
      toModelMessages(h.service.repos.conversations.history(conv.id)),
    );
    expect(after).toBe(before);
    expect(after).not.toContain('payload');
  });
});
