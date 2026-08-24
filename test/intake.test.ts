import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { harness, type Harness } from './event-core.js';

describe('event intake (§4.1, §5.5)', () => {
  let h: Harness;
  beforeEach(() => {
    h = harness();
  });
  afterEach(async () => {
    await h.cleanup();
  });

  it('accepts an event and records the arrival in the trace', () => {
    const r = h.intake.submit({
      type: 'email.received',
      source: 'imap.fastmail',
      payload: { subject: 'hello' },
      serialization_key: 'thread-1',
    });
    expect(r.status).toBe('accepted');
    expect(r.event.id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(r.event.depth).toBe(0);
    expect(r.event.status).toBe('received');
    expect(r.event.payload).toEqual({ subject: 'hello' });

    const trace = h.repos.trace.forEvent(r.event.id);
    expect(trace).toHaveLength(1);
    expect(trace[0]?.kind).toBe('state');
    expect(trace[0]?.data).toEqual({ from: null, to: 'received' });
  });

  it('drops duplicates by (source, idempotency_key)', () => {
    const first = h.intake.submit({
      type: 'email.received',
      source: 'imap.fastmail',
      payload: { n: 1 },
      idempotency_key: '<msg-1@example.com>',
    });
    const second = h.intake.submit({
      type: 'email.received',
      source: 'imap.fastmail',
      payload: { n: 2 },
      idempotency_key: '<msg-1@example.com>',
    });
    expect(first.status).toBe('accepted');
    expect(second.status).toBe('duplicate');
    expect(second.event.id).toBe(first.event.id);
    expect(second.event.payload).toEqual({ n: 1 });
    expect(h.repos.events.recent({ limit: 10 })).toHaveLength(1);
  });

  it('keeps the same idempotency key distinct across sources', () => {
    const a = h.intake.submit({ type: 'x.y', source: 'a', payload: {}, idempotency_key: 'k' });
    const b = h.intake.submit({ type: 'x.y', source: 'b', payload: {}, idempotency_key: 'k' });
    expect(b.status).toBe('accepted');
    expect(b.event.id).not.toBe(a.event.id);
  });

  it('stamps provenance depth on emitted events', () => {
    const root = h.intake.submit({ type: 'a.b', source: 'test', payload: {} });
    const child = h.intake.submit({
      type: 'c.d',
      source: 'test',
      payload: {},
      caused_by: root.event.id,
    });
    const grandchild = h.intake.submit({
      type: 'e.f',
      source: 'test',
      payload: {},
      caused_by: child.event.id,
    });
    expect(child.event.depth).toBe(1);
    expect(grandchild.event.depth).toBe(2);
    expect(h.repos.events.chain(grandchild.event.id).map((e) => e.type)).toEqual([
      'e.f',
      'c.d',
      'a.b',
    ]);
  });

  it('records an emit trace row on the parent event', () => {
    const root = h.intake.submit({ type: 'a.b', source: 'test', payload: {} });
    const child = h.intake.submit({
      type: 'c.d',
      source: 'test',
      payload: {},
      caused_by: root.event.id,
    });
    const emits = h.repos.trace.forEvent(root.event.id).filter((t) => t.kind === 'emit');
    expect(emits).toHaveLength(1);
    expect(emits[0]?.data).toEqual({ emitted_event_id: child.event.id, type: 'c.d' });
  });

  it('rejects beyond MAX_DEPTH and reports system.loop_suspected', () => {
    const h2 = harness({ maxDepth: 2 });
    try {
      let parent = h2.intake.submit({ type: 'chain.0', source: 'test', payload: {} }).event.id;
      for (const depth of [1, 2]) {
        const r = h2.intake.submit({
          type: `chain.${depth}`,
          source: 'test',
          payload: {},
          caused_by: parent,
        });
        expect(r.status).toBe('accepted');
        parent = r.event.id;
      }
      const tooDeep = h2.intake.submit({
        type: 'chain.3',
        source: 'test',
        payload: {},
        caused_by: parent,
      });
      expect(tooDeep.status).toBe('rejected');
      if (tooDeep.status === 'rejected') expect(tooDeep.reason).toBe('depth_exceeded');

      // The rejected event is still written, for the audit trail (App. C.2).
      const stored = h2.repos.events.get(tooDeep.event.id);
      expect(stored?.status).toBe('rejected');

      const report = h2.repos.events
        .recent({ limit: 10 })
        .find((e) => e.type === 'system.loop_suspected');
      expect(report).toBeTruthy();
      expect(report?.depth).toBe(0);
      expect((report?.payload as any).rejected_type).toBe('chain.3');
      expect((report?.payload as any).depth).toBe(3);
    } finally {
      await0(h2);
    }
  });

  it('rejects a cycle: same emitter and serialization key twice in one chain', () => {
    const runId = h.repos.runs.create({ kind: 'handler', handlerName: 'nudger' });
    const root = h.intake.submit({
      type: 'email.received',
      source: 'imap',
      payload: {},
      serialization_key: 'thread-9',
    });
    const first = h.intake.submit({
      type: 'nudge.sent',
      source: 'handler',
      payload: {},
      serialization_key: 'thread-9',
      caused_by: root.event.id,
      emitted_by_run: runId,
    });
    expect(first.status).toBe('accepted');

    const runId2 = h.repos.runs.create({ kind: 'handler', handlerName: 'nudger' });
    const again = h.intake.submit({
      type: 'nudge.sent',
      source: 'handler',
      payload: {},
      serialization_key: 'thread-9',
      caused_by: first.event.id,
      emitted_by_run: runId2,
    });
    expect(again.status).toBe('rejected');
    if (again.status === 'rejected') expect(again.reason).toBe('cycle_detected');
  });

  it('allows the same handler on a different serialization key', () => {
    const runId = h.repos.runs.create({ kind: 'handler', handlerName: 'nudger' });
    const root = h.intake.submit({
      type: 'a.b',
      source: 't',
      payload: {},
      serialization_key: 'k1',
    });
    const first = h.intake.submit({
      type: 'nudge.sent',
      source: 'handler',
      payload: {},
      serialization_key: 'k1',
      caused_by: root.event.id,
      emitted_by_run: runId,
    });
    const other = h.intake.submit({
      type: 'nudge.sent',
      source: 'handler',
      payload: {},
      serialization_key: 'k2',
      caused_by: first.event.id,
      emitted_by_run: h.repos.runs.create({ kind: 'handler', handlerName: 'nudger' }),
    });
    expect(other.status).toBe('accepted');
  });

  it('detects a type-level cycle when no handler run is attributed', () => {
    const root = h.intake.submit({
      type: 'loop.me',
      source: 't',
      payload: {},
      serialization_key: 'k',
    });
    const child = h.intake.submit({
      type: 'loop.me',
      source: 't',
      payload: {},
      serialization_key: 'k',
      caused_by: root.event.id,
    });
    expect(child.status).toBe('rejected');
  });

  it('treats an unknown caused_by as a root event rather than failing', () => {
    const r = h.intake.submit({
      type: 'a.b',
      source: 't',
      payload: {},
      caused_by: '01ZZZZZZZZZZZZZZZZZZZZZZZZ',
    });
    expect(r.status).toBe('accepted');
    expect(r.event.depth).toBe(0);
  });
});

/** Small helper so the nested harness in one test still gets cleaned up. */
function await0(h: Harness): void {
  void h.cleanup();
}
