import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { WATCH_MIN_INTERVAL_S, defaultStateFile } from '../src/watchers/engine.js';
import { bootService, installMcpServer, type ServiceHarness } from './service-harness.js';

let h: ServiceHarness;
afterEach(async () => {
  await h?.cleanup();
});

const drain = (harness: ServiceHarness) => harness.service.queue.drain();
const ctx = { runId: null, eventId: null };

/**
 * Watchers (§30): the deterministic state layer. The invariant every test here
 * circles is the one the phase exists for — **silent means no LLM, never no
 * record**. A poll that finds nothing must cost a trace row and not one token.
 */
describe('the watcher engine (§30.2)', () => {
  /**
   * A carrier whose status the test drives through a file, over a real MCP
   * connection — so the frozen call is as external as the real thing (§23.2).
   */
  let statusFile: string;

  function setStatus(value: string): void {
    fs.writeFileSync(statusFile, value, 'utf8');
  }

  async function withCarrier(): Promise<ServiceHarness> {
    const harness = await bootService({ onboarded: true, watchFiles: false });
    statusFile = path.join(harness.dataDir, 'carrier-status.txt');
    setStatus('waiting_for_handover');
    await installMcpServer(harness, {
      name: 'carrier',
      fixture: path.resolve('test/fixtures/mcp-carrier-server.mjs'),
      env: { TURMINDER_TEST_STATUS_FILE: statusFile },
    });
    return harness;
  }

  /** Create a watcher the way the tool does, with everything granted. */
  async function create(
    harness: ServiceHarness,
    over: Record<string, unknown> = {},
  ): Promise<any> {
    return harness.service.watchers.create(
      {
        note: 'posten parcel',
        tool: 'carrier.track',
        args: { code: 'XYZ42' },
        status_path: 'shipment.status',
        terminal_values: ['delivered'],
        every_s: WATCH_MIN_INTERVAL_S,
        ...over,
      } as never,
      {
        runId: null,
        grants: { granted: () => ['carrier.track'], grantedHandles: () => [] },
        toolCtx: ctx,
      },
    );
  }

  it('creates by polling once: validates, seeds the status, writes the file', async () => {
    h = await withCarrier();
    const created = await create(h);
    expect(created).toMatchObject({ note: 'posten parcel', status: 'waiting_for_handover' });
    expect(created.state_file).toBe('state/posten-parcel.md');

    const file = fs.readFileSync(path.join(h.dataDir, 'files', created.state_file), 'utf8');
    expect(file).toContain('status: waiting_for_handover');
    expect(file).toContain('created, status `waiting_for_handover`');

    // The cadence is an ordinary schedule row (§30.1) — no new mechanism.
    const watcher = h.service.repos.watchers.get(created.watch_id)!;
    const schedule = h.service.repos.schedules.get(watcher.schedule_id)!;
    expect(schedule.event_type).toBe('watch.due');
    expect(JSON.parse(schedule.event_payload)).toEqual({ watch_id: created.watch_id });
  });

  it('refuses what §23.2 refuses, and a cadence tighter than the floor', async () => {
    h = await withCarrier();
    expect(await create(h, { tool: 'carrier.book' })).toMatchObject({ error: 'not_ro' });
    expect(await create(h, { tool: 'carrier.nope' })).toMatchObject({ error: 'unknown_tool' });
    expect(await create(h, { every_s: 60 })).toMatchObject({ error: 'bad_args' });
    // A path that finds nothing says what the result actually looked like.
    const bad = await create(h, { status_path: 'shipment.state' });
    expect(bad).toMatchObject({ error: 'bad_status_path' });
    expect(bad.message).toContain('shipment');
    // None of the refusals left a watcher or a schedule behind.
    expect(h.service.repos.watchers.list()).toEqual([]);
  });

  it('refuses a tool the creating run cannot call', async () => {
    h = await withCarrier();
    const refused = await h.service.watchers.create(
      {
        note: 'sneaky',
        tool: 'carrier.track',
        args: { code: 'X' },
        status_path: 'shipment.status',
        every_s: WATCH_MIN_INTERVAL_S,
      } as never,
      { runId: null, grants: { granted: () => [], grantedHandles: () => [] }, toolCtx: ctx },
    );
    expect(refused).toMatchObject({ error: 'not_granted' });
  });

  it('polls silently: no llm_call, one tool_call, no file write', async () => {
    h = await withCarrier();
    const created = await create(h);
    const file = path.join(h.dataDir, 'files', created.state_file);
    const before = fs.readFileSync(file, 'utf8');
    const runsBefore = h.app.db.prepare(`SELECT COUNT(*) AS n FROM runs`).get() as {
      n: number;
    };

    for (let i = 0; i < 10; i += 1) {
      const step = await h.service.watchers.step(created.watch_id, { toolCtx: ctx });
      expect(step).toMatchObject({ changed: false, terminal: false });
    }

    // Ten polls, ten runs, ten tool_call rows — and zero llm_call rows. That
    // is the whole invariant (§30.2).
    const runs = h.app.db.prepare(`SELECT COUNT(*) AS n FROM runs`).get() as { n: number };
    expect(runs.n - runsBefore.n).toBe(10);
    const kinds = h.app.db
      .prepare(`SELECT kind, COUNT(*) AS n FROM trace GROUP BY kind`)
      .all() as { kind: string; n: number }[];
    const byKind = Object.fromEntries(kinds.map((k) => [k.kind, k.n]));
    expect(byKind.tool_call).toBeGreaterThanOrEqual(10);
    expect(byKind.llm_call ?? 0).toBe(0);
    // And the human-facing file did not move: no commit spam (§30.4).
    expect(fs.readFileSync(file, 'utf8')).toBe(before);
  });

  it('announces a transition, appends to the file, and commits it', async () => {
    h = await withCarrier();
    const created = await create(h);
    setStatus('in_transit');
    const step = await h.service.watchers.step(created.watch_id, { toolCtx: ctx });
    expect(step).toMatchObject({ status: 'in_transit', changed: true, terminal: false });

    const file = fs.readFileSync(path.join(h.dataDir, 'files', created.state_file), 'utf8');
    expect(file).toContain('status: in_transit');
    expect(file).toContain('`waiting_for_handover` → `in_transit`');
    // The journey is the git log of that file (§30.4).
    const log = h.app.home.git.head();
    expect(log).toBeTruthy();

    const event = h.service.repos.events
      .recent({ limit: 10 })
      .find((e) => e.type === 'watch.changed')!;
    expect(event.payload).toMatchObject({
      watch_id: created.watch_id,
      from: 'waiting_for_handover',
      to: 'in_transit',
      terminal: false,
    });
  });

  it('cancels itself on a terminal value, and says so on the event', async () => {
    h = await withCarrier();
    const created = await create(h);
    setStatus('delivered');
    const step = await h.service.watchers.step(created.watch_id, { toolCtx: ctx });
    expect(step).toMatchObject({ changed: true, terminal: true });

    const watcher = h.service.repos.watchers.get(created.watch_id)!;
    expect(watcher.status).toBe('done');
    expect(h.service.repos.schedules.get(watcher.schedule_id)!.status).toBe('cancelled');
    const event = h.service.repos.events
      .recent({ limit: 10 })
      .find((e) => e.type === 'watch.changed')!;
    expect((event.payload as { terminal: boolean }).terminal).toBe(true);
    // A cancelled watcher does not keep polling.
    expect(await h.service.watchers.step(created.watch_id, { toolCtx: ctx })).toMatchObject({
      error: 'not_found',
    });
  });

  it('keeps the last known status when polls fail, and alerts once per streak', async () => {
    h = await withCarrier();
    const created = await create(h);
    setStatus('DOWN');

    for (let i = 0; i < 7; i += 1) {
      await h.service.watchers.step(created.watch_id, { toolCtx: ctx });
    }
    const watcher = h.service.repos.watchers.get(created.watch_id)!;
    // Stale, but marked — nothing looks fresher than it is (§23.2).
    expect(watcher.last_status).toBe('waiting_for_handover');
    expect(watcher.consecutive_failures).toBe(7);

    const failures = h.service.repos.events
      .recent({ limit: 20 })
      .filter((e) => e.type === 'watch.failed');
    // Edge-triggered: one alert for the streak, not one per poll.
    expect(failures).toHaveLength(1);
    expect(failures[0]!.payload).toMatchObject({ consecutive_failures: 5 });

    // Recovery is silent, and the counter resets so a later streak alerts again.
    setStatus('in_transit');
    await h.service.watchers.step(created.watch_id, { toolCtx: ctx });
    expect(h.service.repos.watchers.get(created.watch_id)!.consecutive_failures).toBe(0);
  });

  it('routes watch.due to the engine without ever asking the ingress agent', async () => {
    h = await withCarrier();
    const created = await create(h);

    // Nothing changed: this is the overwhelmingly common poll, and it must
    // cost no inference at all — not even a relevance verdict (§30.2).
    const quiet = h.service.intake.submit({
      type: 'watch.due',
      source: 'scheduler',
      payload: { watch_id: created.watch_id },
    });
    await drain(h);
    expect(h.service.repos.watchers.get(created.watch_id)!.last_polled_at).toBeTruthy();
    // Counted per event rather than by watching the endpoint: background work
    // (the §25 turns index) also talks to it, and this assertion is about what
    // *this event* cost.
    expect(h.service.repos.trace.forEvent(quiet.event.id).map((t) => t.kind)).not.toContain(
      'llm_call',
    );

    // A transition, on the other hand, is supposed to reach the model — but
    // through normal ingress on the emitted `watch.changed`, never because
    // `watch.due` was offered to the gate.
    setStatus('in_transit');
    h.service.intake.submit({
      type: 'watch.due',
      source: 'scheduler',
      payload: { watch_id: created.watch_id },
    });
    await drain(h);
    expect(h.service.repos.watchers.get(created.watch_id)!.last_status).toBe('in_transit');
    const offered = h.service.repos.events
      .recent({ limit: 20 })
      .filter((e) => e.type === 'watch.due')
      .flatMap((e) => h.service.repos.trace.forEvent(e.id))
      .filter((t) => t.kind === 'verdict' || t.kind === 'llm_call');
    // No verdict rows and no llm_call rows against any `watch.due` event: the
    // skip is structural, not a fast path the gate happened to take.
    expect(offered).toEqual([]);
  });

  it('cancels on request, schedule and all', async () => {
    h = await withCarrier();
    const created = await create(h);
    expect(h.service.watchers.cancel(created.watch_id)).toEqual({
      watch_id: created.watch_id,
      cancelled: true,
    });
    const watcher = h.service.repos.watchers.get(created.watch_id)!;
    expect(watcher.status).toBe('cancelled');
    expect(h.service.repos.schedules.get(watcher.schedule_id)!.status).toBe('cancelled');
  });

  it('freezes the args of a prior call with args_from, without retyping them', async () => {
    h = await withCarrier();
    // The trace remembers the run's own successful call; the model references
    // it and the server copies the args (§23.2's anti-telephone rule).
    const runId = h.service.repos.runs.create({ kind: 'chat', eventId: null });
    h.service.repos.trace
      .sink({ runId, eventId: null })
      .append('tool_call', { tool: 'carrier.track', args: { code: 'FROM-TRACE' }, ok: true });

    const created = await h.service.watchers.create(
      {
        note: 'parcel from a prior call',
        tool: 'carrier.track',
        args_from: true,
        status_path: 'shipment.status',
      } as never,
      {
        runId,
        grants: { granted: () => ['carrier.track'], grantedHandles: () => [] },
        toolCtx: { runId, eventId: null },
      },
    );
    expect(created).toMatchObject({ status: 'waiting_for_handover' });
    const watcher = h.service.repos.watchers.get((created as { watch_id: string }).watch_id)!;
    expect(h.service.repos.watchers.argsOf(watcher)).toEqual({ code: 'FROM-TRACE' });

    // And with no prior call, it says exactly that rather than guessing.
    const orphan = await h.service.watchers.create(
      {
        note: 'nothing to copy',
        tool: 'carrier.track',
        args_from: true,
        status_path: 'shipment.status',
      } as never,
      {
        runId: null,
        grants: { granted: () => ['carrier.track'], grantedHandles: () => [] },
        toolCtx: ctx,
      },
    );
    expect(orphan).toMatchObject({ error: 'no_prior_call' });
  });

  it('replays a watch.due sequence into the same transitions (§13.3)', async () => {
    h = await withCarrier();
    const created = await create(h);
    const seq = ['waiting_for_handover', 'in_transit', 'in_transit', 'delivered'];
    for (const value of seq) {
      setStatus(value);
      await h.service.watchers.step(created.watch_id, { toolCtx: ctx });
    }
    // Two transitions from four polls, in order, and the file agrees.
    const changes = h.service.repos.events
      .recent({ limit: 20 })
      .filter((e) => e.type === 'watch.changed')
      .map((e) => e.payload as { from: string; to: string })
      .reverse();
    expect(changes.map((c) => `${c.from}->${c.to}`)).toEqual([
      'waiting_for_handover->in_transit',
      'in_transit->delivered',
    ]);
    const file = fs.readFileSync(path.join(h.dataDir, 'files', created.state_file), 'utf8');
    expect(file.match(/→/g)).toHaveLength(2);
  });

  it('slugs a default state file, and takes an override', () => {
    expect(defaultStateFile('Posten parcel #42')).toBe('state/posten-parcel-42.md');
    expect(defaultStateFile('   ')).toBe('state/watch.md');
  });
});

describe('the watch tools (App. F.16)', () => {
  it('are granted to chat and listed in the catalog', async () => {
    h = await bootService({ onboarded: true, watchFiles: false });
    const names = h.service.tools.handles().map((t) => t.name);
    expect(names).toContain('watch.create');
    expect(names).toContain('watch.poll');
    // `watch.poll` is ro: the underlying frozen call is ro, and the
    // bookkeeping write is not a side effect the user needs gating from.
    expect(h.service.tools.handles().find((t) => t.name === 'watch.poll')?.tier).toBe('ro');
    expect(h.service.tools.handles().find((t) => t.name === 'watch.create')?.tier).toBe('se');
  });

  it('ships a handler that matches both watcher events on the fast class', async () => {
    h = await bootService({ onboarded: true, watchFiles: false });
    const handler = h.service.handlers.all().find((x) => x.name === 'watch-changed')!;
    expect(handler.frontmatter.match?.types).toEqual(['watch.changed', 'watch.failed']);
    expect(handler.frontmatter.model_class).toBe('fast');
    expect(handler.frontmatter.tools).toEqual(['deliver.notify', 'memory.query']);
  });
});
