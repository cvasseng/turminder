import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import YAML from 'yaml';
import { bootstrap, type App } from '../src/app.js';
import { tokenSha256 } from '../src/core/tokens.js';
import { tmpDir, write } from './helpers.js';
import { bootService, postJson, TestClient, type ServiceHarness } from './service-harness.js';

/**
 * Gateway access tokens (§24). The property under test everywhere here is the
 * same one: **the value is never at rest**. A row holds `token_sha256`; the
 * value exists in the moment of creation and nowhere else, so every assertion
 * about "still works" has to go through `authenticate`, and every assertion
 * about the disk is that the value is absent from it.
 */
function bootTmp(seedChannels?: unknown): { app: App; dataDir: string; cleanup: () => void } {
  const t = tmpDir('turminder-tokens-');
  const dataDir = path.join(t.dir, 'home');
  if (seedChannels !== undefined) {
    write(path.join(dataDir, 'config', 'channels.yaml'), YAML.stringify(seedChannels));
  }
  const app = bootstrap({ dataDir });
  return {
    app,
    dataDir,
    cleanup: () => {
      app.close();
      t.cleanup();
    },
  };
}

function channelsText(dataDir: string): string {
  return fs.readFileSync(path.join(dataDir, 'config', 'channels.yaml'), 'utf8');
}

describe('device token store (§24)', () => {
  let boot: ReturnType<typeof bootTmp> | null = null;
  afterEach(() => {
    boot?.cleanup();
    boot = null;
  });

  it('scaffolds the ui device as a hash and hands the value over once', () => {
    boot = bootTmp();
    const { app, dataDir } = boot;

    expect(app.newUiToken).toMatch(/^[0-9a-f]{64}$/);
    const text = channelsText(dataDir);
    expect(text).not.toContain(app.newUiToken!);
    expect(text).toContain(tokenSha256(app.newUiToken!));
    expect(app.tokens.authenticate(app.newUiToken!)).toBe('ui');
  });

  it('creates a token whose value never reaches the config directory', () => {
    boot = bootTmp();
    const { app, dataDir } = boot;

    const created = app.tokens.create('tablet', { label: 'Kitchen tablet', runId: '01RUN' });
    if ('error' in created) throw new Error('create refused a fresh name');

    expect(app.tokens.authenticate(created.token)).toBe('tablet');
    // The sentinel in miniature: the value is in no file under config/.
    const dir = path.join(dataDir, 'config');
    for (const file of fs.readdirSync(dir)) {
      expect(fs.readFileSync(path.join(dir, file), 'utf8')).not.toContain(created.token);
    }
    const row = YAML.parse(channelsText(dataDir)).devices.find(
      (d: any) => d.device === 'tablet',
    );
    expect(row.token_sha256).toBe(tokenSha256(created.token));
    expect(row.token).toBeUndefined();
    expect(row.label).toBe('Kitchen tablet');
    expect(row.created_by_run).toBe('01RUN');
    expect(row.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('lists metadata and never anything a token could be recovered from', () => {
    boot = bootTmp();
    const { app } = boot;
    app.tokens.create('tablet', { label: 'Kitchen tablet' });

    const listed = app.tokens.list();
    expect(listed.map((d) => d.device).sort()).toEqual(['tablet', 'ui']);
    for (const entry of listed) {
      expect(Object.keys(entry).sort()).toEqual(
        entry.label ? ['created_at', 'device', 'label'] : ['created_at', 'device'],
      );
    }
  });

  it('refuses a duplicate device name unless the caller rotates deliberately', () => {
    boot = bootTmp();
    const { app } = boot;
    const first = app.tokens.create('tablet');
    if ('error' in first) throw new Error('create refused a fresh name');

    const clash = app.tokens.create('tablet');
    expect(clash).toEqual({
      error: 'device_exists',
      message: expect.stringContaining('tablet'),
    });
    // Refused means untouched: the first value still authenticates.
    expect(app.tokens.authenticate(first.token)).toBe('tablet');

    const rotated = app.tokens.create('tablet', { rotate: true });
    if ('error' in rotated) throw new Error('rotate refused');
    expect(app.tokens.authenticate(rotated.token)).toBe('tablet');
    expect(app.tokens.authenticate(first.token)).toBeNull();
    expect(app.tokens.list().filter((d) => d.device === 'tablet')).toHaveLength(1);
  });

  it('revokes a device, and says so when there was nothing to revoke', () => {
    boot = bootTmp();
    const { app } = boot;
    const created = app.tokens.create('tablet');
    if ('error' in created) throw new Error('create refused a fresh name');

    expect(app.tokens.revoke('tablet')).toBe(true);
    expect(app.tokens.authenticate(created.token)).toBeNull();
    expect(app.tokens.revoke('tablet')).toBe(false);
  });

  it('authenticates nothing it should not', () => {
    boot = bootTmp();
    const { app } = boot;
    const ui = app.newUiToken!;

    expect(app.tokens.authenticate('')).toBeNull();
    expect(app.tokens.authenticate('not-a-token')).toBeNull();
    // The stored form is a hash, so presenting the hash is not presenting the
    // token — the obvious mistake a "compare what you found in the file" bug
    // would make.
    expect(app.tokens.authenticate(tokenSha256(ui))).toBeNull();
    expect(app.tokens.authenticate(`${ui}x`)).toBeNull();
    expect(app.tokens.authenticate(ui.slice(0, -1))).toBeNull();
  });

  it('self-heals a pre-§24 plaintext row on boot, and the old value keeps working', () => {
    const legacy = 'a'.repeat(64);
    boot = bootTmp({
      devices: [
        { device: 'ui', token: legacy },
        { device: 'phone', token: 'b'.repeat(64), label: 'Phone' },
      ],
    });
    const { app, dataDir } = boot;

    const text = channelsText(dataDir);
    expect(text).not.toContain(legacy);
    expect(text).not.toContain('token:');
    expect(app.tokens.authenticate(legacy)).toBe('ui');
    expect(app.tokens.authenticate('b'.repeat(64))).toBe('phone');
    // Metadata that was already there survives the rewrite.
    expect(app.tokens.list().find((d) => d.device === 'phone')?.label).toBe('Phone');
    // Committed, like every other mutation of the data repo.
    const log = spawnSync('git', ['log', '--oneline'], {
      cwd: dataDir,
      encoding: 'utf8',
    }).stdout;
    expect(log).toContain('hash device tokens at rest');
    // Idempotent: a second boot has nothing left to heal.
    const before = channelsText(dataDir);
    const second = bootstrap({ dataDir });
    expect(channelsText(dataDir)).toBe(before);
    second.close();
  });
});

describe('gateway auth against hashed tokens (§24, App. D/E)', () => {
  let h: ServiceHarness | null = null;
  afterEach(async () => {
    await h?.cleanup();
    h = null;
  });

  it('accepts a healed legacy token on the WS upgrade and the HTTP API', async () => {
    const legacy = 'c'.repeat(64);
    h = await bootService({
      onboarded: true,
      channels: { devices: [{ device: 'ui', token: legacy }] },
    });

    const client = await TestClient.connect(h.baseUrl, legacy);
    const welcome = await client.hello(['chat']);
    expect(welcome.type).toBe('welcome');
    client.close();

    const ok = await postJson(
      `${h.baseUrl}/api/events`,
      { type: 'test.ping', payload: {} },
      legacy,
    );
    expect(ok.status).toBe(200);
  });

  it('closes a live session the moment its device is revoked (§24.1)', async () => {
    h = await bootService({ onboarded: true });
    const client = await TestClient.connect(h.baseUrl, h.token);
    await client.hello(['chat']);
    expect(h.http.ws.connectionCount).toBe(1);

    // No reconnect, no heartbeat wait: the store's change notification is what
    // the gateway acts on.
    expect(h.app.tokens.revoke('ui')).toBe(true);
    const denied = await client.next('error');
    expect(denied.payload.code).toBe('auth_failed');
    await client.closed();
    expect(h.http.ws.connectionCount).toBe(0);
  });

  it('closes a live session whose token was rotated out from under it', async () => {
    h = await bootService({ onboarded: true });
    const client = await TestClient.connect(h.baseUrl, h.token);
    await client.hello(['chat']);

    const rotated = h.app.tokens.create('ui', { rotate: true });
    if ('error' in rotated) throw new Error('rotate refused');
    await client.closed();
    expect(h.http.ws.connectionCount).toBe(0);
    // The new value is the one that works now.
    const next = await TestClient.connect(h.baseUrl, rotated.token);
    await next.hello(['chat']);
    next.close();
  });

  it('catches an out-of-process revoke on the next heartbeat', async () => {
    // What `turminder token revoke` in another terminal looks like from here:
    // the file changes and nothing tells the service. One heartbeat is the
    // interval it takes to bite (§24.1).
    h = await bootService({ onboarded: true, dataDefaults: { ws_heartbeat_s: 1 } });
    const client = await TestClient.connect(h.baseUrl, h.token);
    await client.hello(['chat']);

    fs.writeFileSync(
      path.join(h.dataDir, 'config', 'channels.yaml'),
      YAML.stringify({ devices: [] }),
      'utf8',
    );
    expect(await client.closed(5000)).toBe(4401);
    expect(h.http.ws.connectionCount).toBe(0);
  });

  it('serves the device list over the protocol, values absent by construction', async () => {
    h = await bootService({ onboarded: true });
    const created = h.app.tokens.create('tablet', { label: 'Kitchen tablet' });
    if ('error' in created) throw new Error('create refused a fresh name');

    const client = await TestClient.connect(h.baseUrl, h.token);
    await client.hello(['chat']);
    client.send('token.list', {});
    const listed = await client.next('token.list.result');

    const tablet = listed.payload.devices.find((d: any) => d.device === 'tablet');
    expect(tablet).toEqual({
      device: 'tablet',
      label: 'Kitchen tablet',
      created_at: expect.any(String),
      last_seen: 0,
    });
    expect(JSON.stringify(listed)).not.toContain(created.token);
    expect(JSON.stringify(listed)).not.toContain(tokenSha256(created.token));
    client.close();
  });

  it('revokes another device over the protocol and hangs its socket up', async () => {
    h = await bootService({ onboarded: true });
    const created = h.app.tokens.create('tablet');
    if ('error' in created) throw new Error('create refused a fresh name');

    const ui = await TestClient.connect(h.baseUrl, h.token);
    await ui.hello(['chat']);
    const tablet = await TestClient.connect(h.baseUrl, created.token);
    await tablet.hello(['chat']);

    ui.send('token.revoke', { device: 'tablet' });
    expect((await ui.next('token.revoked')).payload.device).toBe('tablet');
    expect(await tablet.closed()).toBe(4401);
    // The revoking device is untouched.
    expect(h.http.ws.connectionCount).toBe(1);
    ui.close();
  });

  it('answers a bad token.revoke honestly', async () => {
    h = await bootService({ onboarded: true });
    const client = await TestClient.connect(h.baseUrl, h.token);
    await client.hello(['chat']);

    client.send('token.revoke', {});
    expect((await client.next('error')).payload.code).toBe('bad_frame');
    client.send('token.revoke', { device: 'nothing-here' });
    expect((await client.next('error')).payload.code).toBe('not_found');
    client.close();
  });

  it('rejects a revoked token at the door', async () => {
    h = await bootService({ onboarded: true });
    const token = h.token;
    expect(h.app.tokens.revoke('ui')).toBe(true);

    const denied = await postJson(
      `${h.baseUrl}/api/events`,
      { type: 'test.ping', payload: {} },
      token,
    );
    expect(denied.status).toBe(401);
    await expect(TestClient.connect(h.baseUrl, token)).rejects.toThrow();
  });
});

/**
 * Create-blind (§24.2) and the sentinel that keeps it honest. The property is
 * structural rather than behavioural: after the assistant mints a token, the
 * value must exist in exactly one place — the frame the user saw — and in no
 * request body, trace row, persisted turn, or file on disk.
 */
describe('setup.token_create — create-blind (§24.2)', () => {
  let h: ServiceHarness | null = null;
  afterEach(async () => {
    await h?.cleanup();
    h = null;
  });

  const drain = (harness: ServiceHarness) => harness.service.queue.drain();

  /** Script the model to mint one token, then answer. */
  function scriptMint(harness: ServiceHarness, args: Record<string, unknown>): void {
    let asked = false;
    harness.fake.always((req: any) => {
      if (req.body.tools && !asked) {
        asked = true;
        return { toolCalls: [{ name: 'setup.token_create', args }] };
      }
      return { text: 'Scan the code on your phone.' };
    });
  }

  it('reveals the value to the user and never to the model', async () => {
    h = await bootService({ onboarded: true });
    const client = await TestClient.connect(h.baseUrl, h.token);
    await client.hello(['chat']);
    scriptMint(h, { device: 'phone', label: 'My phone' });

    const sent = h.service.chat.send({ text: 'connect my phone' });
    const reveal = await client.next('token.reveal', 15000);
    await drain(h);

    const value = reveal.payload.token as string;
    expect(value).toMatch(/^[0-9a-f]{64}$/);
    expect(reveal.payload.device).toBe('phone');
    expect(reveal.payload.label).toBe('My phone');
    expect(reveal.payload.connect_url).toContain(`#connect=${value}&device=phone`);
    expect(reveal.payload.qr_svg).toContain('<svg');
    expect(typeof reveal.payload.base_url_guessed).toBe('boolean');
    // It is a real token, not a decoration.
    expect(h.app.tokens.authenticate(value)).toBe('phone');

    // What the model got back: that it happened, and nothing it could repeat.
    const call = h.service.repos.trace
      .forEvent(sent.eventId)
      .find((t) => t.kind === 'tool_call')!.data as any;
    expect(call.tool).toBe('setup.token_create');
    expect(JSON.parse(call.result_excerpt)).toEqual({
      device: 'phone',
      label: 'My phone',
      created: true,
      revealed_to_user: true,
    });

    // The sentinel (§24.2), permanent CI: every LLM request body, every trace
    // row, every persisted turn, and every file in the config directory.
    for (const req of h.fake.requests) {
      expect(JSON.stringify(req.body)).not.toContain(value);
    }
    const traced = h.app.db.prepare(`SELECT data FROM trace`).all() as { data: string }[];
    for (const row of traced) expect(row.data).not.toContain(value);
    const turns = h.app.db.prepare(`SELECT content FROM turns`).all() as { content: string }[];
    for (const row of turns) expect(row.content).not.toContain(value);
    const configDir = path.join(h.dataDir, 'config');
    for (const file of fs.readdirSync(configDir)) {
      expect(fs.readFileSync(path.join(configDir, file), 'utf8')).not.toContain(value);
    }
    // Only the hash is on disk, and it authenticates.
    expect(channelsText(h.dataDir)).toContain(tokenSha256(value));
    client.close();
  });

  it('writes no row when there is nobody to reveal to', async () => {
    h = await bootService({ onboarded: true });
    scriptMint(h, { device: 'phone' });

    const sent = h.service.chat.send({ text: 'connect my phone' });
    await drain(h);

    const call = h.service.repos.trace
      .forEvent(sent.eventId)
      .find((t) => t.kind === 'tool_call')!.data as any;
    expect(JSON.parse(call.result_excerpt).error).toBe('no_reveal_target');
    // The refusal is the whole point: a token nobody saw is a liability.
    expect(h.app.tokens.has('phone')).toBe(false);
  });

  it('refuses a name that is already taken, and leaves it alone', async () => {
    h = await bootService({ onboarded: true });
    const client = await TestClient.connect(h.baseUrl, h.token);
    await client.hello(['chat']);
    const first = h.app.tokens.create('phone');
    if ('error' in first) throw new Error('create refused a fresh name');
    scriptMint(h, { device: 'phone' });

    const sent = h.service.chat.send({ text: 'connect my phone' });
    await drain(h);

    const call = h.service.repos.trace
      .forEvent(sent.eventId)
      .find((t) => t.kind === 'tool_call')!.data as any;
    expect(JSON.parse(call.result_excerpt).error).toBe('device_exists');
    expect(h.app.tokens.authenticate(first.token)).toBe('phone');
    client.close();
  });

  it('is reachable from an onboarding run, whose grant is otherwise two config tools', async () => {
    // F.7 gives onboarding `setup.token_create` for the "want your phone
    // connected?" step (§24.3). The prompt asks for it; this proves the run
    // can actually make the call rather than being refused by its grant.
    h = await bootService({ onboarded: false });
    const client = await TestClient.connect(h.baseUrl, h.token);
    await client.hello(['chat']);
    scriptMint(h, { device: 'phone' });

    h.service.chat.send({ text: 'yes, connect my phone' });
    const reveal = await client.next('token.reveal', 15000);
    await drain(h);

    expect(h.app.tokens.authenticate(reveal.payload.token as string)).toBe('phone');
    client.close();
  });

  it('mints from the UI through token.create, same machinery', async () => {
    h = await bootService({ onboarded: true });
    const client = await TestClient.connect(h.baseUrl, h.token);
    await client.hello(['chat']);

    client.send('token.create', { device: 'tablet', label: 'Kitchen' });
    const reveal = await client.next('token.reveal');
    const value = reveal.payload.token as string;
    expect(h.app.tokens.authenticate(value)).toBe('tablet');
    expect(reveal.payload.qr_svg).toContain('<svg');

    // The clash and the malformed name both come back as protocol errors.
    client.send('token.create', { device: 'tablet' });
    expect((await client.next('error')).payload.code).toBe('bad_frame');
    client.send('token.create', { device: '../etc/passwd' });
    expect((await client.next('error')).payload.code).toBe('bad_frame');
    client.close();
  });
});

/**
 * The connect hand-off reaches every page, not just the chat UI (§24.3, §28.2).
 *
 * `#connect=<token>` is how a token gets into a browser without anyone
 * retyping it: a scanned QR, or the desktop shell handing the window what it
 * already holds. The logic used to live in `app.js` alone — so an unconfigured
 * service, which serves `setup.html` at `/`, ignored the fragment and then
 * asked for a token by hand once setup finished. That is the whole first run
 * of a bundled desktop install, and it looked like the app demanding a
 * credential it had just been given.
 *
 * Guarded as source text because that is the side a vitest suite can reach,
 * and because the regression is a deleted script tag.
 */
describe('the connect fragment is consumed by every page served at / (§24.3)', () => {
  const root = path.resolve(import.meta.dirname, '..');
  const read = (rel: string): string => fs.readFileSync(path.join(root, rel), 'utf8');

  it('is loaded by every page the / route can serve', () => {
    // The route's own list, so a third page cannot be added without this
    // failing rather than silently skipping the hand-off.
    const route = read('src/net/http.ts');
    const pages = [...route.matchAll(/this\.service\.configured \? '(.+?)' : '(.+?)'/g)]
      .flatMap((m) => [m[1], m[2]])
      .filter((name): name is string => Boolean(name?.endsWith('.html')));
    expect(pages.sort(), 'the / route should choose between two html pages').toEqual([
      'index.html',
      'setup.html',
    ]);
    for (const page of pages) {
      expect(read(`ui/${page}`), `${page} must load /connect.js`).toContain(
        '<script src="/connect.js"></script>',
      );
    }
  });

  it('lives in exactly one place, and strips the token from the address bar', () => {
    const connect = read('ui/connect.js');
    expect(connect).toContain('localStorage.setItem(TOKEN_KEY, scanned)');
    // A token left in the URL is a token in the history and in screenshots.
    expect(connect).toContain('history.replaceState');
    // No second copy: two implementations of a credential path is one too many.
    for (const file of ['ui/app.js', 'ui/setup.js']) {
      expect(read(file), `${file} must not re-implement the hand-off`).not.toContain(
        'connect=',
      );
    }
    // And one definition of the storage key, shared by the pages that use it.
    expect(connect).toContain("const TOKEN_KEY = 'turminder.token'");
    expect(read('ui/app.js')).not.toContain("TOKEN_KEY = 'turminder.token'");
  });
});

/**
 * And the hand-off actually works — evaluated, not just read.
 *
 * `ui/` has no build step and no module system, so the file boundary is the
 * test seam (the same argument `ui/preview.js` settled). Evaluating
 * `connect.js` against stub globals is the only way to assert the behaviour
 * that a bundled first run depends on, short of driving a browser App. J has
 * no room for.
 */
describe('connect.js consumes the fragment (§24.3)', () => {
  const source = fs.readFileSync(
    path.join(path.resolve(import.meta.dirname, '..'), 'ui/connect.js'),
    'utf8',
  );

  function run(hash: string): { stored: Record<string, string>; url: string | null } {
    const stored: Record<string, string> = {};
    let url: string | null = null;
    const scope = {
      location: { hash, pathname: '/', search: '' },
      history: {
        replaceState: (_s: unknown, _t: unknown, next: string) => {
          url = next;
        },
      },
      localStorage: {
        setItem: (k: string, v: string) => {
          stored[k] = v;
        },
      },
      URLSearchParams,
    };
    new Function(...Object.keys(scope), source)(...Object.values(scope));
    return { stored, url };
  }

  it('stores the token and strips it from the address bar', () => {
    const { stored, url } = run('#connect=abc123def&device=app');
    expect(stored['turminder.token']).toBe('abc123def');
    // Stripped, so the token is not in the history or in a screenshot.
    expect(url).toBe('/');
  });

  it('leaves an ordinary page alone', () => {
    const { stored, url } = run('#some-anchor');
    expect(stored).toEqual({});
    expect(url).toBeNull();
  });

  it('does not store an empty token, but still strips the fragment', () => {
    const { stored, url } = run('#connect=&device=app');
    expect(stored).toEqual({});
    expect(url).toBe('/');
  });

  it('percent-decodes the way URLSearchParams does', () => {
    // `token create` can emit any base64/hex; a `+` must not become a space.
    const { stored } = run('#connect=a%2Bb%2Fc&device=app');
    expect(stored['turminder.token']).toBe('a+b/c');
  });
});
