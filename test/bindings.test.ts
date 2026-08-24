import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Config } from '../src/core/config.js';
import { openDataHome } from '../src/core/datadir.js';
import { openDb } from '../src/db/index.js';
import { createRepos, type Repos } from '../src/db/repos/index.js';
import { EmbedBinder, MAX_BINDINGS, hashValue } from '../src/embeds/binder.js';
import { EmbedStore } from '../src/embeds/store.js';
import { substituteData } from '../src/embeds/serve.js';
import { RunGrants } from '../src/tools/run-grants.js';
import { embedsTools } from '../src/tools/integrations/embeds.js';
import type { ToolHandle } from '../src/tools/types.js';
import {
  bootService,
  installMcpServer,
  TestClient,
  type ServiceHarness,
} from './service-harness.js';
import { tmpDir } from './helpers.js';

const REVENUE_FIXTURE = () => path.resolve('test/fixtures/mcp-revenue-server.mjs');
const SENTINEL = 987654321;

let h: ServiceHarness;
afterEach(async () => {
  await h?.cleanup();
});

const drain = (harness: ServiceHarness) => harness.service.queue.drain();

/* ── in-process pieces, without a service ─────────────────────────────────── */

interface Env {
  repos: Repos;
  store: EmbedStore;
  binder: EmbedBinder;
  runGrants: RunGrants;
  handles: ToolHandle[];
  embedId: string;
  cleanup(): void;
}

/** Shared: the registry itself holds no per-test state worth isolating. */
const runGrants = new RunGrants();

function env(now?: () => Date): Env {
  const t = tmpDir('turminder-bind-');
  const { home } = openDataHome(path.join(t.dir, 'home'));
  const db = openDb(home.dbPath);
  const repos = createRepos(db);
  const config = new Config(home);
  const store = new EmbedStore({ home, config, repo: repos.embeds });
  const handles: ToolHandle[] = [];
  const binder = new EmbedBinder({
    repo: repos.embeds,
    tools: () => handles,
    ...(now ? { now } : {}),
  });
  const created = store.create({
    title: 'Dashboard',
    html: '<div>{{data:revenue.total}}</div>',
  });
  if ('error' in created) throw new Error(created.message);
  return {
    repos,
    store,
    binder,
    runGrants,
    handles,
    embedId: created.embed_id,
    cleanup() {
      db.close();
      t.cleanup();
    },
  };
}

/** A stub handle. Only name, tier and call() are ever consulted here. */
function handle(
  name: string,
  tier: 'ro' | 'se',
  call: (args: unknown) => Promise<{ ok: boolean; output: unknown }>,
): ToolHandle {
  return {
    name,
    description: name,
    tier,
    inputSchema: { type: 'object' },
    source: name.split('.')[0]!,
    call: (args) => call(args),
  };
}

const ok = (output: unknown) => async () => ({ ok: true, output });

/** A grant view like the one a run's inner dispatcher publishes. */
function grantView(names: string[]): { granted: () => string[]; grantedHandles: () => [] } {
  return { granted: () => names, grantedHandles: () => [] };
}

describe('bind-time validation (§23.2, App. F.13)', () => {
  it('freezes the calls and fetches them once', async () => {
    const e = env();
    e.handles.push(handle('revenue.total', 'ro', ok({ total: SENTINEL })));
    const result = await e.binder.bind(
      e.embedId,
      [{ name: 'revenue', tool: 'revenue.total', args: { quarter: 'Q3' } }],
      grantView(['revenue.total']),
    );
    // The first execution's outcomes ride the result — a bind whose fetches
    // failed must say so in the same breath, not in a later refresh.
    expect(result).toEqual({
      embed_id: e.embedId,
      bound: ['revenue'],
      results: [{ name: 'revenue', ok: true, fetched_at: expect.any(String) }],
    });
    // Frozen: the args the model chose, stored verbatim.
    expect(e.repos.embeds.bindings(e.embedId)).toEqual([
      { name: 'revenue', tool: 'revenue.total', args: { quarter: 'Q3' }, refresh: 'manual' },
    ]);
    expect(e.binder.values(e.embedId)).toEqual({ revenue: { total: SENTINEL } });
    e.cleanup();
  });

  it('rejects bindings whose args fail validation, with the tool’s own message', async () => {
    // The NO5 dashboard failure mode: the model wrapped scalar args in junk
    // objects, bind reported success anyway, and the model looped the same
    // garbage ten times. A first execution failing `invalid_arguments` is
    // deterministic — reject it, say why, and restore what was there.
    const e = env();
    e.handles.push(handle('revenue.total', 'ro', ok({ total: SENTINEL })));
    const good = await e.binder.bind(
      e.embedId,
      [{ name: 'revenue', tool: 'revenue.total', args: { quarter: 'Q3' } }],
      grantView(['revenue.total']),
    );
    expect(good).toMatchObject({ bound: ['revenue'] });

    e.handles.push(
      handle('prices.now', 'ro', async () => ({
        ok: false,
        output: { error: 'invalid_arguments', message: 'expected string at area, got object' },
      })),
    );
    const rejected = await e.binder.bind(
      e.embedId,
      [
        { name: 'revenue', tool: 'revenue.total', args: { quarter: 'Q3' } },
        { name: 'now', tool: 'prices.now', args: { area: { area: 'NO5' } } },
      ],
      grantView(['revenue.total', 'prices.now']),
    );
    expect(rejected).toMatchObject({
      error: 'invalid_binding_args',
      failures: [
        { name: 'now', tool: 'prices.now', message: 'expected string at area, got object' },
      ],
    });
    // All-or-nothing: the previous (working) list and its data are back.
    expect(e.repos.embeds.bindings(e.embedId).map((b) => b.name)).toEqual(['revenue']);
    expect(e.binder.values(e.embedId)).toEqual({ revenue: { total: SENTINEL } });
    e.cleanup();
  });

  it('args_from freezes the args of the run’s own prior call, server-side (§23.2)', async () => {
    // The anti-telephone rule applied to args: the model references its call,
    // the server copies the bytes from the trace — immune to transcript
    // elision, impossible to nest wrong.
    const e = env();
    e.handles.push(handle('prices.now', 'ro', ok({ NOK: 1.49 })));
    const prior = new Map([['prices.now', { area: 'NO5' }]]);
    const binder = new EmbedBinder({
      repo: e.repos.embeds,
      tools: () => e.handles,
      priorArgs: (runId, tool) => (runId === 'run-9' ? (prior.get(tool) ?? null) : null),
    });

    const bound = await binder.bind(
      e.embedId,
      [{ name: 'now', tool: 'prices.now', args_from: true }],
      grantView(['prices.now']),
      'run-9',
    );
    expect(bound).toMatchObject({ bound: ['now'] });
    // Frozen verbatim from the trace, auditable in the manifest.
    expect(e.repos.embeds.bindings(e.embedId)[0]).toMatchObject({
      tool: 'prices.now',
      args: { area: 'NO5' },
    });

    // No prior call → a readable refusal, not a silent empty-args binding.
    const none = await binder.bind(
      e.embedId,
      [{ name: 'x', tool: 'prices.now', args_from: true }],
      grantView(['prices.now']),
      'run-without-calls',
    );
    expect(none).toMatchObject({ error: 'no_prior_call', tool: 'prices.now' });

    // Both args and args_from is ambiguous — refused.
    const both = await binder.bind(
      e.embedId,
      [{ name: 'x', tool: 'prices.now', args: { area: 'NO1' }, args_from: true }],
      grantView(['prices.now']),
      'run-9',
    );
    expect(both).toMatchObject({ error: 'args_conflict' });
    e.cleanup();
  });

  it('keeps bindings with transient failures, reporting them in the result', async () => {
    const e = env();
    e.handles.push(
      handle('flaky.read', 'ro', async () => ({
        ok: false,
        output: { error: 'fetch_failed', message: 'HTTP 503' },
      })),
    );
    const result = await e.binder.bind(
      e.embedId,
      [{ name: 'x', tool: 'flaky.read', args: {} }],
      grantView(['flaky.read']),
    );
    // A dead upstream is not a broken binding: it stays, marked, and the
    // failure (with the tool's message) is in the same result the model reads.
    expect(result).toMatchObject({
      bound: ['x'],
      results: [{ name: 'x', ok: false, error: 'fetch_failed', message: 'HTTP 503' }],
    });
    expect(e.repos.embeds.bindings(e.embedId).map((b) => b.name)).toEqual(['x']);
    expect(e.binder.manifest(e.embedId)[0]).toMatchObject({
      ok: false,
      error: 'fetch_failed',
      message: 'HTTP 503',
    });
    e.cleanup();
  });

  it('refuses a tool that does not exist, one that writes, and one it may not call', async () => {
    const e = env();
    e.handles.push(
      handle('revenue.total', 'ro', ok({ total: 1 })),
      handle('revenue.book', 'se', ok({ booked: 1 })),
      handle('secrets.read', 'ro', ok({ secret: 1 })),
    );
    const view = grantView(['revenue.total', 'revenue.book']);

    expect(
      await e.binder.bind(e.embedId, [{ name: 'x', tool: 'nope.thing' }], view),
    ).toMatchObject({ error: 'unknown_tool', tool: 'nope.thing' });
    expect(
      await e.binder.bind(e.embedId, [{ name: 'x', tool: 'revenue.book' }], view),
    ).toMatchObject({ error: 'not_ro', tool: 'revenue.book' });
    // Granted-ness is the run's, not the tool's: `secrets.read` is read-only
    // and exists, and still cannot be bound by a run that could not call it.
    expect(
      await e.binder.bind(e.embedId, [{ name: 'x', tool: 'secrets.read' }], view),
    ).toMatchObject({ error: 'not_granted', tool: 'secrets.read' });
    // Nothing was stored by any of the three refusals.
    expect(e.repos.embeds.bindings(e.embedId)).toEqual([]);
    e.cleanup();
  });

  it('binds nothing at all with no run behind the call', async () => {
    const e = env();
    e.handles.push(handle('revenue.total', 'ro', ok({ total: 1 })));
    // Fails closed: the grant set of nothing is nothing (§23.2).
    expect(
      await e.binder.bind(e.embedId, [{ name: 'x', tool: 'revenue.total' }], null),
    ).toMatchObject({ error: 'not_granted' });
    e.cleanup();
  });

  it('refuses more bindings than the cap allows (App. A)', async () => {
    const e = env();
    e.handles.push(handle('revenue.total', 'ro', ok({ total: 1 })));
    const many = Array.from({ length: MAX_BINDINGS + 1 }, (_, i) => ({
      name: `b${i}`,
      tool: 'revenue.total',
    }));
    expect(await e.binder.bind(e.embedId, many, grantView(['revenue.total']))).toMatchObject({
      error: 'too_many_bindings',
    });
    e.cleanup();
  });

  it('replacing the list drops the data of bindings that are gone', async () => {
    const e = env();
    e.handles.push(handle('revenue.total', 'ro', ok({ total: 1 })));
    const view = grantView(['revenue.total']);
    await e.binder.bind(
      e.embedId,
      [
        { name: 'a', tool: 'revenue.total' },
        { name: 'b', tool: 'revenue.total' },
      ],
      view,
    );
    expect(Object.keys(e.binder.values(e.embedId)).sort()).toEqual(['a', 'b']);
    await e.binder.bind(e.embedId, [{ name: 'a', tool: 'revenue.total' }], view);
    expect(Object.keys(e.repos.embeds.boundData(e.embedId))).toEqual(['a']);
    e.cleanup();
  });
});

describe('the binder (§23.2)', () => {
  it('runs with no model anywhere near it', async () => {
    const e = env();
    let calls = 0;
    e.handles.push(
      handle('revenue.total', 'ro', async () => {
        calls += 1;
        return { ok: true, output: { total: SENTINEL + calls } };
      }),
    );
    await e.binder.bind(
      e.embedId,
      [{ name: 'r', tool: 'revenue.total' }],
      grantView(['revenue.total']),
    );
    await e.binder.refresh(e.embedId);
    expect(calls).toBe(2);
    expect(e.binder.values(e.embedId)).toEqual({ r: { total: SENTINEL + 2 } });
    e.cleanup();
  });

  it('keeps the last good value and marks it stale when the upstream dies', async () => {
    let alive = true;
    const e = env();
    e.handles.push(
      handle('revenue.total', 'ro', async () =>
        alive
          ? { ok: true, output: { total: SENTINEL } }
          : { ok: false, output: { error: 'upstream_down' } },
      ),
    );
    await e.binder.bind(
      e.embedId,
      [{ name: 'r', tool: 'revenue.total' }],
      grantView(['revenue.total']),
    );
    const fresh = e.repos.embeds.boundData(e.embedId).r!;
    alive = false;

    const refreshed = await e.binder.refresh(e.embedId);
    expect(refreshed).toEqual([
      { name: 'r', ok: false, fetched_at: fresh.fetched_at, error: 'upstream_down' },
    ]);
    const stale = e.repos.embeds.boundData(e.embedId).r!;
    // Serving is never blocked, and the age of the value does not move: what
    // the page shows is visibly old rather than convincingly fresh (§23.2).
    expect(stale.value).toEqual({ total: SENTINEL });
    expect(stale.fetched_at).toBe(fresh.fetched_at);
    expect(stale.ok).toBe(false);
    e.cleanup();
  });

  it('re-fetches on_serve bindings only once the TTL has passed', async () => {
    let now = Date.parse('2026-08-22T10:00:00.000Z');
    let calls = 0;
    const e = env(() => new Date(now));
    e.handles.push(
      handle('revenue.total', 'ro', async () => {
        calls += 1;
        return { ok: true, output: { total: calls } };
      }),
    );
    await e.binder.bind(
      e.embedId,
      [
        { name: 'live', tool: 'revenue.total', refresh: 'on_serve' },
        { name: 'once', tool: 'revenue.total', refresh: 'manual' },
      ],
      grantView(['revenue.total']),
    );
    expect(calls).toBe(2);

    await e.binder.refresh(e.embedId, { staleOnly: true });
    expect(calls).toBe(2); // inside the TTL, and `manual` is never on_serve

    now += 61_000;
    await e.binder.refresh(e.embedId, { staleOnly: true });
    expect(calls).toBe(3);
    // The manual binding did not move; only the live one did.
    expect(e.binder.values(e.embedId).once).toEqual({ total: 2 });
    e.cleanup();
  });

  it('names the tool, args and freshness in the manifest, and not the value', async () => {
    const e = env();
    e.handles.push(handle('revenue.total', 'ro', ok({ total: SENTINEL })));
    await e.binder.bind(
      e.embedId,
      [{ name: 'r', tool: 'revenue.total', args: { quarter: 'Q3' }, refresh: 'on_serve' }],
      grantView(['revenue.total']),
    );
    const manifest = e.binder.manifest(e.embedId);
    expect(manifest).toHaveLength(1);
    expect(manifest[0]).toMatchObject({
      name: 'r',
      tool: 'revenue.total',
      args: { quarter: 'Q3' },
      refresh: 'on_serve',
      ok: true,
      hash: hashValue({ total: SENTINEL }),
    });
    // The trust story is provenance, not a second copy of the data (§23.2).
    expect(JSON.stringify(manifest)).not.toContain(String(SENTINEL));
    e.cleanup();
  });

  it('drops an oversized result rather than losing the other bindings', async () => {
    const e = env();
    e.handles.push(
      handle('revenue.total', 'ro', ok({ total: 1 })),
      handle('revenue.dump', 'ro', ok({ blob: 'x'.repeat(300 * 1024) })),
    );
    const refreshed = await e.binder.bind(
      e.embedId,
      [
        { name: 'small', tool: 'revenue.total' },
        { name: 'huge', tool: 'revenue.dump' },
      ],
      grantView(['revenue.total', 'revenue.dump']),
    );
    expect(refreshed).toMatchObject({ bound: ['small', 'huge'] });
    const data = e.repos.embeds.boundData(e.embedId);
    expect(data.small!.ok).toBe(true);
    expect(data.huge).toMatchObject({ ok: false, error: 'value_too_large', value: null });
    e.cleanup();
  });
});

/* ── placement (§23.2) ────────────────────────────────────────────────────── */

describe('{{data:…}} substitution (§23.2)', () => {
  const data = {
    revenue: { total: 41, label: '<b>Q3</b>' },
    plain: 'hello',
    n: 0,
  };

  it('substitutes by name and by path, HTML-escaped', () => {
    expect(substituteData('<p>{{data:plain}}</p>', data)).toBe('<p>hello</p>');
    expect(substituteData('{{data:revenue.total}}', data)).toBe('41');
    expect(substituteData('{{data:n}}', data)).toBe('0');
    // Escaped: a bound value is data, and must never become markup.
    expect(substituteData('{{data:revenue.label}}', data)).toBe('&lt;b&gt;Q3&lt;/b&gt;');
  });

  it('leaves an unresolvable placeholder standing', () => {
    // A visible placeholder names its own bug; a silent blank reads as zero.
    expect(substituteData('{{data:revneue}}', data)).toBe('{{data:revneue}}');
    expect(substituteData('{{data:revenue.nope}}', data)).toBe('{{data:revenue.nope}}');
    expect(substituteData('{{data:plain.deeper}}', data)).toBe('{{data:plain.deeper}}');
  });

  it('renders an object at the wrong depth as its JSON', () => {
    expect(substituteData('{{data:revenue}}', data)).toContain('&quot;total&quot;:41');
  });
});

/* ── the tools, and the whole path through a service ──────────────────────── */

describe('embeds.bind / embeds.refresh (App. F.13)', () => {
  it('reports a missing embed rather than binding into nothing', async () => {
    const e = env();
    const defs = embedsTools({ store: e.store, binder: e.binder, runGrants: e.runGrants });
    const bind = defs.find((d) => d.name === 'embeds.bind')!;
    expect(
      await bind.execute(
        { embed_id: '01NOPE', bindings: [{ name: 'r', tool: 'revenue.total' }] },
        { runId: null, eventId: null },
      ),
    ).toMatchObject({ error: 'not_found' });
    e.cleanup();
  });

  it('is se-tier on both, because both write to the embed', async () => {
    const e = env();
    const defs = new Map(
      embedsTools({ store: e.store, binder: e.binder, runGrants: e.runGrants }).map((d) => [
        d.name,
        d,
      ]),
    );
    expect(defs.get('embeds.bind')!.tier).toBe('se');
    expect(defs.get('embeds.refresh')!.tier).toBe('se');
    e.cleanup();
  });
});

/** The revenue fixture, connected and granted as the form flow would leave it. */
const installRevenue = (harness: ServiceHarness, env: Record<string, string> = {}) =>
  installMcpServer(harness, { name: 'revenue', fixture: REVENUE_FIXTURE(), env });

describe('data trust, end to end (§23.2)', () => {
  /**
   * The anti-telephone test, and the reason this whole layer exists: a number
   * the assistant never saw ends up on the page. It stays in CI forever.
   */
  it('the bound value reaches the served page and appears in no LLM request', async () => {
    h = await bootService({ onboarded: true, watchFiles: false });
    await installRevenue(h);

    let step = 0;
    h.fake.always((req) => {
      if (!req.body.tools) return { text: 'ok' };
      step += 1;
      if (step === 1) {
        return {
          toolCalls: [
            {
              name: 'embeds.create',
              args: {
                title: 'Revenue',
                html: '<h1>Revenue</h1><p id="v">{{data:revenue.total}}</p>',
              },
            },
          ],
        };
      }
      if (step === 2) {
        // The model names the call, never the number.
        return {
          toolCalls: [
            {
              name: 'embeds.bind',
              args: {
                embed_id: h.service.embeds.repo.list()[0]!.id,
                bindings: [{ name: 'revenue', tool: 'revenue.total', args: { quarter: 'Q3' } }],
              },
            },
          ],
        };
      }
      return { text: 'Here is the dashboard.' };
    });

    h.service.chat.send({ text: 'build me a revenue dashboard' });
    await drain(h);

    const row = h.service.embeds.repo.list()[0]!;
    expect(h.service.repos.embeds.bindings(row.id)).toHaveLength(1);

    // The page carries the number…
    const served = await (await fetch(`${h.baseUrl}${h.service.embeds.url(row)}`)).text();
    expect(served).toContain(`<p id="v">${SENTINEL}</p>`);
    // …twice over: substituted into the markup, and available to script code.
    expect(served).toContain(`"total":${SENTINEL}`);

    // …and it rode nothing the model ever saw or said.
    const transcript = JSON.stringify(h.fake.requests);
    expect(transcript).toContain('embeds.bind');
    expect(transcript).not.toContain(String(SENTINEL));
    // Belt and braces: not in the persisted turns either.
    const turns = JSON.stringify(
      h.service.repos.conversations.history(row.conversation_id!, { limit: 50 }),
    );
    expect(turns).not.toContain(String(SENTINEL));
  });

  it('a refresh re-executes the frozen calls with no LLM call in the trace', async () => {
    h = await bootService({ onboarded: true, watchFiles: false });
    await installRevenue(h);
    const created = h.service.embeds.create({
      title: 'Revenue',
      html: '<p>{{data:r.total}}</p>',
    });
    if ('error' in created) throw new Error(created.message);

    // Bound directly: this test is about the refresh path, not the authoring one.
    const bound = await h.service.binder.bind(
      created.embed_id,
      [{ name: 'r', tool: 'revenue.total' }],
      { granted: () => ['revenue.total'], grantedHandles: () => [] },
    );
    expect(bound).toMatchObject({ bound: ['r'] });
    const before = h.fake.requests.length;

    let step = 0;
    h.fake.always((req) => {
      if (!req.body.tools) return { text: 'ok' };
      step += 1;
      if (step === 1) {
        return {
          toolCalls: [{ name: 'embeds.refresh', args: { embed_id: created.embed_id } }],
        };
      }
      return { text: 'Refreshed.' };
    });
    const sent = h.service.chat.send({ text: 'refresh the dashboard' });
    await drain(h);

    const trace = h.service.repos.trace.forEvent(sent.eventId);
    const refresh = trace
      .filter((t) => t.kind === 'tool_call')
      .map((t) => t.data as { tool: string; result_excerpt?: string })
      .find((d) => d.tool === 'embeds.refresh')!;
    expect(refresh.result_excerpt).toContain('"ok":true');
    // The two LLM calls are the run's own turns; the binder added none.
    expect(h.fake.requests.length - before).toBe(2);
    expect(trace.filter((t) => t.kind === 'llm_call').length).toBe(2);
  });

  it('serves stale-marked data when the upstream is dead, and never blocks', async () => {
    h = await bootService({ onboarded: true, watchFiles: false });
    await installRevenue(h);
    const created = h.service.embeds.create({
      title: 'Revenue',
      html: '<p id="v">{{data:r.total}}</p>',
    });
    if ('error' in created) throw new Error(created.message);
    await h.service.binder.bind(
      created.embed_id,
      [{ name: 'r', tool: 'revenue.total', refresh: 'on_serve' }],
      { granted: () => ['revenue.total'], grantedHandles: () => [] },
    );
    const first = h.service.binder.manifest(created.embed_id)[0]!;
    expect(first.ok).toBe(true);

    // The upstream goes away mid-life: reconnect the same server with the
    // failure switch on, which is what a dead API looks like from here.
    await installRevenue(h, { TURMINDER_TEST_DEAD: '1' });
    // Past the on_serve TTL, so the serve actually tries.
    h.service.repos.embeds.setBoundData(created.embed_id, {
      r: { value: { total: SENTINEL }, fetched_at: '2020-01-01T00:00:00.000Z', ok: true },
    });

    const row = h.service.embeds.repo.get(created.embed_id)!;
    const res = await fetch(`${h.baseUrl}${h.service.embeds.url(row)}`);
    expect(res.status).toBe(200);
    const body = await res.text();
    // The last good value still shows…
    expect(body).toContain(`<p id="v">${SENTINEL}</p>`);
    // …and the manifest says out loud that it is old.
    const manifest = h.service.binder.manifest(created.embed_id)[0]!;
    expect(manifest.ok).toBe(false);
    expect(manifest.fetched_at).toBe('2020-01-01T00:00:00.000Z');
    expect(manifest.error).toBeTruthy();
  });

  it('re-fetches on_serve bindings when the page is opened, and says so', async () => {
    h = await bootService({ onboarded: true, watchFiles: false });
    await installRevenue(h);
    const created = h.service.embeds.create({
      title: 'Revenue',
      html: '<p id="v">{{data:r.total}}</p>',
    });
    if ('error' in created) throw new Error(created.message);
    await h.service.binder.bind(
      created.embed_id,
      [{ name: 'r', tool: 'revenue.total', refresh: 'on_serve' }],
      { granted: () => ['revenue.total'], grantedHandles: () => [] },
    );
    const row = h.service.embeds.repo.get(created.embed_id)!;

    // Inside the TTL, opening the page does not hammer the upstream (App. A).
    const stamp = () => h.service.binder.manifest(created.embed_id)[0]!.fetched_at;
    const first = stamp();
    await fetch(`${h.baseUrl}${h.service.embeds.url(row)}`);
    expect(stamp()).toBe(first);

    // Past it, the serve itself re-executes the frozen call…
    h.service.repos.embeds.setBoundData(created.embed_id, {
      r: { value: { total: 1 }, fetched_at: '2020-01-01T00:00:00.000Z', ok: true },
    });
    const body = await (await fetch(`${h.baseUrl}${h.service.embeds.url(row)}`)).text();
    // …so the page the browser got is the fresh number, not the stale one.
    expect(body).toContain(`<p id="v">${SENTINEL}</p>`);
    expect(stamp()).not.toBe('2020-01-01T00:00:00.000Z');
    // A refresh is not an edit: the reaper's quiet window must not reset (§22.1).
    expect(h.service.embeds.repo.get(created.embed_id)!.updated_at).toBe(row.updated_at);
  });

  it('tells open chats that a refresh made their view stale', async () => {
    h = await bootService({ onboarded: true, watchFiles: false });
    await installRevenue(h);
    const created = h.service.embeds.create({
      title: 'Revenue',
      html: '<p>{{data:r.total}}</p>',
    });
    if ('error' in created) throw new Error(created.message);
    await h.service.binder.bind(
      created.embed_id,
      [{ name: 'r', tool: 'revenue.total', refresh: 'on_serve' }],
      { granted: () => ['revenue.total'], grantedHandles: () => [] },
    );

    const client = await TestClient.connect(h.baseUrl, h.token);
    await client.hello(['chat']);

    // A serve-time pass is silent: that page is being fetched anyway (§22.6).
    h.service.repos.embeds.setBoundData(created.embed_id, {
      r: { value: { total: 1 }, fetched_at: '2020-01-01T00:00:00.000Z', ok: true },
    });
    const row = h.service.embeds.repo.get(created.embed_id)!;
    await fetch(`${h.baseUrl}${h.service.embeds.url(row)}`);

    // A model-driven refresh is not: what is on screen is a version behind.
    await h.service.binder.refresh(created.embed_id);
    const frame = await client.next('embed.changed');
    expect(frame.payload).toEqual({ embed_id: created.embed_id });
    // Only the one frame — the serve did not send its own.
    expect(client.frames.filter((f) => f.type === 'embed.changed')).toHaveLength(0);
    client.close();
  });

  it('answers embed.manifest over the socket, without the values', async () => {
    h = await bootService({ onboarded: true, watchFiles: false });
    await installRevenue(h);
    const created = h.service.embeds.create({
      title: 'Revenue',
      html: '<p>{{data:r.total}}</p>',
    });
    if ('error' in created) throw new Error(created.message);
    await h.service.binder.bind(
      created.embed_id,
      [{ name: 'r', tool: 'revenue.total', args: { quarter: 'Q3' } }],
      { granted: () => ['revenue.total'], grantedHandles: () => [] },
    );

    const client = await TestClient.connect(h.baseUrl, h.token);
    await client.hello(['chat']);
    client.send('embed.manifest', { embed_id: created.embed_id });
    const frame = await client.next('embed.manifest.result');
    const payload = frame.payload as {
      embed_id: string;
      bindings: { name: string; tool: string; args: unknown; ok: boolean; hash: string }[];
    };
    expect(payload.embed_id).toBe(created.embed_id);
    expect(payload.bindings[0]).toMatchObject({
      name: 'r',
      tool: 'revenue.total',
      args: { quarter: 'Q3' },
      ok: true,
    });
    expect(JSON.stringify(payload)).not.toContain(String(SENTINEL));

    client.send('embed.manifest', { embed_id: '01MISSING' });
    const err = await client.next('error');
    expect((err.payload as { code: string }).code).toBe('not_found');
    client.close();
  });
  /**
   * The same proof, one layer further out: the value is not a number an MCP
   * server handed over but a number scraped off a page, and `web.query` being
   * `ro` is the only reason that is allowed to happen unattended (§23.2).
   */
  it('binds a scraped page value, which reaches the embed without passing a model', async () => {
    const page =
      '<!doctype html><html><head><title>Widget</title></head><body>' +
      '<nav><a href="/">Home</a></nav>' +
      `<p id="price">${SENTINEL} kr</p>` +
      '</body></html>';
    let upstreamCalls = 0;
    // Count page fetches only: the injected fetch also serves the embedding
    // endpoint, and the history index (§25) embeds in the background after
    // every run — traffic this assertion is not about.
    const upstream = (async (input: unknown) => {
      const url =
        typeof input === 'string' || input instanceof URL
          ? String(input)
          : ((input as Request).url ?? '');
      if (url.includes('example.com')) upstreamCalls += 1;
      return new Response(page, { status: 200, headers: { 'content-type': 'text/html' } });
    }) as unknown as typeof globalThis.fetch;

    h = await bootService({ onboarded: true, watchFiles: false, fetch: upstream });

    let step = 0;
    h.fake.always((req) => {
      if (!req.body.tools) return { text: 'ok' };
      step += 1;
      if (step === 1) {
        return {
          toolCalls: [
            {
              name: 'embeds.create',
              args: {
                title: 'Price watch',
                html: '<p id="v">{{data:price.matches.0}}</p>',
              },
            },
          ],
        };
      }
      if (step === 2) {
        // The model names the page and the selector. It never reads either.
        return {
          toolCalls: [
            {
              name: 'embeds.bind',
              args: {
                embed_id: h.service.embeds.repo.list()[0]!.id,
                bindings: [
                  {
                    name: 'price',
                    tool: 'web.query',
                    args: { url: 'https://example.com/widget', selector: '#price' },
                    refresh: 'on_serve',
                  },
                ],
              },
            },
          ],
        };
      }
      return { text: 'Watching that price.' };
    });

    h.service.chat.send({ text: 'track the price on https://example.com/widget' });
    await drain(h);

    const row = h.service.embeds.repo.list()[0]!;
    expect(h.service.binder.manifest(row.id)[0]).toMatchObject({
      tool: 'web.query',
      args: { url: 'https://example.com/widget', selector: '#price' },
      ok: true,
    });
    expect(upstreamCalls).toBe(1);

    const served = await (await fetch(`${h.baseUrl}${h.service.embeds.url(row)}`)).text();
    expect(served).toContain(`<p id="v">${SENTINEL} kr</p>`);
    expect(served).toContain(`"${SENTINEL} kr"`);

    // The scrape reached the page. It never reached a token stream.
    const transcript = JSON.stringify(h.fake.requests);
    expect(transcript).toContain('web.query');
    expect(transcript).not.toContain(String(SENTINEL));
    const turns = JSON.stringify(
      h.service.repos.conversations.history(row.conversation_id!, { limit: 50 }),
    );
    expect(turns).not.toContain(String(SENTINEL));
  });
});
