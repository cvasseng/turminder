import { afterEach, describe, expect, it } from 'vitest';
import { TurminderYamlSchema } from '../src/core/config-schemas.js';
import { resolveSettings } from '../src/core/config.js';
import { bootService, type ServiceHarness } from './service-harness.js';

/** The §9 chat budgets as the chat executor applies them. */

describe('chat budget settings (§9, G.1)', () => {
  it('reads chat.stall_s and chat.timeout_s from turminder.yaml', () => {
    const s = resolveSettings(
      TurminderYamlSchema.parse({ chat: { stall_s: 30, timeout_s: 90 } }),
    );
    expect(s.chatStallS).toBe(30);
    expect(s.chatTimeoutS).toBe(90);
  });

  it('keeps the App. A defaults when the keys are absent', () => {
    const s = resolveSettings(TurminderYamlSchema.parse({ chat: { max_turns: 4 } }));
    expect(s.chatStallS).toBe(240);
    expect(s.chatTimeoutS).toBe(1800);
  });

  it('refuses a stall_s that is not a positive integer', () => {
    expect(TurminderYamlSchema.safeParse({ chat: { stall_s: 0 } }).success).toBe(false);
    expect(TurminderYamlSchema.safeParse({ chat: { stall_s: 1.5 } }).success).toBe(false);
  });
});

describe('a stalled chat run (§9)', () => {
  let h: ServiceHarness;
  afterEach(async () => {
    await h?.cleanup();
  });

  it('keeps what was said and shows the verbatim stalled banner', async () => {
    h = await bootService({ onboarded: true, config: { chat: { stall_s: 1 } } });
    const failures: string[] = [];
    h.service.chat.onStream({ failed: (e) => failures.push(e.message) });
    h.fake.script(
      { text: 'Looking.', toolCalls: [{ name: 'memory.query', args: { query: 'x' } }] },
      // Accepted, then nothing: longer than stall_s before the first byte.
      { delayMs: 1600, text: 'too late' },
    );
    const sent = h.service.chat.send({ text: 'find it' });
    await h.service.queue.drain();

    const turns = h.service.repos.conversations.history(sent.conversationId);
    expect(turns.map((t) => [t.role, t.text])).toEqual([
      ['user', 'find it'],
      ['assistant', 'Looking.'],
    ]);
    const run = h.service.repos.runs.forEvent(sent.eventId)[0]!;
    expect(run.status).toBe('failed');
    expect(run.error).toBe('stalled: nothing streamed for 1s');
    expect(failures).toEqual([
      'answer cut short (stalled) — nothing arrived from the model for 1s; chat.stall_s in config/turminder.yaml sets the limit',
    ]);
  });
});
