import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { bootService, postJson, TestClient, type ServiceHarness } from './service-harness.js';
import { GrantedDispatcher } from '../src/tools/dispatcher.js';
import type { DeliveryFrame, RenderOutcome, Renderer } from '../daemon/lib.js';
import { write } from './helpers.js';

let h: ServiceHarness;
afterEach(async () => {
  await h?.cleanup();
});

const drain = (harness: ServiceHarness) => harness.service.queue.drain();

const notify = async (
  harness: ServiceHarness,
  args: Record<string, unknown>,
  runId?: string,
) => {
  // A real run row: deliveries.created_by_run is a foreign key, deliberately.
  const run =
    runId ?? harness.service.repos.runs.create({ kind: 'handler', handlerName: 'test' });
  const d = new GrantedDispatcher(
    harness.service.tools.handles(),
    { tools: ['deliver.*'] },
    {
      runId: run,
      eventId: null,
    },
  );
  return d.dispatch({ toolCallId: '1', name: 'deliver.notify', args });
};

/** A renderer that records what it was shown and clicks what it is told to. */
class ScriptedRenderer implements Renderer {
  readonly shown: DeliveryFrame[] = [];
  constructor(
    private readonly click: (d: DeliveryFrame) => string | null = () => null,
    private readonly canShow = true,
  ) {}
  async show(delivery: DeliveryFrame): Promise<RenderOutcome> {
    this.shown.push(delivery);
    if (!this.canShow) return { shown: false, reason: 'no notifier here' };
    return { shown: true, action: this.click(delivery) };
  }
}

describe('delivery outbox (§7.1)', () => {
  it('queues a notification durably, even with nobody connected', async () => {
    h = await bootService({ onboarded: true });
    const result = await notify(h, { title: 'Bins', body: 'Take them out' });
    expect(result.ok).toBe(true);
    const id = (result.output as any).delivery_id as string;

    const stored = h.service.repos.deliveries.get(id)!;
    expect(stored.intent).toBe('notify');
    expect(stored.status).toBe('queued');
    expect(stored.payload).toEqual({ title: 'Bins', body: 'Take them out' });
    expect(Date.parse(stored.expires_at)).toBeGreaterThan(Date.now());
    expect(h.service.repos.deliveries.pending()).toHaveLength(1);
  });

  it('records the delivery on the trace of the run that sent it', async () => {
    h = await bootService({ onboarded: true });
    const runId = h.service.repos.runs.create({ kind: 'handler', handlerName: 'x' });
    const result = await notify(h, { title: 'A', body: 'B' }, runId);
    const rows = h.service.repos.trace.forRun(runId).filter((t) => t.kind === 'delivery');
    expect(rows).toHaveLength(1);
    expect((rows[0]?.data as any).delivery_id).toBe((result.output as any).delivery_id);
  });

  it('honours a per-delivery ttl and expires stale ones', async () => {
    h = await bootService({ onboarded: true });
    const result = await notify(h, { title: 'Soon', body: 'gone', ttl_s: 1 });
    const id = (result.output as any).delivery_id as string;
    h.app.db
      .prepare(`UPDATE deliveries SET expires_at = '2020-01-01T00:00:00.000Z' WHERE id = ?`)
      .run(id);
    expect(h.service.repos.deliveries.expireStale()).toBe(1);
    expect(h.service.repos.deliveries.get(id)?.status).toBe('expired');
    expect(h.service.repos.deliveries.pending()).toHaveLength(0);
  });

  it('delivers to a connected channel and settles on ack', async () => {
    h = await bootService({ onboarded: true });
    const client = await TestClient.connect(h.baseUrl, h.token);
    await client.hello(['notify.actions']);

    const result = await notify(h, { title: 'Now', body: 'while you watch' });
    const id = (result.output as any).delivery_id as string;
    const frame = await client.next('delivery');
    expect(frame.payload.delivery_id).toBe(id);
    expect(frame.payload.intent).toBe('notify');
    expect(frame.payload.payload.title).toBe('Now');
    expect(typeof frame.payload.seq).toBe('number');
    expect(h.service.repos.deliveries.get(id)?.status).toBe('delivered');

    client.send('ack', { delivery_id: id });
    await new Promise((r) => setTimeout(r, 100));
    const acked = h.service.repos.deliveries.get(id)!;
    expect(acked.status).toBe('acked');
    expect(acked.acked_by).toBe('ui');
    client.close();
  });

  it('replays unexpired deliveries on reconnect and drops expired ones', async () => {
    h = await bootService({ onboarded: true });
    const fresh = (await notify(h, { title: 'Fresh', body: 'still useful' })).output as any;
    const stale = (await notify(h, { title: 'Stale', body: 'meeting in 10 minutes' }))
      .output as any;
    h.app.db
      .prepare(`UPDATE deliveries SET expires_at = '2020-01-01T00:00:00.000Z' WHERE id = ?`)
      .run(stale.delivery_id);

    // A device that has never acked anything asks for everything.
    const client = await TestClient.connect(h.baseUrl, h.token);
    const welcome = await client.hello(['notify.actions']);
    expect(welcome.payload.replay_count).toBe(1);
    const replayed = await client.next('delivery');
    expect(replayed.payload.delivery_id).toBe(fresh.delivery_id);
    await new Promise((r) => setTimeout(r, 100));
    expect(client.of('delivery')).toHaveLength(0);
    expect(h.service.repos.deliveries.get(stale.delivery_id)?.status).toBe('expired');
    client.close();
  });

  it('replays only what a device has not seen', async () => {
    h = await bootService({ onboarded: true });
    const first = (await notify(h, { title: 'One', body: '1' })).output as any;
    const second = (await notify(h, { title: 'Two', body: '2' })).output as any;
    const firstSeq = h.service.repos.deliveries.get(first.delivery_id)!.seq;

    const client = await TestClient.connect(h.baseUrl, h.token);
    client.send('hello', {
      device: 'ui',
      capabilities: ['notify.actions'],
      last_seen: firstSeq,
    });
    await client.next('welcome');
    const replayed = await client.next('delivery');
    expect(replayed.payload.delivery_id).toBe(second.delivery_id);
    client.close();
  });

  it('does not send action notifications to a channel that cannot render them', async () => {
    h = await bootService({ onboarded: true });
    const client = await TestClient.connect(h.baseUrl, h.token);
    await client.hello(['chat']);
    await notify(h, {
      title: 'Decide',
      body: 'yes or no',
      actions: [{ id: 'yes', label: 'Yes' }],
    });
    await new Promise((r) => setTimeout(r, 100));
    expect(client.of('delivery')).toHaveLength(0);
    client.close();
  });

  it('turns a clicked action into an event', async () => {
    h = await bootService({ onboarded: true });
    const client = await TestClient.connect(h.baseUrl, h.token);
    await client.hello(['notify.actions']);
    const result = (
      await notify(h, {
        title: 'Bins',
        body: 'Now?',
        actions: [{ id: 'done', label: 'Done' }],
      })
    ).output as any;
    await client.next('delivery');
    client.send('event', {
      type: 'notification.action',
      payload: { delivery_id: result.delivery_id, action: 'done' },
    });
    const accepted = await client.next('event.accepted');
    const event = h.service.repos.events.get(accepted.payload.event_id)!;
    expect(event.type).toBe('notification.action');
    expect(event.source).toBe('ui');
    client.close();
  });
});

describe('confirm round-trip (§7.3, §11.3)', () => {
  const handler = (frontmatter: string) =>
    `---\nname: sender\ndescription: Use for anything that needs sending.\n${frontmatter}---\n\nSend it.\n`;

  it('gates a confirm-tier tool on a real approval', async () => {
    h = await bootService({ onboarded: true });
    write(
      path.join(h.dataDir, 'handlers', 'sender.md'),
      handler('confirm: [deliver.notify]\n'),
    );
    const client = await TestClient.connect(h.baseUrl, h.token);
    await client.hello(['notify.actions']);

    let toolCallsDone = false;
    h.fake.always((req) => {
      if (req.body.response_format) {
        return {
          text: JSON.stringify({
            summary: 'something to send',
            verdicts: [{ handler: 'sender', matched: true, reason: 'needs sending' }],
          }),
        };
      }
      if (req.body.tools && !toolCallsDone) {
        toolCallsDone = true;
        return {
          toolCalls: [{ name: 'deliver.notify', args: { title: 'Sent', body: 'the thing' } }],
        };
      }
      return { text: 'Sent it after you approved.' };
    });

    const submitted = h.service.intake.submit({
      type: 'webhook.send',
      source: 'http',
      payload: { what: 'a thing' },
    });

    // The run suspends on a confirm delivery.
    const confirmFrame = await client.next('delivery', 15000);
    expect(confirmFrame.payload.intent).toBe('confirm');
    expect(confirmFrame.payload.payload.tool).toBe('deliver.notify');
    expect(confirmFrame.payload.payload.actions.map((a: any) => a.id)).toEqual([
      'approve',
      'deny',
    ]);
    const runId = confirmFrame.payload.payload.run_id as string;
    expect(h.service.confirm.waiting).toBe(1);

    client.send('event', {
      type: 'notification.action',
      payload: {
        delivery_id: confirmFrame.payload.delivery_id,
        action: 'approve',
        run_id: runId,
      },
    });
    await drain(h);

    // The gated call went through, and the notification it wanted was queued.
    const notifications = h.service.repos.deliveries
      .recent(10)
      .filter((d) => d.intent === 'notify');
    expect(notifications).toHaveLength(1);
    expect((notifications[0]?.payload as any).title).toBe('Sent');
    expect(h.service.repos.events.get(submitted.event.id)?.status).toBe('done');
    expect(h.service.confirm.waiting).toBe(0);
    client.close();
  });

  it('describes the call in words, and never leaks a secret reference', async () => {
    // §7.3/§11.3: the server writes what the human reads. The model here does
    // what a model legitimately does with a credential — passes the reference
    // it was handed (§19.2) straight into a call — and the dialog, the stored
    // delivery and the trace all have to survive that.
    h = await bootService({ onboarded: true });
    write(
      path.join(h.dataDir, 'handlers', 'sender.md'),
      handler('confirm: [deliver.notify]\n'),
    );
    const client = await TestClient.connect(h.baseUrl, h.token);
    await client.hello(['notify.actions']);

    let toolCallsDone = false;
    h.fake.always((req) => {
      if (req.body.response_format) {
        return {
          text: JSON.stringify({
            summary: 'something to send',
            verdicts: [{ handler: 'sender', matched: true, reason: 'needs sending' }],
          }),
        };
      }
      if (req.body.tools && !toolCallsDone) {
        toolCallsDone = true;
        return {
          toolCalls: [
            {
              name: 'deliver.notify',
              args: { title: 'Sent', body: 'token is ${secret:ASANA_TOKEN}' },
            },
          ],
        };
      }
      return { text: 'Sent it after you approved.' };
    });

    const submitted = h.service.intake.submit({
      type: 'webhook.send',
      source: 'http',
      payload: { what: 'a thing' },
    });

    const frame = await client.next('delivery', 15000);
    const payload = frame.payload.payload as any;

    // A sentence naming who is asking and what for — not the tool name with
    // the dot left in, and not a serialized argument object.
    expect(payload.title).toMatch(/^Handler sender wants to /);
    expect(payload.title).not.toContain('deliver.notify');
    expect(payload.details.map((d: any) => d.label)).toEqual(['Title', 'Body']);
    expect(`${payload.title}\n${payload.args_summary}`).not.toMatch(/[{}[\]"]/);

    // Gone from what the human reads, and from the row that outlives it.
    for (const surface of [
      JSON.stringify(payload),
      JSON.stringify(h.service.repos.deliveries.recent(10)),
    ]) {
      expect(surface).not.toContain('ASANA_TOKEN');
      expect(surface).not.toContain('$\u007bsecret:');
    }
    expect(payload.args_summary).toContain('(a stored secret)');

    client.send('event', {
      type: 'notification.action',
      payload: {
        delivery_id: frame.payload.delivery_id,
        action: 'deny',
        run_id: payload.run_id,
      },
    });
    await drain(h);

    // The trace is the other side of the same rule, and it keeps the
    // reference: `${secret:KEY}` is not a secret (§27, G.6) — it is the name
    // of one, which is what makes "which credential did this call use" an
    // answerable question ninety days later. Masking here would delete
    // forensics to hide something that already lives in `models.yaml`, in git.
    const traced = JSON.stringify(h.service.repos.trace.forEvent(submitted.event.id));
    expect(traced).toContain('ASANA_TOKEN');
    client.close();
  });

  it('denies the call when the user clicks deny, and the run carries on', async () => {
    h = await bootService({ onboarded: true });
    write(
      path.join(h.dataDir, 'handlers', 'sender.md'),
      handler('confirm: [deliver.notify]\n'),
    );
    const client = await TestClient.connect(h.baseUrl, h.token);
    await client.hello(['notify.actions']);

    let toolCallsDone = false;
    h.fake.always((req) => {
      if (req.body.response_format) {
        return {
          text: JSON.stringify({
            summary: 'x',
            verdicts: [{ handler: 'sender', matched: true, reason: 'yes' }],
          }),
        };
      }
      if (req.body.tools && !toolCallsDone) {
        toolCallsDone = true;
        return { toolCalls: [{ name: 'deliver.notify', args: { title: 'Nope', body: 'no' } }] };
      }
      return { text: 'You denied it, so I did nothing.' };
    });

    const submitted = h.service.intake.submit({
      type: 'webhook.send',
      source: 'http',
      payload: {},
    });
    const confirmFrame = await client.next('delivery', 15000);
    client.send('event', {
      type: 'notification.action',
      payload: {
        delivery_id: confirmFrame.payload.delivery_id,
        action: 'deny',
        run_id: confirmFrame.payload.payload.run_id,
      },
    });
    await drain(h);

    expect(
      h.service.repos.deliveries.recent(10).filter((d) => d.intent === 'notify'),
    ).toHaveLength(0);
    const toolCall = h.service.repos.trace
      .forEvent(submitted.event.id)
      .filter((t) => t.kind === 'tool_call')
      .map((t) => t.data as any)[0];
    expect(toolCall.denied).toBe('confirm_denied');
    // The run still finished and explained itself.
    expect(h.service.repos.events.get(submitted.event.id)?.status).toBe('done');
    client.close();
  });

  it('treats a confirmation timeout as a deny (App. A)', async () => {
    h = await bootService({ onboarded: true, dataDefaults: { confirm_timeout_s: 1 } });
    write(
      path.join(h.dataDir, 'handlers', 'sender.md'),
      handler('confirm: [deliver.notify]\n'),
    );

    let toolCallsDone = false;
    h.fake.always((req) => {
      if (req.body.response_format) {
        return {
          text: JSON.stringify({
            summary: 'x',
            verdicts: [{ handler: 'sender', matched: true, reason: 'yes' }],
          }),
        };
      }
      if (req.body.tools && !toolCallsDone) {
        toolCallsDone = true;
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
    const toolCall = h.service.repos.trace
      .forEvent(submitted.event.id)
      .filter((t) => t.kind === 'tool_call')
      .map((t) => t.data as any)[0];
    expect(toolCall.denied).toBe('confirm_denied');
  });
});

describe('daemon (§7.3)', () => {
  it('renders a delivery, acks it, and reports the click as an event — in-process', async () => {
    const renderer = new ScriptedRenderer(() => 'approve');
    h = await bootService({
      onboarded: true,
      bundledDaemon: { enabled: true, renderer, device: 'local' },
    });

    const result = (
      await notify(h, {
        title: 'Bins',
        body: 'Take them out',
        actions: [{ id: 'approve', label: 'Done' }],
      })
    ).output as any;

    for (let i = 0; i < 50 && renderer.shown.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(renderer.shown).toHaveLength(1);
    expect(renderer.shown[0]?.payload.title).toBe('Bins');

    // Bundled delivery acks fast, and the click comes back as an event.
    for (let i = 0; i < 50; i++) {
      if (h.service.repos.deliveries.get(result.delivery_id)?.status === 'acked') break;
      await new Promise((r) => setTimeout(r, 20));
    }
    const acked = h.service.repos.deliveries.get(result.delivery_id)!;
    expect(acked.status).toBe('acked');
    expect(acked.acked_by).toBe('local');

    for (let i = 0; i < 50; i++) {
      if (
        h.service.repos.events
          .recent({ limit: 5 })
          .some((e) => e.type === 'notification.action')
      )
        break;
      await new Promise((r) => setTimeout(r, 20));
    }
    const event = h.service.repos.events
      .recent({ limit: 5 })
      .find((e) => e.type === 'notification.action')!;
    expect((event.payload as any).action).toBe('approve');
    expect(event.source).toBe('local');
  });

  it('replays what the bundled daemon missed while it was not attached', async () => {
    h = await bootService({ onboarded: true });
    const queued = (await notify(h, { title: 'Earlier', body: 'before you woke up' }))
      .output as any;

    const renderer = new ScriptedRenderer();
    const { BundledDaemon } = await import('../src/egress/bundled-daemon.js');
    const daemon = new BundledDaemon(h.service, { renderer, device: 'local' });
    await daemon.start();
    for (let i = 0; i < 50 && renderer.shown.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(renderer.shown.map((d) => d.delivery_id)).toEqual([queued.delivery_id]);
    await daemon.stop();
  });

  it('drops a delivery that expired before it could be rendered', async () => {
    const renderer = new ScriptedRenderer();
    h = await bootService({ onboarded: true });
    const stale = (await notify(h, { title: 'Stale', body: 'old news' })).output as any;
    // Still 'queued', but no longer worth showing.
    h.app.db
      .prepare(`UPDATE deliveries SET expires_at = ? WHERE id = ?`)
      .run(new Date(Date.now() + 40).toISOString(), stale.delivery_id);
    await new Promise((r) => setTimeout(r, 80));

    const { BundledDaemon } = await import('../src/egress/bundled-daemon.js');
    const daemon = new BundledDaemon(h.service, { renderer, device: 'local' });
    await daemon.start();
    await new Promise((r) => setTimeout(r, 200));
    expect(renderer.shown).toHaveLength(0);
    await daemon.stop();
  });
});

describe('failure reporting (§13.2)', () => {
  it('ships a default handler that turns a dead letter into a notification', async () => {
    h = await bootService({ onboarded: true });
    expect(h.service.handlers.all().map((x) => x.name)).toContain('failure-notice');

    let notified = false;
    h.fake.always((req) => {
      if (req.body.response_format) {
        const offered = String(req.body.messages?.[1]?.content ?? '');
        return {
          text: JSON.stringify({
            summary: 'a handler failed',
            verdicts: offered.includes('failure-notice')
              ? [{ handler: 'failure-notice', matched: true, reason: 'an internal failure' }]
              : [],
          }),
        };
      }
      if (req.body.tools && !notified) {
        notified = true;
        return {
          toolCalls: [
            {
              name: 'deliver.notify',
              args: { title: 'Handler failed', body: 'invoice-filer gave up' },
            },
          ],
        };
      }
      return { text: 'reported' };
    });

    // A poisoned event: dead-letters, then reports itself.
    h.service.intake.submit({
      type: 'system.handler_failed',
      source: 'system',
      payload: { event_id: '01OLD', handler: 'invoice-filer', error: 'boom', attempts: 3 },
    });
    await drain(h);

    const deliveries = h.service.repos.deliveries.recent(10);
    expect(deliveries.some((d) => (d.payload as any).title === 'Handler failed')).toBe(true);
  });
});

describe('deliveries api', () => {
  it('exposes nothing without a token', async () => {
    h = await bootService({ onboarded: true });
    const res = await postJson(`${h.baseUrl}/api/events`, { type: 'x.y' });
    expect(res.status).toBe(401);
  });
});

describe('unrenderable deliveries', () => {
  it('leaves a delivery unacked when the notifier cannot show it', async () => {
    const renderer = new ScriptedRenderer(() => null, false);
    h = await bootService({
      onboarded: true,
      bundledDaemon: { enabled: true, renderer, device: 'local' },
    });
    const result = (await notify(h, { title: 'Unseen', body: 'no notifier installed' }))
      .output as any;

    for (let i = 0; i < 50 && renderer.shown.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(renderer.shown).toHaveLength(1);
    await new Promise((r) => setTimeout(r, 100));

    // Still owed to the user: delivered, never acked (§7.1).
    const stored = h.service.repos.deliveries.get(result.delivery_id)!;
    expect(stored.status).toBe('delivered');
    expect(stored.acked_at).toBeNull();
    expect(h.service.repos.deliveries.pending().map((d) => d.id)).toContain(result.delivery_id);
  });

  it('retries an unshown delivery when the daemon reconnects', async () => {
    h = await bootService({ onboarded: true });
    const result = (await notify(h, { title: 'Retry me', body: 'later' })).output as any;
    const { BundledDaemon } = await import('../src/egress/bundled-daemon.js');

    const broken = new ScriptedRenderer(() => null, false);
    const first = new BundledDaemon(h.service, { renderer: broken, device: 'local' });
    await first.start();
    for (let i = 0; i < 50 && broken.shown.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 20));
    }
    await first.stop();
    expect(h.service.repos.deliveries.get(result.delivery_id)?.status).toBe('delivered');

    // A notifier appears; the same delivery is shown and settled.
    const working = new ScriptedRenderer(() => null, true);
    const second = new BundledDaemon(h.service, { renderer: working, device: 'local' });
    await second.start();
    for (let i = 0; i < 50 && working.shown.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(working.shown.map((d) => d.delivery_id)).toContain(result.delivery_id);
    for (let i = 0; i < 50; i++) {
      if (h.service.repos.deliveries.get(result.delivery_id)?.status === 'acked') break;
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(h.service.repos.deliveries.get(result.delivery_id)?.status).toBe('acked');
    await second.stop();
  });
});

describe('confirmation from the chat UI', () => {
  it('gates a chat tool call and lets the browser answer it', async () => {
    h = await bootService({ onboarded: true });
    // The chat UI declares notify.actions, so confirm deliveries reach it.
    const client = await TestClient.connect(h.baseUrl, h.token);
    await client.hello(['chat', 'notify.actions']);

    let asked = false;
    h.fake.always((req) => {
      if (req.body.tools && !asked) {
        asked = true;
        return {
          toolCalls: [{ name: 'memory.forget', args: { name: 'x', reason: 'tidying' } }],
        };
      }
      return { text: 'Done as you asked.' };
    });

    // memory.forget is destructive, so gate it for this test.
    write(
      path.join(h.dataDir, 'config', 'turminder.yaml'),
      'bind: 127.0.0.1:0\nchat:\n  tools: [memory.*]\n  confirm: [memory.forget]\n',
    );
    h.app.config.reload();

    client.send('chat.send', { text: 'forget the thing' });
    const confirmFrame = await client.next('delivery', 15000);
    expect(confirmFrame.payload.intent).toBe('confirm');
    expect(confirmFrame.payload.payload.tool).toBe('memory.forget');

    client.send('event', {
      type: 'notification.action',
      payload: {
        delivery_id: confirmFrame.payload.delivery_id,
        action: 'deny',
        run_id: confirmFrame.payload.payload.run_id,
      },
    });
    await client.next('chat.done', 20000);

    const toolCall = h.service.repos.trace
      .forEvent(
        h.service.repos.events.recent({ limit: 10 }).find((e) => e.type === 'chat.message')!.id,
      )
      .filter((t) => t.kind === 'tool_call')
      .map((t) => t.data as any)[0];
    expect(toolCall.denied).toBe('confirm_denied');
    client.close();
  });

  it('puts confirm-listed tools behind approval even when a glob also grants them', async () => {
    h = await bootService({ onboarded: true });
    const { GrantedDispatcher } = await import('../src/tools/dispatcher.js');
    const dispatcher = new GrantedDispatcher(
      h.service.tools.handles(),
      { tools: ['memory.*'], confirm: ['memory.forget'] },
      { runId: null, eventId: null },
    );
    const result = await dispatcher.dispatch({
      toolCallId: '1',
      name: 'memory.forget',
      args: { name: 'x', reason: 'y' },
    });
    expect(result.denied).toBe('confirm_denied');
  });
});
