import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { afterEach, describe, expect, it } from 'vitest';
import { Config } from '../src/core/config.js';
import { openDataHome } from '../src/core/datadir.js';
import { GrantStore } from '../src/tools/grants.js';
import { GrantedDispatcher } from '../src/tools/dispatcher.js';
import { resolveWritablePath, PathRejected } from '../src/tools/paths.js';
import {
  LEVEL_CHOICES,
  accessForm,
  matchAccess,
  patternsToRecord,
} from '../src/tools/integrations/setup/access.js';
import type { ToolHandle } from '../src/tools/types.js';
import {
  bootService,
  offeredTools,
  TestClient,
  type ServiceHarness,
} from './service-harness.js';
import { tmpDir, write } from './helpers.js';

let h: ServiceHarness;
afterEach(async () => {
  await h?.cleanup();
});

const drain = (harness: ServiceHarness) => harness.service.queue.drain();

const handle = (name: string, source: string, description = `does ${name}`): ToolHandle => ({
  name,
  description,
  tier: 'ro',
  inputSchema: { type: 'object', properties: {} },
  source,
  call: async () => ({ ok: true, output: { called: name } }),
});

function storeEnv() {
  const t = tmpDir('turminder-grants-');
  const { home } = openDataHome(path.join(t.dir, 'home'));
  const config = new Config(home);
  return { home, config, grants: new GrantStore(home, config), cleanup: () => t.cleanup() };
}

describe('the runtime grant store (App. F.7)', () => {
  it('starts empty and merges onto the configured set', () => {
    const e = storeEnv();
    expect(e.grants.records()).toEqual([]);
    const base = { tools: ['memory.*'], confirm: ['memory.forget'] };
    expect(e.grants.merged(base)).toEqual(base);

    e.grants.add([{ pattern: 'github.*', level: 'tools', reason: 'file issues' }], 'grant');
    expect(e.grants.merged(base)).toEqual({
      tools: ['memory.*', 'github.*'],
      confirm: ['memory.forget'],
    });
    expect(e.grants.covers(base, 'github.create_issue')).toBe('tools');
    expect(e.grants.covers(base, 'gitlab.create_issue')).toBeNull();
    e.cleanup();
  });

  it('records why and when, and commits the file', () => {
    const e = storeEnv();
    e.grants.add(
      [{ pattern: 'clock.*', level: 'confirm', reason: 'tell the time', source: 'clock' }],
      'setup: grant clock.* to chat',
    );
    const doc = YAML.parse(fs.readFileSync(e.home.path('config', 'grants.yaml'), 'utf8'));
    expect(doc.grants[0]).toMatchObject({
      pattern: 'clock.*',
      level: 'confirm',
      reason: 'tell the time',
      source: 'clock',
    });
    expect(doc.grants[0].granted_at).toBeTruthy();
    expect(e.home.git.head()).toBeTruthy();
    e.cleanup();
  });

  it('re-granting a pattern replaces it rather than stacking', () => {
    const e = storeEnv();
    e.grants.add([{ pattern: 'clock.*', level: 'confirm' }], 'first');
    e.grants.add([{ pattern: 'clock.*', level: 'tools' }], 'second');
    expect(e.grants.records()).toHaveLength(1);
    expect(e.grants.records()[0]!.level).toBe('tools');
    e.cleanup();
  });

  it('ignores a hand-edited file it cannot parse rather than failing chat', () => {
    const e = storeEnv();
    write(
      e.home.path('config', 'grants.yaml'),
      'grants:\n  - pattern: 5\n    level: shouting\n',
    );
    e.config.reload();
    expect(e.grants.records()).toEqual([]);
    expect(e.grants.merged({ tools: ['memory.*'] })).toEqual({
      tools: ['memory.*'],
      confirm: [],
    });
    e.cleanup();
  });

  it('is not writable by config.write — a self-granted capability is not a grant', () => {
    const e = storeEnv();
    expect(() => resolveWritablePath(e.home, 'config/grants.yaml')).toThrow(PathRejected);
    e.cleanup();
  });
});

describe('the dispatcher re-reads its grant (§19)', () => {
  it('picks up a grant made part-way through a run', async () => {
    const e = storeEnv();
    const available = [
      handle('memory.query', 'memory'),
      handle('github.create_issue', 'github'),
    ];
    const base = { tools: ['memory.*'] };
    const dispatcher = new GrantedDispatcher(
      () => available,
      () => e.grants.merged(base),
      { runId: 'r', eventId: null },
    );

    // Before: the tool exists in the process and is invisible to the model.
    expect(Object.keys(dispatcher.toolSet())).toEqual(['memory.query']);
    const refused = await dispatcher.dispatch({
      toolCallId: '1',
      name: 'github.create_issue',
      args: {},
    });
    expect(refused.denied).toBe('not_granted');

    e.grants.add([{ pattern: 'github.*', level: 'tools' }], 'grant');

    // After: same dispatcher, same run, next turn.
    expect(Object.keys(dispatcher.toolSet()).sort()).toEqual([
      'github.create_issue',
      'memory.query',
    ]);
    const allowed = await dispatcher.dispatch({
      toolCallId: '2',
      name: 'github.create_issue',
      args: {},
    });
    expect(allowed.ok).toBe(true);
    e.cleanup();
  });

  it('honours a confirm-level grant as human-gated, not auto', () => {
    const e = storeEnv();
    e.grants.add([{ pattern: 'github.*', level: 'confirm' }], 'grant');
    const dispatcher = new GrantedDispatcher(
      [handle('github.create_issue', 'github')],
      e.grants.merged({ tools: [] }),
      { runId: 'r', eventId: null },
    );
    expect(dispatcher.granted()).toEqual(['github.create_issue']);
    expect(dispatcher.toolSet()['github.create_issue']!.description).toContain(
      "requires the user's approval",
    );
    e.cleanup();
  });

  it('still accepts a fixed set, which is what a handler frontmatter grant is', () => {
    const dispatcher = new GrantedDispatcher(
      [handle('memory.query', 'memory'), handle('github.create_issue', 'github')],
      { tools: ['memory.*'] },
      { runId: 'r', eventId: null },
    );
    expect(dispatcher.granted()).toEqual(['memory.query']);
  });
});

describe('working out what a request amounts to', () => {
  const available = [
    handle('github.create_issue', 'github', 'Open an issue. Takes a title and a body.'),
    handle('github.list_issues', 'github'),
    handle('memory.query', 'memory'),
  ];

  it('separates what is missing, what is already there, and what does not exist', () => {
    const e = storeEnv();
    const matched = matchAccess(
      { patterns: ['github.*', 'memory.query', 'fastmail.*'], reason: 'x' },
      available,
      { tools: ['memory.*'] },
      e.grants,
    );
    expect(matched.missing.map((t) => t.name).sort()).toEqual([
      'github.create_issue',
      'github.list_issues',
    ]);
    expect(matched.already).toEqual([{ name: 'memory.query', level: 'tools' }]);
    expect(matched.unmatched).toEqual(['fastmail.*']);
    e.cleanup();
  });

  it('puts the tools, their descriptions and the reason in front of the user', () => {
    const form = accessForm(
      {
        patterns: ['github.*'],
        reason: 'filing the bug you just described',
        description: 'The GitHub MCP server, which can read and write issues on your repos.',
      },
      available.slice(0, 2),
    );
    expect(form.title).toBe('Let the assistant use github (2 tools)?');
    expect(form.description).toContain('The GitHub MCP server');
    expect(form.description).toContain('filing the bug you just described');
    // Each tool named, with one sentence of what it does.
    expect(form.description).toContain('• github.create_issue — Open an issue.');
    expect(form.description).toContain('• github.list_issues');
    // And a choice of level, defaulting to the usable one.
    expect(form.fields[0]!.options).toEqual(Object.keys(LEVEL_CHOICES));
    expect(LEVEL_CHOICES[form.fields[0]!.value as string]).toBe('tools');
  });

  it('records the pattern the agent asked for, not every matched name', () => {
    expect(
      patternsToRecord({ patterns: ['github.*'], reason: 'x' }, available.slice(0, 2)),
    ).toEqual(['github.*']);
    // A pattern that matched nothing is not recorded as a grant.
    expect(
      patternsToRecord(
        { patterns: ['github.*', 'nope.*'], reason: 'x' },
        available.slice(0, 1),
      ),
    ).toEqual(['github.*']);
  });
});

describe('setup.request_access, end to end', () => {
  const fixture = () => path.resolve('test/fixtures/mcp-clock-server.mjs');

  /** Installs the clock MCP the way the form flow does, without the form. */
  async function installClock(harness: ServiceHarness): Promise<void> {
    write(
      path.join(harness.dataDir, 'config', 'mcp.yaml'),
      `servers:\n  - name: clock\n    transport: stdio\n    command: ["node", "${fixture()}"]\n`,
    );
    harness.app.config.reload();
    await harness.service.tools.connectExternal('clock');
  }

  it('reproduces the bug: a connected server is not a callable one', async () => {
    h = await bootService({ onboarded: true, watchFiles: false });
    await installClock(h);

    // Connected, listed, and — before this flow existed — unreachable.
    expect(h.service.tools.get('clock.now')).not.toBeNull();
    h.fake.always({ text: 'nothing to do' });
    h.service.chat.send({ text: 'hello' });
    await drain(h);
    const offered = offeredTools(h);
    expect(offered).not.toContain('clock.now');
    expect(h.service.grants.covers(h.service.chatGrants(), 'clock.now')).toBeNull();
  });

  it('asks, is approved, and the tool is callable on the next turn of the same run', async () => {
    h = await bootService({ onboarded: true, watchFiles: false });
    await installClock(h);
    const client = await TestClient.connect(h.baseUrl, h.token);
    await client.hello(['chat', 'forms']);

    // Turn 1 asks for access; turn 2 uses it; turn 3 answers. All one run.
    const script = [
      {
        toolCalls: [
          {
            name: 'setup.request_access',
            args: {
              tools: ['clock.*'],
              reason: 'telling you the time from the clock server',
              description: 'The clock MCP server you just installed.',
            },
          },
        ],
      },
      { toolCalls: [{ name: 'clock.now', args: { timezone: 'Europe/Oslo' } }] },
      { text: 'It is 21:00 UTC.' },
    ];
    let turn = 0;
    h.fake.always(() => script[Math.min(turn++, script.length - 1)]!);

    const sent = h.service.chat.send({ text: 'what does the clock server say?' });
    const form = await client.next('form.request', 15000);
    expect(form.payload.title).toBe('Let the assistant use clock (2 tools)?');
    expect(form.payload.template).toBe('grant_access');
    // The description carries what it is and why — the user's whole basis to decide.
    expect(form.payload.description).toContain('The clock MCP server you just installed.');
    expect(form.payload.description).toContain('telling you the time');
    expect(form.payload.description).toContain('• clock.now');

    client.send('form.submit', {
      form_id: form.payload.form_id,
      values: { decision: 'Yes — let it use these on its own' },
    });
    await drain(h);

    const calls = h.service.repos.trace
      .forEvent(sent.eventId)
      .filter((t) => t.kind === 'tool_call')
      .map((t) => t.data as any);
    expect(calls.map((c) => c.tool)).toEqual(['setup.request_access', 'clock.now']);
    expect(calls[0]!.result_excerpt).toContain('"granted":true');
    // The point of the whole exercise: the very next call went through.
    expect(calls[1]!.ok).toBe(true);
    expect(calls[1]!.result_excerpt).toContain('2026-08-20T21:00:00.000Z');

    const doc = YAML.parse(
      fs.readFileSync(path.join(h.dataDir, 'config', 'grants.yaml'), 'utf8'),
    );
    expect(doc.grants).toEqual([
      {
        pattern: 'clock.*',
        level: 'tools',
        granted_at: expect.any(String),
        reason: 'telling you the time from the clock server',
        source: 'clock',
      },
    ]);
  });

  it('takes no for an answer', async () => {
    h = await bootService({ onboarded: true, watchFiles: false });
    await installClock(h);
    const client = await TestClient.connect(h.baseUrl, h.token);
    await client.hello(['chat', 'forms']);

    let asked = false;
    h.fake.always((req) => {
      if (req.body.tools && !asked) {
        asked = true;
        return {
          toolCalls: [
            { name: 'setup.request_access', args: { tools: ['clock.*'], reason: 'the time' } },
          ],
        };
      }
      return { text: 'Understood, I will leave it alone.' };
    });

    const sent = h.service.chat.send({ text: 'use the clock server' });
    const form = await client.next('form.request', 15000);
    client.send('form.cancel', { form_id: form.payload.form_id });
    await drain(h);

    const call = h.service.repos.trace
      .forEvent(sent.eventId)
      .find((t) => t.kind === 'tool_call')!.data as any;
    expect(call.result_excerpt).toContain('"granted":false');
    expect(call.result_excerpt).toContain('cancelled');
    expect(fs.existsSync(path.join(h.dataDir, 'config', 'grants.yaml'))).toBe(false);
    expect(h.service.tools.get('clock.now')).not.toBeNull();
    expect(h.service.grants.covers(h.service.chatGrants(), 'clock.now')).toBeNull();
  });

  it('does not raise a form for tools it can already call, or ones that do not exist', async () => {
    h = await bootService({ onboarded: true, watchFiles: false });
    const request = h.service.tools.get('setup.request_access')!;
    const ctx = { runId: 'r', eventId: null, conversationId: 'c' };

    const already = await request.call(
      { tools: ['memory.*'], reason: 'remembering things' },
      ctx,
    );
    expect(already.output).toMatchObject({ error: 'nothing_to_grant' });

    const nonexistent = await request.call(
      { tools: ['fastmail.*'], reason: 'reading mail' },
      ctx,
    );
    expect(nonexistent.output).toMatchObject({
      error: 'unknown_tools',
      unmatched: ['fastmail.*'],
    });
    // Neither asked the user anything.
    expect(h.service.forms.waiting).toBe(0);
  });

  it('reports the gap in setup.list_integrations, so the agent can see it', async () => {
    h = await bootService({ onboarded: true, watchFiles: false });
    await installClock(h);
    const list = h.service.tools.get('setup.list_integrations')!;
    const before = (await list.call({}, { runId: null, eventId: null })).output as any;
    expect(before.mcp_servers[0]).toMatchObject({
      name: 'clock',
      connected: true,
      tools: ['clock.now', 'clock.set_alarm'],
      granted: [],
    });
    expect(before.ungranted_tools).toContain('clock.now');

    h.service.grants.add([{ pattern: 'clock.now', level: 'tools' }], 'grant one of them');
    const after = (await list.call({}, { runId: null, eventId: null })).output as any;
    expect(after.mcp_servers[0].granted).toEqual(['clock.now']);
    expect(after.ungranted_tools).toContain('clock.set_alarm');
    expect(after.ungranted_tools).not.toContain('clock.now');
  });

  it('tells the installer that connecting is not granting', async () => {
    h = await bootService({ onboarded: true, watchFiles: false });
    const client = await TestClient.connect(h.baseUrl, h.token);
    await client.hello(['chat', 'forms']);

    let asked = false;
    h.fake.always((req) => {
      if (req.body.tools && !asked) {
        asked = true;
        return {
          toolCalls: [
            {
              name: 'setup.form',
              args: { title: 'Connect the clock MCP', template: 'mcp_stdio' },
            },
          ],
        };
      }
      return { text: 'Connected.' };
    });

    const sent = h.service.chat.send({ text: 'connect the clock mcp' });
    const form = await client.next('form.request', 15000);
    client.send('form.submit', {
      form_id: form.payload.form_id,
      values: { name: 'clock', command: `node "${fixture()}"` },
    });
    await drain(h);

    const call = h.service.repos.trace
      .forEvent(sent.eventId)
      .find((t) => t.kind === 'tool_call')!.data as any;
    expect(call.result_excerpt).toContain('"granted":false');
    expect(call.result_excerpt).toContain('setup.request_access');
  });
});
