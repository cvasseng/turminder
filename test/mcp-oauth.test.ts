import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { afterEach, describe, expect, it } from 'vitest';
import { bootService, type ServiceHarness } from './service-harness.js';
// @ts-expect-error — a plain .mjs fixture, typed by use
import { startOAuthMcpServer } from './fixtures/mcp-oauth-server.mjs';
import { SIGN_IN_OAUTH } from '../src/tools/integrations/setup/templates.js';
import { oauthSecretKey } from '../src/tools/mcp/oauth.js';

interface Fixture {
  url: string;
  base: string;
  seen: { registrations: number; refreshes: number; authorizations: Record<string, string>[] };
  expireAccessTokens(): void;
  revokeAll(): void;
  close(): Promise<void>;
}

let h: ServiceHarness | undefined;
let server: Fixture | undefined;
afterEach(async () => {
  await h?.cleanup();
  await server?.close();
  h = undefined;
  server = undefined;
});

const bare = { runId: null, eventId: null };

function writeMcp(harness: ServiceHarness, servers: unknown[]): void {
  fs.writeFileSync(
    path.join(harness.dataDir, 'config', 'mcp.yaml'),
    YAML.stringify({ servers }),
  );
  harness.app.config.reload();
}

async function call(harness: ServiceHarness, tool: string, args: unknown, ctx: object = bare) {
  const handle = harness.service.tools.get(tool);
  if (!handle) throw new Error(`no tool ${tool}`);
  return (await handle.call(args, ctx as never)).output as any;
}

/** "Approve" the way a person does: open the link; the fixture consents at once. */
async function approve(authUrl: string): Promise<URL> {
  const res = await fetch(authUrl, { redirect: 'manual' });
  expect(res.status).toBe(302);
  return new URL(res.headers.get('location')!);
}

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

const status = (harness: ServiceHarness, name = 'locked') =>
  harness.service.tools.serverStatus().find((s) => s.name === name)!;

const events = (harness: ServiceHarness, type: string) =>
  harness.service.repos.events.recent({ limit: 50 }).filter((e) => e.type === type);

async function until(check: () => boolean, ms = 5000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 20));
  }
}

/** A forms-capable stand-in for the chat UI. */
function formSink(harness: ServiceHarness) {
  const sent: { type: string; payload: Record<string, any> }[] = [];
  harness.service.forms.attach({ send: (type, payload) => sent.push({ type, payload }) });
  return sent;
}

describe('an MCP server that signs in with a browser (§19.6)', () => {
  it('needs_auth, a link, the callback, tools — and nothing secret outside the store', async () => {
    h = await bootService({ onboarded: true, runScheduler: false });
    server = (await startOAuthMcpServer()) as Fixture;
    writeMcp(h, [
      { name: 'locked', transport: 'http', url: server.url, auth: { type: 'oauth' } },
    ]);

    // Reachable and asking for a person: not "dropped", and not retried.
    const connected = await h.service.tools.connectExternal('locked');
    expect(connected.connected).toBe(false);
    expect(connected.needs_auth).toBe(true);
    expect(status(h).needs_auth).toBe(true);
    expect(status(h).next_retry_at).toBeUndefined();
    // Never signed in, so nothing has *expired* — no notice.
    expect(events(h, 'system.integration_needs_auth')).toEqual([]);

    // The link comes back as a value, like Google's.
    const begun = await call(h, 'setup.activate', { integration: 'locked' });
    expect(begun.pending).toBe(true);
    expect(begun.redirect_uri).toBe(`${h.baseUrl}/oauth/callback`);
    const link = new URL(begun.auth_url);
    expect(link.searchParams.get('code_challenge_method')).toBe('S256');
    expect(link.searchParams.get('state')!.length).toBeGreaterThanOrEqual(32);
    expect(server.seen.registrations).toBe(1);

    // Asking again while that link is out hands out the same link.
    const again = await call(h, 'setup.activate', { integration: 'locked' });
    expect(again.auth_url).toBe(begun.auth_url);

    const back = await approve(begun.auth_url);
    expect(back.origin + back.pathname).toBe(`${h.baseUrl}/oauth/callback`);
    const code = back.searchParams.get('code')!;
    const state = back.searchParams.get('state')!;

    // A state this assistant never issued is refused, and changes nothing.
    const forged = new URL(back);
    forged.searchParams.set('state', 'x'.repeat(state.length));
    const refused = await fetch(forged);
    expect(refused.status).toBe(403);
    expect(await refused.text()).toMatch(/already used, or was not one your assistant issued/);
    expect(status(h).connected).toBe(false);

    const ok = await fetch(back);
    expect(ok.status).toBe(200);
    expect(ok.headers.get('content-type')).toMatch(/text\/html/);
    expect(ok.headers.get('cache-control')).toBe('no-store');
    expect(await ok.text()).toMatch(/Signed in to locked/);

    expect(status(h).connected).toBe(true);
    expect(status(h).needs_auth).toBeUndefined();
    expect(h.service.tools.toolsFrom('locked')).toContain('locked.ping');
    expect((await call(h, 'locked.ping', { echo: 'hi' })).pong).toBe('hi');
    await until(() => events(h!, 'system.integration_activated').length > 0);
    expect(events(h, 'system.integration_activated')[0]!.payload).toMatchObject({
      integration: 'locked',
      tools: ['locked.ping'],
    });

    // Single-use: the same callback again finds nothing.
    expect((await fetch(back)).status).toBe(403);

    // The tokens live in the store and nowhere else — not config, not
    // events.db, not the git half. The code and state were never persisted.
    const blob = JSON.parse(h.app.config.secretStore.get(oauthSecretKey('locked'))!);
    expect(blob.state).toBeUndefined();
    expect(blob.verifier).toBeUndefined();
    const store = h.app.config.secretStore.name === 'plain' ? ['secrets/secrets.yaml'] : [];
    expect(sweep(h.dataDir, blob.tokens.access_token)).toEqual(store);
    expect(sweep(h.dataDir, blob.tokens.refresh_token)).toEqual(store);
    expect(sweep(h.dataDir, code)).toEqual([]);
    expect(sweep(h.dataDir, state)).toEqual([]);
    expect(fs.readFileSync(path.join(h.dataDir, 'config', 'mcp.yaml'), 'utf8')).not.toMatch(
      /token/,
    );
  }, 20_000);

  it('refreshes an expired token on its own, and says needs_auth when the sign-in is gone', async () => {
    h = await bootService({ onboarded: true, runScheduler: false });
    server = (await startOAuthMcpServer()) as Fixture;
    writeMcp(h, [
      { name: 'locked', transport: 'http', url: server.url, auth: { type: 'oauth' } },
    ]);
    await h.service.tools.connectExternal('locked');
    const begun = await call(h, 'setup.activate', { integration: 'locked' });
    expect((await fetch(await approve(begun.auth_url))).status).toBe(200);

    // Expiry is the SDK's to handle: one 401, one refresh, the call succeeds.
    server.expireAccessTokens();
    expect((await call(h, 'locked.ping', {})).pong).toBe('pong');
    expect(server.seen.refreshes).toBe(1);

    // Withdrawn: no refresh can fix it. A value, the status says so, it is
    // off the retry loop, and — having worked once — it earns one notice.
    server.revokeAll();
    const dead = await call(h, 'locked.ping', {});
    expect(dead.error).toBe('needs_auth');
    expect(dead.message).toMatch(/setup\.activate \{integration: "locked"\}/);
    expect(status(h).needs_auth).toBe(true);
    expect(status(h).connected).toBe(false);
    expect(status(h).next_retry_at).toBeUndefined();
    // The tools stay advertised (§11.6), and a second call does not re-notify.
    expect(h.service.tools.get('locked.ping')).toBeTruthy();
    expect((await call(h, 'locked.ping', {})).error).toBe('needs_auth');
    await until(() => events(h!, 'system.integration_needs_auth').length > 0);
    const notices = events(h, 'system.integration_needs_auth');
    expect(notices).toHaveLength(1);
    expect(notices[0]!.payload).toMatchObject({ integration: 'locked' });
    // The notice carries no link: one is minted when somebody asks.
    expect(JSON.stringify(notices[0]!.payload)).not.toMatch(/https?:/);
  }, 20_000);

  it('takes a pasted address from a phone, and never hands it to the model', async () => {
    h = await bootService({ onboarded: true, runScheduler: false });
    server = (await startOAuthMcpServer()) as Fixture;
    writeMcp(h, [
      { name: 'locked', transport: 'http', url: server.url, auth: { type: 'oauth' } },
    ]);
    await h.service.tools.connectExternal('locked');
    const sent = formSink(h);
    const ctx = { runId: 'run-paste', eventId: null, conversationId: 'conv-paste' };

    // First ask: the link. Second ask, with the link still out: the form.
    const begun = await call(h, 'setup.activate', { integration: 'locked' }, ctx);
    expect(begun.pending).toBe(true);
    expect(sent).toEqual([]);
    const pasting = call(h, 'setup.activate', { integration: 'locked' }, ctx);
    await until(() => sent.some((f) => f.type === 'form.request'));
    const form = sent.find((f) => f.type === 'form.request')!.payload;
    expect(form.template).toBe('oauth_paste');
    expect(form.fields.map((f: any) => f.name)).toEqual(['redirected_to']);

    // The phone's localhost would not load; the person copies the address.
    const landed = await approve(begun.auth_url);
    const code = landed.searchParams.get('code')!;

    // An address with no code keeps the same form open, saying why.
    const wrong = h.service.forms.submit(form.form_id, {
      redirected_to: `${h.baseUrl}/oauth/callback?nothing=here`,
    });
    expect(wrong).toEqual({ ok: false, error: expect.stringMatching(/no sign-in code/) });

    expect(h.service.forms.submit(form.form_id, { redirected_to: landed.toString() })).toEqual({
      ok: true,
    });
    const result = await pasting;
    expect(result.activated).toBe(true);
    expect(result.tools).toContain('locked.ping');
    expect(status(h).connected).toBe(true);
    // Neither the address nor its code reached the result.
    expect(JSON.stringify(result)).not.toContain(code);
    expect(JSON.stringify(result)).not.toContain('oauth/callback');
    // Heard as the call's own result — not a second notification.
    expect(events(h, 'system.integration_activated')).toEqual([]);
  }, 20_000);

  it('closes the paste form by itself when the callback lands first', async () => {
    h = await bootService({ onboarded: true, runScheduler: false });
    server = (await startOAuthMcpServer()) as Fixture;
    writeMcp(h, [
      { name: 'locked', transport: 'http', url: server.url, auth: { type: 'oauth' } },
    ]);
    await h.service.tools.connectExternal('locked');
    const sent = formSink(h);
    const ctx = { runId: 'run-race', eventId: null, conversationId: 'conv-race' };

    const begun = await call(h, 'setup.activate', { integration: 'locked' }, ctx);
    const waiting = call(h, 'setup.activate', { integration: 'locked' }, ctx);
    await until(() => sent.some((f) => f.type === 'form.request'));

    expect((await fetch(await approve(begun.auth_url))).status).toBe(200);
    const result = await waiting;
    expect(result.activated).toBe(true);
    expect(sent.map((f) => f.type)).toContain('form.closed');
    expect(events(h, 'system.integration_activated')).toEqual([]);
  }, 20_000);

  it('uses a hand-registered client when the provider has no dynamic registration', async () => {
    h = await bootService({ onboarded: true, runScheduler: false });
    server = (await startOAuthMcpServer({
      dcr: false,
      clients: [
        {
          client_id: 'hand-made',
          client_secret: 'sentinel-oauth-client-secret',
          redirect_uris: [`${h.baseUrl}/oauth/callback`],
        },
      ],
    })) as Fixture;
    h.app.config.secretStore.set('LOCKED_OAUTH_CLIENT_SECRET', 'sentinel-oauth-client-secret');
    writeMcp(h, [
      {
        name: 'locked',
        transport: 'http',
        url: server.url,
        auth: {
          type: 'oauth',
          client_id: 'hand-made',
          client_secret: '${secret:LOCKED_OAUTH_CLIENT_SECRET}',
        },
      },
    ]);
    await h.service.tools.connectExternal('locked');
    const begun = await call(h, 'setup.activate', { integration: 'locked' });
    expect(new URL(begun.auth_url).searchParams.get('client_id')).toBe('hand-made');
    expect((await fetch(await approve(begun.auth_url))).status).toBe(200);
    expect(status(h).connected).toBe(true);
    expect(server.seen.registrations).toBe(0);
    const store = h.app.config.secretStore.name === 'plain' ? ['secrets/secrets.yaml'] : [];
    expect(sweep(h.dataDir, 'sentinel-oauth-client-secret')).toEqual(store);
  }, 20_000);

  it('installs from the mcp_http template, keeps the entry, and returns the link', async () => {
    h = await bootService({ onboarded: true, runScheduler: false });
    server = (await startOAuthMcpServer()) as Fixture;
    const sent = formSink(h);
    const ctx = { runId: 'run-install', eventId: null, conversationId: 'conv-install' };

    const pending = call(h, 'setup.form', { title: 'Connect', template: 'mcp_http' }, ctx);
    await until(() => sent.some((f) => f.type === 'form.request'));
    const form = sent.find((f) => f.type === 'form.request')!.payload;
    // The label names the redirect a hand-registered app must list.
    expect(form.fields.find((f: any) => f.name === 'oauth_client_id').label).toContain(
      `${h.baseUrl}/oauth/callback`,
    );
    h.service.forms.submit(form.form_id, {
      name: 'locked',
      url: server.url,
      sign_in: SIGN_IN_OAUTH,
    });
    const result = await pending;
    expect(result.effect).toMatchObject({
      installed: true,
      connected: false,
      needs_auth: true,
    });
    expect(result.effect.auth_url).toMatch(/^http/);

    // Not rolled back: needing a sign-in is not "would not connect".
    const yaml = YAML.parse(
      fs.readFileSync(path.join(h.dataDir, 'config', 'mcp.yaml'), 'utf8'),
    ) as { servers: any[] };
    expect(yaml.servers[0]).toMatchObject({ name: 'locked', auth: { type: 'oauth' } });

    expect((await fetch(await approve(result.effect.auth_url))).status).toBe(200);
    expect(status(h).connected).toBe(true);
  }, 20_000);
});
