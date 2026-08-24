import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FakeLlama } from './fake-llama.js';
import { gatewayFor, RecordingDispatcher } from './model-stack.js';
import { runAgent } from '../src/model/agent-loop.js';
import { MemoryTraceSink } from '../src/model/types.js';
import { jsRenderedNote } from '../src/tools/integrations/web-fetch.js';
import type { ModelGateway } from '../src/model/gateway.js';

/**
 * The futility backstop (§20.9). §20.7 catches the same call twice; this
 * catches four different calls that all find nothing — the loop that cost six
 * calls in the trace this exists for. Everything here is about the difference
 * between "returned nothing" (code decides) and "give up" (the model decides).
 */
describe('the futility backstop (§20.9)', () => {
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
    selector: {},
    priority: 'event' as const,
    system: 'system prompt',
    messages: [{ role: 'user' as const, content: 'find the price' }],
  };

  /** A dispatcher whose emptiness is declared per call, as the real one does. */
  function scripted(results: { output: unknown; empty: boolean }[]): RecordingDispatcher {
    let i = 0;
    const disp = new RecordingDispatcher({});
    disp.dispatch = async (call) => {
      const next = results[Math.min(i, results.length - 1)]!;
      i += 1;
      disp.calls.push({ toolCallId: call.toolCallId, name: call.name, args: call.args });
      return { ok: true, output: next.output, empty: next.empty };
    };
    return disp;
  }

  it('wraps from the third consecutive empty, and says how many turns are left', async () => {
    fake.always((req: any) => {
      const calls = (req.body.messages ?? []).filter((m: any) => m.role === 'tool').length;
      if (calls >= 4) return { text: 'Nothing on those pages.' };
      return {
        toolCalls: [{ name: 'web.query', args: { url: `https://a.example/${calls}` } }],
      };
    });
    const disp = scripted([{ output: { match_count: 0, matches: [] }, empty: true }]);
    const trace = new MemoryTraceSink();
    const r = await runAgent(gw, {
      ...base,
      dispatcher: disp,
      trace,
      budgets: { maxTurns: 10 },
    });

    const results = r.messages
      .filter((m) => m.role === 'tool')
      .map((m) => JSON.stringify(m.content));
    // First two empties pass through untouched: two is not a pattern.
    expect(results[0]).not.toContain('futile_streak');
    expect(results[1]).not.toContain('futile_streak');
    // The third is the point.
    expect(results[2]).toContain('"futile_streak":3');
    expect(results[2]).toContain('3 web.* calls in a row have returned nothing');
    expect(results[2]).toContain('turns remain');
    // The data always arrives, wrapped or not (§20.9).
    expect(results[2]).toContain('match_count');
    // And the fourth keeps saying so, with the count climbing.
    expect(results[3]).toContain('"futile_streak":4');

    // Traced, so the pattern is a query rather than an anecdote (§17.11, C.1).
    const traced = trace.ofKind('tool_call') as { futile_streak?: number }[];
    expect(traced.filter((t) => t.futile_streak).map((t) => t.futile_streak)).toEqual([3, 4]);
  });

  it('never appears on a productive run, however many calls it makes', async () => {
    fake.always((req: any) => {
      const calls = (req.body.messages ?? []).filter((m: any) => m.role === 'tool').length;
      if (calls >= 5) return { text: 'Found it.' };
      return { toolCalls: [{ name: 'web.query', args: { q: calls } }] };
    });
    // Empty, hit, empty, empty, hit — flailing never reaches three in a row.
    const disp = scripted([
      { output: { match_count: 0 }, empty: true },
      { output: { match_count: 2 }, empty: false },
      { output: { match_count: 0 }, empty: true },
      { output: { match_count: 0 }, empty: true },
      { output: { match_count: 1 }, empty: false },
    ]);
    const r = await runAgent(gw, { ...base, dispatcher: disp });
    expect(JSON.stringify(r.messages)).not.toContain('futile_streak');
  });

  it('counts per namespace, so one dead end does not pressure another tool', async () => {
    fake.always((req: any) => {
      const calls = (req.body.messages ?? []).filter((m: any) => m.role === 'tool').length;
      if (calls >= 4) return { text: 'done' };
      // Alternating namespaces: neither reaches three in a row.
      const name = calls % 2 === 0 ? 'web.query' : 'files.search';
      return { toolCalls: [{ name, args: { n: calls } }] };
    });
    const disp = scripted([{ output: { results: [] }, empty: true }]);
    const r = await runAgent(gw, { ...base, dispatcher: disp });
    expect(JSON.stringify(r.messages)).not.toContain('futile_streak');
  });

  it('clears on the first non-empty result', async () => {
    fake.always((req: any) => {
      const calls = (req.body.messages ?? []).filter((m: any) => m.role === 'tool').length;
      if (calls >= 5) return { text: 'done' };
      return { toolCalls: [{ name: 'web.query', args: { n: calls } }] };
    });
    const disp = scripted([
      { output: { match_count: 0 }, empty: true },
      { output: { match_count: 0 }, empty: true },
      { output: { match_count: 0 }, empty: true },
      { output: { match_count: 7 }, empty: false },
      { output: { match_count: 0 }, empty: true },
    ]);
    const r = await runAgent(gw, { ...base, dispatcher: disp });
    const results = r.messages
      .filter((m) => m.role === 'tool')
      .map((m) => JSON.stringify(m.content));
    expect(results[2]).toContain('futile_streak');
    expect(results[3]).not.toContain('futile_streak');
    // The streak restarts from one, so the next empty is not instantly wrapped.
    expect(results[4]).not.toContain('futile_streak');
  });

  it('honours a configured threshold', async () => {
    fake.always((req: any) => {
      const calls = (req.body.messages ?? []).filter((m: any) => m.role === 'tool').length;
      if (calls >= 2) return { text: 'done' };
      return { toolCalls: [{ name: 'web.query', args: { n: calls } }] };
    });
    const disp = scripted([{ output: { match_count: 0 }, empty: true }]);
    const r = await runAgent(gw, { ...base, dispatcher: disp, futileThreshold: 1 });
    const first = JSON.stringify(r.messages.filter((m) => m.role === 'tool')[0]?.content);
    expect(first).toContain('"futile_streak":1');
  });
});

describe('the JS-rendered tell (App. F.5, §20.9)', () => {
  it('fires on a page that is all script and no text', () => {
    const markup = `<html><body><div id="root"></div><script>${'x'.repeat(6000)}</script></body></html>`;
    const note = jsRenderedNote(markup, '', 500);
    expect(note).toContain('rendered by JavaScript');
    expect(note).toContain('fetching it again will not help');
  });

  it('stays quiet on an ordinary article', () => {
    const text = 'word '.repeat(400);
    const markup = `<html><body><article>${text}</article></body></html>`;
    expect(jsRenderedNote(markup, text, 500)).toBeNull();
  });

  it('stays quiet on a short page that is genuinely short', () => {
    // Little text, but little markup too: nothing was hidden from us.
    expect(jsRenderedNote('<html><body><p>404</p></body></html>', '404', 500)).toBeNull();
  });
});
