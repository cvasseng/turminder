import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { bootService, TestClient, type ServiceHarness } from './service-harness.js';
import { GrantedDispatcher } from '../src/tools/dispatcher.js';
import { isoPlusSeconds } from '../src/core/time.js';
import { write } from './helpers.js';

/**
 * §7.1: `expires_at` bounds interrupting, not existing. A notify nobody was
 * connected to see is `missed`, and arrives on the next hello as one quiet
 * list for the drawer — never as a toast. The case this exists for was found
 * live: five mornings of digests, each expired unseen while no client was up.
 */
let h: ServiceHarness;
afterEach(async () => {
  await h?.cleanup();
});

const UI_CAPS = ['chat', 'notify.actions', 'forms', 'files'];
const HOUR = 3600;

/** Moves a delivery's clock back, as though `hours` had passed since it was queued. */
function age(harness: ServiceHarness, id: string, hours: number): void {
  const row = harness.service.repos.deliveries.get(id)!;
  const lifeS = (Date.parse(row.expires_at) - Date.parse(row.created_at)) / 1000;
  harness.app.db
    .prepare(`UPDATE deliveries SET created_at = ?, expires_at = ? WHERE id = ?`)
    .run(isoPlusSeconds(-hours * HOUR), isoPlusSeconds(lifeS - hours * HOUR), id);
}

const settle = () => new Promise((r) => setTimeout(r, 150));

/** A daily digest fired by the real scheduler, handled by the shipped `scheduled-task`. */
async function fireDigest(harness: ServiceHarness, rrule = 'FREQ=DAILY') {
  const schedule = harness.service.repos.schedules.create({
    fireAt: isoPlusSeconds(-1),
    note: 'morning digest',
    rrule,
  });
  let called = false;
  harness.fake.always((req) => {
    if (req.body.response_format) {
      return {
        text: JSON.stringify({
          summary: 'a digest is due',
          verdicts: [{ handler: 'scheduled-task', matched: true, reason: 'the note says so' }],
        }),
      };
    }
    if (req.body.tools && !called) {
      called = true;
      return {
        toolCalls: [
          { name: 'deliver.notify', args: { title: 'Good morning', body: 'Sun, then rain.' } },
        ],
      };
    }
    return { text: 'Sent.' };
  });
  expect(harness.service.scheduler.tick()).toBe(1);
  await harness.service.queue.drain(15_000);
  const [delivery] = harness.service.repos.deliveries
    .recent(10)
    .filter((d) => d.intent === 'notify');
  expect(delivery, 'the digest run should have queued a notify').toBeTruthy();
  return { schedule, delivery: delivery! };
}

describe('a notification nobody saw is missed, not expired (§7.1)', () => {
  it('shows a digest fired with nobody connected, 30h later, in one quiet list', async () => {
    h = await bootService({ onboarded: true, runScheduler: false });
    const { delivery } = await fireDigest(h);
    expect(h.service.repos.deliveries.get(delivery.id)?.status).toBe('queued');

    // Thirty hours pass with the lid shut. Its day-long life ran out at 24h.
    age(h, delivery.id, 30);
    const client = await TestClient.connect(h.baseUrl, h.token);
    const welcome = await client.hello(UI_CAPS);
    expect(welcome.payload.replay_count).toBe(0);

    const missed = await client.next('delivery.missed');
    const entries = missed.payload.deliveries as any[];
    expect(entries).toHaveLength(1);
    expect(entries[0].delivery_id).toBe(delivery.id);
    expect(entries[0].intent).toBe('notify');
    expect(entries[0].payload).toEqual({ title: 'Good morning', body: 'Sun, then rain.' });
    expect(typeof entries[0].created_at).toBe('string');
    expect(h.service.repos.deliveries.get(delivery.id)?.status).toBe('missed');

    // No toast: nothing arrived as a `delivery` frame.
    await settle();
    expect(client.of('delivery')).toHaveLength(0);
    client.close();
  });

  it('acks a missed delivery once it is read, and stops listing it', async () => {
    h = await bootService({ onboarded: true, runScheduler: false });
    const { delivery } = await fireDigest(h);
    age(h, delivery.id, 30);

    const first = await TestClient.connect(h.baseUrl, h.token);
    await first.hello(UI_CAPS);
    await first.next('delivery.missed');
    first.send('ack', { delivery_id: delivery.id });
    await settle();
    const acked = h.service.repos.deliveries.get(delivery.id)!;
    expect(acked.status).toBe('acked');
    expect(acked.acked_by).toBe('ui');
    first.close();

    const second = await TestClient.connect(h.baseUrl, h.token);
    await second.hello(UI_CAPS);
    await settle();
    expect(second.of('delivery.missed')).toHaveLength(0);
    second.close();
  });

  it('ignores last_seen: an old missed row is not hidden behind a newer ack', async () => {
    h = await bootService({ onboarded: true, runScheduler: false });
    const { delivery } = await fireDigest(h);
    age(h, delivery.id, 30);
    const client = await TestClient.connect(h.baseUrl, h.token);
    client.send('hello', {
      device: 'ui',
      capabilities: UI_CAPS,
      last_seen: delivery.seq + 10,
    });
    await client.next('welcome');
    const missed = await client.next('delivery.missed');
    expect((missed.payload.deliveries as any[]).map((d) => d.delivery_id)).toEqual([
      delivery.id,
    ]);
    client.close();
  });

  it('sends the list only to chat-capable devices — a notifier has no drawer', async () => {
    h = await bootService({ onboarded: true, runScheduler: false });
    const { delivery } = await fireDigest(h);
    age(h, delivery.id, 30);
    const client = await TestClient.connect(h.baseUrl, h.token);
    await client.hello(['notify.actions']);
    await settle();
    expect(client.of('delivery.missed')).toHaveLength(0);
    expect(client.of('delivery')).toHaveLength(0);
    // Still waiting for a device that can show it.
    expect(h.service.repos.deliveries.get(delivery.id)?.status).toBe('missed');
    client.close();
  });

  it('expires a notify that was delivered and never acked — a channel showed it', async () => {
    h = await bootService({ onboarded: true });
    const run = h.service.repos.runs.create({ kind: 'handler', handlerName: 'test' });
    const delivery = h.service.repos.deliveries.create({
      intent: 'notify',
      payload: { title: 'Shown', body: 'once' },
      ttlS: 60,
      createdByRun: run,
    });
    h.service.repos.deliveries.markDelivered(delivery.id);
    age(h, delivery.id, 2);
    h.service.repos.deliveries.expireStale();
    expect(h.service.repos.deliveries.get(delivery.id)?.status).toBe('expired');
    expect(h.service.repos.deliveries.missed()).toHaveLength(0);
  });
});

describe('a confirm nobody answered stays expired, and denied (§11.3)', () => {
  it('is never offered late, and the gated call never happens', async () => {
    h = await bootService({ onboarded: true, dataDefaults: { confirm_timeout_s: 1 } });
    write(
      path.join(h.dataDir, 'handlers', 'sender.md'),
      `---\nname: sender\ndescription: Use for anything that needs sending.\nconfirm: [deliver.notify]\n---\n\nSend it.\n`,
    );
    let called = false;
    h.fake.always((req) => {
      if (req.body.response_format) {
        return {
          text: JSON.stringify({
            summary: 'x',
            verdicts: [{ handler: 'sender', matched: true, reason: 'yes' }],
          }),
        };
      }
      if (req.body.tools && !called) {
        called = true;
        return { toolCalls: [{ name: 'deliver.notify', args: { title: 'x', body: 'y' } }] };
      }
      return { text: 'nobody answered' };
    });
    const submitted = h.service.intake.submit({
      type: 'webhook.send',
      source: 'http',
      payload: {},
    });
    await h.service.queue.drain(30_000);

    const confirm = h.service.repos.deliveries.recent(10).find((d) => d.intent === 'confirm')!;
    expect(confirm.status).toBe('queued');
    age(h, confirm.id, 30);

    const client = await TestClient.connect(h.baseUrl, h.token);
    const welcome = await client.hello(UI_CAPS);
    expect(welcome.payload.replay_count).toBe(0);
    await settle();
    expect(client.of('delivery')).toHaveLength(0);
    expect(client.of('delivery.missed')).toHaveLength(0);
    expect(h.service.repos.deliveries.get(confirm.id)?.status).toBe('expired');

    // An ack cannot turn an expired approval into anything else.
    client.send('ack', { delivery_id: confirm.id });
    await settle();
    expect(h.service.repos.deliveries.get(confirm.id)?.status).toBe('expired');

    // Silence was the deny: the gated notify was never queued.
    const toolCall = h.service.repos.trace
      .forEvent(submitted.event.id)
      .filter((t) => t.kind === 'tool_call')
      .map((t) => t.data as any)[0];
    expect(toolCall.denied).toBe('confirm_denied');
    expect(h.service.repos.deliveries.recent(10).filter((d) => d.intent === 'notify')).toEqual(
      [],
    );
    client.close();
  });
});

describe('scheduled work lives until its next occurrence (§7.1)', () => {
  /** A notify dispatched as a run handling `eventId` would dispatch it. */
  const notifyFor = async (eventId: string | null, args: Record<string, unknown>) => {
    const run = h.service.repos.runs.create({ kind: 'handler', handlerName: 'test' });
    const d = new GrantedDispatcher(
      h.service.tools.handles(),
      { tools: ['deliver.*'] },
      { runId: run, eventId },
    );
    const result = await d.dispatch({ toolCallId: '1', name: 'deliver.notify', args });
    return h.service.repos.deliveries.get((result.output as any).delivery_id)!;
  };
  const lifeS = (d: { created_at: string; expires_at: string }) =>
    (Date.parse(d.expires_at) - Date.parse(d.created_at)) / 1000;

  it("defaults a scheduler-origin notify's TTL to the schedule's next occurrence", async () => {
    h = await bootService({ onboarded: true, runScheduler: false });
    // Every six hours, so the schedule's answer and the 24h default differ.
    const { schedule, delivery } = await fireDigest(h, 'FREQ=HOURLY;INTERVAL=6');
    const advanced = h.service.repos.schedules.get(schedule.id)!;
    expect(advanced.fire_at).not.toBe(schedule.fire_at);
    expect(Math.round(lifeS(delivery) / HOUR)).toBe(6);
    // To the second: the delivery lives exactly until the next digest.
    expect(
      Math.abs(Date.parse(delivery.expires_at) - Date.parse(advanced.fire_at)),
    ).toBeLessThan(2000);
  });

  it('uses the ordinary default for a one-shot, and for a non-scheduler event', async () => {
    h = await bootService({ onboarded: true, runScheduler: false });
    const oneShot = h.service.repos.schedules.create({
      fireAt: isoPlusSeconds(-1),
      note: 'once',
    });
    h.fake.always(() => ({ text: 'nothing to do' }));
    expect(h.service.scheduler.tick()).toBe(1);
    const fired = h.service.repos.events
      .recent({ limit: 5 })
      .find((e) => (e.payload as any)?.schedule_id === oneShot.id)!;
    expect(h.service.repos.schedules.get(oneShot.id)?.status).toBe('done');
    const day = h.app.config.settings.notifyTtlS;
    expect(Math.round(lifeS(await notifyFor(fired.id, { title: 'a', body: 'b' })))).toBe(day);

    const http = h.service.intake.submit({ type: 'webhook.send', source: 'http', payload: {} });
    expect(Math.round(lifeS(await notifyFor(http.event.id, { title: 'a', body: 'b' })))).toBe(
      day,
    );
  });

  it('honours an explicit ttl_s, shorter included, on a scheduler-origin run', async () => {
    h = await bootService({ onboarded: true, runScheduler: false });
    h.service.repos.schedules.create({
      fireAt: isoPlusSeconds(-1),
      note: 'standup in ten minutes',
      rrule: 'FREQ=DAILY',
    });
    h.fake.always(() => ({ text: 'nothing to do' }));
    expect(h.service.scheduler.tick()).toBe(1);
    const fired = h.service.repos.events
      .recent({ limit: 5 })
      .find((e) => e.source === 'scheduler')!;
    const delivery = await notifyFor(fired.id, { title: 'Standup', body: 'now', ttl_s: 600 });
    expect(Math.round(lifeS(delivery))).toBe(600);

    // And past it, unseen, it is missed rather than gone.
    age(h, delivery.id, 1);
    h.service.repos.deliveries.expireStale();
    expect(h.service.repos.deliveries.get(delivery.id)?.status).toBe('missed');
  });
});
