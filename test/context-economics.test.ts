import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { MemoryTraceSink, type LlmCallTrace } from '../src/model/types.js';
import { BASE_PROMPTS } from '../src/prompts/base.js';
import { GrantedDispatcher } from '../src/tools/dispatcher.js';
import { PagedDispatcher, OPEN_TOOL } from '../src/tools/paged.js';
import type { ToolHandle } from '../src/tools/types.js';
import { bootService, offeredTools, type ServiceHarness } from './service-harness.js';
import { FakeLlama } from './fake-llama.js';
import { gatewayFor } from './model-stack.js';
import { write } from './helpers.js';

let h: ServiceHarness;
afterEach(async () => {
  await h?.cleanup();
});

const drain = (harness: ServiceHarness) => harness.service.queue.drain();

const CLOCK_FIXTURE = () => path.resolve('test/fixtures/mcp-clock-server.mjs');
const HA_FIXTURE = () => path.resolve('test/fixtures/mcp-home-assistant-server.mjs');

/** Installs an external MCP server the way the form flow does, minus the form. */
async function installMcp(
  harness: ServiceHarness,
  server: { name: string; fixture: string; description?: string },
): Promise<void> {
  write(
    path.join(harness.dataDir, 'config', 'mcp.yaml'),
    `servers:\n  - name: ${server.name}\n    transport: stdio\n` +
      (server.description ? `    description: ${JSON.stringify(server.description)}\n` : '') +
      `    command: ["node", "${server.fixture}"]\n`,
  );
  harness.app.config.reload();
  await harness.service.tools.connectExternal(server.name);
  // Granting is separate from connecting (§19.4) — but every paging test needs
  // the grant in place, because a namespace with no granted tools is not paged,
  // it is simply absent.
  const patterns = harness.service.tools.toolsFrom(server.name);
  harness.service.grants.add(
    patterns.map((pattern) => ({ pattern, level: 'tools' as const })),
    'test grant',
  );
}

const installClock = (harness: ServiceHarness, description?: string) =>
  installMcp(harness, {
    name: 'clock',
    fixture: CLOCK_FIXTURE(),
    ...(description ? { description } : {}),
  });

const system = (harness: ServiceHarness) =>
  harness.fake.requests.at(-1)!.body.messages[0].content as string;
const toolNames = (harness: ServiceHarness) => offeredTools(harness).sort();

/* ── §21.1 honest usage ───────────────────────────────────────────────────── */

describe('llama.cpp cache visibility (§21.1)', () => {
  it('captures timings.prompt_n from a streamed response', async () => {
    h = await bootService({ onboarded: true, watchFiles: false });
    // 900 of 1000 prompt tokens came out of the KV cache.
    h.fake.always({
      text: 'Cached.',
      usage: { prompt: 1000, completion: 4 },
      promptEvaluated: 100,
    });
    const sent = h.service.chat.send({ text: 'hello again' });
    await drain(h);

    const llm = h.service.repos.trace.forEvent(sent.eventId).find((t) => t.kind === 'llm_call')!
      .data as any;
    expect(llm.tokens_in).toBe(1000);
    expect(llm.prompt_evaluated).toBe(100);
    // And the response itself came through the transform untouched.
    expect(h.service.repos.conversations.history(sent.conversationId)[1]!.text).toBe('Cached.');
  });

  it('captures it from a non-streamed response too', async () => {
    // No onDelta, so this is the generateText path — the clone-and-parse half
    // of §21.1, which shares nothing with the SSE transform.
    const fake = new FakeLlama();
    const gw = gatewayFor(await fake.startV1());
    try {
      fake.script({
        text: 'Direct.',
        usage: { prompt: 500, completion: 6 },
        promptEvaluated: 20,
      });
      const trace = new MemoryTraceSink();
      const r = await gw.turn({
        selector: { class: 'fast' },
        priority: 'interactive',
        system: 'be brief',
        messages: [{ role: 'user', content: 'hi' }],
        trace,
      });
      expect(r.text).toBe('Direct.');
      expect(r.promptEvaluated).toBe(20);
      expect((trace.ofKind('llm_call')[0] as LlmCallTrace).prompt_evaluated).toBe(20);
    } finally {
      await fake.stop();
    }
  });

  it('keeps timings from one call out of the next', async () => {
    const fake = new FakeLlama();
    const gw = gatewayFor(await fake.startV1());
    try {
      fake.script(
        { text: 'first', promptEvaluated: 42 },
        // Second call: same endpoint, same cached model client, no timings.
        { text: 'second' },
      );
      const call = () =>
        gw.turn({
          selector: { class: 'fast' },
          priority: 'interactive',
          system: 's',
          messages: [{ role: 'user', content: 'hi' }],
        });
      expect((await call()).promptEvaluated).toBe(42);
      expect((await call()).promptEvaluated).toBeUndefined();
    } finally {
      await fake.stop();
    }
  });

  it('reports nothing rather than zero when the endpoint sends no timings', async () => {
    h = await bootService({ onboarded: true, watchFiles: false });
    // No promptEvaluated: an ordinary OpenAI-compatible endpoint.
    h.fake.always({ text: 'Fine.', usage: { prompt: 300, completion: 2 } });
    const sent = h.service.chat.send({ text: 'hello' });
    await drain(h);
    const llm = h.service.repos.trace.forEvent(sent.eventId).find((t) => t.kind === 'llm_call')!
      .data as any;
    expect(llm.tokens_in).toBe(300);
    expect('prompt_evaluated' in llm).toBe(false);
    // A run with no stats is a normal run, not a failed one.
    expect(h.service.repos.runs.forEvent(sent.eventId)[0]?.status).toBe('done');
  });

  it('streams the same bytes with timings present as without', async () => {
    h = await bootService({ onboarded: true, watchFiles: false });
    // Long enough to arrive in many SSE chunks, so a transform that dropped or
    // reordered anything would show up as mangled text.
    const answer = Array.from({ length: 200 }, (_, i) => `word${i}`).join(' ');
    h.fake.always({ text: answer, promptEvaluated: 7 });
    const sent = h.service.chat.send({ text: 'say a lot' });
    await drain(h);
    expect(h.service.repos.conversations.history(sent.conversationId)[1]!.text).toBe(answer);
  });

  it('reports peak context separately from cumulative billing', async () => {
    h = await bootService({ onboarded: true, watchFiles: false });
    let asked = false;
    h.fake.always((req) => {
      if (req.body.tools && !asked) {
        asked = true;
        return {
          toolCalls: [{ name: 'time.now', args: {} }],
          usage: { prompt: 1000, completion: 5 },
          promptEvaluated: 1000,
        };
      }
      return { text: 'Friday.', usage: { prompt: 1100, completion: 3 }, promptEvaluated: 100 };
    });

    const usage: any[] = [];
    const stop = h.service.stream.subscribe({ usage: (e) => usage.push(e) });
    h.service.chat.send({ text: 'what day is it?' });
    await drain(h);
    stop();

    const last = usage.at(-1)!;
    // Billing sums the prompt once per turn; pressure is the largest of them.
    expect(last.tokensIn).toBe(2100);
    expect(last.contextUsed).toBe(1100);
    expect(last.contextSize).toBe(32768);
    // 1100 of 2100 prompt tokens evaluated => ~48% served from cache.
    expect(last.promptEvaluated).toBe(1100);
    expect(last.billedWithTimings).toBe(2100);
  });
});

/* ── §21.2 tool paging ────────────────────────────────────────────────────── */

describe('tool paging (§21.2)', () => {
  it('renders core namespaces only, and catalogs the rest', async () => {
    h = await bootService({ onboarded: true, watchFiles: false });
    h.fake.always({ text: 'hi' });
    h.service.chat.send({ text: 'hello' });
    await drain(h);

    const names = toolNames(h);
    expect(names).toContain('memory.query');
    expect(names).toContain('time.now');
    expect(names).toContain(OPEN_TOOL);
    // Granted (chat.tools has `config.*` and `setup.*`) but paged out.
    expect(names).not.toContain('config.write');
    expect(names).not.toContain('setup.form');

    const prompt = system(h);
    expect(prompt).toMatch(/^- config: 2 tools — .+ \(closed; open with tools\.open\)$/m);
    expect(prompt).toContain('- setup: 9 tools —');
    // A description from the integration manifest, not a list of tool names.
    expect(prompt).toContain('Reading and writing the assistant’s own configuration.');
  });

  it('never catalogs a namespace the grants would refuse', async () => {
    h = await bootService({ onboarded: true, watchFiles: false });
    h.fake.always({ text: 'hi' });
    h.service.chat.send({ text: 'hello' });
    await drain(h);
    // `events.emit` exists in the process and is not in chat's grant.
    expect(h.service.tools.get('events.emit')).not.toBeNull();
    expect(system(h)).not.toContain('- events:');
    expect(toolNames(h)).not.toContain('events.emit');
  });

  it('describes an external server from its mcp.yaml description', async () => {
    h = await bootService({ onboarded: true, watchFiles: false });
    await installClock(h, 'Tells the time and sets alarms.');
    h.fake.always({ text: 'hi' });
    h.service.chat.send({ text: 'hello' });
    await drain(h);
    expect(system(h)).toContain('- clock: 2 tools — Tells the time and sets alarms.');
  });

  it('falls back to naming tools when nothing described the namespace', async () => {
    h = await bootService({ onboarded: true, watchFiles: false });
    await installClock(h);
    h.fake.always({ text: 'hi' });
    h.service.chat.send({ text: 'hello' });
    await drain(h);
    expect(system(h)).toContain('- clock: 2 tools — clock.now, clock.set_alarm');
  });

  it('opens on request, and the tools stay for the next message', async () => {
    h = await bootService({ onboarded: true, watchFiles: false });
    let opened = false;
    h.fake.always((req) => {
      if (req.body.tools && !opened) {
        opened = true;
        return { toolCalls: [{ name: OPEN_TOOL, args: { namespace: 'setup' } }] };
      }
      return { text: 'Done.' };
    });
    const first = h.service.chat.send({ text: 'connect something' });
    await drain(h);

    // The result names what it revealed…
    const call = h.service.repos.trace
      .forEvent(first.eventId)
      .filter((t) => t.kind === 'tool_call')
      .map((t) => t.data as any)
      .find((d) => d.tool === OPEN_TOOL)!;
    expect(call.ok).toBe(true);
    expect(call.result_excerpt).toContain('setup.form');

    // …the turn after the open already has them…
    expect(toolNames(h)).toContain('setup.form');
    // …and the catalog stopped calling it closed in the same breath.
    expect(system(h)).not.toContain('- setup:');

    // …and so does the next message, in a new run.
    expect(h.service.repos.conversations.openNamespaces(first.conversationId)).toEqual([
      'setup',
    ]);
    h.fake.always({ text: 'Still here.' });
    h.service.chat.send({ conversationId: first.conversationId, text: 'and now?' });
    await drain(h);
    expect(toolNames(h)).toContain('setup.form');

    // A brand-new conversation pays nothing for that.
    h.service.chat.send({ text: 'unrelated question' });
    await drain(h);
    expect(toolNames(h)).not.toContain('setup.form');
    expect(system(h)).toContain('- setup:');
  });

  it('delivers the namespace’s same-named skill with the open (§21.2.3)', async () => {
    // "Read the skill before your first one" was demonstrably skipped; the
    // guarantee is delivery in the open result — the model cannot not-see it.
    h = await bootService({ onboarded: true, watchFiles: false });
    let opened = false;
    h.fake.always((req) => {
      if (req.body.tools && !opened) {
        opened = true;
        return { toolCalls: [{ name: OPEN_TOOL, args: { namespace: 'embeds' } }] };
      }
      return { text: 'Done.' };
    });
    const sent = h.service.chat.send({ text: 'build me a dashboard' });
    await drain(h);
    const call = h.service.repos.trace
      .forEvent(sent.eventId)
      .filter((t) => t.kind === 'tool_call')
      .map((t) => t.data as any)
      .find((d) => d.tool === OPEN_TOOL)!;
    expect(call.ok).toBe(true);
    // The shipped embeds skill body, in the result: rules the model was
    // supposed to fetch, now impossible to skip.
    expect(call.result_excerpt).toContain('"skill"');
    // The `setup` namespace has no same-named skill — no skill key there.
    let second = false;
    h.fake.always((req) => {
      if (req.body.tools && !second) {
        second = true;
        return { toolCalls: [{ name: OPEN_TOOL, args: { namespace: 'setup' } }] };
      }
      return { text: 'ok' };
    });
    const next = h.service.chat.send({ text: 'connect something' });
    await drain(h);
    const setupOpen = h.service.repos.trace
      .forEvent(next.eventId)
      .filter((t) => t.kind === 'tool_call')
      .map((t) => t.data as any)
      .find((d) => d.tool === OPEN_TOOL)!;
    expect(setupOpen.ok).toBe(true);
    expect(setupOpen.result_excerpt).not.toContain('"skill"');
  });

  it('refuses an unknown namespace and says what is openable', async () => {
    h = await bootService({ onboarded: true, watchFiles: false });
    let asked = false;
    h.fake.always((req) => {
      if (req.body.tools && !asked) {
        asked = true;
        return { toolCalls: [{ name: OPEN_TOOL, args: { namespace: 'home-assistant' } }] };
      }
      return { text: 'No such thing.' };
    });
    const sent = h.service.chat.send({ text: 'turn on the lights' });
    await drain(h);
    const call = h.service.repos.trace
      .forEvent(sent.eventId)
      .filter((t) => t.kind === 'tool_call')
      .map((t) => t.data as any)
      .find((d) => d.tool === OPEN_TOOL)!;
    expect(call.ok).toBe(false);
    expect(call.result_excerpt).toContain('unknown_namespace');
    expect(call.result_excerpt).toContain('setup');
    // Nothing was opened by a failed open.
    expect(h.service.repos.conversations.openNamespaces(sent.conversationId)).toEqual([]);
  });

  /**
   * The three-way split, spelled out because collapsing any two of these is
   * exactly how a context optimization becomes a security or behavior change.
   */
  describe('open / closed / ungranted', () => {
    it('open + granted executes, as it always did', async () => {
      h = await bootService({ onboarded: true, watchFiles: false });
      let asked = false;
      h.fake.always((req) => {
        if (req.body.tools && !asked) {
          asked = true;
          return { toolCalls: [{ name: 'time.now', args: {} }] };
        }
        return { text: 'Told you.' };
      });
      const sent = h.service.chat.send({ text: 'what time is it?' });
      await drain(h);
      const call = h.service.repos.trace
        .forEvent(sent.eventId)
        .map((t) => t.data as any)
        .find((d) => d.tool === 'time.now')!;
      expect(call.ok).toBe(true);
      expect(call.denied).toBeUndefined();
      expect(call.implicit_open).toBeUndefined();
    });

    it('closed + granted opens itself and executes', async () => {
      h = await bootService({ onboarded: true, watchFiles: false });
      let asked = false;
      h.fake.always((req) => {
        if (req.body.tools && !asked) {
          asked = true;
          // Not in the rendered definitions: `config` is paged out. The model
          // remembered the name from an earlier conversation.
          return { toolCalls: [{ name: 'config.read', args: { path: 'config/identity.md' } }] };
        }
        return { text: 'Read it.' };
      });
      const sent = h.service.chat.send({ text: 'what is in your identity file?' });
      await drain(h);

      const call = h.service.repos.trace
        .forEvent(sent.eventId)
        .map((t) => t.data as any)
        .find((d) => d.tool === 'config.read')!;
      expect(call.ok).toBe(true);
      expect(call.denied).toBeUndefined();
      expect(call.implicit_open).toBe('config');
      expect(call.result_excerpt).toContain('Sleeper Service');
      // And it is open from now on, like an explicit open.
      expect(h.service.repos.conversations.openNamespaces(sent.conversationId)).toEqual([
        'config',
      ]);
      expect(toolNames(h)).toContain('config.read');
    });

    it('ungranted is refused exactly as before paging existed', async () => {
      h = await bootService({ onboarded: true, watchFiles: false });
      let asked = false;
      h.fake.always((req) => {
        if (req.body.tools && !asked) {
          asked = true;
          return {
            toolCalls: [{ name: 'events.emit', args: { type: 'x.y', payload: {} } }],
          };
        }
        return { text: 'Cannot do that.' };
      });
      const sent = h.service.chat.send({ text: 'emit an event' });
      await drain(h);

      const call = h.service.repos.trace
        .forEvent(sent.eventId)
        .map((t) => t.data as any)
        .find((d) => d.tool === 'events.emit')!;
      expect(call.ok).toBe(false);
      expect(call.denied).toBe('not_granted');
      expect(call.result_excerpt).toContain('unknown_tool');
      expect(call.implicit_open).toBeUndefined();
      // Refusing did not open anything, and no event was created.
      expect(h.service.repos.conversations.openNamespaces(sent.conversationId)).toEqual([]);
      expect(
        h.service.repos.events.recent({ limit: 20 }).filter((e) => e.type === 'x.y'),
      ).toHaveLength(0);
    });
  });

  it('is monotonic: there is no way back to closed', async () => {
    h = await bootService({ onboarded: true, watchFiles: false });
    const conv = h.service.repos.conversations.create({});
    expect(h.service.repos.conversations.openNamespace(conv.id, 'setup')).toBe(true);
    // Idempotent, and the column stays sorted for byte-determinism.
    expect(h.service.repos.conversations.openNamespace(conv.id, 'setup')).toBe(false);
    h.service.repos.conversations.openNamespace(conv.id, 'config');
    expect(h.service.repos.conversations.openNamespaces(conv.id)).toEqual(['config', 'setup']);
    // No tools.close in v1 (§21.2.3).
    expect(h.service.tools.get('tools.close')).toBeNull();
  });

  it('leaves onboarding unpaged — its whole grant is three tools', async () => {
    h = await bootService({ onboarded: false, watchFiles: false });
    h.fake.always({ text: 'Hello. What should I call you?' });
    h.service.chat.send({ text: 'hi' });
    await drain(h);
    // F.7's onboarding grant, verbatim: two config tools and the create-blind
    // token minter for the "want your phone connected?" step (§24.3).
    expect(toolNames(h)).toEqual(['config.read', 'config.write', 'setup.token_create']);
    expect(system(h)).not.toContain('closed; open with');
  });

  it('does not page handler runs', async () => {
    h = await bootService({ onboarded: true, watchFiles: false });
    write(
      path.join(h.dataDir, 'handlers', 'writer.md'),
      `---\nname: writer\ndescription: Use for anything at all.\ntools: [config.read]\n---\n\nRead the identity file.\n`,
    );
    h.service.handlers.reload();
    h.fake.always((req) => {
      if (req.body.response_format) {
        return {
          text: JSON.stringify({
            summary: 'a thing',
            verdicts: [{ handler: 'writer', matched: true, reason: 'yes' }],
          }),
        };
      }
      return { text: 'done' };
    });
    h.service.intake.submit({ type: 'webhook.thing', source: 'http', payload: { a: 1 } });
    await drain(h);
    // The handler's own small explicit grant renders in full, catalog-free.
    const handlerRequest = h.fake.requests.filter((r) => !r.body.response_format).at(-1)!;
    expect(offeredTools(h, handlerRequest)).toEqual(['config.read']);
    expect(handlerRequest.body.messages[0].content).not.toContain('closed; open with');
  });
});

/* ── the phase-16 headline: a big namespace nobody pays for by default ────── */

describe('"turn on the office lights" (§21 exit criteria)', () => {
  const installHa = (harness: ServiceHarness) =>
    installMcp(harness, {
      name: 'home-assistant',
      fixture: HA_FIXTURE(),
      description: 'control lights, climate, covers and media around the house',
    });

  it('works from a fresh conversation, sticks, and does not follow to the next one', async () => {
    h = await bootService({ onboarded: true, watchFiles: false });
    await installHa(h);
    expect(h.service.tools.toolsFrom('home-assistant').length).toBeGreaterThanOrEqual(20);

    // Turn 1: the model sees one catalog line, not 23 definitions.
    let step = 0;
    h.fake.always((req) => {
      if (!req.body.tools) return { text: 'ok' };
      step += 1;
      if (step === 1)
        return { toolCalls: [{ name: OPEN_TOOL, args: { namespace: 'home-assistant' } }] };
      if (step === 2) {
        return { toolCalls: [{ name: 'HassTurnOn', args: { name: 'office lights' } }] };
      }
      return { text: 'Office lights are on.' };
    });

    const firstRequestBefore = h.fake.requests.length;
    const lights = h.service.chat.send({ text: 'turn on the office lights' });
    await drain(h);

    const turnOne = h.fake.requests.slice(firstRequestBefore).filter((r) => r.body.tools)[0]!;
    const turnOneTools = offeredTools(h, turnOne);
    expect(turnOneTools).not.toContain('HassTurnOn');
    expect(turnOne.body.messages[0].content).toContain(
      '- home-assistant: 23 tools — control lights, climate, covers and media around the house',
    );

    // It opened, called, and the call really executed.
    const calls = h.service.repos.trace
      .forEvent(lights.eventId)
      .filter((t) => t.kind === 'tool_call')
      .map((t) => t.data as any);
    expect(calls.map((c) => c.tool)).toEqual([OPEN_TOOL, 'HassTurnOn']);
    expect(calls[1]!.ok).toBe(true);
    expect(calls[1]!.result_excerpt).toContain('"state":"on"');
    expect(h.service.repos.conversations.history(lights.conversationId).at(-1)!.text).toBe(
      'Office lights are on.',
    );

    // Next message in the same conversation: the tools are simply there.
    h.fake.always({ text: 'Dimmed.' });
    h.service.chat.send({ conversationId: lights.conversationId, text: 'dim them a bit' });
    await drain(h);
    expect(toolNames(h)).toContain('HassLightSet');
    expect(system(h)).not.toContain('- home-assistant:');

    // A brand-new conversation is back to the catalog line.
    h.service.chat.send({ text: 'what is on my calendar?' });
    await drain(h);
    expect(toolNames(h)).not.toContain('HassTurnOn');
    expect(system(h)).toContain('- home-assistant: 23 tools');
  });

  it('works without the open call too — the name alone pages it in', async () => {
    h = await bootService({ onboarded: true, watchFiles: false });
    await installHa(h);
    let asked = false;
    h.fake.always((req) => {
      if (req.body.tools && !asked) {
        asked = true;
        // Straight to the tool, no tools.open: it remembered the name.
        return { toolCalls: [{ name: 'HassTurnOn', args: { name: 'office lights' } }] };
      }
      return { text: 'Done.' };
    });
    const sent = h.service.chat.send({ text: 'turn on the office lights' });
    await drain(h);

    const call = h.service.repos.trace
      .forEvent(sent.eventId)
      .map((t) => t.data as any)
      .find((d) => d.tool === 'HassTurnOn')!;
    expect(call.ok).toBe(true);
    // Dot-less MCP names have a namespace like everything else: the connection.
    expect(call.implicit_open).toBe('home-assistant');
    expect(h.service.repos.conversations.openNamespaces(sent.conversationId)).toEqual([
      'home-assistant',
    ]);
  });

  it('cuts turn-1 tool definitions by more than half against the unpaged shape', async () => {
    h = await bootService({ onboarded: true, watchFiles: false });
    await installHa(h);
    h.fake.always({ text: 'ok' });
    h.service.chat.send({ text: 'hello' });
    await drain(h);
    const paged = JSON.stringify(h.fake.requests.at(-1)!.body.tools).length;

    // What the same request would have carried before paging: every granted
    // tool in the process, rendered in full.
    const unpaged = JSON.stringify(
      h.service.tools
        .handles()
        .filter((t) => h.service.grants.covers(h.service.chatGrants(), t.name))
        .map((t) => ({
          type: 'function',
          function: { name: t.name, description: t.description, parameters: t.inputSchema },
        })),
    ).length;
    expect(paged).toBeLessThan(unpaged / 2);
  });
});

/* ── §21.2.7 determinism, on top of the phase-15 prefix work ──────────────── */

describe('paging determinism (§21.2.7)', () => {
  it('renders identical bytes for an unchanged open set, and one bust when it changes', async () => {
    h = await bootService({ onboarded: true, watchFiles: false });
    h.fake.always({ text: 'ok' });

    const first = h.service.chat.send({ text: 'one' });
    await drain(h);
    const a = h.fake.requests.at(-1)!.body;

    h.service.chat.send({ conversationId: first.conversationId, text: 'two' });
    await drain(h);
    const b = h.fake.requests.at(-1)!.body;

    // Same open set, same grants: byte-identical prompt head.
    expect(b.messages[0].content).toBe(a.messages[0].content);
    expect(JSON.stringify(b.tools)).toBe(JSON.stringify(a.tools));

    // Now open one. That is the bust §21.2.7 says we buy on purpose.
    let opened = false;
    h.fake.always((req) => {
      if (req.body.tools && !opened) {
        opened = true;
        return { toolCalls: [{ name: OPEN_TOOL, args: { namespace: 'config' } }] };
      }
      return { text: 'opened' };
    });
    h.service.chat.send({ conversationId: first.conversationId, text: 'three' });
    await drain(h);
    const c = h.fake.requests.at(-1)!.body;
    expect(c.messages[0].content).not.toBe(a.messages[0].content);
    expect(JSON.stringify(c.tools)).not.toBe(JSON.stringify(a.tools));

    // …and then it is stable again, at the new shape.
    h.fake.always({ text: 'ok' });
    h.service.chat.send({ conversationId: first.conversationId, text: 'four' });
    await drain(h);
    const d = h.fake.requests.at(-1)!.body;
    expect(d.messages[0].content).toBe(c.messages[0].content);
    expect(JSON.stringify(d.tools)).toBe(JSON.stringify(c.tools));
  });

  it('sorts tool definitions and catalog lines by name', async () => {
    h = await bootService({ onboarded: true, watchFiles: false });
    await installClock(h);
    h.fake.always({ text: 'ok' });
    h.service.chat.send({ text: 'hello' });
    await drain(h);

    const rendered = offeredTools(h);
    // `tools.open` is appended last by design — its position must not depend on
    // which namespaces happen to be open.
    expect(rendered.at(-1)).toBe(OPEN_TOOL);
    const paged = rendered.slice(0, -1);
    expect(paged).toEqual([...paged].sort());

    const catalog = system(h)
      .split('\n')
      .filter((line) => line.includes('closed; open with'))
      .map((line) => line.slice(2, line.indexOf(':')));
    expect(catalog).toEqual([...catalog].sort());
    expect(catalog).toEqual([
      'clock',
      'config',
      'docs',
      'embeds',
      'history',
      'project',
      'setup',
      'usage',
      'watch',
    ]);
  });
});

/* ── §21.2.6 the wrapper, in isolation ───────────────────────────────────── */

describe('PagedDispatcher (§21.2.6)', () => {
  const handle = (name: string, source: string): ToolHandle => ({
    name,
    description: `does ${name}`,
    tier: 'ro',
    inputSchema: { type: 'object', properties: {} },
    source,
    call: async () => ({ ok: true, output: { called: name } }),
  });

  const ctx = { runId: null, eventId: null };

  function build(opts: { open?: string[] } = {}) {
    const available = [
      handle('memory.query', 'memory'),
      handle('lights.on', 'home-assistant'),
      handle('lights.off', 'home-assistant'),
      handle('secret.thing', 'vault'),
    ];
    const opened = [...(opts.open ?? [])];
    const inner = new GrantedDispatcher(
      available,
      // `vault` exists in the process and is deliberately not granted.
      { tools: ['memory.*', 'lights.*'] },
      ctx,
    );
    const paged = new PagedDispatcher(inner, {
      core: ['memory'],
      store: {
        opened: () => opened,
        open: (ns) => {
          opened.push(ns);
        },
      },
    });
    return { paged, opened };
  }

  it('hides a closed namespace from the toolset but not from the grants', () => {
    const { paged } = build();
    expect(Object.keys(paged.toolSet())).toEqual(['memory.query', OPEN_TOOL]);
    expect(paged.closedNamespaces()).toEqual(['home-assistant']);
    expect(paged.catalog()).toEqual([
      '- home-assistant: 2 tools — lights.off, lights.on (closed; open with tools.open)',
    ]);
  });

  it('drops tools.open once nothing is left to open', () => {
    const { paged } = build({ open: ['home-assistant'] });
    expect(Object.keys(paged.toolSet())).toEqual(['lights.off', 'lights.on', 'memory.query']);
    expect(paged.catalog()).toEqual([]);
  });

  it('treats a re-open as success rather than an error', async () => {
    const { paged } = build({ open: ['home-assistant'] });
    const result = await paged.dispatch({
      toolCallId: '1',
      name: OPEN_TOOL,
      args: { namespace: 'home-assistant' },
    });
    expect(result.ok).toBe(true);
    expect(result.output).toEqual({
      opened: 'home-assistant',
      tools: ['lights.off', 'lights.on'],
    });
  });

  it('refuses to open a namespace whose tools are all ungranted', async () => {
    const { paged, opened } = build();
    const result = await paged.dispatch({
      toolCallId: '1',
      name: OPEN_TOOL,
      args: { namespace: 'vault' },
    });
    expect(result.ok).toBe(false);
    expect(result.output).toEqual({
      error: 'unknown_namespace',
      available: ['home-assistant'],
    });
    expect(opened).toEqual([]);
  });

  it('rejects a missing or non-string namespace without throwing', async () => {
    const { paged } = build();
    for (const args of [{}, { namespace: 42 }, null, { namespace: '  ' }]) {
      const result = await paged.dispatch({ toolCallId: '1', name: OPEN_TOOL, args });
      expect(result.ok).toBe(false);
      expect((result.output as any).error).toBe('unknown_namespace');
    }
  });

  it('leaves the inner refusal untouched for an ungranted tool', async () => {
    const { paged, opened } = build();
    const result = await paged.dispatch({ toolCallId: '1', name: 'secret.thing', args: {} });
    expect(result).toEqual({
      ok: false,
      output: { error: 'unknown_tool' },
      denied: 'not_granted',
    });
    expect(result.implicitOpen).toBeUndefined();
    expect(opened).toEqual([]);
  });
});

/* ── §21.3 batched calls, §21.4 the diet ─────────────────────────────────── */

describe('prompt and schema economics (§21.3, §21.4)', () => {
  const BATCHED =
    'When tool calls are independent of each other, make them all in one turn. ' +
    'Only sequence calls when a later call needs an earlier result.';

  it('carries the batching instruction verbatim in chat and handler', () => {
    expect(BASE_PROMPTS.chat).toContain(BATCHED);
    expect(BASE_PROMPTS.handler).toContain(BATCHED);
  });

  it('explains the catalog and tools.open in the chat prompt', () => {
    expect(BASE_PROMPTS.chat).toContain('tools.open');
    expect(BASE_PROMPTS.chat).toContain('Tool namespaces not loaded');
  });

  it('makes the batch actually go out as one turn', async () => {
    h = await bootService({ onboarded: true, watchFiles: false });
    let asked = false;
    h.fake.always((req) => {
      if (req.body.tools && !asked) {
        asked = true;
        return {
          toolCalls: [
            { name: 'time.now', args: {} },
            { name: 'weather.forecast', args: { location: 'Bergen' } },
          ],
        };
      }
      return { text: 'Both done.' };
    });
    const sent = h.service.chat.send({ text: 'time and weather please' });
    await drain(h);
    // Two calls, two turns total — not three.
    const calls = h.service.repos.trace
      .forEvent(sent.eventId)
      .filter((t) => t.kind === 'tool_call');
    expect(calls).toHaveLength(2);
    expect(h.service.repos.runs.forEvent(sent.eventId)[0]?.turns).toBe(2);
  });

  it('keeps the slimmed outliers under budget', async () => {
    h = await bootService({ onboarded: true, watchFiles: false });
    const size = (name: string) => {
      const t = h.service.tools.get(name);
      if (!t) throw new Error(`no such tool: ${name}`);
      return JSON.stringify({
        name: t.name,
        description: t.description,
        parameters: t.inputSchema,
      }).length;
    };
    /**
     * The §21.4 outliers, with their pre-diet sizes as the ceiling to stay
     * under. A regression here is a description or a `.describe()` creeping
     * back, and it is billed on every request of every conversation.
     */
    const ceilings: Record<string, number> = {
      // Raised 1000 → 1150 when the form primitive gained `choice` fields and
      // `embed_id` previews (App. D.5) — schema growth for real capability,
      // not prose creep, which is what this ceiling exists to stop.
      'setup.form': 1150,
      'setup.request_access': 700,
      'schedule.create': 780,
      'deliver.notify': 800,
      'config.write': 600,
    };
    for (const [name, ceiling] of Object.entries(ceilings)) {
      expect(size(name), `${name} is ${size(name)} chars`).toBeLessThanOrEqual(ceiling);
    }
    // Descriptions are what-and-when; how-to-use-well lives in a skill.
    for (const name of Object.keys(ceilings)) {
      expect(h.service.tools.get(name)!.description.length).toBeLessThanOrEqual(210);
    }
  });

  it('renders a fresh conversation for well under the whole granted catalog', async () => {
    h = await bootService({ onboarded: true, watchFiles: false });
    await installClock(h);
    h.fake.always({ text: 'ok' });
    h.service.chat.send({ text: 'hello' });
    await drain(h);

    const rendered = JSON.stringify(h.fake.requests.at(-1)!.body.tools).length;
    const everything = JSON.stringify(
      h.service.tools
        .handles()
        .filter((t) => h.service.grants.covers(h.service.chatGrants(), t.name))
        .map((t) => ({
          name: t.name,
          description: t.description,
          parameters: t.inputSchema,
        })),
    ).length;
    // The whole point: a conversation about nothing in particular does not pay
    // for `setup`, `config`, or someone else's MCP server.
    expect(rendered).toBeLessThan(everything * 0.8);
  });
});
