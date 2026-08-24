import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { harness, type Harness } from './event-core.js';
import type { EventRecord } from '../src/db/repos/events.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('work queue (§4.2, §4.4)', () => {
  let h: Harness;
  beforeEach(() => {
    h = harness();
  });
  afterEach(async () => {
    await h.cleanup();
  });

  const submit = (type: string, opts: { key?: string; payload?: unknown } = {}) =>
    h.intake.submit({
      type,
      source: 'test',
      payload: opts.payload ?? {},
      serialization_key: opts.key ?? null,
    }).event;

  it('processes an event and marks it done, with state transitions traced', async () => {
    const seen: string[] = [];
    const q = h.queue(async (e) => {
      seen.push(e.id);
    });
    const ev = submit('a.b');
    q.start();
    await q.drain();

    expect(seen).toEqual([ev.id]);
    expect(h.repos.events.get(ev.id)?.status).toBe('done');
    const states = h.repos.trace
      .forEvent(ev.id)
      .filter((t) => t.kind === 'state')
      .map((t) => (t.data as any).to);
    expect(states).toEqual(['received', 'processing', 'done']);
  });

  it('runs events with the same serialization key strictly in order', async () => {
    const order: string[] = [];
    const q = h.queue(async (e) => {
      // Deliberately uneven durations: order must come from the queue, not luck.
      await sleep((e.payload as { ms: number }).ms);
      order.push((e.payload as { tag: string }).tag);
    });
    submit('email.received', { key: 'thread-1', payload: { tag: 'a', ms: 30 } });
    submit('email.received', { key: 'thread-1', payload: { tag: 'b', ms: 1 } });
    submit('email.received', { key: 'thread-1', payload: { tag: 'c', ms: 1 } });
    q.start();
    await q.drain();
    expect(order).toEqual(['a', 'b', 'c']);
  });

  it('never runs two events of one key at the same time', async () => {
    let active = 0;
    let peak = 0;
    const q = h.queue(async () => {
      active += 1;
      peak = Math.max(peak, active);
      await sleep(10);
      active -= 1;
    });
    for (let i = 0; i < 4; i++) submit('email.received', { key: 'same' });
    q.start();
    await q.drain();
    expect(peak).toBe(1);
  });

  it('runs different keys in parallel', async () => {
    let active = 0;
    let peak = 0;
    const q = h.queue(
      async () => {
        active += 1;
        peak = Math.max(peak, active);
        await sleep(20);
        active -= 1;
      },
      { maxConcurrent: 4 },
    );
    for (const key of ['k1', 'k2', 'k3']) submit('email.received', { key });
    q.start();
    await q.drain();
    expect(peak).toBeGreaterThan(1);
  });

  it('respects the concurrency cap for unkeyed events', async () => {
    let active = 0;
    let peak = 0;
    const q = h.queue(
      async () => {
        active += 1;
        peak = Math.max(peak, active);
        await sleep(15);
        active -= 1;
      },
      { maxConcurrent: 2 },
    );
    for (let i = 0; i < 6; i++) submit('timer.fired');
    q.start();
    await q.drain();
    expect(peak).toBe(2);
  });

  it('retries a handler that fails twice, then succeeds', async () => {
    const attempts: number[] = [];
    const q = h.queue(
      async (_e, ctx) => {
        attempts.push(ctx.attempt);
        if (ctx.attempt <= 2) throw new Error(`fail ${ctx.attempt}`);
      },
      { retryBackoffS: [0, 0, 0] },
    );
    const ev = submit('flaky.thing');
    q.start();
    await q.drain();

    expect(attempts).toEqual([1, 2, 3]);
    const stored = h.repos.events.get(ev.id);
    expect(stored?.status).toBe('done');
    expect(stored?.attempts).toBe(3);
    const states = h.repos.trace
      .forEvent(ev.id)
      .filter((t) => t.kind === 'state')
      .map((t) => (t.data as any).to);
    expect(states).toEqual([
      'received',
      'processing',
      'failed',
      'processing',
      'failed',
      'processing',
      'done',
    ]);
  });

  it('dead-letters an event that always fails, after retry_attempts tries', async () => {
    const deadLettered: { id: string; attempts: number }[] = [];
    const q = h.queue(
      async () => {
        throw new Error('always broken');
      },
      {
        retryBackoffS: [0, 0, 0],
        onDeadLetter: (e, _err, attempts) => deadLettered.push({ id: e.id, attempts }),
      },
    );
    const ev = submit('doomed.thing');
    q.start();
    await q.drain();

    const stored = h.repos.events.get(ev.id);
    expect(stored?.status).toBe('dead_letter');
    expect(stored?.attempts).toBe(3);
    expect(stored?.last_error).toContain('always broken');
    expect(deadLettered).toEqual([{ id: ev.id, attempts: 3 }]);
    const errors = h.repos.trace.forEvent(ev.id).filter((t) => t.kind === 'error');
    expect(errors.length).toBe(3);
  });

  it('schedules retries with the configured backoff', async () => {
    const q = h.queue(
      async () => {
        throw new Error('nope');
      },
      { retryBackoffS: [3600, 7200, 10800] },
    );
    const ev = submit('slow.retry');
    q.start();
    await q.idle();
    await sleep(20);
    const stored = h.repos.events.get(ev.id);
    expect(stored?.status).toBe('failed');
    expect(stored?.attempts).toBe(1);
    const waitS = (Date.parse(stored!.next_attempt_at!) - Date.now()) / 1000;
    expect(waitS).toBeGreaterThan(3500);
    expect(waitS).toBeLessThan(3700);
  });

  it('holds back later events of a key while the first waits out its backoff', async () => {
    const done: string[] = [];
    const q = h.queue(
      async (e, ctx) => {
        const tag = (e.payload as { tag: string }).tag;
        if (tag === 'first' && ctx.attempt === 1) throw new Error('not yet');
        done.push(tag);
      },
      { retryBackoffS: [3600] },
    );
    submit('email.received', { key: 'thread-7', payload: { tag: 'first' } });
    submit('email.received', { key: 'thread-7', payload: { tag: 'second' } });
    q.start();
    await q.drain();
    // 'second' must not overtake 'first' just because 'first' is in backoff.
    expect(done).toEqual([]);
  });

  it('requeues events left processing by a crashed process', async () => {
    const ev = submit('interrupted.thing');
    h.repos.events.setStatus(ev.id, 'processing', { attempts: 1 });

    const seen: EventRecord[] = [];
    const q = h.queue(async (e) => {
      seen.push(e);
    });
    q.start();
    await q.drain();

    expect(seen.map((e) => e.id)).toEqual([ev.id]);
    expect(h.repos.events.get(ev.id)?.status).toBe('done');
    expect(h.repos.events.get(ev.id)?.attempts).toBe(2);
  });

  it('wakes up immediately when an event arrives while running', async () => {
    const seen: string[] = [];
    const q = h.queue(async (e) => {
      seen.push(e.type);
    });
    q.start();
    await q.drain();
    const started = Date.now();
    submit('late.arrival');
    await q.idle();
    for (let i = 0; i < 50 && !seen.includes('late.arrival'); i++) await sleep(5);
    expect(seen).toContain('late.arrival');
    expect(Date.now() - started).toBeLessThan(500);
    await q.stop();
  });

  it('leaves rejected events alone', async () => {
    const h2 = harness({ maxDepth: 0 });
    try {
      const root = h2.intake.submit({ type: 'a.b', source: 't', payload: {} });
      const rejected = h2.intake.submit({
        type: 'c.d',
        source: 't',
        payload: {},
        caused_by: root.event.id,
      });
      expect(rejected.status).toBe('rejected');
      const seen: string[] = [];
      const q = h2.queue(async (e) => {
        seen.push(e.type);
      });
      q.start();
      await q.drain();
      expect(seen).not.toContain('c.d');
      expect(h2.repos.events.get(rejected.event.id)?.status).toBe('rejected');
    } finally {
      await h2.cleanup();
    }
  });
});
