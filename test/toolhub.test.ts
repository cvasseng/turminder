import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Config, DEFAULT_SETTINGS } from '../src/core/config.js';
import { openDataHome, type DataHome } from '../src/core/datadir.js';
import { FormBroker } from '../src/chat/forms.js';
import { openDb } from '../src/db/index.js';
import { createRepos } from '../src/db/repos/index.js';
import { EventIntake } from '../src/ingress/intake.js';
import { ToolHub } from '../src/tools/hub.js';
import { SkillLoader } from '../src/tools/skills.js';
import { ProjectScope } from '../src/projects/scope.js';
import { GrantedDispatcher } from '../src/tools/dispatcher.js';
import { webTools } from '../src/tools/integrations/web.js';
import { tmpDir, write } from './helpers.js';

interface Harness {
  home: DataHome;
  hub: ToolHub;
  intake: EventIntake;
  repos: ReturnType<typeof createRepos>;
  cleanup(): Promise<void>;
}

async function hubHarness(opts: { fetch?: typeof globalThis.fetch } = {}): Promise<Harness> {
  const t = tmpDir('turminder-hub-');
  const { home } = openDataHome(path.join(t.dir, 'home'));
  const db = openDb(home.dbPath);
  const repos = createRepos(db);
  const config = new Config(home);
  const intake = new EventIntake(repos, DEFAULT_SETTINGS);
  const skills = new SkillLoader(home);
  const hub = await ToolHub.create({
    home,
    config,
    intake,
    repos,
    skills,
    projectScope: new ProjectScope(repos.conversations),
    forms: new FormBroker(home, config),
    router: () => null,
    ...(opts.fetch ? { fetch: opts.fetch } : {}),
  });
  return {
    home,
    hub,
    intake,
    repos,
    async cleanup() {
      await hub.close();
      db.close();
      t.cleanup();
    },
  };
}

let h: Harness;
afterEach(async () => {
  await h?.cleanup();
});

describe('tool hub (§11.1)', () => {
  it('serves every bundled integration through one interface', async () => {
    h = await hubHarness();
    const names = h.hub
      .handles()
      .map((t) => t.name)
      .sort();
    expect(names).toEqual([
      'config.read',
      'config.write',
      'events.emit',
      'schedule.cancel',
      'schedule.create',
      'schedule.list',
      'skills.fetch',
      'time.now',
      'usage.summary',
      'weather.forecast',
      'web.fetch',
      'web.query',
      'web.search',
    ]);
    expect(h.hub.get('web.search')?.tier).toBe('ro');
    expect(h.hub.get('config.write')?.tier).toBe('se');
    expect(h.hub.get('events.emit')?.source).toBe('events');
  });

  it('stamps provenance on events.emit from the run context, not the model', async () => {
    h = await hubHarness();
    const parent = h.intake.submit({ type: 'email.received', source: 'imap', payload: {} });
    const runId = h.repos.runs.create({
      kind: 'handler',
      handlerName: 'filer',
      eventId: parent.event.id,
    });

    const dispatcher = new GrantedDispatcher(
      h.hub.handles(),
      { tools: ['events.emit'] },
      {
        runId,
        eventId: parent.event.id,
        handlerName: 'filer',
      },
    );
    const r = await dispatcher.dispatch({
      toolCallId: '1',
      name: 'events.emit',
      // The model tries to claim provenance; it must be ignored.
      args: { type: 'invoice.filed', payload: { n: 1 }, caused_by: 'made-up', depth: 0 },
    });
    expect(r.ok).toBe(true);
    const emitted = h.repos.events.get((r.output as any).event_id)!;
    expect(emitted.caused_by).toBe(parent.event.id);
    expect(emitted.depth).toBe(1);
    expect(emitted.source).toBe('handler.filer');
    // And the emit is attributed to the run on the parent's trace.
    expect(h.repos.trace.emitterOf(emitted.id)).toEqual({ runId, handlerName: 'filer' });
  });

  it('refuses an emit that would loop, without throwing', async () => {
    h = await hubHarness();
    const root = h.intake.submit({
      type: 'email.received',
      source: 'imap',
      payload: {},
      serialization_key: 'thread-1',
    });
    const runId = h.repos.runs.create({ kind: 'handler', handlerName: 'nudge' });
    const first = h.intake.submit({
      type: 'nudge.sent',
      source: 'handler.nudge',
      payload: {},
      serialization_key: 'thread-1',
      caused_by: root.event.id,
      emitted_by_run: runId,
    });
    const runId2 = h.repos.runs.create({ kind: 'handler', handlerName: 'nudge' });
    const dispatcher = new GrantedDispatcher(
      h.hub.handles(),
      { tools: ['events.emit'] },
      {
        runId: runId2,
        eventId: first.event.id,
        handlerName: 'nudge',
      },
    );
    const r = await dispatcher.dispatch({
      toolCallId: '1',
      name: 'events.emit',
      args: { type: 'nudge.sent', payload: {}, serialization_key: 'thread-1' },
    });
    expect((r.output as any).error).toBe('loop_rejected');
  });
});

describe('web.search integration (§11.2)', () => {
  it('queries SearXNG json api and returns fenced-ready results', async () => {
    const calls: string[] = [];
    const fakeFetch = (async (url: any) => {
      calls.push(String(url));
      return new Response(
        JSON.stringify({
          results: [
            {
              title: 'Oslo',
              url: 'https://example.com/oslo',
              content: 'Capital of Norway',
              engine: 'duckduckgo',
            },
            {
              title: 'Bergen',
              url: 'https://example.com/bergen',
              content: 'Rain',
              engine: 'brave',
            },
            { title: 'Third', url: 'https://example.com/3', content: 'x', engine: 'y' },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }) as unknown as typeof globalThis.fetch;

    const [search] = webTools({ settings: DEFAULT_SETTINGS, fetch: fakeFetch });
    const result = (await search!.execute(
      { query: 'capital of norway', max_results: 2 },
      {
        runId: null,
        eventId: null,
      },
    )) as { results: { title: string; url: string; snippet: string }[]; untrusted: boolean };

    expect(result.results).toHaveLength(2);
    expect(result.results[0]).toEqual({
      title: 'Oslo',
      url: 'https://example.com/oslo',
      snippet: 'Capital of Norway',
      engine: 'duckduckgo',
    });
    expect(result.untrusted).toBe(true);
    const requested = new URL(calls[0]!);
    expect(requested.pathname).toBe('/search');
    expect(requested.searchParams.get('format')).toBe('json');
    expect(requested.searchParams.get('q')).toBe('capital of norway');
  });

  it('reports a search failure as data instead of throwing', async () => {
    const fakeFetch = (async () =>
      new Response('nope', { status: 502 })) as unknown as typeof globalThis.fetch;
    const [search] = webTools({ settings: DEFAULT_SETTINGS, fetch: fakeFetch });
    const result = (await search!.execute({ query: 'x' }, { runId: null, eventId: null })) as {
      error: string;
    };
    expect(result.error).toBe('search_failed');
  });

  it('is registered read-only so it can auto-execute', async () => {
    const [search] = webTools({ settings: DEFAULT_SETTINGS });
    expect(search!.tier).toBe('ro');
  });
});

describe('skills (§11.1, App. G.8)', () => {
  it('lists descriptions and serves bodies only on request', async () => {
    h = await hubHarness();
    write(
      h.home.path('skills', 'invoice-filing.md'),
      `---\nname: invoice-filing\ndescription: How to file invoices in the finance folder.\n---\n\nStep one: find the invoice number.\n`,
    );
    write(
      h.home.path('skills', 'weather.md'),
      `---\nname: weather\ndescription: Looking up forecasts.\n---\n\nUse web.search with category news.\n`,
    );
    await h.hub.refresh();
    h.hub.skills.reload();

    const roster = h.hub.skills.roster();
    expect(roster.map((s) => s.name).sort()).toEqual(['invoice-filing', 'weather']);
    // The roster carries descriptions only — bodies stay out of the prompt.
    expect(JSON.stringify(roster)).not.toContain('Step one');

    const dispatcher = new GrantedDispatcher(
      h.hub.handles(),
      { tools: ['skills.fetch'] },
      {
        runId: null,
        eventId: null,
      },
    );
    const found = await dispatcher.dispatch({
      toolCallId: '1',
      name: 'skills.fetch',
      args: { name: 'invoice-filing' },
    });
    expect((found.output as any).content).toContain('Step one');

    const missing = await dispatcher.dispatch({
      toolCallId: '2',
      name: 'skills.fetch',
      args: { name: 'nonexistent' },
    });
    expect((missing.output as any).error).toBe('not_found');
    expect((missing.output as any).available).toContain('weather');
  });

  it('skips a malformed skill rather than failing to start', async () => {
    h = await hubHarness();
    write(
      h.home.path('skills', 'good.md'),
      `---\nname: good\ndescription: fine.\n---\n\nbody\n`,
    );
    write(h.home.path('skills', 'bad.md'), `---\nname: bad\n---\n\nno description\n`);
    h.hub.skills.reload();
    expect(h.hub.skills.roster().map((s) => s.name)).toEqual(['good']);
  });

  it('ignores non-markdown files in the skills directory', async () => {
    h = await hubHarness();
    fs.writeFileSync(h.home.path('skills', 'notes.txt'), 'not a skill');
    h.hub.skills.reload();
    expect(h.hub.skills.roster()).toHaveLength(0);
  });
});

describe('external MCP servers (§11.1)', () => {
  it('serves an out-of-process server through the same interface as a bundled one', async () => {
    const t = tmpDir('turminder-mcp-');
    const { home } = openDataHome(path.join(t.dir, 'home'));
    const fixture = path.resolve('test/fixtures/mcp-clock-server.mjs');
    write(
      home.path('config', 'mcp.yaml'),
      `servers:\n  - name: clock\n    transport: stdio\n    command: ["node", "${fixture}"]\n    read_only_tools: ["clock.now"]\n`,
    );
    const db = openDb(home.dbPath);
    const repos = createRepos(db);
    const config = new Config(home);
    const hub = await ToolHub.create({
      home,
      config,
      intake: new EventIntake(repos, DEFAULT_SETTINGS),
      repos,
      skills: new SkillLoader(home),
      projectScope: new ProjectScope(repos.conversations),
      forms: new FormBroker(home, config),
      router: () => null,
    });

    try {
      const names = hub.handles().map((h) => h.name);
      expect(names).toContain('clock.now');
      expect(names).toContain('clock.set_alarm');
      // Both a bundled integration and an external server, same shape.
      expect(hub.get('clock.now')?.source).toBe('clock');
      expect(hub.get('clock.now')?.tier).toBe('ro');
      expect(hub.get('clock.set_alarm')?.tier).toBe('se');
      expect(hub.get('web.search')?.source).toBe('web');

      const dispatcher = new GrantedDispatcher(
        hub.handles(),
        { tools: ['clock.now', 'web.search'] },
        { runId: 'r', eventId: 'e' },
      );
      // The model sees one tool list; nothing marks which side of a process
      // boundary a tool lives on.
      expect(Object.keys(dispatcher.toolSet()).sort()).toEqual(['clock.now', 'web.search']);
      const result = await dispatcher.dispatch({
        toolCallId: '1',
        name: 'clock.now',
        args: { timezone: 'Europe/Oslo' },
      });
      expect(result.ok).toBe(true);
      expect((result.output as any).now).toBe('2026-08-20T21:00:00.000Z');
      expect((result.output as any).timezone).toBe('Europe/Oslo');
      expect((result.output as any).pid_is_separate).toBe(true);

      // Ungranted external tools are just as invisible as ungranted local ones.
      const denied = await dispatcher.dispatch({
        toolCallId: '2',
        name: 'clock.set_alarm',
        args: { at: 'noon' },
      });
      expect(denied.denied).toBe('not_granted');
    } finally {
      await hub.close();
      db.close();
      t.cleanup();
    }
  });

  it('starts with a degraded tool list when an external server is broken', async () => {
    const t = tmpDir('turminder-mcp-bad-');
    const { home } = openDataHome(path.join(t.dir, 'home'));
    write(
      home.path('config', 'mcp.yaml'),
      `servers:\n  - name: broken\n    transport: stdio\n    command: ["node", "/nonexistent/server.mjs"]\n`,
    );
    const db = openDb(home.dbPath);
    const repos = createRepos(db);
    const config = new Config(home);
    const hub = await ToolHub.create({
      home,
      config,
      intake: new EventIntake(repos, DEFAULT_SETTINGS),
      repos,
      skills: new SkillLoader(home),
      projectScope: new ProjectScope(repos.conversations),
      forms: new FormBroker(home, config),
      router: () => null,
    });
    try {
      // The assistant still starts; it just has fewer tools.
      expect(hub.handles().map((h) => h.name)).toContain('web.search');
      expect(hub.get('broken.anything')).toBeNull();
    } finally {
      await hub.close();
      db.close();
      t.cleanup();
    }
  });
});
