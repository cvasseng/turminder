import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BASE_PROMPTS } from '../src/prompts/base.js';
import { fenceTail, renderNow } from '../src/prompts/fencing.js';
import { write } from './helpers.js';
import { bootService, type ServiceHarness } from './service-harness.js';

let h: ServiceHarness;
afterEach(async () => {
  vi.useRealTimers();
  await h?.cleanup();
});

const drain = (harness: ServiceHarness) => harness.service.queue.drain();
type Msg = { role: string; content: string };
const lastMessages = (harness: ServiceHarness) =>
  harness.fake.requests.at(-1)!.body.messages as Msg[];

describe('the <now> line (§20.5, H.1 item 5)', () => {
  it('renders the exact format: time.now local, identity zone, ISO week', () => {
    // Friday 23:44 in Oslo (CEST, UTC+2) is 21:44 UTC.
    expect(renderNow(new Date('2026-10-02T21:44:00Z'), 'Europe/Oslo')).toBe(
      '<now>Friday 2026-10-02 23:44 Europe/Oslo, week 40</now>',
    );
    // The year boundary is where "day of year / 7" goes wrong.
    expect(renderNow(new Date('2027-01-01T12:00:00Z'), 'UTC')).toBe(
      '<now>Friday 2027-01-01 12:00 UTC, week 53</now>',
    );
  });

  it('falls back to UTC for an unusable zone instead of throwing', () => {
    expect(renderNow(new Date('2026-10-02T21:44:00Z'), 'Not/AZone')).toBe(
      '<now>Friday 2026-10-02 21:44 UTC, week 40</now>',
    );
    expect(renderNow(new Date('2026-10-02T21:44:00Z'), undefined)).toContain(' UTC, week 40');
  });

  it('puts <now> first and the memory block after it, or alone with no memories', () => {
    const at = new Date('2026-10-02T21:44:00Z');
    expect(fenceTail(at, 'UTC', [])).toBe(renderNow(at, 'UTC'));
    const both = fenceTail(at, 'UTC', [{ name: 'n', description: 'd', content: 'c' }]);
    expect(both.split('\n')[0]).toBe(renderNow(at, 'UTC'));
    expect(both).toContain('<memory-recall>');
  });

  it('is in the tail of a chat run with no recalled memory, and not in the system prompt', async () => {
    h = await bootService({ onboarded: true, watchFiles: false });
    h.fake.always({ text: 'ok' });
    h.service.chat.send({ text: 'what day is it?' });
    await drain(h);
    const messages = lastMessages(h);
    expect(messages[0]!.role).toBe('system');
    expect(messages[0]!.content).not.toMatch(/<now>\w+day \d{4}-/);
    expect(messages.at(-1)).toMatchObject({ role: 'user', content: 'what day is it?' });
    const tail = messages.at(-2)!;
    expect(tail.role).toBe('user');
    expect(tail.content).toMatch(
      /^<now>\w+day \d{4}-\d\d-\d\d \d\d:\d\d Europe\/Oslo, week \d+<\/now>$/,
    );
  });

  it('leaves the system prompt and history byte-identical across runs at different times', async () => {
    h = await bootService({ onboarded: true, watchFiles: false });
    h.fake.always({ text: 'ok' });
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-02T21:44:00Z'));
    const first = h.service.chat.send({ text: 'one' });
    await drain(h);
    const a = lastMessages(h);

    vi.setSystemTime(new Date('2026-10-05T07:05:00Z'));
    h.service.chat.send({ conversationId: first.conversationId, text: 'two' });
    await drain(h);
    const b = lastMessages(h);

    expect(a.at(-2)!.content).toBe('<now>Friday 2026-10-02 23:44 Europe/Oslo, week 40</now>');
    expect(b.at(-2)!.content).toBe('<now>Monday 2026-10-05 09:05 Europe/Oslo, week 41</now>');
    // Everything before A's tail (system prompt + history) is the same bytes in B.
    const stableA = a.slice(0, a.length - 2);
    expect(JSON.stringify(b.slice(0, stableA.length))).toBe(JSON.stringify(stableA));
    // And no earlier run's <now> line was persisted into history.
    expect(b.slice(0, -2).some((m) => m.role !== 'system' && m.content.includes('<now>'))).toBe(
      false,
    );
  });

  it('rides a handler run as the first message too (H.1 item 5)', async () => {
    h = await bootService({ onboarded: true });
    write(
      path.join(h.dataDir, 'handlers', 'noter.md'),
      `---\nname: noter\ndescription: Notes.\n---\n\nNote it.\n`,
    );
    h.service.handlers.reload();
    h.fake.always((req) =>
      req.body.response_format
        ? {
            text: JSON.stringify({
              summary: 'a thing',
              verdicts: [{ handler: 'noter', matched: true, reason: 'x' }],
            }),
          }
        : { text: 'handled' },
    );
    h.service.intake.submit({ type: 'email.received', source: 'imap.x', payload: { s: 'hi' } });
    await drain(h);
    const messages = lastMessages(h).filter((m) => m.role !== 'system');
    expect(messages[0]!.content).toMatch(
      /^<now>\w+day \d{4}-\d\d-\d\d \d\d:\d\d [\w/]+, week \d+<\/now>$/,
    );
    expect(messages.at(-1)!.content).toContain('Note it.');
    expect(lastMessages(h)[0]!.content).not.toMatch(/<now>\w+day/);
  });
});

describe('the base prompt (§20.8, §20.5)', () => {
  it('explains [[run:]] with its trust clause, alongside the rest of the family', () => {
    for (const kind of ['chat', 'handler'] as const) {
      const p = BASE_PROMPTS[kind];
      expect(p).toContain('[[run: …]]');
      expect(p).toContain('trust it over that answer');
      expect(p).toContain('[[used tools: …]]');
      expect(p).toContain('[[elided: …]]');
    }
  });

  it('does not tell kinds without a <now> line to look for one', () => {
    expect(BASE_PROMPTS.ingress).not.toContain('<now>');
    expect(BASE_PROMPTS.distill).not.toContain('<now>');
    expect(BASE_PROMPTS.maintenance).not.toContain('<now>');
    expect(BASE_PROMPTS.maintenance).toContain('`time.now`');
  });

  it('says the run start arrives in <now> and time.now is for exact or later time', () => {
    const p = BASE_PROMPTS.chat;
    expect(p).toContain('`<now>`');
    expect(p).toContain('`time.now`');
    expect(p).not.toContain('You are never told the current date or time');
  });
});
