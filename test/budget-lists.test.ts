import { describe, expect, it } from 'vitest';
import { budgeted, capResult, TRUNCATION_HINT } from '../src/tools/budget.js';
import type { ToolHandle } from '../src/tools/types.js';

const item = (i: number, pad = 300) => ({ id: `item-${i}`, text: 'x'.repeat(pad) });

describe('whole-item list truncation (§20.3)', () => {
  it('cuts a top-level key list at whole items with the exact marker', () => {
    const output = { events: Array.from({ length: 23 }, (_, i) => item(i)), untrusted: true };
    const capped = capResult(output, 4000);
    const out = capped.output as any;
    expect(out.untrusted).toBe(true);
    const kept = out.events.length;
    expect(kept).toBeGreaterThan(0);
    expect(kept).toBeLessThan(23);
    expect(out._truncated).toEqual({
      field: 'events',
      kept,
      total: 23,
      hint: `${kept} of 23 events shown; narrow the call (a smaller window, max_results, a filter) to see the rest`,
    });
    // Whole items, in order, and the result is valid JSON within the cap.
    expect(out.events).toEqual(output.events.slice(0, kept));
    expect(JSON.stringify(out).length).toBeLessThanOrEqual(4000);
    // One more item would not have fit.
    const more = { ...out, events: output.events.slice(0, kept + 1) };
    expect(JSON.stringify(more).length).toBeGreaterThan(4000);
    expect(capped.truncatedFrom).toBe(JSON.stringify(output).length);
    expect(capped.traceOutput).toBe(output);
  });

  it('takes the largest array when several are present', () => {
    const output = { small: [1, 2, 3], tasks: Array.from({ length: 30 }, (_, i) => item(i)) };
    const out = capResult(output, 4000).output as any;
    expect(out.small).toEqual([1, 2, 3]);
    expect(out._truncated.field).toBe('tasks');
  });

  it('wraps a bare top-level array', () => {
    const output = Array.from({ length: 30 }, (_, i) => item(i));
    const out = capResult(output, 4000).output as any;
    expect(out._truncated.field).toBe('items');
    expect(out.items).toEqual(output.slice(0, out.items.length));
    expect(out._truncated.total).toBe(30);
  });

  it('cuts a nested sections[].tasks list when no whole section fits', () => {
    const output = {
      sections: [
        { section: 'Inbox', tasks: Array.from({ length: 40 }, (_, i) => item(i, 200)) },
        { section: 'Later', tasks: [item(99)] },
      ],
      untrusted: true,
    };
    const capped = capResult(output, 4000);
    const out = capped.output as any;
    const kept = out.sections[0].tasks.length;
    expect(out._truncated).toEqual({
      field: 'sections.0.tasks',
      kept,
      total: 40,
      hint: `${kept} of 40 tasks shown; narrow the call (a smaller window, max_results, a filter) to see the rest; 1 more sections not shown`,
      dropped: { field: 'sections', count: 1 },
    });
    expect(out.sections[0].section).toBe('Inbox');
    expect(out.sections[0].tasks).toEqual(output.sections[0]!.tasks.slice(0, kept));
    expect(out.sections).toHaveLength(1);
    expect(JSON.stringify(out).length).toBeLessThanOrEqual(4000);
    expect(capped.traceOutput).toBe(output);
  });

  it('omits dropped when a nested cut has no later parents', () => {
    const output = {
      sections: [{ section: 'A', tasks: Array.from({ length: 40 }, (_, i) => item(i, 200)) }],
    };
    const m = (capResult(output, 4000).output as any)._truncated;
    expect(m).not.toHaveProperty('dropped');
    expect(m.hint).not.toContain('more');
  });

  it('keeps the excerpt form for a non-list result', () => {
    const out = capResult({ body: 'x'.repeat(9000) }, 4000).output as any;
    expect(out._truncated).toBe(true);
    expect(out.excerpt).toHaveLength(4000);
    expect(out.hint).toBe(TRUNCATION_HINT);
  });

  it('keeps the excerpt form when a single item is itself too big', () => {
    const out = capResult({ events: [item(1, 9000), item(2, 9000)] }, 4000).output as any;
    expect(out._truncated).toBe(true);
    expect(out.excerpt).toHaveLength(4000);
  });

  it('does not touch a list that fits', () => {
    const output = { events: [item(1, 10)] };
    expect(capResult(output, 4000).output).toBe(output);
  });

  it('applies through the hub wrapper, and the trace keeps the original', async () => {
    const output = { events: Array.from({ length: 20 }, (_, i) => item(i)) };
    const handle: ToolHandle = {
      name: 'ext.list',
      description: 'x',
      tier: 'ro',
      inputSchema: { type: 'object', properties: {} },
      source: 'ext',
      call: async () => ({ ok: true, output }),
    };
    const res = await budgeted(handle, 4000).call({}, { runId: null, eventId: null });
    expect((res.output as any)._truncated.field).toBe('events');
    expect(res.traceOutput).toBe(output);
    expect(res.truncatedFrom).toBe(JSON.stringify(output).length);
  });
});
