import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { ModelRouter } from '../src/model/router.js';
import { DEFAULT_ROUTES, ROUTABLE_PURPOSES } from '../src/model/routes.js';
import { ModelsYamlSchema } from '../src/core/config-schemas.js';
import { callCost } from '../src/model/types.js';
import { periodWindow } from '../src/tools/integrations/usage.js';
import { bootService, TestClient, type ServiceHarness } from './service-harness.js';
import { write } from './helpers.js';

let h: ServiceHarness;
afterEach(async () => {
  await h?.cleanup();
});

const drain = (harness: ServiceHarness) => harness.service.queue.drain();

/**
 * Cost accounting and model governance (§10.5, §10.6). Two opacities: what the
 * usage cost, and which endpoint served which run. Both are now traced facts,
 * so both are testable — which is the point.
 */
describe('cost arithmetic (§10.5)', () => {
  const priced = {
    cost: { inPerMtok: 3, outPerMtok: 15, currency: 'USD' },
  };

  it('prices a call from the endpoint that served it', () => {
    // 1M in at $3 + 1M out at $15.
    expect(callCost(priced, 1_000_000, 1_000_000)).toEqual({ cost: 18, currency: 'USD' });
    expect(callCost(priced, 1500, 500)?.cost).toBeCloseTo(0.012, 6);
  });

  it('reports a costless endpoint as costless, never as zero', () => {
    // Absent pricing is a *declaration*, and `null` is how it stays one: a
    // 0.00 in a ledger looks like a measurement.
    expect(callCost({}, 10_000, 10_000)).toBeNull();
  });
});

describe('routing transparency (§10.6)', () => {
  /** Three endpoints, one per role — the governance fixture. */
  const THREE = {
    endpoints: [
      { name: 'quick', url: 'http://a/v1', classes: ['fast'], caps: ['json', 'tools'] },
      { name: 'big', url: 'http://b/v1', classes: ['best'], caps: ['json', 'tools'] },
      { name: 'blind', url: 'http://c/v1', classes: ['fast', 'best'], caps: [] },
    ],
  };

  /** First endpoint in config order that declares this class — the same
   *  first-match rule the router applies, computed independently so this
   *  test does not just restate `DEFAULT_ROUTES` by hand. */
  const firstByClass = (cls: 'fast' | 'best'): string =>
    THREE.endpoints.find((e) => e.classes.includes(cls))!.name;

  it('resolves every routable purpose per DEFAULT_ROUTES (the governance test), replaced with a configured route when one exists', () => {
    const router = new ModelRouter(ModelsYamlSchema.parse(THREE));
    // §10.6 step 5: the kind-default table, made concrete against THREE.
    // `distill → best`, not fast — the old literal here was wrong (Phase 36).
    for (const purpose of ROUTABLE_PURPOSES) {
      if (purpose === 'embedding') continue; // no class default; see below
      const route = DEFAULT_ROUTES[purpose]!;
      const resolved = router.resolve({ purpose });
      expect(resolved.resolved_by, purpose).toBe('kind_default');
      expect(resolved.endpoint.name, purpose).toBe(
        firstByClass((route as { class: 'fast' | 'best' }).class),
      );
    }
    // Step 4 (within a class): capability filter, then models.yaml order.
    expect(router.resolve({ purpose: 'handler', caps: ['tools'] }).endpoint.name).toBe('quick');
    // Step 1 (override): bypasses class/caps filtering entirely.
    expect(
      router.resolve({ purpose: 'chat', pin: { endpoint: 'blind', by: 'override' } }).endpoint
        .name,
    ).toBe('blind');

    // A configured route (§10.6 step 4) beats the kind default and says so.
    const routed = new ModelRouter(
      ModelsYamlSchema.parse({ ...THREE, routes: { distill: { endpoint: 'quick' } } }),
    );
    const r = routed.resolve({ purpose: 'distill' });
    expect(r).toMatchObject({ resolved_by: 'route' });
    expect(r.endpoint.name).toBe('quick');
  });

  it('never lists or accepts the embedding endpoint from a chat surface (§10.6 v2)', async () => {
    // The default harness config carries a legacy `embedding:` block, healed
    // on boot into a `kind: embedding` endpoint named "embedding" — a real
    // fixture for the exclusion, not a contrived one.
    h = await bootService({ onboarded: true, watchFiles: false });
    const client = await TestClient.connect(h.baseUrl, h.token);
    await client.hello(['chat']);
    client.send('models.list', {});
    const listed = await client.next('models.list.result');
    expect((listed.payload.endpoints as { name: string }[]).map((e) => e.name)).not.toContain(
      'embedding',
    );

    const sent = h.service.chat.send({ text: 'hi' });
    await drain(h);
    client.send('conversation.model', {
      conversation_id: sent.conversationId,
      endpoint: 'embedding',
    });
    expect((await client.next('error')).payload.code).toBe('not_found');
    client.close();
  });

  it('stamps endpoint, requested class and who decided onto every llm_call', async () => {
    h = await bootService({ onboarded: true, watchFiles: false });
    h.fake.always({ text: 'hello' });
    const sent = h.service.chat.send({ text: 'hi' });
    await drain(h);

    const call = h.service.repos.trace
      .forEvent(sent.eventId)
      .find((t) => t.kind === 'llm_call')!.data as {
      endpoint: string;
      requested_class: string;
      resolved_by: string;
    };
    expect(call).toMatchObject({
      endpoint: 'main',
      requested_class: 'best',
      resolved_by: 'kind_default',
    });
  });

  it('lets a conversation override the model, absolutely and persistently', async () => {
    h = await bootService({ onboarded: true, watchFiles: false });
    // A second endpoint with no tools: the override must beat the caps filter
    // (§10.6 step 1), which is exactly the case a filter would refuse.
    const models = YAML.parse(
      fs.readFileSync(path.join(h.dataDir, 'config', 'models.yaml'), 'utf8'),
    ) as { endpoints: Record<string, unknown>[] };
    models.endpoints.push({ ...models.endpoints[0], name: 'plain', caps: ['json'] });
    write(path.join(h.dataDir, 'config', 'models.yaml'), YAML.stringify(models));
    h.app.config.reload();
    h.service.loadModels();

    const client = await TestClient.connect(h.baseUrl, h.token);
    await client.hello(['chat']);
    h.fake.always({ text: 'answered by the pinned one' });
    const first = h.service.chat.send({ text: 'hello' });
    await drain(h);

    client.send('conversation.model', {
      conversation_id: first.conversationId,
      endpoint: 'plain',
    });
    expect((await client.next('conversation.model.set')).payload.endpoint).toBe('plain');

    h.service.chat.send({ conversationId: first.conversationId, text: 'again' });
    await drain(h);
    const calls = h.app.db.prepare(`SELECT data FROM trace WHERE kind = 'llm_call'`).all() as {
      data: string;
    }[];
    const last = JSON.parse(calls.at(-1)!.data) as { endpoint: string; resolved_by: string };
    expect(last).toMatchObject({ endpoint: 'plain', resolved_by: 'override' });

    // Persisted on the row, so it survives a reconnect and a restart.
    expect(h.service.repos.conversations.get(first.conversationId)!.model_override).toBe(
      'plain',
    );
    client.close();
  });

  it('clears an override whose endpoint has gone, with a visible notice', async () => {
    h = await bootService({ onboarded: true, watchFiles: false });
    const sent = h.service.chat.send({ text: 'hello' });
    await drain(h);
    h.service.repos.conversations.setModelOverride(sent.conversationId, 'vanished');

    const client = await TestClient.connect(h.baseUrl, h.token);
    await client.hello(['chat']);
    h.fake.always({ text: 'still here' });
    h.service.chat.send({ conversationId: sent.conversationId, text: 'again' });
    const notice = await client.next('chat.error');
    expect(notice.payload.message).toContain('no longer configured');
    await drain(h);
    // Cleared, and the turn still happened — fail-open, honest (§10.6).
    expect(h.service.repos.conversations.get(sent.conversationId)!.model_override).toBeNull();
    client.close();
  });

  it('refuses an override naming an endpoint that does not exist', async () => {
    h = await bootService({ onboarded: true, watchFiles: false });
    const sent = h.service.chat.send({ text: 'hello' });
    await drain(h);
    const client = await TestClient.connect(h.baseUrl, h.token);
    await client.hello(['chat']);
    client.send('conversation.model', {
      conversation_id: sent.conversationId,
      endpoint: 'nope',
    });
    expect((await client.next('error')).payload.code).toBe('not_found');
    client.close();
  });

  it('serves the selector its data, pricing included and secrets excluded', async () => {
    h = await bootService({ onboarded: true, watchFiles: false });
    const client = await TestClient.connect(h.baseUrl, h.token);
    await client.hello(['chat']);
    client.send('models.list', {});
    const listed = await client.next('models.list.result');
    expect(listed.payload.endpoints[0]).toMatchObject({
      name: 'main',
      serves_this_conversation: true,
    });
    expect(JSON.stringify(listed.payload)).not.toContain('api_key');
    client.close();
  });
});

describe('reasoning effort (§10.6)', () => {
  /** Give the harness endpoint a declaration, the way a real models.yaml does. */
  function declareEfforts(harness: ServiceHarness, efforts: string[] | null): void {
    const file = path.join(harness.dataDir, 'config', 'models.yaml');
    const models = YAML.parse(fs.readFileSync(file, 'utf8')) as {
      endpoints: Record<string, unknown>[];
    };
    if (efforts) models.endpoints[0]!.efforts = efforts;
    else delete models.endpoints[0]!.efforts;
    write(file, YAML.stringify(models));
    harness.app.config.reload();
    harness.service.loadModels();
  }

  const completions = (harness: ServiceHarness) =>
    harness.fake.requests.filter((r) => r.path.endsWith('/chat/completions'));

  it('sends reasoning_effort exactly when it was chosen and is declared', async () => {
    h = await bootService({ onboarded: true, watchFiles: false });
    declareEfforts(h, ['low', 'high']);
    const client = await TestClient.connect(h.baseUrl, h.token);
    await client.hello(['chat']);
    h.fake.always({ text: 'thought about it' });

    // Before anyone chooses: the endpoint's own default stands, unnamed.
    const sent = h.service.chat.send({ text: 'hello' });
    await drain(h);
    expect(completions(h).at(-1)!.body.reasoning_effort).toBeUndefined();

    client.send('conversation.model', {
      conversation_id: sent.conversationId,
      effort: 'high',
    });
    expect((await client.next('conversation.model.set')).payload.effort).toBe('high');

    h.service.chat.send({ conversationId: sent.conversationId, text: 'again' });
    await drain(h);
    expect(completions(h).at(-1)!.body.reasoning_effort).toBe('high');

    // Clearing it stops sending it — absence is the third state, not "low".
    client.send('conversation.model', { conversation_id: sent.conversationId, effort: null });
    await client.next('conversation.model.set');
    h.service.chat.send({ conversationId: sent.conversationId, text: 'once more' });
    await drain(h);
    expect(completions(h).at(-1)!.body.reasoning_effort).toBeUndefined();
    client.close();
  });

  it('never sends it to an endpoint that declared nothing, and clears the stale pin', async () => {
    // The negative that matters: the harness endpoint declares no efforts, so
    // a level that got onto the row some other way must not reach the wire.
    h = await bootService({ onboarded: true, watchFiles: false });
    const sent = h.service.chat.send({ text: 'hello' });
    await drain(h);
    h.service.repos.conversations.setEffortOverride(sent.conversationId, 'xhigh');

    const client = await TestClient.connect(h.baseUrl, h.token);
    await client.hello(['chat']);
    h.fake.always({ text: 'answered anyway' });
    h.service.chat.send({ conversationId: sent.conversationId, text: 'again' });
    const notice = await client.next('chat.error');
    expect(notice.payload.message).toContain('xhigh');
    await drain(h);

    for (const req of completions(h)) expect(req.body.reasoning_effort).toBeUndefined();
    // Cleared, and the turn still happened — fail-open, honest (§10.6).
    expect(h.service.repos.conversations.get(sent.conversationId)!.effort_override).toBeNull();
    client.close();
  });

  it('refuses a level the serving endpoint does not declare, naming the set', async () => {
    h = await bootService({ onboarded: true, watchFiles: false });
    declareEfforts(h, ['low', 'high']);
    const sent = h.service.chat.send({ text: 'hello' });
    await drain(h);
    const client = await TestClient.connect(h.baseUrl, h.token);
    await client.hello(['chat']);

    client.send('conversation.model', {
      conversation_id: sent.conversationId,
      effort: 'xhigh',
    });
    const refused = await client.next('error');
    expect(refused.payload.code).toBe('not_found');
    expect(refused.payload.message).toContain('low, high');
    expect(h.service.repos.conversations.get(sent.conversationId)!.effort_override).toBeNull();

    // Neither field is not a request, it is a typo.
    client.send('conversation.model', { conversation_id: sent.conversationId });
    expect((await client.next('error')).payload.code).toBe('bad_frame');
    client.close();
  });

  it('persists the choice on the row and re-serves it to a reconnecting client', async () => {
    h = await bootService({ onboarded: true, watchFiles: false });
    declareEfforts(h, ['low', 'high']);
    const sent = h.service.chat.send({ text: 'hello' });
    await drain(h);
    const first = await TestClient.connect(h.baseUrl, h.token);
    await first.hello(['chat']);
    first.send('conversation.model', { conversation_id: sent.conversationId, effort: 'low' });
    await first.next('conversation.model.set');
    first.close();

    // On the row, which is what survives a restart; and handed back on the
    // next `models.list`, which is what survives a reconnect.
    expect(h.service.repos.conversations.get(sent.conversationId)!.effort_override).toBe('low');
    const second = await TestClient.connect(h.baseUrl, h.token);
    await second.hello(['chat']);
    second.send('models.list', { conversation_id: sent.conversationId });
    const listed = await second.next('models.list.result');
    expect(listed.payload.effort).toBe('low');
    // The declaration rides along, because that is what draws the control.
    expect(listed.payload.endpoints[0].efforts).toEqual(['low', 'high']);
    second.close();
  });

  it('lets a handler ask for a level in its frontmatter (G.7)', async () => {
    h = await bootService({ onboarded: true, watchFiles: false });
    declareEfforts(h, ['low', 'medium', 'xhigh']);
    write(
      path.join(h.dataDir, 'handlers', 'quiet-filer.md'),
      `---\nname: quiet-filer\ndescription: Files a thing. Mechanical.\nmatch:\n  types: ["thing.filed"]\neffort: low\ntools: []\n---\n\nSay "filed".\n`,
    );
    h.service.handlers.reload();
    h.fake.always((req: any) =>
      req.body.response_format
        ? {
            text: JSON.stringify({
              summary: 'a thing',
              verdicts: [{ handler: 'quiet-filer', matched: true, reason: 'a thing arrived' }],
            }),
          }
        : { text: 'filed' },
    );

    h.service.intake.submit({
      type: 'thing.filed',
      source: 'test',
      payload: { what: 'a thing' },
    });
    await drain(h);

    const bodies = completions(h).map((r) => r.body);
    // The handler run asked for `low`; the ingress classifier, which asked for
    // nothing, still sends nothing (§10.6: no kind default).
    expect(bodies.some((b) => b.reasoning_effort === 'low')).toBe(true);
    expect(bodies.some((b) => b.response_format && b.reasoning_effort === undefined)).toBe(
      true,
    );
  });

  it('drops a handler level the serving endpoint never declared', async () => {
    // The endpoint says nothing about efforts, so the handler's request is a
    // preference the wire never hears — not an error, and not a guess.
    h = await bootService({ onboarded: true, watchFiles: false });
    write(
      path.join(h.dataDir, 'handlers', 'quiet-filer.md'),
      `---\nname: quiet-filer\ndescription: Files a thing. Mechanical.\nmatch:\n  types: ["thing.filed"]\neffort: low\ntools: []\n---\n\nSay "filed".\n`,
    );
    h.service.handlers.reload();
    h.fake.always((req: any) =>
      req.body.response_format
        ? {
            text: JSON.stringify({
              summary: 'a thing',
              verdicts: [{ handler: 'quiet-filer', matched: true, reason: 'a thing arrived' }],
            }),
          }
        : { text: 'filed' },
    );

    h.service.intake.submit({
      type: 'thing.filed',
      source: 'test',
      payload: { what: 'a thing' },
    });
    await drain(h);
    for (const req of completions(h)) expect(req.body.reasoning_effort).toBeUndefined();
  });

  it('changes the request parameter and nothing about the prompt', async () => {
    // Effort is a request parameter, not prompt content (§10.6): the system
    // prompt and the messages must be byte-identical either way, or the
    // §20/§21 cache invariants are paying for a knob.
    h = await bootService({ onboarded: true, watchFiles: false });
    declareEfforts(h, ['low', 'high']);
    h.fake.always({ text: 'same either way' });
    h.service.chat.send({ text: 'identical question' });
    await drain(h);
    const before = completions(h).at(-1)!.body;

    const client = await TestClient.connect(h.baseUrl, h.token);
    await client.hello(['chat']);
    const pinned = h.service.chat.send({ text: 'identical question' });
    await drain(h);
    client.send('conversation.model', {
      conversation_id: pinned.conversationId,
      effort: 'high',
    });
    await client.next('conversation.model.set');
    h.fake.requests.length = 0;
    h.service.chat.send({ conversationId: pinned.conversationId, text: 'identical question' });
    await drain(h);
    const after = completions(h).at(-1)!.body;

    expect(after.reasoning_effort).toBe('high');
    // The system prompt and the rendered user message, byte for byte.
    expect(after.messages[0]).toEqual(before.messages[0]);
    expect(after.messages[1]).toEqual(before.messages[1]);
    client.close();
  });
});

describe('the usage ledger (F.17, §10.5)', () => {
  it('sums stamped rows, groups by endpoint, and never invents a price', async () => {
    h = await bootService({ onboarded: true, watchFiles: false });
    const trace = h.service.repos.trace.sink({ eventId: null, runId: null });
    trace.append('llm_call', {
      model: 'hosted',
      endpoint: 'hosted',
      tokens_in: 1_000_000,
      tokens_out: 1_000_000,
      cost: 18,
      currency: 'USD',
    });
    trace.append('llm_call', {
      model: 'hosted',
      endpoint: 'hosted',
      tokens_in: 500_000,
      tokens_out: 0,
      cost: 1.5,
      currency: 'USD',
    });
    // The local box: tokens, no money.
    trace.append('llm_call', {
      model: 'local',
      endpoint: 'local',
      tokens_in: 2000,
      tokens_out: 300,
    });

    const summary = h.service.tools.handles().find((t) => t.name === 'usage.summary')!;
    const out = (await summary.call({ period: 'all' }, { runId: null, eventId: null }))
      .output as any;
    const byKey = Object.fromEntries(out.groups.map((g: any) => [g.key, g]));
    expect(byKey.hosted).toMatchObject({ calls: 2, cost: 19.5, currency: 'USD' });
    expect(byKey.local).toMatchObject({ calls: 1, cost: null, currency: 'local' });
    expect(out.total).toMatchObject({ calls: 3, cost: 19.5, currency: 'USD' });
    // `ro`, so a cost dashboard can bind it (§23.2).
    expect(summary.tier).toBe('ro');
  });

  it('groups by purpose (§10.6, F.17)', async () => {
    h = await bootService({ onboarded: true, watchFiles: false });
    const trace = h.service.repos.trace.sink({ eventId: null, runId: null });
    trace.append('llm_call', {
      endpoint: 'main',
      purpose: 'chat',
      tokens_in: 100,
      tokens_out: 50,
    });
    trace.append('llm_call', {
      endpoint: 'main',
      purpose: 'title',
      tokens_in: 10,
      tokens_out: 5,
    });
    // A row predating the field groups as "unknown" rather than vanishing.
    trace.append('llm_call', { endpoint: 'main', tokens_in: 1, tokens_out: 1 });

    const summary = h.service.tools.handles().find((t) => t.name === 'usage.summary')!;
    const out = (
      await summary.call({ period: 'all', group_by: 'purpose' }, { runId: null, eventId: null })
    ).output as any;
    const byKey = Object.fromEntries(out.groups.map((g: any) => [g.key, g]));
    expect(byKey.chat).toMatchObject({ calls: 1, tokens_in: 100, tokens_out: 50 });
    expect(byKey.title).toMatchObject({ calls: 1, tokens_in: 10, tokens_out: 5 });
    expect(byKey.unknown).toMatchObject({ calls: 1 });
  });

  it('groups mixed currencies rather than adding them', async () => {
    h = await bootService({ onboarded: true, watchFiles: false });
    const trace = h.service.repos.trace.sink({ eventId: null, runId: null });
    trace.append('llm_call', {
      endpoint: 'a',
      tokens_in: 1,
      tokens_out: 1,
      cost: 2,
      currency: 'USD',
    });
    trace.append('llm_call', {
      endpoint: 'b',
      tokens_in: 1,
      tokens_out: 1,
      cost: 30,
      currency: 'NOK',
    });

    const summary = h.service.tools.handles().find((t) => t.name === 'usage.summary')!;
    const out = (await summary.call({ period: 'all' }, { runId: null, eventId: null }))
      .output as any;
    expect(out.total.by_currency).toEqual([
      { currency: 'USD', cost: 2 },
      { currency: 'NOK', cost: 30 },
    ]);
    expect(out.total.cost).toBeUndefined();
  });

  it('windows a period from an injected clock', () => {
    const now = new Date('2026-08-22T12:00:00.000Z');
    expect(periodWindow('day', now).from).toBe('2026-08-21T12:00:00.000Z');
    expect(periodWindow('week', now).from).toBe('2026-08-15T12:00:00.000Z');
    expect(periodWindow('month', now).from).toBe('2026-07-23T12:00:00.000Z');
    expect(periodWindow('all', now).from).toBeNull();
  });

  it('reports the run and conversation cost on chat.usage', async () => {
    h = await bootService({ onboarded: true, watchFiles: false });
    // Price the fake endpoint.
    const file = path.join(h.dataDir, 'config', 'models.yaml');
    const models = YAML.parse(fs.readFileSync(file, 'utf8')) as any;
    models.endpoints[0].cost = { in_per_mtok: 1000, out_per_mtok: 2000, currency: 'USD' };
    write(file, YAML.stringify(models));
    h.app.config.reload();
    h.service.loadModels();

    const client = await TestClient.connect(h.baseUrl, h.token);
    await client.hello(['chat']);
    h.fake.always({ text: 'priced', usage: { prompt: 1000, completion: 500 } });
    h.service.chat.send({ text: 'what does this cost?' });
    const usage = await client.next('chat.usage', 15000);
    await drain(h);

    // 1000 in at $1000/Mtok = $1; 500 out at $2000/Mtok = $1.
    expect(usage.payload.cost).toMatchObject({ currency: 'USD' });
    expect(usage.payload.cost.run).toBeCloseTo(2, 6);
    expect(usage.payload.cost.conversation).toBeCloseTo(2, 6);
    client.close();
  });
});

describe('the request log window (§10.8)', () => {
  it('excludes rows older than the caller-supplied cutoff', async () => {
    h = await bootService({ onboarded: true, watchFiles: false });
    const row = (endpoint: string) =>
      JSON.stringify({
        purpose: 'chat',
        endpoint,
        tokens_in: 1,
        tokens_out: 1,
        duration_ms: 1,
        stop_reason: 'stop',
        resolved_by: 'kind_default',
      });
    const insertAt = (iso: string, endpoint: string) =>
      h.app.db
        .prepare(`INSERT INTO trace (at, kind, data) VALUES (?, 'llm_call', ?)`)
        .run(iso, row(endpoint));

    const dayAgo = new Date(Date.now() - 25 * 3600 * 1000).toISOString();
    const hourAgo = new Date(Date.now() - 1 * 3600 * 1000).toISOString();
    insertAt(dayAgo, 'too-old');
    insertAt(hourAgo, 'within-window');

    const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
    const rows = h.service.repos.trace.recentCalls({ limit: 100, since });
    expect(rows.map((r) => r.endpoint)).toEqual(['within-window']);
  });
});
