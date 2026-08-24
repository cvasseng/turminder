import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { LAYOUT_VERSION } from '../src/core/datadir.js';
import { DB_VERSION } from '../src/db/index.js';
import { bootService, postJson, TestClient, type ServiceHarness } from './service-harness.js';

let h: ServiceHarness;
afterEach(async () => {
  await h?.cleanup();
});

describe('http server (App. E)', () => {
  it('serves health without auth', async () => {
    h = await bootService({ onboarded: true });
    const res = await fetch(`${h.baseUrl}/healthz`);
    expect(res.status).toBe(200);
    // Read the constants rather than pinning numbers that move with migrations.
    expect(await res.json()).toEqual({
      status: 'ok',
      db_version: DB_VERSION,
      layout_version: LAYOUT_VERSION,
      linked: true,
    });
  });

  it('says nothing is linked when no device holds a token (§24.3)', async () => {
    // The gate reads this to choose between "scan the QR your assistant shows"
    // and the terminal — and the terminal is right only here, where there is no
    // device to ask from. The whole answer is a boolean: no count, no names,
    // which is what the exhaustive match below is here to keep true.
    h = await bootService({ onboarded: true, channels: { devices: [] } });
    const res = await fetch(`${h.baseUrl}/healthz`);
    expect(await res.json()).toEqual({
      status: 'ok',
      db_version: DB_VERSION,
      layout_version: LAYOUT_VERSION,
      linked: false,
    });
  });

  it('serves the chat UI when configured and the setup page when not', async () => {
    h = await bootService({ onboarded: true });
    const chat = await (await fetch(`${h.baseUrl}/`)).text();
    expect(chat).toContain('id="composer"');
    await h.cleanup();

    h = await bootService({ configured: false });
    const setup = await (await fetch(`${h.baseUrl}/`)).text();
    expect(setup).toContain('Turminder needs a model');
  });

  it('serves static assets and 404s the rest', async () => {
    h = await bootService({ onboarded: true });
    const css = await fetch(`${h.baseUrl}/style.css`);
    expect(css.status).toBe(200);
    expect(css.headers.get('content-type')).toContain('text/css');
    expect((await fetch(`${h.baseUrl}/nope.txt`)).status).toBe(404);
    expect((await fetch(`${h.baseUrl}/../package.json`)).status).toBe(404);
  });

  it('requires a bearer token to inject events', async () => {
    h = await bootService({ onboarded: true });
    const unauthorised = await postJson(`${h.baseUrl}/api/events`, { type: 'webhook.test' });
    expect(unauthorised.status).toBe(401);

    const ok = await postJson(
      `${h.baseUrl}/api/events`,
      { type: 'webhook.test', source: 'http', payload: { a: 1 }, idempotency_key: 'k1' },
      h.token,
    );
    expect(ok.status).toBe(200);
    expect(ok.body.status).toBe('accepted');

    const dupe = await postJson(
      `${h.baseUrl}/api/events`,
      { type: 'webhook.test', source: 'http', payload: { a: 1 }, idempotency_key: 'k1' },
      h.token,
    );
    expect(dupe.body.status).toBe('duplicate');
    expect(dupe.body.event_id).toBe(ok.body.event_id);
  });

  it('reports the openai-compatible adapter as not implemented yet', async () => {
    h = await bootService({ onboarded: true });
    const r = await postJson(`${h.baseUrl}/v1/chat/completions`, { messages: [] }, h.token);
    expect(r.status).toBe(501);
  });
});

describe('setup api (plan §3b)', () => {
  it('probes an endpoint, derives caps, commits, and turns the service on', async () => {
    h = await bootService({ configured: false });
    expect(h.service.configured).toBe(false);
    h.fake.always((req) => {
      // Answer the probe suite: json probe, tool probe, smoke.
      const body = req.body;
      if (body.response_format) return { text: '{"ok":true,"note":"hello"}' };
      if (body.tools)
        return { toolCalls: [{ name: 'probe.echo', args: { word: 'pineapple' } }] };
      return { text: 'ready' };
    });

    const probe = await postJson(`${h.baseUrl}/api/setup/probe`, { url: h.fake.baseUrl });
    expect(probe.status).toBe(200);
    expect(probe.body.reachable).toBe(true);
    expect(probe.body.caps.sort()).toEqual(['json', 'long_context', 'tools']);
    expect(probe.body.model_id).toBe('fake-model');
    expect(probe.body.context_size).toBe(32768);
    expect(probe.body.smoke).toBe('ready');

    const commit = await postJson(`${h.baseUrl}/api/setup/commit`, {
      endpoints: [
        {
          name: 'main',
          url: probe.body.url,
          classes: ['fast', 'best'],
          caps: probe.body.caps,
          context_size: probe.body.context_size,
        },
      ],
    });
    expect(commit.status).toBe(200);
    expect(commit.body.ui_token).toBe(h.token);
    expect(h.service.configured).toBe(true);
    const written = fs.readFileSync(path.join(h.dataDir, 'config', 'models.yaml'), 'utf8');
    expect(written).toContain('name: main');
    expect(h.app.home.git.head()).toBeTruthy();

    // And the chat UI is now what / serves.
    expect(await (await fetch(`${h.baseUrl}/`)).text()).toContain('id="composer"');
  });

  it('puts the API key in the secret store and a reference in models.yaml (§28.5)', async () => {
    h = await bootService({ configured: false, watchFiles: false });
    const probe = await postJson(`${h.baseUrl}/api/setup/probe`, { url: h.fake.baseUrl });
    expect(probe.body.reachable).toBe(true);

    const committed = await postJson(`${h.baseUrl}/api/setup/commit`, {
      endpoints: [
        {
          name: 'main',
          url: probe.body.url,
          classes: ['fast', 'best'],
          caps: probe.body.caps,
          api_key: 'sentinel-hosted-key',
        },
      ],
      // The user declined embeddings: search degrades, nothing breaks (§28.5).
      embedding: false,
    });
    expect(committed.status).toBe(200);

    const yaml = fs.readFileSync(path.join(h.dataDir, 'config', 'models.yaml'), 'utf8');
    expect(yaml).not.toContain('sentinel-hosted-key');
    expect(yaml).toContain('${secret:MODEL_API_KEY_MAIN}');
    expect(yaml).not.toContain('embedding:');
    expect(h.app.config.secretStore.get('MODEL_API_KEY_MAIN')).toBe('sentinel-hosted-key');
    // And the reference resolves, so the endpoint actually works.
    expect(h.app.config.models()?.endpoints[0]?.api_key).toBe('sentinel-hosted-key');
  });

  it('reports a dead endpoint honestly instead of hanging', async () => {
    h = await bootService({ configured: false });
    const probe = await postJson(`${h.baseUrl}/api/setup/probe`, { url: 'http://127.0.0.1:9' });
    expect(probe.status).toBe(200);
    expect(probe.body.reachable).toBe(false);
    expect(probe.body.error).toMatch(/unreachable/);
    expect(probe.body.notes.length).toBeGreaterThan(0);
  });

  it('records missing capabilities without refusing the endpoint', async () => {
    h = await bootService({ configured: false });
    h.fake.always((req) => {
      if (req.body.response_format) return { text: 'not json at all' };
      if (req.body.tools) return { text: 'I will not call the tool' };
      return { text: 'ready' };
    });
    const probe = await postJson(`${h.baseUrl}/api/setup/probe`, { url: h.fake.baseUrl });
    expect(probe.body.reachable).toBe(true);
    expect(probe.body.checks.completion).toBe(true);
    expect(probe.body.checks.json).toBe(false);
    expect(probe.body.checks.tools).toBe(false);
    expect(probe.body.caps).not.toContain('tools');
    expect(probe.body.notes.join(' ')).toMatch(/did not call the tool/);
  });

  it('locks the setup api down once models are configured', async () => {
    h = await bootService({ onboarded: true });
    const probe = await postJson(`${h.baseUrl}/api/setup/probe`, { url: h.fake.baseUrl });
    expect(probe.status).toBe(401);
    const authorised = await postJson(
      `${h.baseUrl}/api/setup/probe`,
      { url: 'http://127.0.0.1:9' },
      h.token,
    );
    expect(authorised.status).toBe(200);
  });
});

/**
 * The setup page's provider picker (§28.5).
 *
 * Guarded as source text, because the failure it prevents is a typo in a
 * prefilled URL — and a prefill nobody checked is worse than no prefill: it
 * looks authoritative. The probe is what actually validates an endpoint, so
 * these cases only assert the list is *well-formed*, never that a vendor's
 * address is still current.
 */
describe('the setup page offers provider prefills (§28.5)', () => {
  const root = path.resolve(import.meta.dirname, '..');
  const read = (rel: string): string => fs.readFileSync(path.join(root, rel), 'utf8');
  const html = () => read('ui/setup.html');

  /** Every `<option>` in the provider select, in document order. */
  function options(): { label: string; url: string | null; embeddings: boolean }[] {
    const select = /<select id="provider">([\s\S]*?)<\/select>/.exec(html());
    if (!select) throw new Error('ui/setup.html should carry a #provider select');
    return [...select[1]!.matchAll(/<option([^>]*)>([\s\S]*?)<\/option>/g)].map((m) => {
      const attrs = m[1]!;
      const url = /data-url="([^"]+)"/.exec(attrs);
      return {
        label: m[2]!.replace(/\s+/g, ' ').trim(),
        url: url ? url[1]! : null,
        embeddings: !/data-embeddings="no"/.test(attrs),
      };
    });
  }

  it('leads with Custom, which prefills nothing', () => {
    const first = options()[0];
    expect(first?.label).toBe('Custom');
    // No data-url is what makes it the "I will type it myself" option, and what
    // the picker falls back to when the box is edited by hand.
    expect(first?.url).toBeNull();
  });

  it('gives every other option an absolute base URL', () => {
    const rest = options().slice(1);
    expect(rest.length).toBeGreaterThan(2);
    for (const option of rest) {
      expect(option.url, `${option.label} needs a data-url`).toBeTruthy();
      // `normaliseEndpointUrl` adds a scheme and /v1 when absent, but a prefill
      // the user reads should already be the real address.
      expect(option.url, `${option.label}: ${option.url}`).toMatch(/^https?:\/\/[^\s"]+$/);
      expect(option.url, `${option.label} should not carry a trailing slash`).not.toMatch(
        /\/$/,
      );
    }
  });

  it('names the providers that have no embeddings endpoint', () => {
    const byLabel = new Map(options().map((o) => [o.label, o]));
    // Anthropic is the one people reach for first, and it has no embeddings
    // API — leaving the box checked there commits a setup that cannot embed.
    expect(byLabel.get('Anthropic')?.embeddings).toBe(false);
    expect(byLabel.get('OpenAI')?.embeddings).toBe(true);
  });

  it('is wired to the url box and to the embeddings checkbox', () => {
    const js = read('ui/setup.js');
    expect(js).toContain("$('provider').onchange");
    // Two-way: typing over the URL must drop the picker back to Custom, or the
    // page claims a provider the address does not belong to.
    expect(js).toContain("$('url').addEventListener('input'");
    expect(js).toContain('applyEmbeddingsSupport');
    expect(html()).toContain('id="embeddings-note"');
  });
});

/**
 * And the picker actually works — evaluated against the real markup.
 *
 * `ui/` has no build step, so the file boundary is the test seam (the argument
 * `ui/preview.js` settled). The option list is parsed out of `setup.html` and
 * fed to a DOM stub, so a prefill removed from the page fails here rather than
 * silently doing nothing in a browser nobody automated.
 */
describe('the provider picker fills the url box (§28.5)', () => {
  const root = path.resolve(import.meta.dirname, '..');
  const read = (rel: string): string => fs.readFileSync(path.join(root, rel), 'utf8');

  interface Stub {
    select: {
      value: string;
      options: unknown[];
      selectedOptions: unknown[];
      onchange?: () => void;
    };
    url: { value: string; listeners: Record<string, () => void>; focus: () => void };
    embeddings: { checked: boolean; disabled: boolean };
    note: { textContent: string };
    pick: (label: string) => void;
    type: (value: string) => void;
  }

  /** A DOM just large enough for the picker's own code, built from the page. */
  function mount(): Stub {
    const block = /<select id="provider">([\s\S]*?)<\/select>/.exec(read('ui/setup.html'))![1]!;
    const options = [...block.matchAll(/<option([^>]*)>([\s\S]*?)<\/option>/g)].map((m) => {
      const attrs = m[1]!;
      const url = /data-url="([^"]+)"/.exec(attrs);
      const label = m[2]!.replace(/\s+/g, ' ').trim();
      const dataset: Record<string, string> = {};
      if (url) dataset.url = url[1]!;
      if (/data-embeddings="no"/.test(attrs)) dataset.embeddings = 'no';
      return {
        value: /value="([^"]*)"/.exec(attrs)?.[1] ?? label,
        textContent: label,
        dataset,
      };
    });

    const select = { value: '', options, selectedOptions: [] as unknown[] } as Stub['select'];
    const setSelected = () => {
      const hit = options.find((o) => o.value === select.value);
      select.selectedOptions = hit ? [hit] : [];
    };
    const url = {
      value: 'http://localhost:8080',
      listeners: {} as Record<string, () => void>,
      focus: () => {},
      addEventListener: (name: string, fn: () => void) => {
        url.listeners[name] = fn;
      },
    };
    const embeddings = { checked: true, disabled: false };
    const note = { textContent: '' };
    const byId: Record<string, unknown> = {
      provider: select,
      url,
      embeddings,
      'embeddings-note': note,
    };
    // Anything else the page wires up (the Probe button, the result panel) gets
    // an inert stand-in: this test is about the picker, and a missing element
    // would otherwise throw before the picker's own code ran.
    const document = {
      getElementById: (id: string) => {
        byId[id] ??= {
          value: '',
          textContent: '',
          innerHTML: '',
          checked: false,
          disabled: false,
          focus: () => {},
          addEventListener: () => {},
        };
        return byId[id];
      },
    };

    // Assigning `value` on a real <select> updates selectedOptions; the stub
    // has to do the same or every assertion below is meaningless.
    const proxied = new Proxy(select, {
      set(target, prop, value) {
        Reflect.set(target, prop, value);
        if (prop === 'value') setSelected();
        return true;
      },
    });
    byId.provider = proxied;

    new Function('document', 'TOKEN_KEY', 'fetch', 'location', read('ui/setup.js'))(
      document,
      'turminder.token',
      () => Promise.reject(new Error('no network in this test')),
      { href: '' },
    );

    return {
      select: proxied,
      url: url as unknown as Stub['url'],
      embeddings,
      note,
      pick: (label: string) => {
        const hit = options.find((o) => o.textContent === label);
        if (!hit) throw new Error(`no option labelled ${label}`);
        proxied.value = hit.value;
        proxied.onchange!();
      },
      type: (value: string) => {
        url.value = value;
        url.listeners.input!();
      },
    };
  }

  it('starts in agreement with the prefilled url', () => {
    const dom = mount();
    // The box ships pointing at a local llama.cpp; the picker must say so
    // rather than reading "Custom" above an address it recognises.
    expect(dom.select.selectedOptions[0]).toMatchObject({ textContent: expect.any(String) });
    expect((dom.select.selectedOptions[0] as { textContent: string }).textContent).toContain(
      'llama.cpp',
    );
  });

  it('prefills the url when a provider is chosen', () => {
    const dom = mount();
    dom.pick('OpenAI');
    expect(dom.url.value).toBe('https://api.openai.com/v1');
    dom.pick('Anthropic');
    expect(dom.url.value).toBe('https://api.anthropic.com/v1');
  });

  it('turns embeddings off, with a reason, for a provider that has none', () => {
    const dom = mount();
    dom.pick('Anthropic');
    expect(dom.embeddings.checked).toBe(false);
    expect(dom.embeddings.disabled).toBe(true);
    expect(dom.note.textContent).toContain('no embeddings endpoint');
    // And back on for one that does, rather than staying stuck off.
    dom.pick('OpenAI');
    expect(dom.embeddings.disabled).toBe(false);
    expect(dom.note.textContent).toBe('');
  });

  it('drops back to Custom when the url is typed over', () => {
    const dom = mount();
    dom.pick('OpenAI');
    dom.type('http://192.168.0.9:9000/v1');
    // Saying "OpenAI" above a hand-typed address would be a lie. Custom is
    // `value=""`, so falling back to it *is* a selection — of the one option
    // that prefills nothing.
    expect(dom.select.value).toBe('');
    expect((dom.select.selectedOptions[0] as { textContent: string }).textContent).toBe(
      'Custom',
    );
    expect(
      (dom.select.selectedOptions[0] as { dataset: { url?: string } }).dataset.url,
    ).toBeUndefined();
    // Typing a known address back picks it up again.
    dom.type('https://api.groq.com/openai/v1');
    expect((dom.select.selectedOptions[0] as { textContent: string }).textContent).toBe('Groq');
  });
});

describe('websocket protocol (App. D)', () => {
  it('rejects an upgrade with a bad token', async () => {
    h = await bootService({ onboarded: true });
    await expect(TestClient.connect(h.baseUrl, 'not-a-token')).rejects.toThrow(/401/);
  });

  it('requires hello as the first frame', async () => {
    h = await bootService({ onboarded: true });
    const client = await TestClient.connect(h.baseUrl, h.token);
    client.send('chat.send', { text: 'too early' });
    const err = await client.next('error');
    expect(err.payload.code).toBe('not_ready');
    await new Promise((r) => setTimeout(r, 100));
    expect(client.closeCode).toBeGreaterThan(0);
  });

  it('greets with instance name and configuration state', async () => {
    h = await bootService({ onboarded: true });
    const client = await TestClient.connect(h.baseUrl, h.token);
    const welcome = await client.hello();
    expect(welcome.payload.instance_name).toBe('Sleeper Service');
    // Who it is talking to, for the UI's own chrome (§9) — the harness writes
    // this name into identity.md.
    expect(welcome.payload.user_name).toBe('Alex');
    expect(welcome.payload.configured).toBe(true);
    expect(welcome.payload.onboarding).toBe(false);
    expect(welcome.payload.replay_count).toBe(0);
    client.close();
  });

  it('names neither party before onboarding has written an identity', async () => {
    h = await bootService({ onboarded: false });
    const client = await TestClient.connect(h.baseUrl, h.token);
    const welcome = await client.hello();
    // Both null rather than absent or invented: the greeting drops the name
    // and stays a sentence (§9), and the speaker label falls back on its own.
    expect(welcome.payload.instance_name).toBeNull();
    expect(welcome.payload.user_name).toBeNull();
    expect(welcome.payload.onboarding).toBe(true);
    client.close();
  });

  it('streams a chat turn end to end', async () => {
    h = await bootService({ onboarded: true });
    h.fake.always({ text: 'The capital is Oslo.' });
    const client = await TestClient.connect(h.baseUrl, h.token);
    await client.hello();
    client.send('chat.send', { text: 'capital of Norway?' });

    const accepted = await client.next('chat.accepted');
    expect(accepted.payload.conversation_id).toBeTruthy();
    const done = await client.next('chat.done');
    expect(done.payload.turn_seq).toBe(2);
    expect(client.deltaText()).toBe('The capital is Oslo.');
    expect(client.of('chat.delta').length).toBeGreaterThan(1);

    client.send('chat.history', { conversation_id: accepted.payload.conversation_id });
    const history = await client.next('chat.history.result');
    expect(history.payload.turns.map((t: any) => t.role)).toEqual(['user', 'assistant']);
    expect(history.payload.more).toBe(false);
    client.close();
  });

  /**
   * The whole path, because the bug lived between two layers that were each
   * correct: the guard rejected the turn, and the socket had already sent it.
   * Reported from live use as "the chat often outputs internal [[...]] tags".
   */
  it('retracts a turn the guard rejected, so no marker reaches a client (§20.8)', async () => {
    h = await bootService({ onboarded: true });
    h.fake.script(
      { text: 'Added it.\n[[used tools: files.append]]' },
      { text: 'Added it, properly this time.' },
    );
    const client = await TestClient.connect(h.baseUrl, h.token);
    await client.hello();
    client.send('chat.send', { text: 'add mobile chat to the todo' });

    await client.next('chat.done');
    // The frame exists and fired exactly once, for the one rejected turn.
    expect(client.of('chat.retract')).toHaveLength(1);
    // Everything the socket carried, in order: the marker was sent — it had to
    // be, deltas leave before the guard sees them — and then taken back.
    const retractAt = client.frames.findIndex((f) => f.type === 'chat.retract');
    const before = client.frames
      .slice(0, retractAt)
      .filter((f) => f.type === 'chat.delta')
      .map((f) => f.payload.text)
      .join('');
    const after = client.frames
      .slice(retractAt)
      .filter((f) => f.type === 'chat.delta')
      .map((f) => f.payload.text)
      .join('');
    expect(before).toContain('[[used tools:');
    // What survives the retraction is clean, and is the whole answer rather
    // than a second one appended to the first.
    expect(after).toBe('Added it, properly this time.');
    expect(after).not.toContain('[[used tools:');

    // And the stored turn agrees with what the client is left showing.
    const conversationId = client.of('chat.accepted')[0]!.payload.conversation_id as string;
    client.send('chat.history', { conversation_id: conversationId });
    const settled = await client.next('chat.history.result');
    const assistant = settled.payload.turns.find((t: any) => t.role === 'assistant');
    expect(assistant.text).toBe('Added it, properly this time.');
    client.close();
  });

  it('lists and closes conversations', async () => {
    h = await bootService({ onboarded: true });
    h.fake.always({ text: 'ok' });
    const client = await TestClient.connect(h.baseUrl, h.token);
    await client.hello();
    client.send('chat.send', { text: 'hello' });
    const accepted = await client.next('chat.accepted');
    await client.next('chat.done');

    client.send('conversation.list', {});
    const list = await client.next('conversation.list.result');
    expect(list.payload.conversations[0].id).toBe(accepted.payload.conversation_id);

    client.send('conversation.close', { conversation_id: accepted.payload.conversation_id });
    const closed = await client.next('conversation.closed');
    expect(closed.payload.conversation_id).toBe(accepted.payload.conversation_id);
    expect(
      h.service.repos.events
        .recent({ limit: 10 })
        .some((e) => e.type === 'system.conversation_closed'),
    ).toBe(true);
    client.close();
  });

  it('labels an onboarding conversation for the ui', async () => {
    h = await bootService({ configured: true, onboarded: false });
    h.fake.always({ text: 'I need a name.' });
    const client = await TestClient.connect(h.baseUrl, h.token);
    const welcome = await client.hello();
    expect(welcome.payload.onboarding).toBe(true);
    client.send('chat.send', { text: 'hello' });
    const mode = await client.next('conversation.mode');
    expect(mode.payload.mode).toBe('onboarding');
    client.close();
  });

  it('accepts events from a device, stamping the source itself', async () => {
    h = await bootService({ onboarded: true });
    const client = await TestClient.connect(h.baseUrl, h.token);
    await client.hello(['notify.actions']);
    client.send('event', {
      type: 'desktop.session_locked',
      payload: {},
      source: 'pretend-to-be-imap',
    });
    const accepted = await client.next('event.accepted');
    const event = h.service.repos.events.get(accepted.payload.event_id)!;
    expect(event.type).toBe('desktop.session_locked');
    expect(event.source).toBe('ui');
    client.close();
  });

  it('reports unknown frame types and bad frames without dropping the socket', async () => {
    h = await bootService({ onboarded: true });
    const client = await TestClient.connect(h.baseUrl, h.token);
    await client.hello();
    client.send('nonsense.frame', {});
    expect((await client.next('error')).payload.code).toBe('unknown_type');
    client.send('chat.send', {});
    expect((await client.next('error')).payload.code).toBe('bad_frame');
    client.send('conversation.list', {});
    await client.next('conversation.list.result');
    client.close();
  });

  it('refuses chat while no model is configured', async () => {
    h = await bootService({ configured: false });
    const client = await TestClient.connect(h.baseUrl, h.token);
    const welcome = await client.hello();
    expect(welcome.payload.configured).toBe(false);
    client.send('chat.send', { text: 'hello?' });
    expect((await client.next('error')).payload.code).toBe('not_ready');
    client.close();
  });

  it('only sends chat frames to channels that asked for chat', async () => {
    h = await bootService({ onboarded: true });
    h.fake.always({ text: 'hello you' });
    const chatty = await TestClient.connect(h.baseUrl, h.token);
    const quiet = await TestClient.connect(h.baseUrl, h.token);
    await chatty.hello(['chat']);
    await quiet.hello(['notify.actions']);
    chatty.send('chat.send', { text: 'hi' });
    await chatty.next('chat.done');
    expect(quiet.of('chat.delta')).toHaveLength(0);
    chatty.close();
    quiet.close();
  });

  it('survives a socket that dies mid-stream, and history has the answer', async () => {
    h = await bootService({ onboarded: true });
    h.fake.always({ text: 'a long-ish answer that keeps streaming', delayMs: 40 });
    const client = await TestClient.connect(h.baseUrl, h.token);
    await client.hello();
    client.send('chat.send', { text: 'tell me something' });
    const accepted = await client.next('chat.accepted');
    (client as unknown as { socket: WebSocket }).socket.terminate();

    await h.service.queue.drain();
    const reconnected = await TestClient.connect(h.baseUrl, h.token);
    await reconnected.hello();
    reconnected.send('chat.history', { conversation_id: accepted.payload.conversation_id });
    const history = await reconnected.next('chat.history.result');
    expect(history.payload.turns.map((t: any) => t.role)).toEqual(['user', 'assistant']);
    expect(history.payload.turns[1].text).toContain('long-ish answer');
    reconnected.close();
  });
});

describe('protocol version skew (App. D)', () => {
  it('advertises the frames it handles in welcome', async () => {
    h = await bootService({ onboarded: true });
    const client = await TestClient.connect(h.baseUrl, h.token);
    const welcome = await client.hello();
    const frames = welcome.payload.frames as string[];
    // The page checks this list before relying on a frame.
    for (const expected of [
      'chat.send',
      'chat.history',
      'conversation.list',
      'conversation.close',
      'conversation.delete',
    ]) {
      expect(frames).toContain(expected);
    }
    client.close();
  });

  it('blames stale code, not the client, for an unknown frame', async () => {
    h = await bootService({ onboarded: true });
    const client = await TestClient.connect(h.baseUrl, h.token);
    await client.hello();
    client.send('conversation.teleport', {});
    const error = await client.next('error');
    expect(error.payload.code).toBe('unknown_type');
    expect(error.payload.message).toMatch(/restart the service/);
    client.close();
  });
});
