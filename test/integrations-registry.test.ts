import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import YAML from 'yaml';
import { afterEach, describe, expect, it } from 'vitest';
import { LAYOUT_VERSION, openDataHome } from '../src/core/datadir.js';
import { MANIFESTS, manifestFor, namespaceOf } from '../src/tools/integrations/registry.js';
import { WIRE_SEPARATOR, internalToolName, wireToolName } from '../src/model/tool-names.js';
import {
  AsanaSettingsSchema,
  CalendarSettingsSchema,
} from '../src/tools/integrations/external.js';
import { bootService, TestClient, type ServiceHarness } from './service-harness.js';
import { FakeAsana } from './fake-asana.js';
import { FakeGoogle } from './fake-google.js';
import { tmpDir, write } from './helpers.js';

let h: ServiceHarness;
afterEach(async () => {
  await h?.cleanup();
});

const drain = (harness: ServiceHarness) => harness.service.queue.drain();

/**
 * One fetch for the whole service, routed by hostname — the harness injects a
 * single implementation everywhere, and the flows under test talk to two
 * different upstreams.
 */
function routed(bases: { asana?: string; google?: string }): typeof globalThis.fetch {
  return (async (input: any, init?: any) => {
    const raw = String(input instanceof URL ? input : (input.url ?? input));
    const url = new URL(raw);
    if (url.hostname.endsWith('asana.com') && bases.asana) {
      return globalThis.fetch(new URL(url.pathname + url.search, bases.asana), init);
    }
    if (url.hostname.endsWith('googleapis.com') && bases.google) {
      const p = url.hostname.startsWith('oauth2') ? '/token' : url.pathname;
      return globalThis.fetch(new URL(p + url.search, bases.google), init);
    }
    return globalThis.fetch(input, init);
  }) as unknown as typeof globalThis.fetch;
}

/**
 * Answer the confirm request a gated tool call raises, the way a click would.
 * `setup.deactivate` is at the confirm level in the default grant (App. F.7),
 * so switching an integration off always passes through here.
 */
async function approveNextConfirm(client: TestClient): Promise<string> {
  const delivery = await client.next('delivery', 15000);
  expect(delivery.payload.intent).toBe('confirm');
  client.send('event', {
    type: 'notification.action',
    payload: {
      delivery_id: delivery.payload.delivery_id,
      action: 'approve',
      run_id: delivery.payload.payload.run_id,
    },
  });
  return delivery.payload.payload.tool as string;
}

/** Scripts the model to make one tool call, then answer. */
function scriptOneCall(harness: ServiceHarness, name: string, args: unknown): void {
  let called = false;
  harness.fake.always((req) => {
    if (req.body.tools && !called) {
      called = true;
      return { toolCalls: [{ name, args }] };
    }
    return { text: 'Done.' };
  });
}

/**
 * Calls a tool directly and returns its whole output. Trace excerpts are capped
 * at 1000 characters (App. C.1), so anything longer has to be read here.
 */
async function callTool(
  harness: ServiceHarness,
  name: string,
  args: unknown = {},
): Promise<any> {
  const { GrantedDispatcher } = await import('../src/tools/dispatcher.js');
  const dispatcher = new GrantedDispatcher(
    harness.service.tools.handles(),
    { tools: ['*'] },
    { runId: null, eventId: null },
  );
  const result = await dispatcher.dispatch({ toolCallId: 'test', name, args });
  return result.output;
}

function toolCallResult(harness: ServiceHarness, eventId: string): any {
  const row = harness.service.repos.trace.forEvent(eventId).find((t) => t.kind === 'tool_call')!
    .data as any;
  return { ...row, parsed: JSON.parse(row.result_excerpt) };
}

/**
 * §11.5. Tools cross the wire as `namespace__verb`, because Anthropic and
 * OpenAI reject a dot in a tool name. That translation is only a true inverse
 * while no tool name contains `__` of its own — `calendar.create_task` must
 * come back as itself and not as `calendar.create.task`. The separator was
 * chosen over a single underscore precisely so the reverse needs no lookup
 * table, which matters because a paged-closed or ungranted call names a tool
 * the request never offered.
 */
describe('tool names survive the wire (§11.5)', () => {
  let h: ServiceHarness;
  afterEach(async () => {
    await h?.cleanup();
  });

  it('no tool name contains the wire separator, so the round trip is exact', async () => {
    h = await bootService({ onboarded: true, watchFiles: false });
    const names = h.service.tools.handles().map((t) => t.name);
    expect(names.length).toBeGreaterThan(20);
    expect(names.filter((n) => n.includes(WIRE_SEPARATOR))).toEqual([]);
    for (const name of names) {
      expect(internalToolName(wireToolName(name))).toBe(name);
      expect(wireToolName(name)).toMatch(/^[a-zA-Z0-9_-]{1,128}$/);
    }
  });
});

describe('the manifest registry (§19.5)', () => {
  it('declares every integration this build ships, with its activation', () => {
    const core = MANIFESTS.filter((m) => m.activation === 'none').map((m) => m.name);
    expect(core).toEqual([
      'memory',
      'files',
      'schedule',
      'deliver',
      'events',
      'web',
      'weather',
      'time',
      'config',
      'skills',
      'embeds',
      'docs',
      'history',
      'project',
      'usage',
      'watch',
      'setup',
    ]);
    expect(manifestFor('asana')?.activation).toBe('form');
    expect(manifestFor('google-calendar')?.activation).toBe('oauth');
    expect(manifestFor('nope')).toBeNull();
    // The name and the tool namespace are not the same thing.
    expect(namespaceOf(manifestFor('google-calendar')!)).toBe('calendar');
    expect(namespaceOf(manifestFor('asana')!)).toBe('asana');
  });

  it('gives every activatable integration a form to activate with', () => {
    for (const manifest of MANIFESTS.filter((m) => m.activation !== 'none')) {
      expect(manifest.fields?.length, manifest.name).toBeGreaterThan(0);
      // The credential field is a secret field, so it can only go to the store.
      expect(
        manifest.fields!.some((f) => f.type === 'secret'),
        manifest.name,
      ).toBe(true);
    }
    for (const manifest of MANIFESTS.filter((m) => m.activation === 'none')) {
      expect(manifest.fields, manifest.name).toBeUndefined();
    }
  });
});

describe('setup.list_integrations (App. F.9)', () => {
  it('answers "what can you connect to" on a data dir with nothing configured', async () => {
    h = await bootService({ onboarded: true, watchFiles: false });
    // The result is longer than a trace excerpt, so read it from the tool.
    const parsed = await callTool(h, 'setup.list_integrations');
    const byName = new Map<string, any>(parsed.integrations.map((i: any) => [i.name, i]));
    expect(byName.get('asana')).toMatchObject({ activation: 'form', active: false });
    expect(byName.get('google-calendar')).toMatchObject({ activation: 'oauth', active: false });
    // Core facilities are always on and need no explanation.
    expect(byName.get('memory')).toMatchObject({ activation: 'none', active: true });
    expect(byName.get('files').provides.tools).toContain('files.edit');
    expect(parsed.mcp_servers).toEqual([]);
  });

  it('lists configured external MCP servers alongside them', async () => {
    const fixture = path.resolve('test/fixtures/mcp-clock-server.mjs');
    h = await bootService({ onboarded: true, watchFiles: false });
    write(
      path.join(h.dataDir, 'config', 'mcp.yaml'),
      `servers:\n  - name: clock\n    transport: stdio\n    command: ["node", "${fixture}"]\n`,
    );
    h.app.config.reload();
    await h.service.tools.connectExternal('clock');

    const parsed = await callTool(h, 'setup.list_integrations');
    expect(parsed.mcp_servers).toEqual([
      {
        name: 'clock',
        transport: 'stdio',
        connected: true,
        tools: ['clock.now', 'clock.set_alarm'],
        // Connected, and not yet callable: the grant is a separate question,
        // asked with setup.request_access (App. F.7).
        granted: [],
      },
    ]);
  });
});

describe('activating asana (activation: form, §19.5)', () => {
  it('probes the token, starts the poller, and the tools work in the same conversation', async () => {
    const fake = new FakeAsana();
    const base = await fake.start();
    fake.section('Inbox').tasks.push({
      gid: 't1',
      name: 'Review the spec',
      completed: false,
      modified_at: '2026-08-21T09:00:00.000Z',
    });

    h = await bootService({
      onboarded: true,
      watchFiles: false,
      fetch: routed({ asana: base }),
    });
    const client = await TestClient.connect(h.baseUrl, h.token);
    await client.hello(['chat', 'forms']);

    // Nothing yet: dormant means dormant.
    expect(h.service.tools.get('asana.inbox')).toBeNull();

    scriptOneCall(h, 'setup.activate', { integration: 'asana' });
    const sent = h.service.chat.send({ text: 'set up asana' });
    const form = await client.next('form.request', 15000);
    expect(form.payload.title).toBe('Set up asana');
    expect(form.payload.template).toBe('activate:asana');
    expect(form.payload.fields.map((f: any) => f.name)).toEqual([
      'pat',
      'poll_interval_s',
      'inbox_section',
      'daily_section',
    ]);
    expect(form.payload.fields[0]!.type).toBe('secret');

    client.send('form.submit', {
      form_id: form.payload.form_id,
      values: {
        pat: 'sentinel-asana-pat-42',
        poll_interval_s: '120',
        inbox_section: 'Inbox',
        daily_section: 'Do today',
      },
    });
    await drain(h);

    const { parsed } = toolCallResult(h, sent.eventId);
    expect(parsed).toMatchObject({ submitted: true, integration: 'asana', activated: true });
    expect(parsed.tools).toContain('asana.inbox');

    // The activation record, with the non-secret settings in it (G.12).
    const records = YAML.parse(
      fs.readFileSync(path.join(h.dataDir, 'config', 'integrations.yaml'), 'utf8'),
    );
    expect(records.integrations.asana).toMatchObject({
      active: true,
      settings: { poll_interval_s: 120, inbox_section: 'Inbox', daily_section: 'Do today' },
    });
    expect(records.integrations.asana.activated_at).toBeTruthy();
    expect(AsanaSettingsSchema.safeParse(records.integrations.asana.settings)).toMatchObject({
      success: true,
      data: { poll_interval_s: 120 },
    });

    // The tools are live now, not after a restart.
    const inbox = h.service.tools.get('asana.inbox')!;
    const result = await inbox.call({}, { runId: null, eventId: null });
    expect(result.ok).toBe(true);
    expect(JSON.stringify(result.output)).toContain('Review the spec');
    expect(h.service.sources.sources.map((s) => s.name)).toContain('asana.inbox');

    // The sentinel test again (§19.2), extended to activation.
    expect(h.app.config.secrets.ASANA_PAT).toBe('sentinel-asana-pat-42');
    expect(sweep(h.dataDir, 'sentinel-asana-pat-42')).toEqual(['secrets/secrets.yaml']);

    await fake.stop();
  });

  it('refuses a token the service rejects, and writes no record', async () => {
    const fake = new FakeAsana();
    const base = await fake.start();
    fake.failNext = 401;

    h = await bootService({
      onboarded: true,
      watchFiles: false,
      fetch: routed({ asana: base }),
    });
    const client = await TestClient.connect(h.baseUrl, h.token);
    await client.hello(['chat', 'forms']);

    scriptOneCall(h, 'setup.activate', { integration: 'asana' });
    const sent = h.service.chat.send({ text: 'set up asana' });
    const form = await client.next('form.request', 15000);
    client.send('form.submit', { form_id: form.payload.form_id, values: { pat: 'wrong' } });
    await drain(h);

    const { parsed } = toolCallResult(h, sent.eventId);
    expect(parsed).toMatchObject({ activated: false, error: 'credential_rejected' });
    expect(fs.existsSync(path.join(h.dataDir, 'config', 'integrations.yaml'))).toBe(false);
    expect(h.service.tools.get('asana.inbox')).toBeNull();
    await fake.stop();
  });

  it('deactivates: poller stops, tools go, the credential stays', async () => {
    const fake = new FakeAsana();
    const base = await fake.start();
    h = await bootService({
      onboarded: true,
      watchFiles: false,
      fetch: routed({ asana: base }),
    });
    write(
      path.join(h.dataDir, 'config', 'integrations.yaml'),
      'integrations:\n  asana:\n    active: true\n',
    );
    write(path.join(h.dataDir, 'secrets', 'secrets.yaml'), 'ASANA_PAT: keep-me\n');
    h.app.config.reload();
    await h.service.reloadIntegrations();
    expect(h.service.tools.get('asana.inbox')).not.toBeNull();

    const client = await TestClient.connect(h.baseUrl, h.token);
    await client.hello(['chat', 'notify.actions']);
    scriptOneCall(h, 'setup.deactivate', { integration: 'asana' });
    const sent = h.service.chat.send({ text: 'turn asana off' });
    expect(await approveNextConfirm(client)).toBe('setup.deactivate');
    await drain(h);

    const { parsed } = toolCallResult(h, sent.eventId);
    expect(parsed).toMatchObject({ deactivated: true, secrets_retained: true });
    expect(h.service.tools.get('asana.inbox')).toBeNull();
    expect(h.service.sources.sources).toHaveLength(0);
    // Deliberately retained, so reactivating is one confirm (§19.5).
    expect(h.app.config.secrets.ASANA_PAT).toBe('keep-me');
    const records = YAML.parse(
      fs.readFileSync(path.join(h.dataDir, 'config', 'integrations.yaml'), 'utf8'),
    );
    expect(records.integrations.asana).toBeUndefined();
    await fake.stop();
  });

  it('will not activate what is already active, or a core facility', async () => {
    h = await bootService({ onboarded: true, watchFiles: false });
    const client = await TestClient.connect(h.baseUrl, h.token);
    await client.hello(['chat', 'notify.actions']);

    scriptOneCall(h, 'setup.activate', { integration: 'memory' });
    const first = h.service.chat.send({ text: 'set up memory' });
    await drain(h);
    expect(toolCallResult(h, first.eventId).parsed).toMatchObject({ error: 'always_on' });

    scriptOneCall(h, 'setup.deactivate', { integration: 'files' });
    const second = h.service.chat.send({ text: 'turn off files' });
    await approveNextConfirm(client);
    await drain(h);
    expect(toolCallResult(h, second.eventId).parsed).toMatchObject({ error: 'always_on' });

    scriptOneCall(h, 'setup.activate', { integration: 'fastmail' });
    const third = h.service.chat.send({ text: 'set up fastmail' });
    await drain(h);
    expect(toolCallResult(h, third.eventId).parsed).toMatchObject({
      error: 'unknown_integration',
    });
  });
});

describe('activating google calendar (activation: oauth, §19.5)', () => {
  it('hands back an auth url, then finishes on the callback and says so', async () => {
    const google = new FakeGoogle();
    const base = await google.start();
    h = await bootService({
      onboarded: true,
      watchFiles: false,
      fetch: routed({ google: base }),
    });
    const client = await TestClient.connect(h.baseUrl, h.token);
    await client.hello(['chat', 'forms']);

    scriptOneCall(h, 'setup.activate', { integration: 'google-calendar' });
    const sent = h.service.chat.send({ text: 'set up google calendar' });
    const form = await client.next('form.request', 15000);
    expect(form.payload.fields.map((f: any) => f.name)).toEqual([
      'client_id',
      'client_secret',
      'upcoming_lead_min',
    ]);

    client.send('form.submit', {
      form_id: form.payload.form_id,
      values: {
        client_id: 'client-abc.apps.googleusercontent.com',
        client_secret: 'sentinel-google-secret',
        upcoming_lead_min: '20',
      },
    });
    await drain(h);

    // The run does not stay suspended across the browser round-trip.
    const { parsed } = toolCallResult(h, sent.eventId);
    expect(parsed).toMatchObject({ pending: true });
    expect(parsed.auth_url).toContain('accounts.google.com');
    const authUrl = new URL(parsed.auth_url as string);
    expect(authUrl.searchParams.get('client_id')).toBe('client-abc.apps.googleusercontent.com');
    expect(authUrl.searchParams.get('access_type')).toBe('offline');
    // Nothing is active until consent lands.
    expect(h.service.tools.get('calendar.list_events')).toBeNull();

    // The user consents: the browser is redirected to the loopback callback.
    const redirect = new URL(authUrl.searchParams.get('redirect_uri')!);
    redirect.searchParams.set('code', 'auth-code');
    redirect.searchParams.set('state', authUrl.searchParams.get('state')!);
    const landed = await fetch(redirect);
    expect(landed.status).toBe(200);

    await waitFor(() => h.service.tools.get('calendar.list_events') !== null, 8000);
    const records = YAML.parse(
      fs.readFileSync(path.join(h.dataDir, 'config', 'integrations.yaml'), 'utf8'),
    );
    expect(records.integrations['google-calendar']).toMatchObject({
      active: true,
      settings: { upcoming_lead_min: 20 },
    });
    // And the settings actually load: every key the form writes has to be one
    // the schema knows, or the whole record falls back to defaults.
    expect(
      CalendarSettingsSchema.safeParse(records.integrations['google-calendar'].settings),
    ).toMatchObject({ success: true, data: { upcoming_lead_min: 20 } });
    // The refresh token is a store key (§27), not a file the vault would miss.
    expect(fs.existsSync(path.join(h.dataDir, 'secrets', 'google-token.json'))).toBe(false);
    expect(h.app.config.secretStore.get('GOOGLE_OAUTH_TOKEN')).toContain('refresh_token');

    // And it announced itself, because the conversation had already moved on.
    await waitFor(
      () =>
        h.service.repos.events
          .recent({ limit: 20 })
          .some((e) => e.type === 'system.integration_activated'),
      8000,
    );
    const announcement = h.service.repos.events
      .recent({ limit: 20 })
      .find((e) => e.type === 'system.integration_activated')!;
    expect(announcement.payload).toMatchObject({ integration: 'google-calendar' });
    expect((announcement.payload as any).tools).toContain('calendar.list_events');

    // The client secret went where secrets go, and nowhere else.
    expect(h.app.config.secrets.GOOGLE_CLIENT_SECRET).toBe('sentinel-google-secret');
    expect(sweep(h.dataDir, 'sentinel-google-secret')).toEqual(['secrets/secrets.yaml']);
    await google.stop();
  });

  it('says which client it would use when none is available', async () => {
    h = await bootService({ onboarded: true, watchFiles: false });
    const client = await TestClient.connect(h.baseUrl, h.token);
    await client.hello(['chat', 'forms']);
    scriptOneCall(h, 'setup.activate', { integration: 'google-calendar' });
    const sent = h.service.chat.send({ text: 'set up google calendar' });
    const form = await client.next('form.request', 15000);
    // Both credential fields left blank, and nothing bundled.
    client.send('form.submit', { form_id: form.payload.form_id, values: {} });
    await drain(h);
    expect(toolCallResult(h, sent.eventId).parsed).toMatchObject({
      activated: false,
      error: 'no_oauth_client',
    });
  });
});

describe('the sources.yaml migration (G.12)', () => {
  it('folds the old file into activation records and deletes it', () => {
    const t = tmpDir('turminder-migrate-');
    const dir = path.join(t.dir, 'home');
    // A data dir as layout 1 left it: sources.yaml plus a token on disk.
    fs.mkdirSync(path.join(dir, 'config'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'secrets'), { recursive: true });
    write(
      path.join(dir, 'MANIFEST'),
      'layout_version: 1\ncreated_at: 2026-08-20T10:00:00.000Z\n',
    );
    write(
      path.join(dir, 'config', 'sources.yaml'),
      'asana:\n  enabled: true\n  poll_seconds: 240\n  daily_section: Today\ngoogle_calendar:\n  enabled: true\n  lead_minutes: 25\n',
    );
    write(path.join(dir, 'secrets', 'secrets.yaml'), 'ASANA_PAT: existing\n');
    write(path.join(dir, 'secrets', 'google-token.json'), '{"refresh_token":"r"}');

    const { home } = openDataHome(dir);

    expect(home.readManifest().layout_version).toBe(LAYOUT_VERSION);
    expect(fs.existsSync(path.join(dir, 'config', 'sources.yaml'))).toBe(false);
    const records = YAML.parse(
      fs.readFileSync(path.join(dir, 'config', 'integrations.yaml'), 'utf8'),
    ).integrations;
    expect(records.asana).toMatchObject({
      active: true,
      settings: { poll_interval_s: 240, daily_section: 'Today' },
    });
    expect(records['google-calendar']).toMatchObject({
      active: true,
      settings: { upcoming_lead_min: 25 },
    });
    t.cleanup();
  });

  it('leaves nothing active when there was nothing to fold', () => {
    const t = tmpDir('turminder-migrate-bare-');
    const dir = path.join(t.dir, 'home');
    fs.mkdirSync(dir, { recursive: true });
    write(
      path.join(dir, 'MANIFEST'),
      'layout_version: 1\ncreated_at: 2026-08-20T10:00:00.000Z\n',
    );
    const { home } = openDataHome(dir);
    expect(home.readManifest().layout_version).toBe(LAYOUT_VERSION);
    expect(fs.existsSync(path.join(dir, 'config', 'integrations.yaml'))).toBe(false);
    t.cleanup();
  });

  it('refuses a data dir from a newer build', () => {
    const t = tmpDir('turminder-future-');
    const dir = path.join(t.dir, 'home');
    fs.mkdirSync(dir, { recursive: true });
    write(
      path.join(dir, 'MANIFEST'),
      'layout_version: 99\ncreated_at: 2026-08-20T10:00:00.000Z\n',
    );
    expect(() => openDataHome(dir)).toThrow(/layout_version 99/);
    t.cleanup();
  });
});

describe('setup.rename (F.9, G.3)', () => {
  it('rewrites identity.md with a new name and story, committed', async () => {
    h = await bootService({ onboarded: true, watchFiles: false });
    const result = await callTool(h, 'setup.rename', {
      name: 'Grey Area',
      story: 'Grey Area, after the Mind that reads what others will not.',
    });
    expect(result).toMatchObject({
      name: 'Grey Area',
      previous: 'Sleeper Service',
      updated: 'config/identity.md',
      committed: true,
    });
    const identity = h.app.config.identity()!;
    expect(identity.frontmatter.instance_name).toBe('Grey Area');
    // Renaming touches the name, never the rest of who this install is.
    expect(identity.frontmatter.user_name).toBe('Alex');
    expect(identity.frontmatter.timezone).toBe('Europe/Oslo');
    expect(identity.body).toContain('reads what others will not');
    const head = spawnSync('git', ['log', '-1', '--format=%s'], {
      cwd: h.dataDir,
      encoding: 'utf8',
    });
    expect(head.stdout.trim()).toBe('setup(rename): Sleeper Service → Grey Area');
  });

  it('without a story, swaps whole-word mentions in the body and no others', async () => {
    h = await bootService({ onboarded: true, watchFiles: false });
    write(
      path.join(h.dataDir, 'config', 'identity.md'),
      '---\ninstance_name: Sleeper Service\nuser_name: Alex\ntimezone: Europe/Oslo\nlocale: en\n---\n\n' +
        'Sleeper Service, a name; the Sleeper Servicemen are somebody else.\n',
    );
    h.app.config.reload();
    const result = await callTool(h, 'setup.rename', { name: 'Grey Area' });
    expect(result.name).toBe('Grey Area');
    const body = h.app.config.identity()!.body;
    expect(body).toContain('Grey Area, a name');
    expect(body).toContain('Sleeper Servicemen');
  });

  it('reports where the old name lives on, and rewrites none of it', async () => {
    h = await bootService({ onboarded: true, watchFiles: false });
    write(
      path.join(h.dataDir, 'config', 'personality.md'),
      '---\nformality: relaxed\nverbosity: terse\nhumor: dry\n---\n\nSleeper Service is dry.\n',
    );
    write(
      path.join(h.dataDir, 'memory', 'a-note.md'),
      '---\nname: a-note\ndescription: mentions the old name\ntype: fact\n---\n\nSleeper Service said so.\n',
    );
    write(path.join(h.dataDir, 'memory', 'unrelated.md'), '---\nname: unrelated\n---\n\nNo.\n');
    const result = await callTool(h, 'setup.rename', { name: 'Grey Area' });
    expect(result.old_name_still_in).toEqual(['config/personality.md', 'memory/a-note.md']);
    // Reported, not rewritten: curation is the model's job, not a sed's.
    expect(fs.readFileSync(path.join(h.dataDir, 'memory', 'a-note.md'), 'utf8')).toContain(
      'Sleeper Service',
    );
  });

  it('refuses the name it already has, and refuses before onboarding', async () => {
    h = await bootService({ onboarded: true, watchFiles: false });
    const same = await callTool(h, 'setup.rename', { name: 'Sleeper Service' });
    expect(same).toMatchObject({ error: 'same_name' });
    const blank = await callTool(h, 'setup.rename', { name: '   ' });
    expect(blank).toMatchObject({ error: 'invalid_name' });
    await h.cleanup();

    h = await bootService({ onboarded: false, watchFiles: false });
    const early = await callTool(h, 'setup.rename', { name: 'Grey Area' });
    expect(early).toMatchObject({ error: 'not_onboarded' });
  });
});

async function waitFor(ok: () => boolean, timeoutMs: number): Promise<void> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (ok()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('timed out waiting for the activation to finish');
}

/**
 * Every file under the data dir containing `needle`. `.git` and `events.db` are
 * included on purpose: a submitted credential must exist in exactly one file.
 */
function sweep(root: string, needle: string): string[] {
  const hits: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(abs);
        continue;
      }
      if (fs.readFileSync(abs).includes(needle)) hits.push(path.relative(root, abs));
    }
  };
  walk(root);
  return hits.sort();
}
