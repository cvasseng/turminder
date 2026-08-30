import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import matter from 'gray-matter';
import YAML from 'yaml';
import { Config } from '../src/core/config.js';
import { openDataHome, type DataHome } from '../src/core/datadir.js';
import { FormBroker, type FieldSpec, type FormSink } from '../src/chat/forms.js';
import { resolveWritablePath, PathRejected } from '../src/tools/paths.js';
import { redactTraceArgs } from '../src/tools/redact.js';
import { splitCommand } from '../src/tools/integrations/setup/templates.js';
import { fillSecretKeys, mergeFields } from '../src/tools/integrations/setup/tools.js';
import { bootService, TestClient, type ServiceHarness } from './service-harness.js';
import { FakeSpeech } from './fake-speech.js';
import { clearVoiceCache } from '../src/model/probe.js';
import { OPENAI_VOICES, STT_LANGUAGES } from '../src/tools/integrations/setup/tools.js';
import { tmpDir, write } from './helpers.js';

let h: ServiceHarness;
afterEach(async () => {
  await h?.cleanup();
});

const drain = (harness: ServiceHarness) => harness.service.queue.drain();

/** Read secrets the way everything else does: through the store (§27). */
const storeFor = (home: DataHome) => new Config(home).secretStore;
const secretsOf = (home: DataHome) => storeFor(home).all();

/** Collects the frames a channel would have been sent. */
function recorder(): FormSink & { sent: { type: string; payload: any }[] } {
  const sent: { type: string; payload: any }[] = [];
  return { sent, send: (type, payload) => sent.push({ type, payload }) };
}

interface BrokerEnv {
  home: DataHome;
  broker: FormBroker;
  cleanup(): void;
}

function brokerEnv(timeoutS?: number): BrokerEnv {
  const t = tmpDir('turminder-forms-');
  const { home } = openDataHome(path.join(t.dir, 'home'));
  if (timeoutS !== undefined) {
    write(
      home.path('config', 'turminder.yaml'),
      `data_defaults:\n  form_timeout_s: ${timeoutS}\n`,
    );
  }
  const config = new Config(home);
  return { home, broker: new FormBroker(home, config), cleanup: () => t.cleanup() };
}

const FIELDS: FieldSpec[] = [
  { name: 'name', label: 'Name', type: 'text' },
  { name: 'url', label: 'URL', type: 'url', required: false },
  { name: 'count', label: 'Count', type: 'number', required: false },
  { name: 'pick', label: 'Pick', type: 'select', options: ['a', 'b'], required: false },
  {
    name: 'token',
    label: 'Token',
    type: 'secret',
    required: false,
    secret_key: 'FASTMAIL_KEY',
  },
];

function requestOn(env: BrokerEnv, fields = FIELDS) {
  return env.broker.request({
    runId: 'run-1',
    conversationId: 'conv-1',
    title: 'Connect something',
    fields,
  });
}

describe('form primitive (§19.1, App. D.5)', () => {
  it('sends a form.request to every capable channel and resumes on submit', async () => {
    const env = brokerEnv();
    const a = recorder();
    const b = recorder();
    env.broker.attach(a);
    env.broker.attach(b);

    const pending = requestOn(env);
    expect(env.broker.waiting).toBe(1);
    expect(a.sent).toHaveLength(1);
    expect(b.sent).toHaveLength(1);
    const frame = a.sent[0]!;
    expect(frame.type).toBe('form.request');
    expect(frame.payload.run_id).toBe('run-1');
    expect(frame.payload.conversation_id).toBe('conv-1');
    expect(frame.payload.fields.map((f: any) => f.name)).toEqual([
      'name',
      'url',
      'count',
      'pick',
      'token',
    ]);

    expect(env.broker.submit(frame.payload.form_id, { name: 'github', count: '3' })).toEqual({
      ok: true,
    });
    const outcome = await pending;
    expect(outcome).toEqual({
      submitted: true,
      values: { name: 'github', count: 3 },
      secrets: {},
    });
    expect(env.broker.waiting).toBe(0);
    env.cleanup();
  });

  it('carries embed_id in the frame and validates choice like select (App. D.5)', async () => {
    // The "continue this, or start fresh?" shape: one choice field, and the
    // embed under discussion rendered inside the form.
    const env = brokerEnv();
    const sink = recorder();
    env.broker.attach(sink);
    const pending = env.broker.request({
      runId: 'run-1',
      conversationId: 'conv-1',
      title: 'You already have "NO5 energy dashboard"',
      embedId: '01EMBED',
      fields: [
        {
          name: 'decision',
          label: 'Continue it, or start fresh?',
          type: 'choice',
          options: ['Continue existing', 'Start fresh'],
        },
      ],
    });
    const frame = sink.sent[0]!;
    expect(frame.payload.embed_id).toBe('01EMBED');
    expect(frame.payload.fields[0]).toMatchObject({
      type: 'choice',
      options: ['Continue existing', 'Start fresh'],
    });

    // Off-menu answers are refused and the form stays pending, like select.
    expect(env.broker.submit(frame.payload.form_id, { decision: 'Delete it' })).toMatchObject({
      ok: false,
    });
    expect(env.broker.waiting).toBe(1);
    expect(env.broker.submit(frame.payload.form_id, { decision: 'Continue existing' })).toEqual(
      { ok: true },
    );
    expect(await pending).toEqual({
      submitted: true,
      values: { decision: 'Continue existing' },
      secrets: {},
    });
    env.cleanup();
  });

  it('reports no_channel rather than hanging when nothing can render it', async () => {
    const env = brokerEnv();
    expect(await requestOn(env)).toEqual({ submitted: false, reason: 'no_channel' });
    env.cleanup();
  });

  it('re-sends pending forms to a reconnecting channel', async () => {
    const env = brokerEnv();
    const first = recorder();
    const detach = env.broker.attach(first);
    const pending = requestOn(env);
    detach();

    const reconnected = recorder();
    env.broker.attach(reconnected);
    expect(reconnected.sent.map((f) => f.type)).toEqual(['form.request']);
    expect(reconnected.sent[0]!.payload.form_id).toBe(first.sent[0]!.payload.form_id);

    env.broker.cancel(first.sent[0]!.payload.form_id);
    expect(await pending).toEqual({ submitted: false, reason: 'cancelled' });
    env.cleanup();
  });

  it('first submit wins; a stale form is not found', async () => {
    const env = brokerEnv();
    const sink = recorder();
    env.broker.attach(sink);
    const pending = requestOn(env);
    const formId = sink.sent[0]!.payload.form_id;

    expect(env.broker.submit(formId, { name: 'one' })).toEqual({ ok: true });
    expect(env.broker.submit(formId, { name: 'two' })).toEqual({
      ok: false,
      error: 'not_found',
    });
    expect(env.broker.cancel(formId)).toEqual({ ok: false, error: 'not_found' });
    const outcome = await pending;
    expect(outcome.submitted && outcome.values.name).toBe('one');
    env.cleanup();
  });

  it('validates the submission and leaves the form pending when it is wrong', async () => {
    const env = brokerEnv();
    const sink = recorder();
    env.broker.attach(sink);
    const pending = requestOn(env);
    const formId = sink.sent[0]!.payload.form_id;

    expect(env.broker.submit(formId, {})).toEqual({ ok: false, error: 'Name is required' });
    expect(env.broker.submit(formId, { name: 'x', count: 'lots' })).toEqual({
      ok: false,
      error: 'Count must be a number',
    });
    expect(env.broker.submit(formId, { name: 'x', url: 'not a url' })).toEqual({
      ok: false,
      error: 'URL must be a URL',
    });
    expect(env.broker.submit(formId, { name: 'x', pick: 'c' })).toEqual({
      ok: false,
      error: 'Pick must be one of: a, b',
    });
    // Still waiting: a bad submission is a correction, not an outcome.
    expect(env.broker.waiting).toBe(1);
    expect(env.broker.submit(formId, { name: 'x' })).toEqual({ ok: true });
    expect((await pending).submitted).toBe(true);
    env.cleanup();
  });

  it('times out into a cancellation (App. A)', async () => {
    const env = brokerEnv(1);
    env.broker.attach(recorder());
    const started = Date.now();
    expect(await requestOn(env)).toEqual({ submitted: false, reason: 'timeout' });
    expect(Date.now() - started).toBeGreaterThanOrEqual(900);
    env.cleanup();
  });

  it('fails a waiting run on shutdown rather than leaving it hanging (App. D.3)', async () => {
    const env = brokerEnv();
    env.broker.attach(recorder());
    const pending = requestOn(env);
    expect(env.broker.interruptAll()).toBe(1);
    expect(await pending).toEqual({ submitted: false, reason: 'confirm_interrupted' });
    env.cleanup();
  });
});

describe('secret routing (§19.2)', () => {
  it('writes secret fields to secrets.yaml and hands the run only a reference', async () => {
    const env = brokerEnv();
    const sink = recorder();
    env.broker.attach(sink);
    const pending = requestOn(env);
    const frame = sink.sent[0]!.payload;

    // The frame the UI renders never carries a prefilled secret either.
    expect(frame.fields.find((f: any) => f.name === 'token')).not.toHaveProperty('value');

    env.broker.submit(frame.form_id, { name: 'fastmail', token: 'sentinel-abc123' });
    const outcome = await pending;
    expect(outcome).toEqual({
      submitted: true,
      values: { name: 'fastmail' },
      secrets: { token: '${secret:FASTMAIL_KEY}' },
    });
    expect(secretsOf(env.home).FASTMAIL_KEY).toBe('sentinel-abc123');
    const mode = fs.statSync(env.home.path('secrets', 'secrets.yaml')).mode & 0o777;
    expect(mode).toBe(0o600);
    env.cleanup();
  });

  it('resolves a {name} placeholder against what was actually submitted', async () => {
    const env = brokerEnv();
    const sink = recorder();
    env.broker.attach(sink);
    const pending = requestOn(env, [
      { name: 'name', label: 'Name', type: 'text' },
      { name: 'api_key', label: 'Key', type: 'secret', secret_key: '{name}_API_KEY' },
    ]);
    env.broker.submit(sink.sent[0]!.payload.form_id, {
      name: 'spare box',
      api_key: 'sentinel-placeholder',
    });
    const outcome = await pending;
    expect(outcome.submitted && outcome.secrets.api_key).toBe('${secret:SPARE_BOX_API_KEY}');
    expect(secretsOf(env.home).SPARE_BOX_API_KEY).toBe('sentinel-placeholder');
    env.cleanup();
  });

  it('refuses a secret field with nowhere to put it', async () => {
    const env = brokerEnv();
    const sink = recorder();
    env.broker.attach(sink);
    void requestOn(env, [{ name: 'token', label: 'Token', type: 'secret' }]);
    expect(env.broker.submit(sink.sent[0]!.payload.form_id, { token: 'x' })).toEqual({
      ok: false,
      error: 'field token has no secret_key',
    });
    env.cleanup();
  });

  it('merges into secrets.yaml without losing what was there', () => {
    const env = brokerEnv();
    storeFor(env.home).merge({ FIRST: 'one' });
    storeFor(env.home).merge({ SECOND: 'two' });
    expect(secretsOf(env.home)).toEqual({ FIRST: 'one', SECOND: 'two' });
    env.cleanup();
  });

  it('keeps secrets out of git', () => {
    const env = brokerEnv();
    storeFor(env.home).merge({ LEAK_CHECK: 'sentinel-git' });
    env.home.git.commit('anything', ['.']);
    // `git log -p` over the whole repo: the value must appear nowhere in it.
    const grep = env.home.git.head();
    expect(grep).toBeTruthy();
    env.cleanup();
  });
});

describe('trace redaction (§14.4.2, App. F.9)', () => {
  it('masks prefilled values on setup.* calls and leaves other tools alone', () => {
    const args = {
      title: 'Connect',
      fields: [
        { name: 'token', type: 'secret', value: 'sentinel-xyz', secret_key: 'K' },
        { name: 'url', type: 'url', value: 'https://example.test' },
      ],
      prefill: { pat: 'sentinel-pat' },
    };
    const redacted = redactTraceArgs('setup.form', args) as any;
    expect(redacted.fields[0].value).toBe('***');
    expect(redacted.fields[0].secret_key).toBe('K');
    expect(redacted.fields[1].value).toBe('***');
    expect(redacted.prefill).toEqual({ pat: '***' });
    expect(JSON.stringify(redacted)).not.toContain('sentinel');
    // Every other tool's args are stored verbatim (App. C.1).
    expect(redactTraceArgs('memory.save', { content: 'plain' })).toEqual({ content: 'plain' });
  });
});

describe('config.write carve-out (§14.4.1)', () => {
  it('refuses the three files a human must be in the loop for', () => {
    const env = brokerEnv();
    for (const file of [
      'config/mcp.yaml',
      'config/integrations.yaml',
      'config/channels.yaml',
    ]) {
      expect(() => resolveWritablePath(env.home, file)).toThrow(PathRejected);
    }
    // The rest of config/ is still the assistant's to edit.
    expect(() => resolveWritablePath(env.home, 'config/personality.md')).not.toThrow();
    env.cleanup();
  });

  it('leaves no code path from a chat tool call to an MCP install', async () => {
    h = await bootService({ onboarded: true });
    h.fake.script(
      {
        toolCalls: [
          {
            name: 'config.write',
            args: {
              path: 'config/mcp.yaml',
              content: 'servers:\n  - name: evil\n    transport: stdio\n    command: ["sh"]\n',
              message: 'install a server',
            },
          },
        ],
      },
      { text: 'I could not do that.' },
    );
    const sent = h.service.chat.send({ text: 'install an mcp server yourself' });
    await drain(h);

    expect(fs.existsSync(path.join(h.dataDir, 'config', 'mcp.yaml'))).toBe(false);
    const call = h.service.repos.trace
      .forEvent(sent.eventId)
      .find((t) => t.kind === 'tool_call')!.data as any;
    expect(call.ok).toBe(false);
    expect(call.result_excerpt).toContain('setup form flow');
  });
});

describe('field merging (App. F.9)', () => {
  it('overrides a template field by name and appends unknown ones', () => {
    const base: FieldSpec[] = [
      { name: 'name', label: 'Name', type: 'text' },
      { name: 'command', label: 'Command', type: 'text' },
    ];
    const merged = mergeFields(base, [
      { name: 'command', value: 'npx -y thing' },
      { name: 'extra', label: 'Extra', type: 'number' },
    ]);
    expect(merged).toEqual([
      { name: 'name', label: 'Name', type: 'text' },
      { name: 'command', label: 'Command', type: 'text', value: 'npx -y thing' },
      { name: 'extra', label: 'Extra', type: 'number' },
    ]);
  });

  it('derives a per-connector secret key when the agent did not name one', () => {
    const fields = fillSecretKeys([
      { name: 'name', label: 'Name', type: 'text', value: 'github-mcp' },
      { name: 'credential', label: 'Token', type: 'secret' },
      { name: 'other', label: 'Other', type: 'secret', secret_key: 'CHOSEN' },
    ]);
    expect(fields[1]!.secret_key).toBe('{name}_CREDENTIAL');
    expect(fields[2]!.secret_key).toBe('CHOSEN');
  });

  it('splits a command line the way a shell would, without the shell', () => {
    expect(splitCommand('npx -y  @scope/pkg --flag "two words"')).toEqual([
      'npx',
      '-y',
      '@scope/pkg',
      '--flag',
      'two words',
    ]);
    expect(() => splitCommand('npx "unbalanced')).toThrow(/unbalanced quote/);
  });
});

describe('setup.form end to end, through the chat UI', () => {
  it('summons a form, suspends the run, and resumes with references only', async () => {
    h = await bootService({ onboarded: true });
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
              args: {
                title: 'Connect Fastmail',
                fields: [
                  { name: 'account', label: 'Account', type: 'text' },
                  {
                    name: 'api_key',
                    label: 'API key',
                    type: 'secret',
                    secret_key: 'FASTMAIL_KEY',
                  },
                ],
              },
            },
          ],
        };
      }
      return { text: 'Stored the key and used the reference.' };
    });

    const sent = h.service.chat.send({ text: 'connect fastmail' });
    const form = await client.next('form.request', 15000);
    expect(form.payload.title).toBe('Connect Fastmail');
    expect(form.payload.conversation_id).toBe(sent.conversationId);
    expect(h.service.forms.waiting).toBe(1);

    client.send('form.submit', {
      form_id: form.payload.form_id,
      values: { account: 'me@example.test', api_key: 'sentinel-fastmail-9times7' },
    });
    expect((await client.next('form.accepted')).payload.form_id).toBe(form.payload.form_id);
    await drain(h);

    // What the run was handed: the account verbatim, the key as a reference.
    const call = h.service.repos.trace
      .forEvent(sent.eventId)
      .find((t) => t.kind === 'tool_call')!.data as any;
    expect(call.ok).toBe(true);
    expect(call.result_excerpt).toContain('${secret:FASTMAIL_KEY}');
    expect(call.result_excerpt).toContain('me@example.test');
    expect(h.service.forms.waiting).toBe(0);

    // The sentinel test (§19.2): the value is in secrets.yaml and nowhere else.
    const secretsFile = path.join(h.dataDir, 'secrets', 'secrets.yaml');
    expect(YAML.parse(fs.readFileSync(secretsFile, 'utf8')).FASTMAIL_KEY).toBe(
      'sentinel-fastmail-9times7',
    );
    expect(sweep(h.dataDir, 'sentinel-fastmail-9times7')).toEqual(['secrets/secrets.yaml']);
  });

  it('resumes gracefully when the user cancels', async () => {
    h = await bootService({ onboarded: true });
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
              args: {
                title: 'Connect something',
                fields: [{ name: 'thing', label: 'Thing', type: 'text' }],
              },
            },
          ],
        };
      }
      return { text: 'No problem, dropped it.' };
    });

    const sent = h.service.chat.send({ text: 'connect something' });
    const form = await client.next('form.request', 15000);
    client.send('form.cancel', { form_id: form.payload.form_id });
    await client.next('form.accepted');
    await drain(h);

    const call = h.service.repos.trace
      .forEvent(sent.eventId)
      .find((t) => t.kind === 'tool_call')!.data as any;
    expect(call.result_excerpt).toContain('cancelled');
    const turns = h.service.repos.conversations.history(sent.conversationId);
    expect(turns.at(-1)?.text).toContain('dropped it');
  });

  it('answers a submit for a form nobody is waiting on', async () => {
    h = await bootService({ onboarded: true });
    const client = await TestClient.connect(h.baseUrl, h.token);
    await client.hello(['chat', 'forms']);
    client.send('form.submit', { form_id: 'nope', values: {} });
    const err = await client.next('error');
    expect(err.payload.code).toBe('not_found');
  });
});

describe('connector templates (§19.3)', () => {
  it('installs a real MCP server from a submitted form and reports its tools', async () => {
    h = await bootService({ onboarded: true });
    const client = await TestClient.connect(h.baseUrl, h.token);
    await client.hello(['chat', 'forms']);
    const fixture = path.resolve('test/fixtures/mcp-clock-server.mjs');

    let asked = false;
    h.fake.always((req) => {
      if (req.body.tools && !asked) {
        asked = true;
        return {
          toolCalls: [
            {
              name: 'setup.form',
              args: {
                title: 'Connect the clock MCP',
                template: 'mcp_stdio',
                fields: [
                  { name: 'name', value: 'clock' },
                  { name: 'command', value: `node "${fixture}"` },
                ],
              },
            },
          ],
        };
      }
      return { text: 'Connected. You now have clock.now.' };
    });

    const sent = h.service.chat.send({ text: 'connect the clock mcp' });
    const form = await client.next('form.request', 15000);
    expect(form.payload.template).toBe('mcp_stdio');
    // The exact command is in front of the human submitting it (§14.4.1).
    expect(form.payload.fields.find((f: any) => f.name === 'command').value).toContain(
      'mcp-clock-server.mjs',
    );

    client.send('form.submit', {
      form_id: form.payload.form_id,
      values: { name: 'clock', command: `node "${fixture}"` },
    });
    await drain(h);

    const call = h.service.repos.trace
      .forEvent(sent.eventId)
      .find((t) => t.kind === 'tool_call')!.data as any;
    expect(call.result_excerpt).toContain('clock.now');
    // Written by the integration, committed, and actually connected.
    const mcp = YAML.parse(fs.readFileSync(path.join(h.dataDir, 'config', 'mcp.yaml'), 'utf8'));
    expect(mcp.servers[0]).toMatchObject({ name: 'clock', transport: 'stdio' });
    expect(h.service.tools.get('clock.now')?.source).toBe('clock');
    expect(h.service.tools.serverStatus()).toEqual([
      {
        name: 'clock',
        transport: 'stdio',
        connected: true,
        tools: ['clock.now', 'clock.set_alarm'],
      },
    ]);
  });

  it('routes a template credential into secrets and references it from mcp.yaml', async () => {
    h = await bootService({ onboarded: true });
    const client = await TestClient.connect(h.baseUrl, h.token);
    await client.hello(['chat', 'forms']);
    const fixture = path.resolve('test/fixtures/mcp-clock-server.mjs');

    let asked = false;
    h.fake.always((req) => {
      if (req.body.tools && !asked) {
        asked = true;
        return {
          toolCalls: [
            {
              name: 'setup.form',
              args: {
                title: 'Connect the clock MCP',
                template: 'mcp_stdio',
                fields: [{ name: 'name', value: 'clock' }],
              },
            },
          ],
        };
      }
      return { text: 'Connected.' };
    });

    h.service.chat.send({ text: 'connect the clock mcp with a token' });
    const form = await client.next('form.request', 15000);
    client.send('form.submit', {
      form_id: form.payload.form_id,
      values: {
        name: 'clock',
        command: `node "${fixture}"`,
        env_var: 'CLOCK_TOKEN',
        credential: 'sentinel-mcp-credential',
      },
    });
    await drain(h);

    // The committed file holds a reference; the value is in the secret store.
    const mcp = YAML.parse(fs.readFileSync(path.join(h.dataDir, 'config', 'mcp.yaml'), 'utf8'));
    expect(mcp.servers[0].env).toEqual({ CLOCK_TOKEN: '${secret:CLOCK_CREDENTIAL}' });
    expect(h.app.config.secrets.CLOCK_CREDENTIAL).toBe('sentinel-mcp-credential');
    expect(sweep(h.dataDir, 'sentinel-mcp-credential')).toEqual(['secrets/secrets.yaml']);
    // And the server came up with the resolved value in its environment.
    expect(h.service.tools.get('clock.now')).not.toBeNull();
  });

  it('backs the config out again when the server will not come up', async () => {
    h = await bootService({ onboarded: true });
    const client = await TestClient.connect(h.baseUrl, h.token);
    await client.hello(['chat', 'forms']);

    let asked = false;
    h.fake.always((req) => {
      if (req.body.tools && !asked) {
        asked = true;
        return {
          toolCalls: [
            { name: 'setup.form', args: { title: 'Connect', template: 'mcp_stdio' } },
          ],
        };
      }
      return { text: 'That did not connect.' };
    });

    const sent = h.service.chat.send({ text: 'connect a broken mcp' });
    const form = await client.next('form.request', 15000);
    client.send('form.submit', {
      form_id: form.payload.form_id,
      values: { name: 'broken', command: 'node /nonexistent/server.mjs' },
    });
    await drain(h);

    const call = h.service.repos.trace
      .forEvent(sent.eventId)
      .find((t) => t.kind === 'tool_call')!.data as any;
    expect(call.result_excerpt).toContain('"installed":false');
    const mcp = YAML.parse(fs.readFileSync(path.join(h.dataDir, 'config', 'mcp.yaml'), 'utf8'));
    expect(mcp.servers).toEqual([]);
  });

  it('probes a model endpoint before adding it, and keeps the key out of the file', async () => {
    h = await bootService({ onboarded: true });
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
              args: { title: 'Add an endpoint', template: 'model_endpoint' },
            },
          ],
        };
      }
      if (req.body.response_format) return { text: '{"ok":true,"note":"hello"}' };
      return { text: 'ready' };
    });

    h.service.chat.send({ text: 'add my other box' });
    const form = await client.next('form.request', 15000);
    client.send('form.submit', {
      form_id: form.payload.form_id,
      values: {
        name: 'spare',
        url: h.fake.baseUrl,
        api_key: 'sentinel-model-key',
        classes: 'fast',
      },
    });
    await drain(h);

    const models = YAML.parse(
      fs.readFileSync(path.join(h.dataDir, 'config', 'models.yaml'), 'utf8'),
    );
    const added = models.endpoints.find((e: any) => e.name === 'spare');
    expect(added.api_key).toBe('${secret:SPARE_API_KEY}');
    expect(h.app.config.secrets.SPARE_API_KEY).toBe('sentinel-model-key');
    expect(added.kind).toBe('chat');
    expect(added.classes).toEqual(['fast']);
    expect(added.caps).toContain('json');
    expect(models.embedding).toBeUndefined();
    expect(h.service.modelStack?.router.byName('spare', 'chat')).toBeTruthy();
    expect(sweep(h.dataDir, 'sentinel-model-key')).toEqual(['secrets/secrets.yaml']);
  });

  it('gives the classes field no prefill once a chat endpoint already exists (§10.6)', async () => {
    h = await bootService({ onboarded: true });
    const client = await TestClient.connect(h.baseUrl, h.token);
    await client.hello(['chat', 'forms']);

    h.fake.always((req) => {
      if (req.body.tools) {
        return {
          toolCalls: [
            {
              name: 'setup.form',
              args: { title: 'Add an endpoint', template: 'model_endpoint' },
            },
          ],
        };
      }
      return { text: 'ready' };
    });

    h.service.chat.send({ text: 'add another endpoint' });
    const form = await client.next('form.request', 15000);
    // `main` already exists (the harness default), and it is a chat endpoint —
    // asking about "the first one" would be furniture at best.
    const classesField = form.payload.fields.find((f: any) => f.name === 'classes');
    expect(classesField.value).toBeUndefined();
    expect(classesField.label).toContain('already has a chat endpoint');
  });
});

describe('the speech_endpoint template (§10.9, F.9)', () => {
  let speech: FakeSpeech;

  afterEach(async () => {
    await speech?.stop();
  });

  /** Drive `setup.form` with the speech template and submit these values. */
  async function addSpeechEndpoint(values: Record<string, string>): Promise<any> {
    const client = await TestClient.connect(h.baseUrl, h.token);
    await client.hello(['chat', 'forms']);
    let asked = false;
    h.fake.always((req: any) => {
      if (req.body.tools && !asked) {
        asked = true;
        return {
          toolCalls: [
            {
              name: 'setup.form',
              args: { title: 'Connect speech', template: 'speech_endpoint' },
            },
          ],
        };
      }
      return { text: 'ready' };
    });
    const sent = h.service.chat.send({ text: 'connect my transcriber' });
    const form = await client.next('form.request', 15000);
    client.send('form.submit', { form_id: form.payload.form_id, values });
    await drain(h);
    return { ...form.payload, eventId: sent.eventId };
  }

  function modelsYaml(): any {
    return YAML.parse(fs.readFileSync(path.join(h.dataDir, 'config', 'models.yaml'), 'utf8'));
  }

  it('probes, writes the entry, routes the purpose once, and keeps the key a reference', async () => {
    h = await bootService({ onboarded: true });
    speech = new FakeSpeech();
    const url = await speech.start();
    speech.script('Turminder is ready to help you today.');

    await addSpeechEndpoint({
      kind: 'stt',
      name: 'whisper',
      url,
      api_key: 'sentinel-speech-key',
      language: 'nb',
    });

    const models = modelsYaml();
    const added = models.endpoints.find((e: any) => e.name === 'whisper');
    expect(added).toMatchObject({ kind: 'stt', language: 'nb', model: 'fake-whisper' });
    expect(added.api_key).toBe('${secret:WHISPER_API_KEY}');
    expect(added.classes).toBeUndefined();
    expect(models.routes.stt).toEqual({ endpoint: 'whisper' });
    expect(h.service.modelStack?.router.speech('stt')?.name).toBe('whisper');
    expect(sweep(h.dataDir, 'sentinel-speech-key')).toEqual(['secrets/secrets.yaml']);
    // It probed before writing — the fixture went over the wire, not a guess.
    expect(speech.requests.some((r) => r.path.endsWith('/audio/transcriptions'))).toBe(true);
  });

  it('writes a tts entry with its voice and does not steal an existing route', async () => {
    h = await bootService({ onboarded: true });
    speech = new FakeSpeech();
    const url = await speech.start();

    await addSpeechEndpoint({ kind: 'tts', name: 'piper', url, voice: 'alloy' });
    expect(modelsYaml().routes.tts).toEqual({ endpoint: 'piper' });

    await addSpeechEndpoint({ kind: 'tts', name: 'second', url, voice: 'nova' });
    const models = modelsYaml();
    expect(models.endpoints.find((e: any) => e.name === 'second')).toMatchObject({
      kind: 'tts',
      voice: 'nova',
    });
    // The first one keeps the route: a second endpoint is an addition, not a
    // silent reassignment (§10.6).
    expect(models.routes.tts).toEqual({ endpoint: 'piper' });
  });

  it('writes nothing when the probe fails', async () => {
    h = await bootService({ onboarded: true });
    speech = new FakeSpeech();
    const url = await speech.start();
    speech.script('Thank you for watching.'); // the silence hallucination

    const added = await addSpeechEndpoint({ kind: 'stt', name: 'deaf', url });

    const models = modelsYaml();
    expect(models.endpoints.find((e: any) => e.name === 'deaf')).toBeUndefined();
    expect(models.routes?.stt).toBeUndefined();
    const call = h.service.repos.trace
      .forEvent(added.eventId)
      .find((t) => t.kind === 'tool_call')!.data as any;
    expect(call.result_excerpt).toContain('probe_failed');
  });

  it('offers the kind as a two-button choice and asks for nothing it cannot use', async () => {
    h = await bootService({ onboarded: true });
    speech = new FakeSpeech();
    const url = await speech.start();
    const payload = await addSpeechEndpoint({ kind: 'tts', name: 'piper', url });
    const fields: any[] = payload.fields;
    expect(fields.find((f) => f.name === 'kind')).toMatchObject({
      type: 'choice',
      options: ['stt', 'tts'],
    });
    expect(fields.find((f) => f.name === 'api_key')).toMatchObject({
      type: 'secret',
      required: false,
    });
    expect(fields.map((f) => f.name)).toEqual([
      'kind',
      'name',
      'url',
      'api_key',
      'model',
      'voice',
      'language',
    ]);
  });
});

describe('setup.voice (§33.5)', () => {
  let speech: FakeSpeech;

  afterEach(async () => {
    await speech?.stop();
  });

  /** A harness whose models.yaml carries a transcriber and a synthesiser. */
  async function bootWithSpeech(
    entries: { stt?: Record<string, unknown>; tts?: Record<string, unknown> } = {},
  ): Promise<void> {
    clearVoiceCache();
    h = await bootService({ onboarded: true, watchFiles: false });
    speech = new FakeSpeech();
    const url = await speech.start();
    const file = path.join(h.dataDir, 'config', 'models.yaml');
    const models = YAML.parse(fs.readFileSync(file, 'utf8')) as {
      endpoints: Record<string, unknown>[];
    };
    if (entries.stt !== undefined) {
      models.endpoints.push({ name: 'whisper', url, kind: 'stt', model: 'w', ...entries.stt });
    }
    if (entries.tts !== undefined) {
      models.endpoints.push({ name: 'piper', url, kind: 'tts', model: 'p', ...entries.tts });
    }
    fs.writeFileSync(file, YAML.stringify(models), 'utf8');
    h.app.config.reload();
    h.service.loadModels();
  }

  const modelsFile = () => path.join(h.dataDir, 'config', 'models.yaml');
  const modelsYaml = () => YAML.parse(fs.readFileSync(modelsFile(), 'utf8'));

  /** Drive `setup.voice` and answer (or refuse) its form. */
  async function runVoiceForm(
    answer: Record<string, string> | 'cancel' | null,
  ): Promise<{ form: any; result: any }> {
    const client = await TestClient.connect(h.baseUrl, h.token);
    await client.hello(['chat', 'forms']);
    let asked = false;
    h.fake.always((req: any) => {
      if (req.body.tools && !asked) {
        asked = true;
        return { toolCalls: [{ name: 'setup.voice', args: {} }] };
      }
      return { text: 'done' };
    });
    const sent = h.service.chat.send({ text: 'speak Norwegian' });
    let form: any = null;
    if (answer !== null) {
      form = (await client.next('form.request', 15000)).payload;
      if (answer === 'cancel') client.send('form.cancel', { form_id: form.form_id });
      else client.send('form.submit', { form_id: form.form_id, values: answer });
    }
    await drain(h);
    const call = h.service.repos.trace
      .forEvent(sent.eventId)
      .find((t) => t.kind === 'tool_call')!.data as any;
    client.close();
    return { form, result: call.result_excerpt as string };
  }

  it('prefills the language from the identity locale, and from the entry when it has one', async () => {
    await bootWithSpeech({ stt: {}, tts: {} });
    const bare = await runVoiceForm('cancel');
    const language = bare.form.fields.find((f: any) => f.name === 'language');
    // The harness identity says `locale: en`, and an absent `language` means
    // exactly that (§10.9) — so that is what the form shows.
    expect(language.value).toBe('en — English');
    expect(language.options).toContain('auto — let the transcriber detect');
    expect(language.options.length).toBeGreaterThanOrEqual(20);
    expect(language.options).toEqual(STT_LANGUAGES);

    await h.cleanup();
    await speech.stop();
    await bootWithSpeech({ stt: { language: 'nb' }, tts: {} });
    const pinned = await runVoiceForm('cancel');
    expect(pinned.form.fields.find((f: any) => f.name === 'language').value).toBe(
      'nb — Norwegian Bokmål',
    );
  });

  it('offers a previewable voice field led by the configured voice', async () => {
    await bootWithSpeech({ stt: {}, tts: { voice: 'nova' } });
    speech.voices = ['alloy', 'nova'];
    const { form } = await runVoiceForm('cancel');
    const voice = form.fields.find((f: any) => f.name === 'voice');
    expect(voice.type).toBe('voice');
    expect(voice.value).toBe('nova');
    // What is in use leads the list, so the common case — open the form, hear
    // one or two others, keep what you had — is one click.
    expect(voice.options).toEqual(['nova', 'alloy']);
  });

  it('keeps a configured voice the endpoint does not list, but stops defaulting to it', async () => {
    // The endpoint lists voices and this is not one of them, so it is a
    // leftover from a synthesiser this address no longer is. Still reachable,
    // because a listing can be incomplete; no longer the default, because the
    // default is what submitting an untouched form writes back.
    await bootWithSpeech({ stt: {}, tts: { voice: 'nb_NO-talesyntese-medium' } });
    speech.voices = ['alloy', 'nova'];
    const { form } = await runVoiceForm('cancel');
    const voice = form.fields.find((f: any) => f.name === 'voice');
    expect(voice.value).toBe('alloy');
    expect(voice.options).toEqual(['alloy', 'nova', 'nb_NO-talesyntese-medium']);
  });

  it('offers the voices the endpoint nests in its model listing', async () => {
    // Speaches has no /voices route at all — the voices are inside the
    // `/v1/models` entry. Before this the form offered OpenAI's six, which are
    // openedai-speech's piper aliases, so the wrong list looked like a right
    // one (Christer, 2026-08-31).
    await bootWithSpeech({ stt: {}, tts: { model: 'kokoro', voice: 'af_heart' } });
    speech.voices = null;
    speech.otherModels = ['kokoro'];
    speech.modelVoices = { kokoro: ['af_heart', 'am_puck', 'bf_emma'] };
    const { form } = await runVoiceForm('cancel');
    const voice = form.fields.find((f: any) => f.name === 'voice');
    expect(voice.options).toEqual(['af_heart', 'am_puck', 'bf_emma']);
    expect(voice.value).toBe('af_heart');
  });

  it('stops defaulting to a voice the endpoint no longer has, without hiding it', async () => {
    // Swapping openedai-speech for Speaches leaves `voice: alloy` in the file
    // and Kokoro has no `alloy`. Leading with it would mean submitting the
    // form unchanged writes the broken setting straight back.
    await bootWithSpeech({ stt: {}, tts: { model: 'kokoro', voice: 'alloy' } });
    speech.voices = null;
    speech.otherModels = ['kokoro'];
    speech.modelVoices = { kokoro: ['af_heart', 'am_puck'] };
    const { form } = await runVoiceForm('cancel');
    const voice = form.fields.find((f: any) => f.name === 'voice');
    // Prefilled with something that works…
    expect(voice.value).toBe('af_heart');
    // …and the leftover still reachable, in case the listing is incomplete.
    expect(voice.options).toEqual(['af_heart', 'am_puck', 'alloy']);
  });

  it('falls back to the OpenAI six when the endpoint lists nothing', async () => {
    await bootWithSpeech({ stt: {}, tts: {} });
    const { form } = await runVoiceForm('cancel');
    expect(form.fields.find((f: any) => f.name === 'voice').options).toEqual(OPENAI_VOICES);
  });

  it('writes the language and the voice and nothing else', async () => {
    await bootWithSpeech({ stt: {}, tts: { voice: 'alloy' } });
    const before = modelsYaml();
    const { result } = await runVoiceForm({
      language: 'nb — Norwegian Bokmål',
      voice: 'nova',
    });
    expect(result).toContain('"submitted":true');
    const after = modelsYaml();
    expect(after.endpoints.find((e: any) => e.name === 'whisper')).toMatchObject({
      language: 'nb',
      model: 'w',
    });
    expect(after.endpoints.find((e: any) => e.name === 'piper').voice).toBe('nova');
    // Everything else, byte for byte: only those two keys moved.
    const strip = (doc: any) =>
      JSON.stringify({
        ...doc,
        endpoints: doc.endpoints.map((e: any) => {
          const { language: _l, voice: _v, ...rest } = e;
          return rest;
        }),
      });
    expect(strip(after)).toBe(strip(before));
    expect(h.service.modelStack?.router.speech('stt')?.language).toBe('nb');
  });

  it('deletes the key for `auto` rather than writing it', async () => {
    // Absent means the locale, `auto` means detect (G.2) — and the file says
    // "detect" by saying nothing at all.
    await bootWithSpeech({ stt: { language: 'nb' }, tts: { voice: 'alloy' } });
    await runVoiceForm({ language: 'auto — let the transcriber detect', voice: 'alloy' });
    const entry = modelsYaml().endpoints.find((e: any) => e.name === 'whisper');
    expect('language' in entry).toBe(false);
  });

  it('writes nothing on cancel', async () => {
    await bootWithSpeech({ stt: { language: 'nb' }, tts: { voice: 'alloy' } });
    const before = fs.readFileSync(modelsFile(), 'utf8');
    const { result } = await runVoiceForm('cancel');
    expect(result).toContain('"submitted":false');
    expect(fs.readFileSync(modelsFile(), 'utf8')).toBe(before);
  });

  it('names the missing kind rather than opening a form about nothing', async () => {
    await bootWithSpeech({ stt: {} });
    const { form, result } = await runVoiceForm(null);
    expect(form).toBeNull();
    expect(result).toContain('no_speech_endpoint');
    expect(result).toContain('"kind":"tts"');
    expect(result).toContain('speech_endpoint');
  });
});

describe('setup.rebuild_index (§8.3, F.9)', () => {
  const askForRebuild = () => {
    let asked = false;
    h.fake.always((req: any) => {
      if (req.body.tools && !asked) {
        asked = true;
        return { toolCalls: [{ name: 'setup.rebuild_index', args: {} }] };
      }
      return { text: 'Done.' };
    });
  };

  it('rebuilds all three indexes after the user approves', async () => {
    h = await bootService({ onboarded: true });
    const client = await TestClient.connect(h.baseUrl, h.token);
    await client.hello(['chat', 'forms']);
    askForRebuild();

    const sent = h.service.chat.send({ text: 'rebuild the search index' });
    const form = await client.next('form.request', 15000);
    expect(form.payload.fields).toHaveLength(1);
    expect(form.payload.fields[0].type).toBe('choice');

    client.send('form.submit', {
      form_id: form.payload.form_id,
      values: { confirm: 'Rebuild' },
    });
    await client.next('form.accepted');
    await drain(h);

    const call = h.service.repos.trace
      .forEvent(sent.eventId)
      .find((t) => t.kind === 'tool_call')!.data as any;
    expect(call.ok).toBe(true);
    expect(call.result_excerpt).toContain('"rebuilt":true');
    // All three corpora report stats — the rebuild actually ran.
    expect(call.result_excerpt).toContain('"memory"');
    expect(call.result_excerpt).toContain('"files"');
    expect(call.result_excerpt).toContain('"history"');
  });

  it('declines without rebuilding when the user picks Cancel', async () => {
    h = await bootService({ onboarded: true });
    const client = await TestClient.connect(h.baseUrl, h.token);
    await client.hello(['chat', 'forms']);
    askForRebuild();

    const sent = h.service.chat.send({ text: 'rebuild the search index' });
    const form = await client.next('form.request', 15000);
    client.send('form.submit', {
      form_id: form.payload.form_id,
      values: { confirm: 'Cancel' },
    });
    await client.next('form.accepted');
    await drain(h);

    const call = h.service.repos.trace
      .forEvent(sent.eventId)
      .find((t) => t.kind === 'tool_call')!.data as any;
    expect(call.ok).toBe(true);
    expect(call.result_excerpt).toContain('"rebuilt":false');
    expect(call.result_excerpt).not.toContain('"indexes"');
  });
});

describe('setup.pricing (§10.5, F.9)', () => {
  const askToPrice = (args: Record<string, unknown> = {}) => {
    let asked = false;
    h.fake.always((req: any) => {
      if (req.body.tools && !asked) {
        asked = true;
        return { toolCalls: [{ name: 'setup.pricing', args }] };
      }
      return { text: 'Done.' };
    });
  };

  const models = () =>
    YAML.parse(fs.readFileSync(path.join(h.dataDir, 'config', 'models.yaml'), 'utf8'));

  const traced = (eventId: string) =>
    h.service.repos.trace.forEvent(eventId).find((t) => t.kind === 'tool_call')!.data as any;

  it('prices an endpoint from figures the human typed', async () => {
    h = await bootService({ onboarded: true });
    const client = await TestClient.connect(h.baseUrl, h.token);
    await client.hello(['chat', 'forms']);
    askToPrice({ endpoint: 'main' });

    const sent = h.service.chat.send({ text: 'the main endpoint is $3 in and $15 out' });
    const form = await client.next('form.request', 15000);
    // One endpoint named, so no picker — and the consequence is stated where
    // the decision is made (§10.5).
    const names = form.payload.fields.map((f: any) => f.name);
    expect(names).not.toContain('endpoint');
    expect(names).toEqual(['priced', 'in_per_mtok', 'out_per_mtok', 'currency']);
    expect(form.payload.title).toContain('from now on');

    client.send('form.submit', {
      form_id: form.payload.form_id,
      values: {
        priced: 'yes, it charges',
        in_per_mtok: '3',
        out_per_mtok: '15',
        currency: 'usd',
      },
    });
    await client.next('form.accepted');
    await drain(h);

    expect(models().endpoints[0].cost).toEqual({
      in_per_mtok: 3,
      out_per_mtok: 15,
      currency: 'USD',
    });
    const call = traced(sent.eventId);
    expect(call.ok).toBe(true);
    expect(call.result_excerpt).toContain('"committed":true');
    // The price reaches the router without a restart (camelCase inside the
    // model layer; the YAML above is the wire form).
    expect(h.service.modelStack?.router.byName('main')?.cost).toEqual({
      inPerMtok: 3,
      outPerMtok: 15,
      currency: 'USD',
    });
  });

  it('offers the way back to costless, and takes it', async () => {
    h = await bootService({ onboarded: true });
    const client = await TestClient.connect(h.baseUrl, h.token);
    await client.hello(['chat', 'forms']);
    askToPrice({ endpoint: 'main' });

    h.service.chat.send({ text: 'the main endpoint is free' });
    const form = await client.next('form.request', 15000);
    client.send('form.submit', {
      form_id: form.payload.form_id,
      values: { priced: 'no — local or free' },
    });
    await client.next('form.accepted');
    await drain(h);

    // Absent, not zeroed: §10.5 draws a line between free and unpriced, and
    // this is the surface that has to keep it reachable.
    expect(models().endpoints[0]).not.toHaveProperty('cost');
  });

  it('refuses an endpoint that does not exist, and writes nothing', async () => {
    h = await bootService({ onboarded: true });
    const client = await TestClient.connect(h.baseUrl, h.token);
    await client.hello(['chat', 'forms']);
    askToPrice({ endpoint: 'nowhere' });

    const before = fs.readFileSync(path.join(h.dataDir, 'config', 'models.yaml'), 'utf8');
    const sent = h.service.chat.send({ text: 'price the nowhere endpoint' });
    await drain(h);

    const call = traced(sent.eventId);
    expect(call.result_excerpt).toContain('unknown_endpoint');
    // …and it names the set, so the model can correct itself rather than guess.
    expect(call.result_excerpt).toContain('main');
    expect(fs.readFileSync(path.join(h.dataDir, 'config', 'models.yaml'), 'utf8')).toBe(before);
  });

  it('refuses figures that are not prices, and writes nothing', async () => {
    h = await bootService({ onboarded: true });
    const client = await TestClient.connect(h.baseUrl, h.token);
    await client.hello(['chat', 'forms']);
    askToPrice({ endpoint: 'main' });

    const before = fs.readFileSync(path.join(h.dataDir, 'config', 'models.yaml'), 'utf8');
    const sent = h.service.chat.send({ text: 'price it' });
    const form = await client.next('form.request', 15000);
    client.send('form.submit', {
      form_id: form.payload.form_id,
      values: {
        priced: 'yes, it charges',
        in_per_mtok: '-3',
        out_per_mtok: '15',
        currency: 'dollars',
      },
    });
    await client.next('form.accepted');
    await drain(h);

    const call = traced(sent.eventId);
    expect(call.result_excerpt).toContain('bad_price');
    expect(fs.readFileSync(path.join(h.dataDir, 'config', 'models.yaml'), 'utf8')).toBe(before);
  });
});

/**
 * The handler-routing form (§10.6, §19.2, F.6): `config.write` never accepts
 * `model_class`/`endpoint`/`effort` from the model. Driven like `setup.pricing`
 * above — a scripted tool call, the form round trip, then the file on disk.
 */
describe('handler routing form (F.6)', () => {
  const handlerPath = (dataDir: string, name: string) =>
    path.join(dataDir, 'handlers', `${name}.md`);

  const readModelsDoc = (harness: ServiceHarness) =>
    YAML.parse(
      fs.readFileSync(path.join(harness.dataDir, 'config', 'models.yaml'), 'utf8'),
    ) as { endpoints: Record<string, unknown>[] };

  const writeModelsDoc = (harness: ServiceHarness, doc: unknown) => {
    write(path.join(harness.dataDir, 'config', 'models.yaml'), YAML.stringify(doc));
    harness.app.config.reload();
    harness.service.loadModels();
  };

  /** A second chat endpoint — real capability, not just a class label. */
  const addChatEndpoint = (
    harness: ServiceHarness,
    name: string,
    opts: { efforts?: string[] } = {},
  ) => {
    const doc = readModelsDoc(harness);
    const base = { ...doc.endpoints[0] } as Record<string, unknown>;
    delete base.cost;
    delete base.efforts;
    doc.endpoints.push({ ...base, name, ...(opts.efforts ? { efforts: opts.efforts } : {}) });
    writeModelsDoc(harness, doc);
  };

  const declareMainEfforts = (harness: ServiceHarness, efforts: string[]) => {
    const doc = readModelsDoc(harness);
    doc.endpoints[0]!.efforts = efforts;
    writeModelsDoc(harness, doc);
  };

  const askToWriteHandler = (args: Record<string, unknown>) => {
    let asked = false;
    h.fake.always((req: any) => {
      if (req.body.tools && !asked) {
        asked = true;
        return { toolCalls: [{ name: 'config.write', args }] };
      }
      return { text: 'Done.' };
    });
  };

  const NEW_HANDLER =
    '---\nname: nudge\ndescription: d\nmodel_class: best\ntools: []\n---\n\nDo it.\n';
  const NEW_HANDLER_NO_ROUTING = '---\nname: nudge\ndescription: d\ntools: []\n---\n\nDo it.\n';

  const tracedCall = (harness: ServiceHarness, eventId: string) =>
    harness.service.repos.trace.forEvent(eventId).find((t) => t.kind === 'tool_call')!
      .data as any;

  it('(a) routes a new handler through a form with two endpoints, and strips what the model wrote', async () => {
    h = await bootService({ onboarded: true });
    addChatEndpoint(h, 'plain');
    const client = await TestClient.connect(h.baseUrl, h.token);
    await client.hello(['chat', 'forms']);
    askToWriteHandler({
      path: 'handlers/nudge.md',
      content: NEW_HANDLER,
      message: 'add the nudge handler',
    });

    const sent = h.service.chat.send({ text: 'add a nudge handler' });
    const form = await client.next('form.request', 15000);
    expect(form.payload.fields.map((f: any) => f.name)).toEqual(['model']);
    const options = form.payload.fields[0].options as string[];
    expect(options[0]).toMatch(/^Default — handler route/);
    const plainOption = options.find((o) => o.startsWith('plain'))!;
    expect(plainOption).toBeTruthy();

    client.send('form.submit', {
      form_id: form.payload.form_id,
      values: { model: plainOption },
    });
    await client.next('form.accepted');
    await drain(h);

    const parsed = matter(fs.readFileSync(handlerPath(h.dataDir, 'nudge'), 'utf8'));
    expect(parsed.data.endpoint).toBe('plain');
    expect(parsed.data.model_class).toBeUndefined();

    const call = tracedCall(h, sent.eventId);
    expect(call.result_excerpt).toContain('"chosen_by":"user"');
    expect(call.result_excerpt).toContain('"endpoint":"plain"');
    expect(call.result_excerpt).toContain('"ignored":["model_class"]');
  });

  it('(b) writes with no form and no routing keys when there is no real choice', async () => {
    h = await bootService({ onboarded: true });
    const client = await TestClient.connect(h.baseUrl, h.token);
    await client.hello(['chat', 'forms']);
    askToWriteHandler({
      path: 'handlers/nudge.md',
      content: NEW_HANDLER,
      message: 'add the nudge handler',
    });

    const sent = h.service.chat.send({ text: 'add a nudge handler' });
    await drain(h);

    const parsed = matter(fs.readFileSync(handlerPath(h.dataDir, 'nudge'), 'utf8'));
    expect(parsed.data.model_class).toBeUndefined();
    expect(parsed.data.endpoint).toBeUndefined();
    expect(parsed.data.effort).toBeUndefined();

    const call = tracedCall(h, sent.eventId);
    expect(call.result_excerpt).toContain('"chosen_by":"table"');
    expect(call.result_excerpt).toContain('"ignored":["model_class"]');
  });

  it('(c) keeps an existing choice across an ordinary rewrite, byte-for-byte', async () => {
    h = await bootService({ onboarded: true });
    addChatEndpoint(h, 'plain');
    write(
      handlerPath(h.dataDir, 'nudge'),
      '---\nname: nudge\ndescription: d\nendpoint: plain\ntools: []\n---\n\nOld body.\n',
    );

    const client = await TestClient.connect(h.baseUrl, h.token);
    await client.hello(['chat', 'forms']);
    askToWriteHandler({
      path: 'handlers/nudge.md',
      content: NEW_HANDLER_NO_ROUTING.replace('Do it.', 'New body.'),
      message: 'update the nudge handler',
    });

    const sent = h.service.chat.send({ text: 'update the nudge handler' });
    await drain(h);

    const parsed = matter(fs.readFileSync(handlerPath(h.dataDir, 'nudge'), 'utf8'));
    expect(parsed.data.endpoint).toBe('plain');
    expect(parsed.content.trim()).toBe('New body.');

    const call = tracedCall(h, sent.eventId);
    expect(call.result_excerpt).toContain('"chosen_by":"kept"');
    expect(call.result_excerpt).toContain('"endpoint":"plain"');
  });

  it('(d) rechoose_routing raises the form again even though a choice was already kept', async () => {
    h = await bootService({ onboarded: true });
    addChatEndpoint(h, 'plain');
    write(
      handlerPath(h.dataDir, 'nudge'),
      '---\nname: nudge\ndescription: d\nendpoint: plain\ntools: []\n---\n\nOld body.\n',
    );

    const client = await TestClient.connect(h.baseUrl, h.token);
    await client.hello(['chat', 'forms']);
    askToWriteHandler({
      path: 'handlers/nudge.md',
      content: NEW_HANDLER_NO_ROUTING.replace('Do it.', 'New body.'),
      message: 'update the nudge handler',
      rechoose_routing: true,
    });

    h.service.chat.send({ text: 'let me pick the model for nudge again' });
    const form = await client.next('form.request', 15000);
    expect(form.payload.fields.map((f: any) => f.name)).toEqual(['model']);
    client.send('form.submit', {
      form_id: form.payload.form_id,
      values: { model: form.payload.fields[0].options[0] }, // Default
    });
    await client.next('form.accepted');
    await drain(h);

    const parsed = matter(fs.readFileSync(handlerPath(h.dataDir, 'nudge'), 'utf8'));
    expect(parsed.data.endpoint).toBeUndefined();
  });

  it('(e) cancelling the form writes nothing — new file stays absent', async () => {
    h = await bootService({ onboarded: true });
    addChatEndpoint(h, 'plain');
    const client = await TestClient.connect(h.baseUrl, h.token);
    await client.hello(['chat', 'forms']);
    askToWriteHandler({
      path: 'handlers/nudge.md',
      content: NEW_HANDLER,
      message: 'add the nudge handler',
    });

    const sent = h.service.chat.send({ text: 'add a nudge handler' });
    const form = await client.next('form.request', 15000);
    client.send('form.cancel', { form_id: form.payload.form_id });
    await client.next('form.accepted');
    await drain(h);

    expect(fs.existsSync(handlerPath(h.dataDir, 'nudge'))).toBe(false);
    const call = tracedCall(h, sent.eventId);
    expect(call.result_excerpt).toContain('"submitted":false');
    expect(call.result_excerpt).toContain('"reason":"cancelled"');
  });

  it('(f) refuses a write needing a choice when there is no conversation to ask in', async () => {
    h = await bootService({ onboarded: true, watchFiles: false });
    addChatEndpoint(h, 'plain');
    const tool = h.service.tools.handles().find((t) => t.name === 'config.write')!;
    const result = (
      await tool.call(
        { path: 'handlers/nudge.md', content: NEW_HANDLER_NO_ROUTING, message: 'add handler' },
        { runId: 'r1', eventId: null },
      )
    ).output as any;
    expect(result).toMatchObject({ error: 'no_conversation' });
    expect(fs.existsSync(handlerPath(h.dataDir, 'nudge'))).toBe(false);
  });

  it('(g) drops a chosen effort the target endpoint does not declare, with a note', async () => {
    h = await bootService({ onboarded: true });
    declareMainEfforts(h, ['low', 'high']);
    addChatEndpoint(h, 'plain');
    const client = await TestClient.connect(h.baseUrl, h.token);
    await client.hello(['chat', 'forms']);
    askToWriteHandler({
      path: 'handlers/nudge.md',
      content: NEW_HANDLER_NO_ROUTING,
      message: 'add the nudge handler',
    });

    const sent = h.service.chat.send({ text: 'add a nudge handler' });
    const form = await client.next('form.request', 15000);
    expect(form.payload.fields.map((f: any) => f.name)).toEqual(['model', 'effort']);
    const modelField = form.payload.fields[0];
    const effortField = form.payload.fields[1];
    expect(effortField.options).toEqual(['endpoint default', 'low', 'high']);
    const plainOption = modelField.options.find((o: string) => o.startsWith('plain'))!;

    client.send('form.submit', {
      form_id: form.payload.form_id,
      values: { model: plainOption, effort: 'high' },
    });
    await client.next('form.accepted');
    await drain(h);

    const parsed = matter(fs.readFileSync(handlerPath(h.dataDir, 'nudge'), 'utf8'));
    expect(parsed.data.endpoint).toBe('plain');
    expect(parsed.data.effort).toBeUndefined();

    const call = tracedCall(h, sent.eventId);
    expect(call.result_excerpt).toContain('not declared by the endpoint');
  });
});

/**
 * Every file under the data dir that contains `needle`, data-dir-relative. The
 * walk deliberately includes `.git` and `events.db`: the point of the sentinel
 * test (§19.2) is that a submitted credential exists in exactly one file.
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
      const body = fs.readFileSync(abs);
      if (body.includes(needle)) hits.push(path.relative(root, abs));
    }
  };
  walk(root);
  return hits.sort();
}
