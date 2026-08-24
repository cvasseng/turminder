import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  PairingBroker,
  PAIR_PENDING_MAX,
  PAIR_POLL_INTERVAL_S,
  PAIR_TTL_S,
} from '../src/core/pairing.js';
import { DeviceTokens, tokenSha256 } from '../src/core/tokens.js';
import { Config } from '../src/core/config.js';
import { openDataHome } from '../src/core/datadir.js';
import { tmpDir } from './helpers.js';
import { bootService, postJson, TestClient, type ServiceHarness } from './service-harness.js';

const ROOT = path.resolve(import.meta.dirname, '..');
const read = (rel: string): string => fs.readFileSync(path.join(ROOT, rel), 'utf8');

/**
 * Page-initiated pairing (§24.4). Two properties, and everything here is one of
 * them: the **code** is a thing a human reads out, so it does nothing on its
 * own; the **ticket** is what the token is delivered against, and it never
 * leaves the browser that asked. Around those, the §24 invariant that outlives
 * every mechanism: no value at rest, anywhere, ever.
 */
function broker(clock: { ms: number }): {
  pairing: PairingBroker;
  tokens: DeviceTokens;
  dataDir: string;
  cleanup: () => void;
} {
  const t = tmpDir('turminder-pair-');
  const dataDir = path.join(t.dir, 'home');
  const { home } = openDataHome(dataDir);
  const config = new Config(home);
  const tokens = new DeviceTokens(home, config);
  return {
    pairing: new PairingBroker(tokens, () => clock.ms),
    tokens,
    dataDir,
    cleanup: t.cleanup,
  };
}

describe('the pairing broker (§24.4)', () => {
  let b: ReturnType<typeof broker> | null = null;
  afterEach(() => {
    b?.cleanup();
    b = null;
  });

  it('hands out a readable code and a secret ticket, and mints nothing yet', () => {
    const clock = { ms: 1_000_000 };
    b = broker(clock);
    const asked = b.pairing.request();
    if ('error' in asked) throw new Error(`request refused: ${asked.error}`);

    // Six characters an alphabet with no 0/1/I/L/O/U can produce, in two halves
    // because it gets read out loud.
    expect(asked.code).toMatch(/^[2-9A-HJ-NP-TV-Z]{3}-[2-9A-HJ-NP-TV-Z]{3}$/);
    expect(asked.ticket).toMatch(/^[0-9a-f]{64}$/);
    expect(asked.expires_in_s).toBe(PAIR_TTL_S);
    // Asking is not being let in.
    expect(b.pairing.claim(asked.ticket)).toEqual({ status: 'pending' });
    expect(b.tokens.list().map((d) => d.device)).toEqual(['ui']);
  });

  it('delivers the token to the ticket-holder exactly once', () => {
    const clock = { ms: 1_000_000 };
    b = broker(clock);
    const asked = b.pairing.request();
    if ('error' in asked) throw new Error('request refused');

    const approved = b.pairing.approve(asked.code, 'phone', 'My phone');
    expect(approved).toEqual({
      device: 'phone',
      label: 'My phone',
      approved: true,
      delivered_to_device: true,
    });
    // The approval's return value is the whole of what the approver learns: no
    // token, not even a hash of one (§24.2).
    expect(JSON.stringify(approved)).not.toMatch(/[0-9a-f]{64}/);

    const claim = b.pairing.claim(asked.ticket);
    if (claim.status !== 'approved') throw new Error(`claim said ${claim.status}`);
    expect(claim.device).toBe('phone');
    expect(b.tokens.authenticate(claim.token)).toBe('phone');
    // Once. A replayed ticket is indistinguishable from one that never existed.
    expect(b.pairing.claim(asked.ticket)).toEqual({ status: 'expired' });
    expect(b.pairing.waiting).toBe(0);
  });

  it('gives the token to nobody but the ticket-holder', () => {
    const clock = { ms: 1_000_000 };
    b = broker(clock);
    const asked = b.pairing.request();
    if ('error' in asked) throw new Error('request refused');
    b.pairing.approve(asked.code, 'phone');

    // Knowing the code — which is read out loud in a room — is not knowing the
    // ticket, and the ticket is what the value answers to.
    expect(b.pairing.claim(asked.code)).toEqual({ status: 'expired' });
    expect(b.pairing.claim('0'.repeat(64))).toEqual({ status: 'expired' });
    const claim = b.pairing.claim(asked.ticket);
    expect(claim.status).toBe('approved');
  });

  it('matches a code the way a person would say it', () => {
    const clock = { ms: 1_000_000 };
    b = broker(clock);
    const asked = b.pairing.request();
    if ('error' in asked) throw new Error('request refused');

    const spoken = asked.code.toLowerCase().replace('-', ' ');
    expect(b.pairing.approve(spoken, 'phone')).toMatchObject({ approved: true });
  });

  it('expires, and an expired code writes no row', () => {
    const clock = { ms: 1_000_000 };
    b = broker(clock);
    const asked = b.pairing.request();
    if ('error' in asked) throw new Error('request refused');

    clock.ms += PAIR_TTL_S * 1000 + 1;
    const refused = b.pairing.approve(asked.code, 'phone');
    expect(refused).toMatchObject({ error: 'no_such_request' });
    expect(b.tokens.has('phone')).toBe(false);
    expect(b.pairing.claim(asked.ticket)).toEqual({ status: 'expired' });
  });

  it('refuses a second approval, and a name already taken — keeping the request', () => {
    const clock = { ms: 1_000_000 };
    b = broker(clock);
    const asked = b.pairing.request();
    if ('error' in asked) throw new Error('request refused');

    // The model guessed a name that exists. The request has to survive that, or
    // a naming clash costs the user another trip to the phone.
    expect(b.pairing.approve(asked.code, 'ui')).toMatchObject({ error: 'device_exists' });
    expect(b.pairing.approve(asked.code, 'phone')).toMatchObject({ approved: true });
    expect(b.pairing.approve(asked.code, 'phone2')).toMatchObject({
      error: 'already_approved',
    });
    expect(b.tokens.has('phone2')).toBe(false);
  });

  it('bounds what an unauthenticated caller can pile up', () => {
    const clock = { ms: 1_000_000 };
    b = broker(clock);
    for (let i = 0; i < PAIR_PENDING_MAX; i++) {
      expect(b.pairing.request()).not.toHaveProperty('error');
    }
    expect(b.pairing.request()).toMatchObject({ error: 'too_many_pending' });
    // And the cap is a window, not a wall: they age out.
    clock.ms += PAIR_TTL_S * 1000 + 1;
    expect(b.pairing.request()).not.toHaveProperty('error');
  });

  it('refuses to start on an install with nothing to approve it', () => {
    const clock = { ms: 1_000_000 };
    b = broker(clock);
    b.tokens.revoke('ui');
    expect(b.pairing.request()).toMatchObject({ error: 'nothing_linked' });
  });
});

/**
 * The same flow through the routes and the tool the real thing uses — and the
 * §24.2 sentinel, extended to this path: after a pairing the value exists in
 * the page that claimed it and nowhere else on the machine.
 */
describe('pairing end to end (§24.4, App. E, F.9)', () => {
  let h: ServiceHarness | null = null;
  afterEach(async () => {
    await h?.cleanup();
    h = null;
  });

  /** Script the model to approve whatever code the user reads out. */
  function scriptApprove(harness: ServiceHarness, args: Record<string, unknown>): void {
    let asked = false;
    harness.fake.always((req: any) => {
      if (req.body.tools && !asked) {
        asked = true;
        return { toolCalls: [{ name: 'setup.pair_approve', args }] };
      }
      return { text: 'Your phone is connected.' };
    });
  }

  it('takes a device from a gate with no token to a working one', async () => {
    h = await bootService({ onboarded: true });
    const client = await TestClient.connect(h.baseUrl, h.token);
    await client.hello(['chat']);

    // The gate asks. No auth: it has nothing to authenticate with, which is
    // why it is asking.
    const asked = await postJson(`${h.baseUrl}/api/pair/request`, {});
    expect(asked.status).toBe(200);
    const { code, ticket } = asked.body as { code: string; ticket: string };
    expect(code).toMatch(/^[2-9A-HJ-NP-TV-Z]{3}-[2-9A-HJ-NP-TV-Z]{3}$/);

    const pending = await postJson(`${h.baseUrl}/api/pair/claim`, { ticket });
    expect(pending.body).toEqual({ status: 'pending' });

    // The user reads the code out; the assistant approves it by name.
    scriptApprove(h, { code, device: 'phone', label: 'My phone' });
    const sent = h.service.chat.send({ text: `connect this device, the code is ${code}` });
    await h.service.queue.drain();

    const claimed = await postJson(`${h.baseUrl}/api/pair/claim`, { ticket });
    const body = claimed.body as { status: string; token: string; device: string };
    expect(body.status).toBe('approved');
    expect(body.device).toBe('phone');
    // It is a real token: the whole point is that the page can now connect.
    expect(h.app.tokens.authenticate(body.token)).toBe('phone');
    const paired = await TestClient.connect(h.baseUrl, body.token);
    await paired.hello(['chat']);
    paired.close();

    // What the model got back: that it happened, and nothing it could repeat.
    const call = h.service.repos.trace
      .forEvent(sent.eventId)
      .find((t) => t.kind === 'tool_call')!.data as any;
    expect(call.tool).toBe('setup.pair_approve');
    expect(JSON.parse(call.result_excerpt)).toEqual({
      device: 'phone',
      label: 'My phone',
      approved: true,
      delivered_to_device: true,
    });

    // The sentinel (§24.2) over the new path: LLM request bodies, trace rows,
    // persisted turns, and every file under config/.
    const value = body.token;
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
    const channels = fs.readFileSync(path.join(configDir, 'channels.yaml'), 'utf8');
    expect(channels).toContain(tokenSha256(value));
    client.close();
  });

  it('puts the approval in front of the user, and lets them name the device', async () => {
    h = await bootService({ onboarded: true });
    const client = await TestClient.connect(h.baseUrl, h.token);
    await client.hello(['chat', 'forms']);

    const asked = await postJson(`${h.baseUrl}/api/pair/request`, { kind: 'phone' });
    const { code, ticket } = asked.body as { code: string; ticket: string };

    // No dictation, no model: asking is what raises the dialog.
    const form = await client.next('form.request', 15000);
    expect(form.payload.title).toContain(code);
    // It belongs to a device, not to a conversation — so it renders wherever
    // the reader happens to be looking (App. D.5).
    expect(form.payload.conversation_id).toBe('');
    expect(String(form.payload.description)).toMatch(/own screen/);
    const fields = form.payload.fields as { name: string; type: string; value?: string }[];
    expect(fields).toHaveLength(1);
    expect(fields[0]).toMatchObject({ name: 'device', type: 'text' });
    // Prefilled from the kind the asker declared, so the common case is one
    // tap — a word this server wrote, never one the caller supplied.
    expect(fields[0]?.value).toBe('phone');
    expect(h.fake.requests).toHaveLength(0);

    client.send('form.submit', {
      form_id: form.payload.form_id,
      values: { device: 'pixel' },
    });
    await client.next('form.accepted');

    const claimed = await postJson(`${h.baseUrl}/api/pair/claim`, { ticket });
    const body = claimed.body as { status: string; token: string; device: string };
    expect(body.status).toBe('approved');
    expect(body.device).toBe('pixel');
    expect(h.app.tokens.authenticate(body.token)).toBe('pixel');
    // The model was never involved — nothing was said, so nothing ran.
    expect(h.fake.requests).toHaveLength(0);
    client.close();
  });

  it('takes only a kind it knows, and writes the words itself', async () => {
    h = await bootService({ onboarded: true });
    const client = await TestClient.connect(h.baseUrl, h.token);
    await client.hello(['chat', 'forms']);

    // An unauthenticated caller picks a category. It does not get to put text
    // of its own in front of the person answering (§24.4).
    const bad = await postJson(`${h.baseUrl}/api/pair/request`, { kind: 'trusted-laptop' });
    expect(bad.status).toBe(400);
    const alsoBad = await postJson(`${h.baseUrl}/api/pair/request`, { device: 'laptop' });
    expect(alsoBad.status).toBe(400);
    expect(h.service.pairing.waiting).toBe(0);

    await postJson(`${h.baseUrl}/api/pair/request`, { kind: 'browser' });
    const form = await client.next('form.request', 15000);
    expect((form.payload.fields as { value?: string }[])[0]?.value).toBe('browser');
    client.close();
  });

  it('re-asks when the name is taken, and again when it is unusable', async () => {
    h = await bootService({ onboarded: true });
    const client = await TestClient.connect(h.baseUrl, h.token);
    await client.hello(['chat', 'forms']);

    const asked = await postJson(`${h.baseUrl}/api/pair/request`, {});
    const { ticket } = asked.body as { ticket: string };

    const first = await client.next('form.request', 15000);
    client.send('form.submit', { form_id: first.payload.form_id, values: { device: 'ui' } });
    await client.next('form.accepted');

    // The request survives a naming clash: walking back to the phone because
    // of a name is exactly the round trip this flow exists to remove.
    const second = await client.next('form.request', 15000);
    expect(String(second.payload.description)).toContain('already a device called ui');
    client.send('form.submit', {
      form_id: second.payload.form_id,
      values: { device: 'my phone!' },
    });
    await client.next('form.accepted');

    const third = await client.next('form.request', 15000);
    expect(String(third.payload.description)).toMatch(/not a usable device name/);
    client.send('form.submit', { form_id: third.payload.form_id, values: { device: 'phone' } });
    await client.next('form.accepted');

    const claimed = await postJson(`${h.baseUrl}/api/pair/claim`, { ticket });
    expect((claimed.body as { status: string }).status).toBe('approved');
    expect(h.app.tokens.has('my phone!')).toBe(false);
    client.close();
  });

  it('tells the device it was refused, not that it timed out', async () => {
    h = await bootService({ onboarded: true });
    const client = await TestClient.connect(h.baseUrl, h.token);
    await client.hello(['chat', 'forms']);

    const asked = await postJson(`${h.baseUrl}/api/pair/request`, {});
    const { code, ticket } = asked.body as { code: string; ticket: string };
    const form = await client.next('form.request', 15000);
    client.send('form.cancel', { form_id: form.payload.form_id });

    // "declined" and "expired" are different facts, and the device says so.
    // Polled because the cancel travels the socket before it reaches the form.
    const claim = `${h.baseUrl}/api/pair/claim`;
    await expect
      .poll(async () => ((await postJson(claim, { ticket })).body as { status: string }).status)
      .toBe('declined');
    // And a declined code cannot then be approved by talking to the model.
    expect(h.service.pairing.approve(code, 'phone')).toMatchObject({
      error: 'no_such_request',
    });
    expect(h.app.tokens.has('phone')).toBe(false);
    client.close();
  });

  it('leaves the request standing when there is no screen to ask on', async () => {
    // `no_channel` is not a refusal: a daemon-only install has nobody to show
    // a form to, and the spoken path still has to work.
    h = await bootService({ onboarded: true });
    const asked = await postJson(`${h.baseUrl}/api/pair/request`, {});
    const { code, ticket } = asked.body as { code: string; ticket: string };
    expect(h.service.pairing.approve(code, 'phone')).toMatchObject({ approved: true });
    const claimed = await postJson(`${h.baseUrl}/api/pair/claim`, { ticket });
    expect((claimed.body as { status: string }).status).toBe('approved');
  });

  it('rejects a claim with no ticket rather than guessing what was meant', async () => {
    h = await bootService({ onboarded: true });
    expect((await postJson(`${h.baseUrl}/api/pair/claim`, {})).status).toBe(400);
    expect((await postJson(`${h.baseUrl}/api/pair/claim`, { ticket: 'nope' })).body).toEqual({
      status: 'expired',
    });
  });

  it('tells the model when a code has expired, and writes nothing', async () => {
    h = await bootService({ onboarded: true });
    const client = await TestClient.connect(h.baseUrl, h.token);
    await client.hello(['chat']);
    scriptApprove(h, { code: 'ABC-DEF', device: 'phone' });

    const sent = h.service.chat.send({ text: 'connect this device, the code is ABC-DEF' });
    await h.service.queue.drain();

    const call = h.service.repos.trace
      .forEvent(sent.eventId)
      .find((t) => t.kind === 'tool_call')!.data as any;
    expect(JSON.parse(call.result_excerpt).error).toBe('no_such_request');
    expect(h.app.tokens.has('phone')).toBe(false);
    client.close();
  });

  it('offers no way for the model to discover what is waiting', async () => {
    // §24.4: the code comes from the human, or approving is a formality the
    // model can perform alone. A listing tool would be exactly that.
    h = await bootService({ onboarded: true });
    await postJson(`${h.baseUrl}/api/pair/request`, {});
    const names = h.service.tools.handles().map((t) => t.name);
    expect(names).toContain('setup.pair_approve');
    expect(names.filter((n) => /pair/.test(n))).toEqual(['setup.pair_approve']);
  });
});

/**
 * The constants and the clients that hold copies of them. Three files carry the
 * poll interval — the broker, the chat gate, the extension's options page — and
 * two of those are hand-written JavaScript that no compiler checks against
 * anything. The interval drifting is not a crash; it is a device that feels
 * slow to connect on one surface and hammers the service on another.
 */
describe('the pairing constants say what App. A says (§24.4)', () => {
  /** The App. A row for a constant, as a number. */
  function specConstant(name: string): number {
    const row = read('spec.md')
      .split('\n')
      .find((line) => line.startsWith('|') && line.includes(`\`${name}\``));
    if (!row) throw new Error(`App. A should carry a table row for ${name}`);
    const match = /\|\s*(\d+)/.exec(row.slice(row.indexOf('|', 1)));
    if (!match) throw new Error(`App. A row for ${name} should state a number: ${row}`);
    return Number(match[1]);
  }

  it('pins the broker to the table', () => {
    expect(PAIR_TTL_S).toBe(specConstant('pair_ttl_s'));
    expect(PAIR_PENDING_MAX).toBe(specConstant('pair_pending_max'));
    expect(PAIR_POLL_INTERVAL_S).toBe(specConstant('pair_poll_interval_s'));
  });

  it('pins both waiting clients to the same interval', () => {
    const ms = specConstant('pair_poll_interval_s') * 1000;
    for (const file of ['ui/app.js', 'extension/options.js']) {
      const match = /PAIR_POLL_MS = (\d+)/.exec(read(file));
      expect(match, `${file} should define PAIR_POLL_MS`).toBeTruthy();
      expect(Number(match?.[1]), file).toBe(ms);
    }
  });

  it('has both clients ask, wait, and keep the value out of the page', () => {
    for (const file of ['ui/app.js', 'extension/options.js']) {
      const source = read(file);
      expect(source, file).toContain('/api/pair/request');
      expect(source, file).toContain('/api/pair/claim');
      // The ticket travels in the body, never a query string (§24.4).
      expect(source, file).not.toMatch(/pair\/claim\?/);
      // Both say which of the two endings it was.
      expect(source, file).toContain("'declined'");
    }
    // The extension has a token field, and a paired token must not land in it:
    // it arrived without anyone reading it (§29.5).
    const options = read('extension/options.js');
    expect(options).not.toMatch(/\$\('token'\)\.value = body\.token/);
    expect(options).toContain("body: JSON.stringify({ kind: 'browser' })");
  });
});
