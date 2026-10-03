import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { GrantedDispatcher } from '../src/tools/dispatcher.js';
import { NAMESPACE_IDLE_RUNS, OPEN_TOOL, PagedDispatcher } from '../src/tools/paged.js';
import type { ToolHandle } from '../src/tools/types.js';
import {
  bootService,
  installMcpServer,
  offeredTools,
  type ServiceHarness,
} from './service-harness.js';

let h: ServiceHarness;
afterEach(async () => {
  await h?.cleanup();
});

const drain = (harness: ServiceHarness) => harness.service.queue.drain();
const column = (harness: ServiceHarness, id: string) =>
  (
    harness.app.db
      .prepare(`SELECT open_namespaces FROM conversations WHERE id = ?`)
      .get(id) as {
      open_namespaces: string;
    }
  ).open_namespaces;

describe('open_namespaces shape and decay (§21.2.5)', () => {
  it('reads a legacy array of plain names as idle 0 and rewrites it on the next write', async () => {
    h = await bootService({ onboarded: true, watchFiles: false });
    const repo = h.service.repos.conversations;
    const conv = repo.create({});
    h.app.db
      .prepare(`UPDATE conversations SET open_namespaces = ? WHERE id = ?`)
      .run('["setup","config"]', conv.id);

    expect(repo.openNamespaces(conv.id)).toEqual(['config', 'setup']);
    // Reading alone does not rewrite.
    expect(column(h, conv.id)).toBe('["setup","config"]');

    repo.openNamespace(conv.id, 'watch');
    expect(JSON.parse(column(h, conv.id))).toEqual([
      { name: 'config', idle_runs: 0 },
      { name: 'setup', idle_runs: 0 },
      { name: 'watch', idle_runs: 0 },
    ]);
  });

  it('rewrites a legacy row even when the re-opened name was already present', async () => {
    h = await bootService({ onboarded: true, watchFiles: false });
    const repo = h.service.repos.conversations;
    const conv = repo.create({});
    h.app.db
      .prepare(`UPDATE conversations SET open_namespaces = ? WHERE id = ?`)
      .run('["setup"]', conv.id);
    expect(repo.openNamespace(conv.id, 'setup')).toBe(false);
    expect(JSON.parse(column(h, conv.id))).toEqual([{ name: 'setup', idle_runs: 0 }]);
  });

  it('survives a mangled column by starting from core', async () => {
    h = await bootService({ onboarded: true, watchFiles: false });
    const repo = h.service.repos.conversations;
    const conv = repo.create({});
    for (const raw of ['not json', '{"a":1}', '[1,null,{"idle_runs":2}]']) {
      h.app.db
        .prepare(`UPDATE conversations SET open_namespaces = ? WHERE id = ?`)
        .run(raw, conv.id);
      expect(repo.openNamespaces(conv.id)).toEqual([]);
      expect(repo.decayNamespaces(conv.id, NAMESPACE_IDLE_RUNS)).toEqual([]);
    }
  });

  it('keeps a namespace through three idle runs and drops it on the fourth', async () => {
    h = await bootService({ onboarded: true, watchFiles: false });
    const repo = h.service.repos.conversations;
    const conv = repo.create({});
    repo.openNamespace(conv.id, 'setup');
    expect(NAMESPACE_IDLE_RUNS).toBe(3);

    // Two idle runs: still open.
    expect(repo.decayNamespaces(conv.id, NAMESPACE_IDLE_RUNS)).toEqual([]);
    expect(repo.decayNamespaces(conv.id, NAMESPACE_IDLE_RUNS)).toEqual([]);
    expect(repo.openNamespaces(conv.id)).toEqual(['setup']);
    // Third: idle_runs reaches 3, which is not above the limit.
    expect(repo.decayNamespaces(conv.id, NAMESPACE_IDLE_RUNS)).toEqual([]);
    expect(repo.openNamespaces(conv.id)).toEqual(['setup']);
    // Fourth: above it, dropped.
    expect(repo.decayNamespaces(conv.id, NAMESPACE_IDLE_RUNS)).toEqual(['setup']);
    expect(repo.openNamespaces(conv.id)).toEqual([]);
  });

  it('restarts the count when the namespace is opened again', async () => {
    h = await bootService({ onboarded: true, watchFiles: false });
    const repo = h.service.repos.conversations;
    const conv = repo.create({});
    repo.openNamespace(conv.id, 'setup');
    repo.decayNamespaces(conv.id, 3);
    repo.decayNamespaces(conv.id, 3);
    repo.openNamespace(conv.id, 'setup');
    repo.decayNamespaces(conv.id, 3);
    repo.decayNamespaces(conv.id, 3);
    repo.decayNamespaces(conv.id, 3);
    expect(repo.openNamespaces(conv.id)).toEqual(['setup']);
  });

  it('decays each namespace on its own count', async () => {
    h = await bootService({ onboarded: true, watchFiles: false });
    const repo = h.service.repos.conversations;
    const conv = repo.create({});
    repo.openNamespace(conv.id, 'old');
    repo.decayNamespaces(conv.id, 3);
    repo.decayNamespaces(conv.id, 3);
    repo.openNamespace(conv.id, 'fresh');
    repo.decayNamespaces(conv.id, 3);
    expect(repo.decayNamespaces(conv.id, 3)).toEqual(['old']);
    expect(repo.openNamespaces(conv.id)).toEqual(['fresh']);
  });
});

describe('use resets the idle count (§21.2.5)', () => {
  function build(core: string[] = []) {
    const handles = [
      { name: 'clock.now', source: 'clock', tier: 'ro' },
      { name: 'files.read', source: 'files', tier: 'ro' },
    ] as unknown as ToolHandle[];
    const opens: string[] = [];
    const inner = {
      grantedHandles: () => handles,
      toolSet: () => ({}),
      dispatch: async () => ({ ok: true, output: {} }),
    } as unknown as GrantedDispatcher;
    const paged = new PagedDispatcher(inner, {
      core,
      store: { opened: () => opens, open: (n) => void opens.push(n) },
    });
    return { paged, opens };
  }

  it('an implicit call writes through', async () => {
    const { paged, opens } = build();
    await paged.dispatch({ toolCallId: '1', name: 'clock.now', args: {} });
    expect(opens).toEqual(['clock']);
  });

  it('a call in an already-open namespace writes through again', async () => {
    const { paged, opens } = build();
    opens.push('clock');
    await paged.dispatch({ toolCallId: '1', name: 'clock.now', args: {} });
    expect(opens).toEqual(['clock', 'clock']);
  });

  it('asking tools.open for an open namespace counts as use', async () => {
    const { paged, opens } = build();
    opens.push('clock');
    await paged.dispatch({ toolCallId: '1', name: OPEN_TOOL, args: { namespace: 'clock' } });
    expect(opens).toEqual(['clock', 'clock']);
  });

  it('a core namespace has no counter to reset', async () => {
    const { paged, opens } = build(['clock']);
    await paged.dispatch({ toolCallId: '1', name: 'clock.now', args: {} });
    expect(opens).toEqual([]);
  });
});

describe('decay at chat run start (§21.2.5)', () => {
  const FIXTURE = () => path.resolve('test/fixtures/mcp-clock-server.mjs');

  it('sheds the definitions on the fourth run without use, and a call in between resets it', async () => {
    h = await bootService({ onboarded: true, watchFiles: false });
    await installMcpServer(h, { name: 'clock', fixture: FIXTURE() });
    const repo = h.service.repos.conversations;
    const conv = repo.create({});
    repo.openNamespace(conv.id, 'clock');
    h.fake.always({ text: 'ok' });

    const run = async (text: string) => {
      h.service.chat.send({ conversationId: conv.id, text });
      await drain(h);
      return offeredTools(h);
    };

    // Runs 1-3 are idle but the namespace is still within its allowance.
    for (const n of [1, 2, 3]) expect(await run(`idle ${n}`)).toContain('clock.now');
    // Run 4 decays it before the first call.
    expect(await run('idle 4')).not.toContain('clock.now');
    expect(repo.openNamespaces(conv.id)).not.toContain('clock');

    // Reopen, then use it in a run: the count restarts.
    repo.openNamespace(conv.id, 'clock');
    expect(await run('idle a')).toContain('clock.now');
    expect(await run('idle b')).toContain('clock.now');
    let called = false;
    h.fake.always((req) => {
      if (!called && offeredTools(h, req as never).includes('clock.now')) {
        called = true;
        return { toolCalls: [{ name: 'clock.now', args: {} }] };
      }
      return { text: 'ok' };
    });
    expect(await run('use it')).toContain('clock.now');
    h.fake.always({ text: 'ok' });
    for (const n of [1, 2, 3]) expect(await run(`after ${n}`)).toContain('clock.now');
    expect(await run('after 4')).not.toContain('clock.now');
  });

  it('closes only at the run boundary: tool definitions are identical across a run', async () => {
    h = await bootService({ onboarded: true, watchFiles: false });
    await installMcpServer(h, { name: 'clock', fixture: FIXTURE() });
    const repo = h.service.repos.conversations;
    const conv = repo.create({});
    repo.openNamespace(conv.id, 'clock');
    // Idle to the edge, so this run is the one that decays it.
    for (let i = 0; i < 3; i++) repo.decayNamespaces(conv.id, 3);
    let calls = 0;
    h.fake.always(() => {
      calls++;
      return calls === 1 ? { toolCalls: [{ name: 'time.now', args: {} }] } : { text: 'done' };
    });
    h.service.chat.send({ conversationId: conv.id, text: 'go' });
    await drain(h);
    const [first, second] = h.fake.requests.slice(-2).map((r) => JSON.stringify(r.body.tools));
    expect(second).toBe(first);
    expect(offeredTools(h)).not.toContain('clock.now');
    expect(repo.openNamespaces(conv.id)).toEqual([]);
  });
});
