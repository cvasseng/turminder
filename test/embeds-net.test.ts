import fs from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { EMBED_SECRET_KEY } from '../src/embeds/tokens.js';
import { bootService, TestClient, type ServiceHarness } from './service-harness.js';
import { write } from './helpers.js';

let h: ServiceHarness;
afterEach(async () => {
  await h?.cleanup();
});

const drain = (harness: ServiceHarness) => harness.service.queue.drain();

const PAGE =
  '<div id="root">nothing yet</div><script>turminder.getState().then(function (s) {' +
  'document.getElementById("root").textContent = JSON.stringify(s); });</script>';

function makeEmbed(
  harness: ServiceHarness,
  over: {
    title?: string;
    html?: string;
    kind?: 'ephemeral' | 'persistent';
    conversationId?: string;
  } = {},
) {
  const created = harness.service.embeds.create({
    title: over.title ?? 'Week chart',
    html: over.html ?? PAGE,
    ...(over.kind ? { kind: over.kind } : {}),
    ...(over.conversationId ? { conversationId: over.conversationId } : {}),
  });
  if ('error' in created) throw new Error(created.message);
  return created;
}

/* ── serving (§22.3) ─────────────────────────────────────────────────────── */

describe('GET /embed/<id> (§22.3)', () => {
  it('serves the page under the spec CSP, with the runtime prepended', async () => {
    h = await bootService({ onboarded: true, watchFiles: false });
    const embed = makeEmbed(h);
    const res = await fetch(`${h.baseUrl}${embed.url}`);
    expect(res.status).toBe(200);
    const csp = res.headers.get('content-security-policy')!;
    expect(csp).toContain('sandbox allow-scripts');
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain(`connect-src ${h.baseUrl}/embed-api/${embed.embed_id}/`);
    // The one word that would undo the whole isolation model.
    expect(csp).not.toContain('allow-same-origin');
    const body = await res.text();
    expect(body.indexOf('window.turminder')).toBeLessThan(body.indexOf('<div id="root">'));
  });

  /**
   * The sentinel test that stays in CI forever: an embed context must never see
   * the device token (§22.3.2). Every served byte, and every embed-api answer.
   */
  it('the device token appears in nothing an embed can see', async () => {
    h = await bootService({ onboarded: true, watchFiles: false });
    const embed = makeEmbed(h);
    const bodies: string[] = [];
    const page = await fetch(`${h.baseUrl}${embed.url}`);
    bodies.push(await page.text(), JSON.stringify([...page.headers]));
    const state = await fetch(
      `${h.baseUrl}/embed-api/${embed.embed_id}/state?t=${token(embed.url)}`,
    );
    bodies.push(await state.text());

    const client = await TestClient.connect(h.baseUrl, h.token);
    await client.hello(['chat']);
    client.send('embed.resolve', { embed_id: embed.embed_id });
    const resolved = await client.next('embed.resolve.result');
    bodies.push(JSON.stringify(resolved));
    client.close();

    for (const body of bodies) {
      expect(body).not.toContain(h.token);
      expect(body).not.toContain(h.app.config.secrets[EMBED_SECRET_KEY]!);
    }
  });

  it('refuses a wrong token, a rotated one, and a deleted embed', async () => {
    h = await bootService({ onboarded: true, watchFiles: false });
    const embed = makeEmbed(h);
    expect(
      (await fetch(`${h.baseUrl}/embed/${embed.embed_id}?t=${'0'.repeat(64)}`)).status,
    ).toBe(403);
    expect((await fetch(`${h.baseUrl}/embed/${embed.embed_id}`)).status).toBe(403);

    const rotated = h.service.embeds.rotate(embed.embed_id);
    if ('error' in rotated) throw new Error(rotated.message);
    expect((await fetch(`${h.baseUrl}${embed.url}`)).status).toBe(403);
    expect((await fetch(`${h.baseUrl}${rotated.url}`)).status).toBe(200);

    h.service.embeds.delete(embed.embed_id);
    expect((await fetch(`${h.baseUrl}${rotated.url}`)).status).toBe(404);
  });

  it('a scoped token is worth exactly one embed', async () => {
    h = await bootService({ onboarded: true, watchFiles: false });
    const mine = makeEmbed(h, { title: 'Mine' });
    const theirs = makeEmbed(h, { title: 'Theirs' });
    h.service.embeds.writeState(theirs.embed_id, { secret: 'not yours' });

    const leaked = token(mine.url);
    for (const url of [
      `${h.baseUrl}/embed/${theirs.embed_id}?t=${leaked}`,
      `${h.baseUrl}/embed-api/${theirs.embed_id}/state?t=${leaked}`,
    ]) {
      const res = await fetch(url);
      expect(res.status).toBe(403);
      expect(await res.text()).not.toContain('not yours');
    }
  });
});

/* ── the runtime API (§22.4) ─────────────────────────────────────────────── */

describe('the embed API (§22.4)', () => {
  it('reads and writes the pouch', async () => {
    h = await bootService({ onboarded: true, watchFiles: false });
    const embed = makeEmbed(h);
    const base = `${h.baseUrl}/embed-api/${embed.embed_id}`;
    const t = token(embed.url);

    const put = await fetch(`${base}/state?t=${t}`, {
      method: 'PUT',
      headers: { 'content-type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ tab: 'week', count: 3 }),
    });
    expect(put.status).toBe(200);
    expect(await put.json()).toMatchObject({ accepted: true });
    expect(await (await fetch(`${base}/state?t=${t}`)).json()).toEqual({
      state: { tab: 'week', count: 3 },
    });
  });

  it('refuses a pouch over 64KB', async () => {
    h = await bootService({ onboarded: true, watchFiles: false });
    const embed = makeEmbed(h);
    const res = await fetch(
      `${h.baseUrl}/embed-api/${embed.embed_id}/state?t=${token(embed.url)}`,
      {
        method: 'PUT',
        headers: { 'content-type': 'text/plain;charset=utf-8' },
        body: JSON.stringify({ big: 'x'.repeat(70_000) }),
      },
    );
    expect(res.status).toBe(413);
    expect(await res.json()).toMatchObject({ accepted: false, error: 'state_too_large' });
  });

  it('answers a CORS preflight and allows any origin — the token is the auth', async () => {
    h = await bootService({ onboarded: true, watchFiles: false });
    const embed = makeEmbed(h);
    const res = await fetch(`${h.baseUrl}/embed-api/${embed.embed_id}/state`, {
      method: 'OPTIONS',
    });
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
    // Never on the routes that take a device token.
    const health = await fetch(`${h.baseUrl}/healthz`);
    expect(health.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('emits embed.action with the creating run as its cause', async () => {
    h = await bootService({ onboarded: true, watchFiles: false });
    h.fake.always({ text: 'built it' });
    const sent = h.service.chat.send({ text: 'build me a chart' });
    await drain(h);
    const run = h.service.repos.runs.forEvent(sent.eventId)[0]!;
    const created = h.service.embeds.create({
      title: 'Logger',
      html: PAGE,
      conversationId: sent.conversationId,
      runId: run.id,
    });
    if ('error' in created) throw new Error(created.message);

    const res = await fetch(
      `${h.baseUrl}/embed-api/${created.embed_id}/event?t=${token(created.url)}`,
      {
        method: 'POST',
        headers: { 'content-type': 'text/plain;charset=utf-8' },
        body: JSON.stringify({ action: 'logged', data: { reps: 12 } }),
      },
    );
    expect(await res.json()).toEqual({ accepted: true });
    await drain(h);

    const event = h.service.repos.events
      .recent({ limit: 20 })
      .find((row) => row.type === 'embed.action')!;
    expect(event.source).toBe(`embed.${created.embed_id}`);
    expect(event.serialization_key).toBe(created.embed_id);
    expect(event.payload).toMatchObject({
      embed_id: created.embed_id,
      action: 'logged',
      data: { reps: 12 },
    });
    // Lineage back to the run that authored the thing being clicked (§22.4).
    expect(event.caused_by).toBe(sent.eventId);
  });

  it('rate-limits a looping embed, and the accepted events dead-end', async () => {
    h = await bootService({ onboarded: true, watchFiles: false });
    const embed = makeEmbed(h);
    const url = `${h.baseUrl}/embed-api/${embed.embed_id}/event?t=${token(embed.url)}`;
    const codes: number[] = [];
    for (let i = 0; i < 25; i += 1) {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'text/plain;charset=utf-8' },
        body: JSON.stringify({ action: 'spam' }),
      });
      codes.push(res.status);
      if (res.status === 429) expect(await res.json()).toMatchObject({ accepted: false });
    }
    expect(codes.filter((c) => c === 200).length).toBeLessThanOrEqual(12);
    expect(codes).toContain(429);
    await drain(h);

    // Nothing is bound, so every accepted event ends as a matched-nothing event
    // rather than as work.
    const actions = h.service.repos.events
      .recent({ limit: 50 })
      .filter((e) => e.type === 'embed.action');
    expect(actions.length).toBeGreaterThan(0);
    for (const e of actions) expect(['done', 'received']).toContain(e.status);
  });

  it('refuses an event with no action, and a body that is not an object', async () => {
    h = await bootService({ onboarded: true, watchFiles: false });
    const embed = makeEmbed(h);
    const url = `${h.baseUrl}/embed-api/${embed.embed_id}/event?t=${token(embed.url)}`;
    const post = (body: string) =>
      fetch(url, { method: 'POST', headers: { 'content-type': 'text/plain' }, body });
    expect((await post(JSON.stringify({ data: 1 }))).status).toBe(400);
    expect((await post('[1,2]')).status).toBe(400);
  });
});

/* ── the chat surface (§22.6, App. D) ────────────────────────────────────── */

describe('embeds over the WS protocol (App. D)', () => {
  it('resolves a marker to a scoped url and counts it as a serve', async () => {
    h = await bootService({ onboarded: true, watchFiles: false });
    const embed = makeEmbed(h, { title: 'Dashboard' });
    expect(h.service.repos.embeds.get(embed.embed_id)!.last_served_at).toBeNull();

    const client = await TestClient.connect(h.baseUrl, h.token);
    await client.hello(['chat']);
    client.send('embed.resolve', { embed_id: embed.embed_id });
    const result = await client.next('embed.resolve.result');
    expect(result.payload).toMatchObject({
      embed_id: embed.embed_id,
      title: 'Dashboard',
      kind: 'ephemeral',
    });
    expect(result.payload.url).toContain('?t=');
    expect(h.service.repos.embeds.get(embed.embed_id)!.last_served_at).not.toBeNull();

    client.send('embed.resolve', { embed_id: '01MISSING' });
    expect((await client.next('error')).payload.code).toBe('not_found');
    client.close();
  });

  it('keeps an embed on the user’s say-so, and lists what is kept', async () => {
    h = await bootService({ onboarded: true, watchFiles: false });
    const embed = makeEmbed(h, { title: 'Keeper' });
    const client = await TestClient.connect(h.baseUrl, h.token);
    await client.hello(['chat']);

    client.send('embed.list', { kind: 'persistent' });
    expect((await client.next('embed.list.result')).payload.embeds).toEqual([]);

    client.send('embed.promote', { embed_id: embed.embed_id });
    expect((await client.next('embed.promoted')).payload).toMatchObject({
      embed_id: embed.embed_id,
      kind: 'persistent',
    });
    expect(fs.existsSync(h.app.home.path('embeds', `${embed.embed_id}.html`))).toBe(true);

    client.send('embed.list', { kind: 'persistent' });
    const listed = (await client.next('embed.list.result')).payload.embeds;
    expect(listed.map((e: { title: string }) => e.title)).toEqual(['Keeper']);
    client.close();
  });

  it('unkeeps on the user’s say-so, and drops it off the kept shelf', async () => {
    h = await bootService({ onboarded: true, watchFiles: false });
    const embed = makeEmbed(h, { title: 'Keeper' });
    const client = await TestClient.connect(h.baseUrl, h.token);
    await client.hello(['chat']);

    client.send('embed.promote', { embed_id: embed.embed_id });
    await client.next('embed.promoted');

    client.send('embed.demote', { embed_id: embed.embed_id });
    expect((await client.next('embed.demoted')).payload).toMatchObject({
      embed_id: embed.embed_id,
      kind: 'ephemeral',
    });
    expect(fs.existsSync(h.app.home.path('embeds', `${embed.embed_id}.html`))).toBe(false);
    expect(fs.existsSync(h.app.home.path('embeds', 'tmp', `${embed.embed_id}.html`))).toBe(
      true,
    );

    // The shelf is what the panel shows, so it has to be empty again.
    client.send('embed.list', { kind: 'persistent' });
    expect((await client.next('embed.list.result')).payload.embeds).toEqual([]);

    // Still resolvable: unkeeping is not deleting, and the link is unchanged.
    client.send('embed.resolve', { embed_id: embed.embed_id });
    expect((await client.next('embed.resolve.result')).payload).toMatchObject({
      embed_id: embed.embed_id,
      kind: 'ephemeral',
    });
    client.close();
  });

  it('rejects an unkeep with no embed_id, and one for an unknown embed', async () => {
    h = await bootService({ onboarded: true, watchFiles: false });
    const client = await TestClient.connect(h.baseUrl, h.token);
    await client.hello(['chat']);

    client.send('embed.demote', {});
    expect((await client.next('error')).payload.code).toBe('bad_frame');
    client.send('embed.demote', { embed_id: '01NOSUCHEMBED' });
    expect((await client.next('error')).payload.code).toBe('not_found');
    client.close();
  });

  /**
   * §22.6: iterating on an embed has to reach the frames already on screen.
   * The alternative is a chat showing last version's chart until reload, which
   * is indistinguishable from the edit having done nothing.
   */
  it('announces an edit to open chats, and stays quiet about state writes', async () => {
    h = await bootService({ onboarded: true, watchFiles: false });
    const embed = makeEmbed(h, { title: 'Chart' });
    const client = await TestClient.connect(h.baseUrl, h.token);
    await client.hello(['chat']);

    const edited = h.service.embeds.edit(embed.embed_id, 'nothing yet', 'something now');
    expect(edited).not.toHaveProperty('error');
    expect((await client.next('embed.changed')).payload).toEqual({ embed_id: embed.embed_id });

    // A pouch write is not a content change: an embed's own setState would
    // otherwise reload the page under the user on every click (§22.6).
    h.service.embeds.writeState(embed.embed_id, { tab: 'week' });
    await new Promise((r) => setTimeout(r, 50));
    expect(client.frames.filter((f) => f.type === 'embed.changed')).toHaveLength(0);
    client.close();
  });

  it('sends embed.changed only to chat-capable devices', async () => {
    h = await bootService({ onboarded: true, watchFiles: false });
    const embed = makeEmbed(h);
    const client = await TestClient.connect(h.baseUrl, h.token);
    await client.hello(['notify.actions']);

    h.service.embeds.edit(embed.embed_id, 'nothing yet', 'something else');
    await new Promise((r) => setTimeout(r, 50));
    expect(client.frames.filter((f) => f.type === 'embed.changed')).toHaveLength(0);
    client.close();
  });
});

/**
 * The chat UI's half of the isolation model, guarded as source text because the
 * failure it prevents is a one-word edit (§22.3.1). An embed frame with
 * `allow-same-origin` can read this page's localStorage — and the device token
 * lives there.
 */
/**
 * The views panel's unkeep affordance (§22.6), guarded as source text.
 *
 * Not by extracting `embedRow` and calling it: the architect already settled
 * that regex-lifting functions out of a 2700-line `app.js` is a test that
 * punishes formatting (JUDGMENT.md, 2026-08-22). What is worth pinning is the
 * wiring that would silently rot — the control existing only on kept rows, the
 * confirm before it, and the click not also jumping the transcript.
 */
describe('the views panel can unkeep what it lists (§22.6)', () => {
  const app = (): string => fs.readFileSync(new URL('../ui/app.js', import.meta.url), 'utf8');

  it('offers unkeep on kept rows only, and asks before doing it', () => {
    const source = app();
    // Only kept rows: an ephemeral view has no permanence to withdraw, and the
    // toolbar's "Keep" is the affordance there.
    expect(source).toContain(
      "if (info.kind === 'persistent') entry.append(unkeepButton(info))",
    );
    expect(source).toContain("send('embed.demote', { embed_id: info.embed_id })");
    // Asked, not done: the confirm is where the "this is not a delete"
    // distinction gets made to the person clicking.
    const button = source.slice(source.indexOf('function unkeepButton'));
    expect(button.slice(0, 1200)).toContain('confirmDialog');
    // A row in "in this conversation" is itself clickable; without this the
    // unkeep click would also scroll the transcript.
    expect(button.slice(0, 1200)).toContain('e.stopPropagation()');
  });

  it('re-resolves after either move, because both relocate the file', () => {
    // Promotion and demotion both change kind *and* path, so the client must
    // re-resolve rather than patch its cached url.
    const source = app();
    expect(source).toMatch(/case 'embed\.promoted':\s*\n\s*case 'embed\.demoted':/);
  });

  it('leaves embed frames out of the version-skew list, as promote does', () => {
    // `REQUIRED_FRAMES` is what the page insists an older server understands.
    // No embed frame is in it, so embeds degrade rather than block — adding
    // only `embed.demote` there would make unkeep stricter than keep.
    const required = /const REQUIRED_FRAMES = \[([\s\S]*?)\]/.exec(app())?.[1] ?? '';
    expect(required).not.toContain('embed.');
  });
});

describe('the chat UI never grants an embed the same origin', () => {
  it('mounts embeds with sandbox="allow-scripts" and nothing else', () => {
    const app = fs.readFileSync(new URL('../ui/app.js', import.meta.url), 'utf8');
    expect(app).toContain("frame.setAttribute('sandbox', 'allow-scripts')");
    expect(app.match(/setAttribute\('sandbox'/g)).toHaveLength(1);
    for (const file of ['app.js', 'index.html', 'style.css']) {
      const source = fs.readFileSync(new URL(`../ui/${file}`, import.meta.url), 'utf8');
      // Comments stripped: the files say the words "allow-same-origin" on
      // purpose, explaining why they never grant it.
      expect(stripComments(source)).not.toContain('allow-same-origin');
    }
  });
});

/* ── the scenarios from the phase exit criteria ──────────────────────────── */

describe('embeds end to end', () => {
  it('a click on a bound mini-app appends to a file, in one lineage', async () => {
    h = await bootService({ onboarded: true, watchFiles: false });
    h.fake.always({ text: 'built it' });
    const sent = h.service.chat.send({ text: 'build me a workout logger' });
    await drain(h);
    const run = h.service.repos.runs.forEvent(sent.eventId)[0]!;
    const embed = h.service.embeds.create({
      title: 'Workout logger',
      html: '<button onclick="turminder.event(\'logged\', {reps: 12})">log</button>',
      conversationId: sent.conversationId,
      runId: run.id,
    });
    if ('error' in embed) throw new Error(embed.message);

    write(
      h.app.home.path('handlers', 'workout-logger.md'),
      `---\nname: workout-logger\ndescription: Records a set logged from the workout embed.\nembed: ${embed.embed_id}\ntools: [files.append]\n---\n\nAppend one line to workout-log.md.\n`,
    );
    h.service.handlers.reload();

    let appended = false;
    h.fake.always((req) => {
      if (req.body.response_format) {
        return {
          text: JSON.stringify({
            summary: 'a set was logged',
            verdicts: [{ handler: 'workout-logger', matched: true, reason: 'its embed' }],
          }),
        };
      }
      if (req.body.tools && !appended) {
        appended = true;
        return {
          toolCalls: [
            {
              name: 'files.append',
              args: {
                path: 'workout-log.md',
                content: '- 12 reps\n',
                message: 'log a set from the workout embed',
              },
            },
          ],
        };
      }
      return { text: 'logged it' };
    });

    await fetch(`${h.baseUrl}/embed-api/${embed.embed_id}/event?t=${token(embed.url)}`, {
      method: 'POST',
      headers: { 'content-type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ action: 'logged', data: { reps: 12 } }),
    });
    await drain(h);

    expect(h.service.files.read('workout-log.md')).toMatchObject({
      content: expect.stringContaining('12 reps'),
    });
    // One lineage: the chat event caused the embed's event, which ran the handler.
    const action = h.service.repos.events
      .recent({ limit: 20 })
      .find((e) => e.type === 'embed.action')!;
    expect(action.caused_by).toBe(sent.eventId);
    const handlerRun = h.service.repos.runs
      .forEvent(action.id)
      .find((r) => r.handler_name === 'workout-logger');
    expect(handlerRun).toBeTruthy();
  });

  it('a second conversation renders the same embed rather than a duplicate', async () => {
    h = await bootService({ onboarded: true, watchFiles: false });
    h.fake.always({ text: 'built it' });
    const first = h.service.chat.send({ text: 'build me a dashboard' });
    await drain(h);
    const embed = makeEmbed(h, {
      title: 'Budget dashboard',
      conversationId: first.conversationId,
    });

    // A new conversation asks to see it: the list is the lookup (§22.2).
    const listed = h.service.repos.embeds.list({ query: 'budget' });
    expect(listed.map((r) => r.id)).toEqual([embed.embed_id]);

    const client = await TestClient.connect(h.baseUrl, h.token);
    await client.hello(['chat']);
    client.send('embed.resolve', { embed_id: embed.embed_id });
    await client.next('embed.resolve.result');
    client.close();
    // Still one embed, and now protected from the reaper by the serve.
    expect(h.service.repos.embeds.list({}).length).toBe(1);
    const served = h.service.repos.embeds.get(embed.embed_id)!.last_served_at!;
    expect(h.service.repos.embeds.reapable(served).map((r) => r.id)).toEqual([]);
  });
});

function token(url: string): string {
  return new URL(url, 'http://x').searchParams.get('t')!;
}

/** Crude but adequate for the three UI files: block, line, and HTML comments. */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/<!--[\s\S]*?-->/g, '');
}
