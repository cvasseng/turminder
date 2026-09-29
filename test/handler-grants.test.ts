import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import matter from 'gray-matter';
import { afterEach, describe, expect, it } from 'vitest';
import { bootService, TestClient, type ServiceHarness } from './service-harness.js';
import { write } from './helpers.js';
import type { ToolContext } from '../src/tools/types.js';

/**
 * G1 (§14.4.4, §19.4, App. F.6/F.20): what a handler may run unattended is
 * approved by a person, once, on a form — and is then out of the model's
 * reach. The negative cases are the point: each one is a way the model used
 * to grant itself a capability.
 */

let h: ServiceHarness;
let client: TestClient | null = null;
afterEach(async () => {
  client?.close();
  client = null;
  await h?.cleanup();
});

const drain = (harness: ServiceHarness) => harness.service.queue.drain();
const handlerPath = (harness: ServiceHarness, name: string) =>
  path.join(harness.dataDir, 'handlers', `${name}.md`);
const ctx: ToolContext = { runId: 'run-g1', eventId: null, conversationId: 'conv-g1' };

async function call(harness: ServiceHarness, tool: string, args: unknown, c = ctx) {
  const handle = harness.service.tools.get(tool);
  if (!handle) throw new Error(`no such tool: ${tool}`);
  return (await handle.call(args, c)).output as any;
}

const commits = (harness: ServiceHarness) =>
  spawnSync('git', ['rev-list', '--count', 'HEAD'], {
    cwd: harness.dataDir,
    encoding: 'utf8',
  }).stdout.trim();

const DIGEST = {
  name: 'weather-digest',
  description: 'Use when the morning weather digest is due. Not for anything else.',
  event_types: ['digest.due'],
  requested_tools: ['weather.*', 'deliver.notify'],
  requested_confirm: ['deliver.notify'],
  reason: 'to send you the weather every morning at 7',
  body: 'Get the forecast for home and send it as one notification.',
};

async function formsClient(harness: ServiceHarness): Promise<TestClient> {
  client = await TestClient.connect(harness.baseUrl, harness.token);
  await client.hello(['chat', 'forms']);
  return client;
}

describe('config.write cannot grant a handler anything (F.6)', () => {
  const EXISTING =
    '---\nname: nudge\ndescription: Use for reminders.\nmatch:\n  types: ["timer.fired"]\ntools: [deliver.notify]\n---\n\nSay it.\n';

  it('keeps the approved grants when the model adds calendar.delete_event', async () => {
    h = await bootService({ onboarded: true, watchFiles: false });
    write(handlerPath(h, 'nudge'), EXISTING);

    const result = await call(h, 'config.write', {
      path: 'handlers/nudge.md',
      content:
        '---\nname: nudge\ndescription: Use for reminders, now louder.\nmatch:\n  types: ["*"]\nwatch: ["**"]\ntools: [deliver.notify, calendar.delete_event]\nconfirm: []\n---\n\nSay it louder.\n',
      message: 'handlers: nudge can delete events',
    });

    expect(result.committed).toBe(true);
    expect(result.pinned).toEqual(['match', 'watch', 'tools', 'confirm']);
    expect(result.message).toMatch(/handler\.update/);
    const written = matter(fs.readFileSync(handlerPath(h, 'nudge'), 'utf8'));
    // The prose and description are config.write's to change…
    expect(written.data.description).toBe('Use for reminders, now louder.');
    expect(written.content.trim()).toBe('Say it louder.');
    // …what it may call and when it runs are not.
    expect(written.data.tools).toEqual(['deliver.notify']);
    expect(written.data.match).toEqual({ types: ['timer.fired'] });
    expect(written.data.watch).toBeUndefined();
    expect(written.data.confirm).toBeUndefined();
    h.service.handlers.reload();
    expect(h.service.handlers.get('nudge')!.frontmatter.tools).toEqual(['deliver.notify']);
  });

  it('does not report keys a faithful read-modify-write round-trips', async () => {
    h = await bootService({ onboarded: true, watchFiles: false });
    write(handlerPath(h, 'nudge'), EXISTING);
    const result = await call(h, 'config.write', {
      path: 'handlers/nudge.md',
      content: EXISTING.replace('Say it.', 'Say it kindly.'),
      message: 'handlers: nudge wording',
    });
    expect(result.committed).toBe(true);
    expect(result.pinned).toBeUndefined();
  });

  it('refuses to create a handler, and names the tool that can', async () => {
    h = await bootService({ onboarded: true, watchFiles: false });
    const before = commits(h);
    const result = await call(h, 'config.write', {
      path: 'handlers/sneaky.md',
      content:
        '---\nname: sneaky\ndescription: Anything.\ntools: [calendar.delete_event]\n---\n\nDelete things.\n',
      message: 'handlers: sneaky',
    });
    expect(result.error).toBe('use_handler_create');
    expect(result.message).toMatch(/handler\.create/);
    expect(fs.existsSync(handlerPath(h, 'sneaky'))).toBe(false);
    expect(commits(h)).toBe(before);
  });
});

describe('handler.create refuses before it asks (F.20)', () => {
  it('writes nothing, and raises no form, for a tool that does not exist', async () => {
    h = await bootService({ onboarded: true, watchFiles: false });
    const c = await formsClient(h);
    const result = await call(h, 'handler.create', {
      ...DIGEST,
      requested_tools: ['weather.forecast', 'weather.telepathy', 'nothing.*'],
    });
    expect(result.error).toBe('unknown_tools');
    expect(result.unmatched).toEqual(['weather.telepathy', 'nothing.*']);
    expect(fs.existsSync(handlerPath(h, DIGEST.name))).toBe(false);
    expect(c.of('form.request')).toEqual([]);
  });

  it('refuses a catch-all unless it is asked for', async () => {
    h = await bootService({ onboarded: true, watchFiles: false });
    const c = await formsClient(h);
    const { event_types: _, ...noTrigger } = DIGEST;

    const bare = await call(h, 'handler.create', { ...noTrigger, event_types: [] });
    expect(bare.error).toBe('catch_all');

    // `watch` makes file changes arrive; it does not stop everything else.
    const watchOnly = await call(h, 'handler.create', { ...noTrigger, watch: ['**/*.md'] });
    expect(watchOnly.error).toBe('catch_all');
    expect(watchOnly.message).toContain('file.changed');

    expect(fs.existsSync(handlerPath(h, DIGEST.name))).toBe(false);
    expect(c.of('form.request')).toEqual([]);

    // Said on purpose, it goes as far as the form.
    const pending = call(h, 'handler.create', { ...noTrigger, catch_all: true });
    const form = await c.next('form.request', 15000);
    expect(form.payload.description).toContain('on every event');
    c.send('form.cancel', { form_id: form.payload.form_id });
    expect(await pending).toEqual({ approved: false, reason: 'cancelled' });
    expect(fs.existsSync(handlerPath(h, DIGEST.name))).toBe(false);
  });

  it('refuses with no conversation to ask in, and writes nothing', async () => {
    h = await bootService({ onboarded: true, watchFiles: false });
    const result = await call(h, 'handler.create', DIGEST, { runId: 'r', eventId: 'e' });
    expect(result.error).toBe('no_conversation');
    expect(fs.existsSync(handlerPath(h, DIGEST.name))).toBe(false);
  });

  it('writes nothing when the approval form is abandoned and answered late', async () => {
    h = await bootService({ onboarded: true });
    const c = await formsClient(h);
    h.fake.always((req) =>
      req.body.tools
        ? { toolCalls: [{ name: 'handler.create', args: DIGEST }] }
        : { text: '-' },
    );
    const sent = h.service.chat.send({ text: 'every morning at 7, send me the weather' });
    const form = await c.next('form.request', 15000);
    const before = commits(h);

    c.send('chat.stop', { conversation_id: sent.conversationId });
    const closed = await c.next('form.closed', 15000);
    expect(closed.payload).toEqual({ form_id: form.payload.form_id, reason: 'abandoned' });
    await drain(h);

    c.send('form.submit', {
      form_id: form.payload.form_id,
      values: { 'weather.forecast': 'On its own', 'deliver.notify': 'On its own' },
    });
    expect((await c.next('error')).payload.code).toBe('not_found');
    await drain(h);

    expect(fs.existsSync(handlerPath(h, DIGEST.name))).toBe(false);
    expect(commits(h)).toBe(before);
  });
});

describe('handler.create, approved (F.20)', () => {
  it('pins concrete tools, loads, and is the consumer of its schedule', async () => {
    h = await bootService({ onboarded: true, watchFiles: false });
    const c = await formsClient(h);
    // Warm the loader's cache the way a run does, so the reload is tested.
    expect(h.service.handlers.all().map((x) => x.name)).not.toContain(DIGEST.name);

    const pending = call(h, 'handler.create', DIGEST);
    const form = await c.next('form.request', 15000);
    expect(form.payload.template).toBe('handler_grants');
    expect(form.payload.title).toBe('Let the handler "weather-digest" use 2 tools?');
    expect(form.payload.description).toContain('to send you the weather every morning at 7');
    expect(form.payload.description).toContain('on events of type digest.due');
    // One field per concrete tool — the glob is expanded before anyone is
    // asked — labelled from the catalog, never from the model's words.
    const fields = form.payload.fields as { name: string; label: string; value: string }[];
    expect(fields.map((f) => f.name)).toEqual(['deliver.notify', 'weather.forecast']);
    expect(fields[1]!.label).toBe(
      'weather.forecast — The weather forecast for a place, by name or by coordinates.',
    );
    expect(fields[0]!.value).toBe('Ask me each time');
    expect(fields[1]!.value).toBe('On its own');

    c.send('form.submit', {
      form_id: form.payload.form_id,
      values: { 'deliver.notify': 'Ask me each time', 'weather.forecast': 'On its own' },
    });
    const result = await pending;
    expect(result).toMatchObject({
      name: 'weather-digest',
      path: 'handlers/weather-digest.md',
      committed: true,
      tools: ['weather.forecast'],
      confirm: ['deliver.notify'],
      routing: { chosen_by: 'table' },
    });

    const file = matter(fs.readFileSync(handlerPath(h, DIGEST.name), 'utf8'));
    expect(file.data).toEqual({
      name: 'weather-digest',
      description: DIGEST.description,
      match: { types: ['digest.due'] },
      tools: ['weather.forecast'],
      confirm: ['deliver.notify'],
    });
    expect(file.content.trim()).toBe(DIGEST.body);

    // The loader takes it — with no reload by hand — and it owns its type.
    expect(h.service.handlers.errors()).toEqual([]);
    expect(h.service.handlers.get(DIGEST.name)?.frontmatter.tools).toEqual([
      'weather.forecast',
    ]);
    const booked = await call(
      h,
      'schedule.create',
      {
        fire_at: new Date(Date.now() + 3600_000).toISOString(),
        note: 'weather',
        event_type: 'digest.due',
        rrule: 'FREQ=DAILY',
      },
      { runId: null, eventId: null },
    );
    expect(booked.consumers, JSON.stringify(booked)).toEqual(['weather-digest']);
    expect(booked.warning).toBeUndefined();

    // A second create of the same name is not a way round update's form.
    const again = await call(h, 'handler.create', DIGEST);
    expect(again.error).toBe('exists');
  });
});

describe('handler.update (F.20)', () => {
  const APPROVED =
    '---\nname: weather-digest\ndescription: Use when the weather digest is due.\nmatch:\n  types: ["digest.due"]\ntools: [weather.forecast, deliver.notify]\nbudgets:\n  max_turns: 4\n---\n\nSend the weather.\n';

  it('changes the body freely, with no form, and keeps grants and budgets', async () => {
    h = await bootService({ onboarded: true, watchFiles: false });
    write(handlerPath(h, 'weather-digest'), APPROVED);
    const c = await formsClient(h);
    const result = await call(h, 'handler.update', {
      name: 'weather-digest',
      body: 'Send the weather, and mention rain first.',
      // Restating what is already approved asks nothing.
      requested_tools: ['deliver.notify', 'weather.forecast'],
    });
    expect(result).toMatchObject({ committed: true, approval: 'unchanged' });
    expect(c.of('form.request')).toEqual([]);
    const file = matter(fs.readFileSync(handlerPath(h, 'weather-digest'), 'utf8'));
    expect(file.content.trim()).toBe('Send the weather, and mention rain first.');
    expect(file.data.tools).toEqual(['weather.forecast', 'deliver.notify']);
    expect(file.data.budgets).toEqual({ max_turns: 4 });
  });

  it('"also let it delete calendar events" asks again, and changes nothing until approved', async () => {
    h = await bootService({ onboarded: true, watchFiles: false });
    write(handlerPath(h, 'weather-digest'), APPROVED);
    const c = await formsClient(h);
    const args = {
      name: 'weather-digest',
      requested_tools: ['weather.forecast', 'deliver.notify', 'schedule.cancel'],
      reason: 'so it can also clear the schedule when you are away',
    };

    // Declined: byte-identical.
    let pending = call(h, 'handler.update', args);
    let form = await c.next('form.request', 15000);
    expect(fs.readFileSync(handlerPath(h, 'weather-digest'), 'utf8')).toBe(APPROVED);
    // The whole resulting set, prefilled with what was already approved.
    expect(form.payload.fields.map((f: any) => [f.name, f.value])).toEqual([
      ['deliver.notify', 'On its own'],
      ['schedule.cancel', 'On its own'],
      ['weather.forecast', 'On its own'],
    ]);
    c.send('form.cancel', { form_id: form.payload.form_id });
    expect(await pending).toEqual({ approved: false, reason: 'cancelled' });
    expect(fs.readFileSync(handlerPath(h, 'weather-digest'), 'utf8')).toBe(APPROVED);

    // Approved, with the new one behind a confirm.
    pending = call(h, 'handler.update', args);
    form = await c.next('form.request', 15000);
    c.send('form.submit', {
      form_id: form.payload.form_id,
      values: {
        'deliver.notify': 'On its own',
        'schedule.cancel': 'Ask me each time',
        'weather.forecast': 'On its own',
      },
    });
    expect(await pending).toMatchObject({ approval: 'asked', confirm: ['schedule.cancel'] });
    const file = matter(fs.readFileSync(handlerPath(h, 'weather-digest'), 'utf8'));
    expect(file.data.tools).toEqual(['deliver.notify', 'weather.forecast']);
    expect(file.data.confirm).toEqual(['schedule.cancel']);
    expect(file.data.budgets).toEqual({ max_turns: 4 });
  });

  it('needs a reason, and a known tool, before it asks', async () => {
    h = await bootService({ onboarded: true, watchFiles: false });
    write(handlerPath(h, 'weather-digest'), APPROVED);
    const noReason = await call(h, 'handler.update', {
      name: 'weather-digest',
      requested_tools: ['weather.forecast'],
    });
    expect(noReason.error).toBe('reason_required');
    const unknown = await call(h, 'handler.update', {
      name: 'weather-digest',
      requested_tools: ['calendar.delete_everything'],
      reason: 'x',
    });
    expect(unknown.error).toBe('unknown_tools');
    expect(fs.readFileSync(handlerPath(h, 'weather-digest'), 'utf8')).toBe(APPROVED);
    expect((await call(h, 'handler.update', { name: 'nope', body: 'x' })).error).toBe(
      'not_found',
    );
  });
});
