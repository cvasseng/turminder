import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { bootService, installMcpServer, type ServiceHarness } from './service-harness.js';
import { tmpDir } from './helpers.js';

const FIXTURE = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'fixtures',
  'mcp-flaky-server.mjs',
);

const ctx = { runId: null, eventId: null };

let h: ServiceHarness;
let t: { dir: string; cleanup: () => void };
afterEach(async () => {
  await h?.cleanup();
  t?.cleanup();
});

/**
 * Take the server away the way a VPN route goes away: the process exits, and
 * the *next* process refuses to start while the marker file is there. Both
 * halves are needed — a stdio reconnect spawns a fresh child, so without the
 * marker "unreachable" would be impossible to stage at all.
 */
const install = async (
  harness: ServiceHarness,
  env: Record<string, string> = {},
): Promise<void> => {
  await installMcpServer(harness, { name: 'flaky', fixture: FIXTURE, env });
};

const kill = async (harness: ServiceHarness): Promise<void> => {
  await harness.service.tools.get('flaky.die')!.call({}, ctx);
  // The child exits ~20ms after answering; wait for `onclose` to land.
  for (let i = 0; i < 100; i += 1) {
    if (!harness.service.tools.serverStatus()[0]?.connected) return;
    await new Promise((r) => setTimeout(r, 20));
  }
};

const statusOf = (harness: ServiceHarness) =>
  harness.service.tools.serverStatus().find((s) => s.name === 'flaky')!;

describe('an MCP server that dropped (§11.6)', () => {
  it('reports it is down, with the error, and comes back with no restart', async () => {
    t = tmpDir('turminder-flaky-');
    const down = path.join(t.dir, 'down');
    h = await bootService({ onboarded: true, runScheduler: false });
    await install(h, { FLAKY_DOWN_FILE: down });

    expect(statusOf(h).connected).toBe(true);
    expect((await h.service.tools.get('flaky.ping')!.call({}, ctx)).ok).toBe(true);

    // Take it away, and keep it away.
    fs.writeFileSync(down, '');
    await kill(h);

    // `connected` is liveness now, not map membership — and it carries the
    // error that took the server down.
    const dead = statusOf(h);
    expect(dead.connected).toBe(false);
    expect(dead.error).toBeTruthy();

    // The tools stay advertised: withdrawing them removes the model's only
    // reason to call one, and the call is what triggers the reconnect.
    expect(h.service.tools.get('flaky.ping')).toBeTruthy();
    expect(dead.tools).toContain('flaky.ping');

    // A call now says the server is unreachable and when it will be retried —
    // not `tool_failed`, which taught the user nothing.
    const refused = await h.service.tools.get('flaky.ping')!.call({}, ctx);
    expect(refused.ok).toBe(false);
    expect((refused.output as any).error).toBe('server_unavailable');
    expect((refused.output as any).message).toContain('flaky');
    expect((refused.output as any).message).toMatch(/try again automatically/);
    expect(statusOf(h).next_retry_at).toBeTruthy();

    // Fix the fault. Ask the same question again. No restart.
    fs.rmSync(down);
    const back = await h.service.tools.get('flaky.ping')!.call({ echo: 'hi' }, ctx);
    expect(back.ok).toBe(true);
    expect((back.output as any).pong).toBe('hi');
    const revived = statusOf(h);
    expect(revived.connected).toBe(true);
    expect(revived.error).toBeUndefined();
    expect(revived.next_retry_at).toBeUndefined();
  }, 20_000);

  it('picks up a different tool set on reconnect', async () => {
    t = tmpDir('turminder-flaky-');
    const toolset = path.join(t.dir, 'toolset');
    h = await bootService({ onboarded: true, runScheduler: false });
    await install(h, { FLAKY_TOOLSET_FILE: toolset });

    expect(h.service.tools.get('flaky.extra')).toBeNull();
    await kill(h);

    // The server grew a tool while it was away.
    fs.writeFileSync(toolset, 'extended');
    const back = await h.service.tools.get('flaky.ping')!.call({}, ctx);
    expect(back.ok).toBe(true);
    expect((back.output as any).toolset).toBe('extended');

    // The hub re-listed rather than assuming (§11.6).
    expect(h.service.tools.get('flaky.extra')).toBeTruthy();
    expect(statusOf(h).tools).toContain('flaky.extra');
  }, 20_000);

  it('leaves a bundled integration trivially alive — it cannot drop', async () => {
    h = await bootService({ onboarded: true, runScheduler: false });
    // Nothing in-process ever reports a liveness problem: it is the same
    // process, so there is nothing to lose the connection to.
    const before = await h.service.tools.get('time.now')!.call({}, ctx);
    expect(before.ok).toBe(true);
    expect(h.service.tools.serverStatus()).toEqual([]);
  });
});

describe('the reconnect backoff (§11.6, App. A)', () => {
  /** A clock a test owns: nothing sleeps, and every delay is recorded. */
  class FakeClock {
    ms = 0;
    readonly booked: number[] = [];
    private readonly pending = new Map<
      NodeJS.Timeout,
      { at: number; fn: () => void | Promise<void> }
    >();
    private next = 1;

    readonly api = {
      now: () => this.ms,
      setTimeout: (fn: () => void | Promise<void>, delay: number): NodeJS.Timeout => {
        const id = this.next++ as unknown as NodeJS.Timeout;
        this.booked.push(delay);
        this.pending.set(id, { at: this.ms + delay, fn });
        return id;
      },
      clearTimeout: (id: NodeJS.Timeout): void => {
        this.pending.delete(id);
      },
    };

    /** Fire everything due at or before `to`, in order. */
    async advanceTo(to: number): Promise<void> {
      this.ms = to;
      for (;;) {
        const due = [...this.pending.entries()]
          .filter(([, p]) => p.at <= to)
          .sort((a, b) => a[1].at - b[1].at);
        if (!due.length) return;
        for (const [id, p] of due) {
          this.pending.delete(id);
          // Awaited, not guessed at: a reconnect spawns a process, and no
          // number of microtask ticks is evidence that it has finished.
          await p.fn();
        }
      }
    }
  }

  it('follows the schedule and settles at the last value, forever', async () => {
    t = tmpDir('turminder-backoff-');
    const clock = new FakeClock();
    // A server that can never start: the command is not there. From the user's
    // side "never came up" and "dropped" are the same fault, and §11.6 gives
    // them the same loop.
    h = await bootService({ onboarded: true, runScheduler: false, hubClock: clock.api });
    const { write } = await import('./helpers.js');
    write(
      path.join(h.dataDir, 'config', 'mcp.yaml'),
      `servers:\n  - name: ghost\n    transport: stdio\n    command: ["node", "${path.join(t.dir, 'nope.mjs')}"]\n`,
    );
    h.app.config.reload();
    await h.service.tools.connectExternal('ghost');

    const status = () => h.service.tools.serverStatus().find((s) => s.name === 'ghost')!;
    expect(status().connected).toBe(false);
    expect(status().error).toBeTruthy();

    // The first attempt is booked as soon as the connect fails.
    expect(clock.booked).toEqual([5000]);
    await clock.advanceTo(5000);
    expect(clock.booked).toEqual([5000, 15000]);
    await clock.advanceTo(20_000);
    expect(clock.booked).toEqual([5000, 15000, 60000]);
    await clock.advanceTo(80_000);
    expect(clock.booked).toEqual([5000, 15000, 60000, 300000]);

    // ...and then the last value repeats forever rather than spinning.
    await clock.advanceTo(380_000);
    await clock.advanceTo(680_000);
    expect(clock.booked).toEqual([5000, 15000, 60000, 300000, 300000, 300000]);
  }, 20_000);

  it('stops retrying a server that has left mcp.yaml', async () => {
    t = tmpDir('turminder-backoff-');
    const clock = new FakeClock();
    h = await bootService({ onboarded: true, runScheduler: false, hubClock: clock.api });
    const { write } = await import('./helpers.js');
    write(
      path.join(h.dataDir, 'config', 'mcp.yaml'),
      `servers:\n  - name: ghost\n    transport: stdio\n    command: ["node", "${path.join(t.dir, 'nope.mjs')}"]\n`,
    );
    h.app.config.reload();
    await h.service.tools.connectExternal('ghost');
    expect(clock.booked).toEqual([5000]);

    // The user removed it through the form flow; the loop is not the hub's to
    // keep alive after that.
    write(path.join(h.dataDir, 'config', 'mcp.yaml'), `servers: []\n`);
    h.app.config.reload();
    await clock.advanceTo(5000);
    expect(clock.booked).toEqual([5000]);
    await clock.advanceTo(400_000);
    expect(clock.booked).toEqual([5000]);
  }, 20_000);

  it('honours a url edited in mcp.yaml while the service ran', async () => {
    t = tmpDir('turminder-backoff-');
    const down = path.join(t.dir, 'down');
    h = await bootService({ onboarded: true, runScheduler: false });
    const { write } = await import('./helpers.js');
    // First definition points at a command that does not exist.
    write(
      path.join(h.dataDir, 'config', 'mcp.yaml'),
      `servers:\n  - name: flaky\n    transport: stdio\n    command: ["node", "${path.join(t.dir, 'nope.mjs')}"]\n`,
    );
    h.app.config.reload();
    await h.service.tools.connectExternal('flaky');
    expect(h.service.tools.serverStatus()[0]?.connected).toBe(false);

    // The user fixes the path. A reconnect re-reads this server's own entry.
    write(
      path.join(h.dataDir, 'config', 'mcp.yaml'),
      `servers:\n  - name: flaky\n    transport: stdio\n    command: ["node", "${FIXTURE}"]\n    env:\n      FLAKY_DOWN_FILE: ${JSON.stringify(down)}\n`,
    );
    h.app.config.reload();
    await h.service.tools.connectExternal('flaky');
    expect(h.service.tools.serverStatus()[0]?.connected).toBe(true);
    expect(h.service.tools.get('flaky.ping')).toBeTruthy();
  }, 20_000);
});
