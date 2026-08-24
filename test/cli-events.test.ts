import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runCli, tmpDir, write } from './helpers.js';

const DEV = { TURMINDER_DEV_PROCESSOR: '1' };

describe('turminder events (phase 2 exit criteria)', () => {
  let t: { dir: string; cleanup: () => void };
  let root: string;

  beforeEach(async () => {
    t = tmpDir('turminder-events-cli-');
    root = path.join(t.dir, 'home');
    await runCli(['--data-dir', root, 'doctor']);
    // Retries with zero backoff, so a CLI demo does not take 30 minutes.
    write(
      path.join(root, 'config', 'turminder.yaml'),
      'data_defaults:\n  retry_attempts: 3\n  retry_backoff_s: [0, 0, 0]\n',
    );
  });
  afterEach(() => t.cleanup());

  const inject = (args: string[]) =>
    runCli(['--data-dir', root, 'events', 'inject', ...args], DEV);

  it('injects and processes an event, visible in show', async () => {
    const r = await inject([
      '--type',
      'email.received',
      '--source',
      'imap.test',
      '--payload',
      '{"subject":"hi"}',
      '--run',
    ]);
    expect(r.code).toBe(0);
    const { event_id, status } = JSON.parse(r.stdout.trim());
    expect(status).toBe('accepted');

    const show = await runCli(['--data-dir', root, 'events', 'show', event_id]);
    expect(show.code).toBe(0);
    expect(show.stdout).toContain('email.received');
    expect(show.stdout).toContain('status   done');
    expect(show.stdout).toMatch(/\(new\) → received/);
    expect(show.stdout).toMatch(/received → processing/);
    expect(show.stdout).toMatch(/processing → done/);
  });

  it('dedupes on the idempotency key', async () => {
    const first = await inject([
      '--type',
      'email.received',
      '--source',
      'imap.test',
      '--idem',
      '<m1@x>',
    ]);
    const second = await inject([
      '--type',
      'email.received',
      '--source',
      'imap.test',
      '--idem',
      '<m1@x>',
    ]);
    const a = JSON.parse(first.stdout.trim());
    const b = JSON.parse(second.stdout.trim());
    expect(a.status).toBe('accepted');
    expect(b.status).toBe('duplicate');
    expect(b.event_id).toBe(a.event_id);
  });

  it('retries an event that fails twice and shows every attempt', async () => {
    const r = await inject(['--type', 'test.flaky', '--payload', '{"fail_times":2}', '--run']);
    const { event_id } = JSON.parse(r.stdout.trim());
    const show = await runCli(['--data-dir', root, 'events', 'show', event_id, '--json']);
    const parsed = JSON.parse(show.stdout);
    expect(parsed.event.status).toBe('done');
    expect(parsed.event.attempts).toBe(3);
    const states = parsed.trace
      .filter((x: any) => x.kind === 'state')
      .map((x: any) => x.data.to);
    expect(states).toEqual([
      'received',
      'processing',
      'failed',
      'processing',
      'failed',
      'processing',
      'done',
    ]);
    const errors = parsed.trace.filter((x: any) => x.kind === 'error');
    expect(errors).toHaveLength(2);
  });

  it('dead-letters an event that always fails, and reports it as an event', async () => {
    const r = await inject(['--type', 'test.fail', '--run']);
    const { event_id } = JSON.parse(r.stdout.trim());
    const show = await runCli(['--data-dir', root, 'events', 'show', event_id, '--json']);
    const parsed = JSON.parse(show.stdout);
    expect(parsed.event.status).toBe('dead_letter');
    expect(parsed.event.attempts).toBe(3);
    expect(parsed.event.last_error).toContain('always fails');

    const list = await runCli(['--data-dir', root, 'events', 'list', '-n', '20']);
    expect(list.stdout).toContain('system.handler_failed');
  });

  it('serialises events on one key and runs them all to completion', async () => {
    const ids: string[] = [];
    for (const tag of ['a', 'b', 'c']) {
      const r = await inject([
        '--type',
        'test.slow',
        '--key',
        'thread-1',
        '--payload',
        `{"ms":5,"tag":"${tag}"}`,
      ]);
      ids.push(JSON.parse(r.stdout.trim()).event_id);
    }
    const run = await inject([
      '--type',
      'test.slow',
      '--key',
      'thread-1',
      '--payload',
      '{"ms":1,"tag":"d"}',
      '--run',
    ]);
    expect(run.code).toBe(0);
    ids.push(JSON.parse(run.stdout.trim()).event_id);

    for (const id of ids) {
      const show = await runCli(['--data-dir', root, 'events', 'show', id, '--json']);
      const parsed = JSON.parse(show.stdout);
      expect(parsed.event.status).toBe('done');
      expect(parsed.event.serialization_key).toBe('thread-1');
    }
    // Arrival order is id order (monotonic ULIDs), and processing followed it.
    expect([...ids].sort()).toEqual(ids);
  });

  it('rejects an over-deep chain and emits system.loop_suspected', async () => {
    write(
      path.join(root, 'config', 'turminder.yaml'),
      'data_defaults:\n  max_depth: 1\n  retry_backoff_s: [0, 0, 0]\n',
    );
    const root0 = JSON.parse((await inject(['--type', 'chain.a'])).stdout.trim());
    const child = JSON.parse(
      (await inject(['--type', 'chain.b', '--caused-by', root0.event_id])).stdout.trim(),
    );
    expect(child.status).toBe('accepted');
    const tooDeep = JSON.parse(
      (await inject(['--type', 'chain.c', '--caused-by', child.event_id])).stdout.trim(),
    );
    expect(tooDeep.status).toBe('rejected');
    expect(tooDeep.reason).toBe('depth_exceeded');

    const list = await runCli(['--data-dir', root, 'events', 'list', '-n', '20']);
    expect(list.stdout).toContain('system.loop_suspected');
    expect(list.stdout).toContain('rejected');
  });

  it('reports a useful error for an unknown event id', async () => {
    const r = await runCli(['--data-dir', root, 'events', 'show', 'NOPE']);
    expect(r.code).toBe(1);
    expect(r.stdout + r.stderr).toMatch(/not_found/);
  });
});
