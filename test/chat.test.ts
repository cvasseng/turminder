import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { bootService, type ServiceHarness } from './service-harness.js';

let h: ServiceHarness;
afterEach(async () => {
  await h?.cleanup();
});

const drain = async (harness: ServiceHarness) => {
  await harness.service.queue.drain();
};

describe('chat executor (§9)', () => {
  it('answers a message, records the turns, and traces the run', async () => {
    h = await bootService({ onboarded: true });
    h.fake.always({ text: 'Oslo.', usage: { prompt: 120, completion: 3 } });

    const sent = h.service.chat.send({ text: 'Capital of Norway?' });
    await drain(h);

    const turns = h.service.repos.conversations.history(sent.conversationId);
    expect(turns.map((t) => [t.role, t.text])).toEqual([
      ['user', 'Capital of Norway?'],
      ['assistant', 'Oslo.'],
    ]);

    const runs = h.service.repos.runs.forEvent(sent.eventId);
    expect(runs).toHaveLength(1);
    expect(runs[0]?.kind).toBe('chat');
    expect(runs[0]?.status).toBe('done');
    expect(runs[0]?.tokens_in).toBe(120);
    expect(runs[0]?.model).toBe('main');

    const trace = h.service.repos.trace.forEvent(sent.eventId);
    expect(trace.some((t) => t.kind === 'llm_call')).toBe(true);
    expect(h.service.repos.events.get(sent.eventId)?.status).toBe('done');
  });

  it('runs chat at interactive priority', async () => {
    h = await bootService({ onboarded: true });
    h.fake.always({ text: 'hi' });
    const sent = h.service.chat.send({ text: 'hello' });
    await drain(h);
    const llm = h.service.repos.trace.forEvent(sent.eventId).find((t) => t.kind === 'llm_call')!
      .data as any;
    expect(llm.priority).toBe('interactive');
  });

  it('puts identity and personality in the system prompt', async () => {
    h = await bootService({ onboarded: true });
    h.fake.always({ text: 'noted' });
    h.service.chat.send({ text: 'who are you?' });
    await drain(h);
    const system = h.fake.requests.at(-1)!.body.messages[0].content as string;
    expect(system).toContain('Sleeper Service');
    expect(system).toContain('Alex');
    expect(system).toContain('Europe/Oslo');
    expect(system).toContain('verbosity terse');
    expect(system).toContain('Be brief.');
  });

  it('sends conversation history as context', async () => {
    h = await bootService({ onboarded: true });
    h.fake.always({ text: 'ack' });
    const first = h.service.chat.send({ text: 'my cat is called Fen' });
    await drain(h);
    h.service.chat.send({
      conversationId: first.conversationId,
      text: 'what is my cat called?',
    });
    await drain(h);

    const messages = h.fake.requests.at(-1)!.body.messages as {
      role: string;
      content: string;
    }[];
    const texts = messages.filter((m) => m.role !== 'system').map((m) => m.content);
    expect(texts).toEqual(['my cat is called Fen', 'ack', 'what is my cat called?']);
  });

  it('is idempotent when the same chat event is redelivered', async () => {
    h = await bootService({ onboarded: true });
    h.fake.always({ text: 'once' });
    const sent = h.service.chat.send({ text: 'hello' });
    await drain(h);

    // At-least-once delivery (§4.2): the same event can be processed twice.
    h.service.repos.events.setStatus(sent.eventId, 'received');
    await drain(h);

    const turns = h.service.repos.conversations.history(sent.conversationId);
    expect(turns.filter((t) => t.role === 'user')).toHaveLength(1);
    // The answer is regenerated rather than duplicated as a user turn.
    expect(turns.filter((t) => t.role === 'assistant').length).toBeGreaterThanOrEqual(1);
  });

  it('answers after a restart when the process died mid-turn', async () => {
    h = await bootService({ onboarded: true });
    h.fake.always({ text: 'answered after the restart' });
    const sent = h.service.chat.send({ text: 'are you there?' });
    // Leave the event exactly as a killed process would: claimed, unfinished.
    await h.service.queue.stop();
    h.service.repos.events.setStatus(sent.eventId, 'processing', { attempts: 1 });

    h.service.queue.start();
    await drain(h);

    const turns = h.service.repos.conversations.history(sent.conversationId);
    expect(turns.map((t) => t.role)).toEqual(['user', 'assistant']);
    expect(turns[1]?.text).toBe('answered after the restart');
    expect(h.service.repos.events.get(sent.eventId)?.status).toBe('done');
  });

  it('reports a model failure in-band instead of retrying forever', async () => {
    h = await bootService({ onboarded: true });
    h.fake.always({ errorStatus: 500 });
    const sent = h.service.chat.send({ text: 'hello' });
    await drain(h);

    const event = h.service.repos.events.get(sent.eventId)!;
    expect(event.status).toBe('done');
    expect(event.attempts).toBe(1);
    const runs = h.service.repos.runs.forEvent(sent.eventId);
    expect(runs[0]?.status).toBe('failed');
    expect(runs[0]?.error).toBeTruthy();
    // No assistant turn was invented.
    expect(h.service.repos.conversations.history(sent.conversationId)).toHaveLength(1);
  });

  it('closes a conversation and emits system.conversation_closed', async () => {
    h = await bootService({ onboarded: true });
    h.fake.always({ text: 'sure' });
    const sent = h.service.chat.send({ text: 'hello' });
    await drain(h);

    const closed = h.service.chat.close(sent.conversationId);
    expect(closed).toEqual({ closed: true, turnCount: 2 });
    const events = h.service.repos.events.recent({ limit: 10 });
    const closeEvent = events.find((e) => e.type === 'system.conversation_closed');
    expect(closeEvent).toBeTruthy();
    expect((closeEvent?.payload as any).conversation_id).toBe(sent.conversationId);
    expect((closeEvent?.payload as any).turn_count).toBe(2);

    // A second close is a no-op, not a second event.
    expect(h.service.chat.close(sent.conversationId).closed).toBe(false);
  });

  it('distils idle conversations without archiving them, skipping empty ones', async () => {
    h = await bootService({ onboarded: true });
    h.fake.always({ text: 'ok' });
    const spoken = h.service.chat.send({ text: 'hello' });
    await drain(h);
    const empty = h.service.repos.conversations.create({});

    // Age both conversations past the idle window.
    h.app.db
      .prepare(`UPDATE conversations SET last_activity_at = '2020-01-01T00:00:00.000Z'`)
      .run();
    expect(h.service.chat.distillIdle()).toBe(1);

    // Idle is a hint that distillation is worth running, not the user saying
    // they are done: both conversations stay open and stay in the list.
    expect(h.service.repos.conversations.get(spoken.conversationId)?.status).toBe('open');
    expect(h.service.repos.conversations.get(empty.id)?.status).toBe('open');
    expect(
      h.service.chat
        .list()
        .map((c) => c.id)
        .sort(),
    ).toEqual([spoken.conversationId, empty.id].sort());
    const idleEvents = h.service.repos.events
      .recent({ limit: 20 })
      .filter((e) => e.type === 'system.conversation_idle');
    expect(idleEvents).toHaveLength(1);
    expect((idleEvents[0]?.payload as any).conversation_id).toBe(spoken.conversationId);
    expect((idleEvents[0]?.payload as any).turn_count).toBe(2);
    // Nothing was archived, so no close event either.
    expect(
      h.service.repos.events
        .recent({ limit: 20 })
        .filter((e) => e.type === 'system.conversation_closed'),
    ).toHaveLength(0);
  });

  it('does not distil the same idle conversation twice', async () => {
    h = await bootService({ onboarded: true });
    h.fake.always({ text: 'ok' });
    const sent = h.service.chat.send({ text: 'hello' });
    await drain(h);
    // Backdating `last_activity_at` is how the test lets time pass.
    const idleSince = (at: string) =>
      h.app.db.prepare(`UPDATE conversations SET last_activity_at = ?`).run(at);

    idleSince('2020-01-01T00:00:00.000Z');
    expect(h.service.chat.distillIdle()).toBe(1);
    // The sweep ticks every minute; a quiet conversation is not owed a pass
    // every tick.
    expect(h.service.chat.distillIdle()).toBe(0);

    // Turns after the pass are new material, so it comes round again.
    h.service.chat.send({ conversationId: sent.conversationId, text: 'more' });
    await drain(h);
    idleSince('2020-06-01T00:00:00.000Z');
    expect(h.service.chat.distillIdle()).toBe(1);
  });

  it('reopens a closed conversation rather than forking a new one', async () => {
    h = await bootService({ onboarded: true });
    h.fake.always({ text: 'ok' });
    const first = h.service.chat.send({ text: 'hello' });
    await drain(h);
    h.service.chat.close(first.conversationId);

    // Forking here is what made history appear to vanish: the client went on
    // pointing at the old id while turns landed in a new conversation.
    const second = h.service.chat.send({ conversationId: first.conversationId, text: 'again' });
    expect(second.conversationId).toBe(first.conversationId);
    expect(h.service.repos.conversations.get(first.conversationId)?.status).toBe('open');
  });
});

describe('the onboarding greeting (§3c, App. B)', () => {
  /**
   * The gap this closes: onboarding was a conversation nobody started. The
   * prompt is written as an introduction, but the only thing that created a
   * conversation was the user sending a message — so a fresh install finished
   * setup and sat in an empty chat with an `onboarding` badge, waiting to be
   * spoken to without ever saying so.
   */
  it('opens the conversation itself, with no user turn', async () => {
    h = await bootService({ onboarded: false });
    h.fake.always({ text: 'I thought I might call myself Sleeper Service.' });

    expect(h.service.chat.requestOnboarding()).toBe(true);
    await drain(h);

    const conversation = h.service.repos.conversations.onboardingConversation();
    expect(conversation, 'a greeting should have made an onboarding conversation').toBeTruthy();
    const turns = h.service.repos.conversations.history(conversation!.id, {});
    // The whole point: one turn, and it is the assistant's. A user turn here
    // would be words nobody typed.
    expect(turns).toHaveLength(1);
    expect(turns[0]?.role).toBe('assistant');
    expect(turns[0]?.text).toContain('Sleeper Service');

    const event = h.service.repos.events
      .recent({ limit: 10, type: 'system.onboarding_ready' })
      .at(0);
    expect(event, 'the greeting runs off an event like everything else').toBeTruthy();
    expect(h.service.repos.runs.forEvent(event!.id)[0]?.kind).toBe('onboarding');
    // No history retrieval on a run with nothing to retrieve against, and no
    // fabricated user turn in the transcript sent to the model either: the
    // opening instruction is the only user-role message.
    const sentMessages = h.fake.requests.at(-1)!.body.messages as { role: string }[];
    expect(sentMessages.filter((m) => m.role === 'user')).toHaveLength(1);
  });

  it('is requested during start, so a half-finished install picks itself up', async () => {
    // The case that prompted this: setup was completed at some point, nothing
    // greeted, and the install has been sitting with a model and no identity.
    h = await bootService({ onboarded: false, greetOnStart: true });
    expect(
      h.service.repos.events.recent({ limit: 10, type: 'system.onboarding_ready' }),
    ).toHaveLength(1);
  });

  it('is not asked for twice once one is pending or under way', async () => {
    h = await bootService({ onboarded: false });
    h.fake.always({ text: 'Hello.' });

    expect(h.service.chat.requestOnboarding()).toBe(true);
    // Still queued: its run has not created a conversation yet, so the only
    // thing that can see it is the pending-event check.
    expect(h.service.chat.requestOnboarding()).toBe(false);
    await drain(h);
    // And now it has said something, which is the other half of the guard.
    expect(h.service.chat.requestOnboarding()).toBe(false);
    await drain(h);
    expect(h.service.repos.conversations.list({ includeArchived: true })).toHaveLength(1);
  });

  it('is never asked for once identity exists', async () => {
    h = await bootService({ onboarded: true });
    expect(h.service.chat.needsOnboarding()).toBe(false);
    expect(h.service.chat.requestOnboarding()).toBe(false);
  });

  it('retries into the same conversation when a greeting produced nothing', async () => {
    h = await bootService({ onboarded: false });
    // An empty onboarding conversation is a greeting that never landed; the
    // retry belongs there rather than in a fresh one, or a flapping endpoint
    // leaves a litter of empties in the sidebar.
    const orphan = h.service.repos.conversations.create({ mode: 'onboarding' });
    h.fake.always({ text: 'Second time lucky.' });

    expect(h.service.chat.requestOnboarding()).toBe(true);
    await drain(h);

    expect(h.service.repos.conversations.list({ includeArchived: true })).toHaveLength(1);
    const turns = h.service.repos.conversations.history(orphan.id, {});
    expect(turns).toHaveLength(1);
    expect(turns[0]?.role).toBe('assistant');
  });
});

describe('onboarding (plan §3c)', () => {
  it('routes the first conversation into onboarding and writes the config files', async () => {
    h = await bootService({ onboarded: false });
    expect(h.service.chat.needsOnboarding()).toBe(true);

    const identity = `---\ninstance_name: Sleeper Service\nuser_name: Alex\ntimezone: Europe/Oslo\nlocale: en\nonboarded_at: 2026-08-20T12:00:00.000Z\n---\n\nMade during onboarding.\n`;
    const personality = `---\nformality: relaxed\nverbosity: terse\nhumor: dry\n---\n\nBe brief.\n`;
    h.fake.script(
      {
        text: 'I will call myself Sleeper Service.',
        toolCalls: [
          {
            name: 'config.write',
            args: {
              path: 'config/identity.md',
              content: identity,
              message: 'initial identity: Sleeper Service',
            },
          },
          {
            name: 'config.write',
            args: {
              path: 'config/personality.md',
              content: personality,
              message: 'initial personality',
            },
          },
        ],
      },
      { text: 'Saved. Ready.' },
    );

    const sent = h.service.chat.send({ text: 'hello' });
    expect(sent.mode).toBe('onboarding');
    await drain(h);

    expect(fs.readFileSync(path.join(h.dataDir, 'config', 'identity.md'), 'utf8')).toContain(
      'Sleeper Service',
    );
    expect(fs.existsSync(path.join(h.dataDir, 'config', 'personality.md'))).toBe(true);

    const runs = h.service.repos.runs.forEvent(sent.eventId);
    expect(runs[0]?.kind).toBe('onboarding');
    const toolCalls = h.service.repos.trace
      .forEvent(sent.eventId)
      .filter((t) => t.kind === 'tool_call');
    expect(toolCalls).toHaveLength(2);
    expect((toolCalls[0]?.data as any).ok).toBe(true);

    // Identity now exists, so the conversation is a normal one from here.
    expect(h.service.repos.conversations.get(sent.conversationId)?.mode).toBe('normal');
    expect(h.service.chat.needsOnboarding()).toBe(false);
    expect(h.app.home.git.head()).toBeTruthy();
  });

  it('grants onboarding exactly the F.7 set', async () => {
    h = await bootService({ onboarded: false });
    h.fake.always({ text: 'thinking about names' });
    h.service.chat.send({ text: 'hello' });
    await drain(h);
    const tools = (h.fake.requests.at(-1)!.body.tools ?? []).map((t: any) => t.function.name);
    expect(tools.sort()).toEqual(['config.read', 'config.write', 'setup.token_create']);
  });

  it('refuses to write outside the allowed roots', async () => {
    h = await bootService({ onboarded: false });
    h.fake.script(
      {
        toolCalls: [
          {
            name: 'config.write',
            args: { path: '../escape.md', content: 'nope', message: 'try to escape' },
          },
        ],
      },
      { text: 'that did not work' },
    );
    const sent = h.service.chat.send({ text: 'hello' });
    await drain(h);

    expect(fs.existsSync(path.join(h.dataDir, '..', 'escape.md'))).toBe(false);
    const toolCall = h.service.repos.trace
      .forEvent(sent.eventId)
      .find((t) => t.kind === 'tool_call')!.data as any;
    expect(toolCall.ok).toBe(false);
    expect(toolCall.result_excerpt).toContain('tool_failed');
  });

  it('offers chat the configured default toolset and nothing else', async () => {
    h = await bootService({ onboarded: true });
    h.fake.always({ text: 'no tools needed' });
    h.service.chat.send({ text: 'hello' });
    await drain(h);
    const tools = (h.fake.requests.at(-1)!.body.tools ?? []).map((t: any) => t.function.name);
    /**
     * The default grant (App. F.7) covers more than this — `config.*` so chat
     * can author handlers (plan §6) and `setup.*` so it can connect things
     * (§19). What a *fresh* conversation renders is the core namespaces
     * (§21.2.1) plus `tools.open`; the rest is one catalog line each until the
     * model asks for it. Grants did not change, only what is drawn.
     */
    expect(tools.sort()).toEqual([
      'deliver.notify',
      'files.append',
      'files.delete',
      'files.edit',
      'files.list',
      'files.read',
      'files.search',
      'files.write',
      'memory.forget',
      'memory.query',
      'memory.save',
      'memory.update',
      'schedule.cancel',
      'schedule.create',
      'schedule.list',
      'skills.fetch',
      'time.now',
      'tools.open',
      'weather.forecast',
      'web.fetch',
      'web.query',
      'web.search',
    ]);
    // Emitting events onto its own loop is a handler's business, not chat's.
    // It is ungranted, so it is absent from the catalog too — a catalog line
    // must never advertise what the grants would refuse (§21.2.2).
    expect(tools).not.toContain('events.emit');
    const system = h.fake.requests.at(-1)!.body.messages[0].content as string;
    expect(system).not.toContain('events');
    // Granted but paged out: named in the catalog, not in the definitions.
    expect(system).toContain('- config:');
    expect(system).toContain('- setup:');
  });
});

describe('chat activity feedback', () => {
  it('reports what the run is doing: thinking, recalling, tool calls', async () => {
    h = await bootService({ onboarded: true });
    await h.service.memory.save({
      type: 'fact',
      description: 'Coffee preference',
      content: 'Black, no milk.',
    });

    const activity: any[] = [];
    h.service.chat.onStream({ activity: (e) => activity.push(e.activity) });

    h.fake.script(
      { toolCalls: [{ name: 'memory.query', args: { query: 'coffee' } }] },
      { text: 'Black, no milk.' },
    );
    h.service.chat.send({ text: 'how do I take my coffee?' });
    await drain(h);

    const kinds = activity.map((a) => a.kind);
    expect(kinds).toContain('recalled');
    expect(kinds).toContain('thinking');
    expect(kinds).toContain('tool_call');
    expect(kinds).toContain('tool_result');

    const call = activity.find((a) => a.kind === 'tool_call');
    expect(call.tool).toBe('memory.query');
    expect(call.args).toEqual({ query: 'coffee' });
    const result = activity.find((a) => a.kind === 'tool_result');
    expect(result).toMatchObject({ tool: 'memory.query', ok: true });
    // Turn numbers advance, so the UI can say "still thinking (turn 2)".
    expect(activity.filter((a) => a.kind === 'thinking').map((a) => a.turn)).toEqual([1, 2]);
  });

  it('reports a stop reason when a run ends badly', async () => {
    h = await bootService({ onboarded: true });
    const activity: any[] = [];
    h.service.chat.onStream({ activity: (e) => activity.push(e.activity) });
    h.fake.always({ errorStatus: 500 });
    h.service.chat.send({ text: 'hello?' });
    await drain(h);
    expect(activity.find((a) => a.kind === 'stopped')?.reason).toBe('error');
  });

  it('streams activity frames over the websocket', async () => {
    h = await bootService({ onboarded: true });
    const { TestClient } = await import('./service-harness.js');
    const client = await TestClient.connect(h.baseUrl, h.token);
    await client.hello();
    h.fake.script(
      { toolCalls: [{ name: 'web.search', args: { query: 'oslo' } }] },
      { text: 'Found it.' },
    );
    client.send('chat.send', { text: 'search for oslo' });
    await client.next('chat.done', 15000);
    const frames = client.of('chat.activity').map((f) => f.payload.activity);
    expect(frames.some((a: any) => a.kind === 'tool_call' && a.tool === 'web.search')).toBe(
      true,
    );
    client.close();
  });
});

describe('transcript completeness', () => {
  it('persists what the assistant said before a tool call, not just the last turn', async () => {
    h = await bootService({ onboarded: true });
    h.fake.script(
      {
        text: 'Let me look that up.',
        toolCalls: [{ name: 'memory.query', args: { query: 'coffee' } }],
      },
      { text: 'You take it black.' },
    );
    const sent = h.service.chat.send({ text: 'how do I take my coffee?' });
    await drain(h);

    const turns = h.service.repos.conversations.history(sent.conversationId);
    expect(turns).toHaveLength(2);
    // Both halves survive a page refresh, because both are in the transcript.
    expect(turns[1]?.text).toContain('Let me look that up.');
    expect(turns[1]?.text).toContain('You take it black.');
  });

  it('keeps the answer when the final turn adds nothing', async () => {
    h = await bootService({ onboarded: true });
    h.fake.script(
      {
        text: 'Here is what I found.',
        toolCalls: [{ name: 'memory.query', args: { query: 'x' } }],
      },
      { text: '' },
    );
    const sent = h.service.chat.send({ text: 'anything?' });
    await drain(h);

    const turns = h.service.repos.conversations.history(sent.conversationId);
    expect(turns.map((t) => t.role)).toEqual(['user', 'assistant']);
    expect(turns[1]?.text).toBe('Here is what I found.');
    expect(h.service.repos.runs.forEvent(sent.eventId)[0]?.status).toBe('done');
  });

  it('still reports a genuinely silent run as a failure', async () => {
    h = await bootService({ onboarded: true });
    h.fake.always({ text: '' });
    const sent = h.service.chat.send({ text: 'hello?' });
    await drain(h);
    expect(h.service.repos.conversations.history(sent.conversationId)).toHaveLength(1);
    expect(h.service.repos.runs.forEvent(sent.eventId)[0]?.status).toBe('failed');
  });
});

describe('conversation continuity', () => {
  it('carries on in the same conversation after an idle distillation pass', async () => {
    h = await bootService({ onboarded: true });
    h.fake.always({ text: 'still here' });
    const first = h.service.chat.send({ text: 'morning' });
    await drain(h);

    // The idle sweep runs distillation (§9) and leaves the conversation open.
    h.app.db
      .prepare(`UPDATE conversations SET last_activity_at = '2020-01-01T00:00:00.000Z'`)
      .run();
    expect(h.service.chat.distillIdle()).toBe(1);
    expect(h.service.repos.conversations.get(first.conversationId)?.status).toBe('open');
    await drain(h);

    // Typing into it continues it rather than forking a new one — forking is
    // what made history look like it had vanished.
    const second = h.service.chat.send({
      conversationId: first.conversationId,
      text: 'still there?',
    });
    expect(second.conversationId).toBe(first.conversationId);
    expect(h.service.repos.conversations.get(first.conversationId)?.status).toBe('open');
    await drain(h);

    const turns = h.service.repos.conversations.history(first.conversationId);
    expect(turns.map((t) => t.text)).toEqual([
      'morning',
      'still here',
      'still there?',
      'still here',
    ]);
    expect(h.service.repos.conversations.list()).toHaveLength(1);
  });

  it('never closes a conversation behind the user on the idle sweep', async () => {
    h = await bootService({ onboarded: true });
    const closed: { conversationId: string }[] = [];
    h.service.chat.onStream({ closed: (e) => closed.push(e) });
    h.fake.always({ text: 'ok' });
    h.service.chat.send({ text: 'hello' });
    await drain(h);

    h.app.db
      .prepare(`UPDATE conversations SET last_activity_at = '2020-01-01T00:00:00.000Z'`)
      .run();
    h.service.chat.distillIdle();
    // Archiving is a user action, so there is nothing to tell clients about.
    expect(closed).toEqual([]);
  });

  it('broadcasts an archive over the websocket', async () => {
    h = await bootService({ onboarded: true });
    const { TestClient } = await import('./service-harness.js');
    const client = await TestClient.connect(h.baseUrl, h.token);
    await client.hello();
    h.fake.always({ text: 'ok' });
    client.send('chat.send', { text: 'hello' });
    const accepted = await client.next('chat.accepted');
    await client.next('chat.done');

    // Another client archiving it should not leave this one out of date.
    h.service.chat.close(accepted.payload.conversation_id);
    const frame = await client.next('conversation.closed');
    expect(frame.payload).toEqual({
      conversation_id: accepted.payload.conversation_id,
    });
    client.close();
  });

  it('starts a fresh conversation only when the client asks for one', async () => {
    h = await bootService({ onboarded: true });
    h.fake.always({ text: 'ok' });
    const first = h.service.chat.send({ text: 'one' });
    await drain(h);
    const second = h.service.chat.send({ text: 'two' });
    await drain(h);
    // No conversation id given means a new conversation, as before.
    expect(second.conversationId).not.toBe(first.conversationId);
    // But naming the old one keeps it.
    const third = h.service.chat.send({ conversationId: first.conversationId, text: 'three' });
    expect(third.conversationId).toBe(first.conversationId);
  });

  it('does not lose turns when two clients talk to the same conversation', async () => {
    h = await bootService({ onboarded: true });
    h.fake.always({ text: 'noted' });
    const first = h.service.chat.send({ text: 'from tab one' });
    await drain(h);
    // A second, stale client sends into the same (now closed) conversation.
    h.service.chat.close(first.conversationId);
    await drain(h);
    const second = h.service.chat.send({
      conversationId: first.conversationId,
      text: 'from tab two',
    });
    await drain(h);

    expect(second.conversationId).toBe(first.conversationId);
    const texts = h.service.repos.conversations
      .history(first.conversationId)
      .map((t) => t.text);
    expect(texts).toContain('from tab one');
    expect(texts).toContain('from tab two');
    expect(h.service.repos.conversations.list()).toHaveLength(1);
  });
});

describe('archiving and deleting conversations', () => {
  it('hides archived conversations from the list by default', async () => {
    h = await bootService({ onboarded: true });
    h.fake.always({ text: 'ok' });
    const keep = h.service.chat.send({ text: 'live one' });
    await drain(h);
    const archive = h.service.chat.send({ text: 'old one' });
    await drain(h);
    h.service.chat.close(archive.conversationId);
    await drain(h);

    expect(h.service.chat.list().map((c) => c.id)).toEqual([keep.conversationId]);
    const all = h.service.chat.list({ includeArchived: true }).map((c) => c.id);
    expect(all).toContain(archive.conversationId);
    expect(all).toContain(keep.conversationId);
  });

  it('deletes a conversation and its turns, keeping the event trail', async () => {
    h = await bootService({ onboarded: true });
    h.fake.always({ text: 'ok' });
    const sent = h.service.chat.send({ text: 'forget this whole thing' });
    await drain(h);
    expect(h.service.repos.conversations.history(sent.conversationId)).toHaveLength(2);

    const result = h.service.chat.delete(sent.conversationId);
    expect(result).toEqual({ deleted: true, turns: 2 });
    expect(h.service.repos.conversations.get(sent.conversationId)).toBeNull();
    expect(h.service.repos.conversations.history(sent.conversationId)).toHaveLength(0);
    expect(h.service.chat.list({ includeArchived: true })).toHaveLength(0);

    // The events remain: they are the audit trail, not the transcript.
    expect(h.service.repos.events.get(sent.eventId)).not.toBeNull();
  });

  it('reports a delete of something that is not there', async () => {
    h = await bootService({ onboarded: true });
    expect(h.service.chat.delete('01NOPE')).toEqual({ deleted: false, turns: 0 });
  });

  it('orphans embeds instead of refusing the delete (§22.1)', async () => {
    h = await bootService({ onboarded: true });
    h.fake.always({ text: 'ok' });
    const sent = h.service.chat.send({ text: 'make me a chart' });
    await drain(h);
    const embed = h.service.repos.embeds.create({
      title: 'Chart',
      kind: 'ephemeral',
      conversationId: sent.conversationId,
    });

    // The regression: this threw "FOREIGN KEY constraint failed".
    expect(h.service.chat.delete(sent.conversationId)).toMatchObject({ deleted: true });

    // The embed survives its birth conversation, unanchored — the reaper's
    // "conversation gone" clause takes it from here on the normal TTL.
    const row = h.service.repos.embeds.get(embed.id);
    expect(row).not.toBeNull();
    expect(row!.conversation_id).toBeNull();
  });

  it('archives and deletes over the websocket, telling other clients', async () => {
    h = await bootService({ onboarded: true });
    h.fake.always({ text: 'ok' });
    const { TestClient } = await import('./service-harness.js');
    const client = await TestClient.connect(h.baseUrl, h.token);
    const watcher = await TestClient.connect(h.baseUrl, h.token);
    await client.hello();
    await watcher.hello();

    client.send('chat.send', { text: 'hello' });
    const accepted = await client.next('chat.accepted');
    await client.next('chat.done');
    const conversationId = accepted.payload.conversation_id as string;

    // Archive: gone from the default list, present when asked for.
    client.send('conversation.close', { conversation_id: conversationId });
    await client.next('conversation.closed');
    client.send('conversation.list', {});
    expect((await client.next('conversation.list.result')).payload.conversations).toHaveLength(
      0,
    );
    client.send('conversation.list', { include_archived: true });
    const withArchived = await client.next('conversation.list.result');
    expect(withArchived.payload.include_archived).toBe(true);
    expect(withArchived.payload.conversations[0].status).toBe('closed');

    // Delete: gone for good, announced once to every client.
    client.send('conversation.delete', { conversation_id: conversationId });
    const deleted = await client.next('conversation.deleted');
    expect(deleted.payload).toEqual({ conversation_id: conversationId, turns: 2 });
    const broadcast = await watcher.next('conversation.deleted');
    expect(broadcast.payload).toEqual({ conversation_id: conversationId, turns: 2 });
    // Exactly one frame each, not a broadcast plus an addressed copy.
    await new Promise((r) => setTimeout(r, 100));
    expect(client.of('conversation.deleted')).toHaveLength(0);
    expect(h.service.repos.conversations.get(conversationId)).toBeNull();

    client.send('conversation.delete', { conversation_id: conversationId });
    expect((await client.next('error')).payload.code).toBe('not_found');
    client.close();
    watcher.close();
  });

  it('keeps an archived conversation reachable by continuing it', async () => {
    h = await bootService({ onboarded: true });
    h.fake.always({ text: 'ok' });
    const sent = h.service.chat.send({ text: 'hello' });
    await drain(h);
    h.service.chat.close(sent.conversationId);
    // Hidden from the list while archived...
    expect(h.service.chat.list()).toHaveLength(0);
    // ...but talking into it brings it back.
    h.service.chat.send({ conversationId: sent.conversationId, text: 'still there?' });
    expect(h.service.chat.list().map((c) => c.id)).toEqual([sent.conversationId]);
  });
});

describe('conversation titles', () => {
  it('names a new conversation from its opening exchange', async () => {
    h = await bootService({ onboarded: true });
    let asked = '';
    h.fake.always((req) => {
      if (req.body.response_format?.json_schema?.name === 'conversation_title') {
        asked = req.body.messages.map((m: any) => m.content).join('\n');
        return { text: JSON.stringify({ title: '"Hafslund invoice."' }) };
      }
      return { text: 'It is 812 NOK, due 5 September.' };
    });

    const sent = h.service.chat.send({ text: 'what do I owe Hafslund?' });
    await drain(h);
    for (let i = 0; i < 100; i++) {
      if (h.service.repos.conversations.get(sent.conversationId)?.title) break;
      await new Promise((r) => setTimeout(r, 20));
    }
    // Quotes and trailing punctuation stripped.
    expect(h.service.repos.conversations.get(sent.conversationId)?.title).toBe(
      'Hafslund invoice',
    );
    // It saw both halves of the exchange.
    expect(asked).toContain('what do I owe Hafslund?');
    expect(asked).toContain('812 NOK');
  });

  it('titles at background priority and does not delay the reply', async () => {
    h = await bootService({ onboarded: true });
    h.fake.always((req) =>
      req.body.response_format?.json_schema?.name === 'conversation_title'
        ? { text: JSON.stringify({ title: 'Small talk' }) }
        : { text: 'hello there' },
    );
    const sent = h.service.chat.send({ text: 'hi' });
    await drain(h);
    // The event is done before the title run has necessarily finished.
    expect(h.service.repos.events.get(sent.eventId)?.status).toBe('done');

    for (let i = 0; i < 100; i++) {
      if (h.service.repos.conversations.get(sent.conversationId)?.title) break;
      await new Promise((r) => setTimeout(r, 20));
    }
    const titleRun = h.service.repos.runs
      .forEvent(sent.eventId)
      .concat(h.app.db.prepare(`SELECT * FROM runs WHERE kind='maintenance'`).all() as any[])
      .find((r: any) => r.kind === 'maintenance');
    expect(titleRun?.status).toBe('done');
    const llm = h.app.db
      .prepare(`SELECT data FROM trace WHERE run_id = ? AND kind='llm_call'`)
      .all(titleRun!.id) as { data: string }[];
    expect(JSON.parse(llm[0]!.data).priority).toBe('background');
  });

  it('titles only once, and never overwrites an existing title', async () => {
    h = await bootService({ onboarded: true });
    let titleCalls = 0;
    h.fake.always((req) => {
      if (req.body.response_format?.json_schema?.name === 'conversation_title') {
        titleCalls += 1;
        return { text: JSON.stringify({ title: `Title ${titleCalls}` }) };
      }
      return { text: 'ok' };
    });
    const sent = h.service.chat.send({ text: 'first' });
    await drain(h);
    for (let i = 0; i < 100 && titleCalls === 0; i++)
      await new Promise((r) => setTimeout(r, 20));

    h.service.chat.send({ conversationId: sent.conversationId, text: 'second' });
    await drain(h);
    await new Promise((r) => setTimeout(r, 200));
    expect(titleCalls).toBe(1);
    expect(h.service.repos.conversations.get(sent.conversationId)?.title).toBe('Title 1');
  });

  it('leaves the conversation unnamed rather than failing when titling breaks', async () => {
    h = await bootService({ onboarded: true });
    h.fake.always((req) =>
      req.body.response_format?.json_schema?.name === 'conversation_title'
        ? { text: 'not json' }
        : { text: 'answered anyway' },
    );
    const sent = h.service.chat.send({ text: 'hello' });
    await drain(h);
    await new Promise((r) => setTimeout(r, 300));
    expect(h.service.repos.conversations.get(sent.conversationId)?.title).toBeNull();
    // The turn itself is unaffected.
    expect(h.service.repos.conversations.history(sent.conversationId)).toHaveLength(2);
  });
});

describe('context and token reporting', () => {
  it('reports what the turn cost and how full the context is', async () => {
    h = await bootService({ onboarded: true });
    const usage: any[] = [];
    h.service.chat.onStream({ usage: (e) => usage.push(e) });
    h.fake.always((req) =>
      req.body.response_format?.json_schema?.name === 'conversation_title'
        ? { text: JSON.stringify({ title: 'x' }) }
        : { text: 'answered', usage: { prompt: 1200, completion: 80 } },
    );

    const sent = h.service.chat.send({ text: 'hello' });
    await drain(h);

    expect(usage).toHaveLength(1);
    expect(usage[0]).toMatchObject({
      conversationId: sent.conversationId,
      model: 'main',
      turns: 1,
      tokensIn: 1200,
      tokensOut: 80,
      // The harness endpoint declares 32768.
      contextSize: 32768,
    });
    expect(usage[0].durationMs).toBeGreaterThanOrEqual(0);
  });

  it('accumulates tokens across the conversation', async () => {
    h = await bootService({ onboarded: true });
    const usage: any[] = [];
    h.service.chat.onStream({ usage: (e) => usage.push(e) });
    h.fake.always((req) =>
      req.body.response_format?.json_schema?.name === 'conversation_title'
        ? { text: JSON.stringify({ title: 'x' }) }
        : { text: 'ok', usage: { prompt: 100, completion: 10 } },
    );

    const first = h.service.chat.send({ text: 'one' });
    await drain(h);
    h.service.chat.send({ conversationId: first.conversationId, text: 'two' });
    await drain(h);

    const last = usage.at(-1)!;
    expect(last.tokensIn).toBe(100);
    // Two chat runs of 110 each; the title run is not part of the conversation.
    expect(last.conversationTokensIn + last.conversationTokensOut).toBe(220);
  });

  it('emits per-turn usage as activity, so a client can tick it live', async () => {
    h = await bootService({ onboarded: true });
    const activity: any[] = [];
    h.service.chat.onStream({ activity: (e) => activity.push(e.activity) });
    let toolDone = false;
    h.fake.always((req) => {
      if (req.body.response_format?.json_schema?.name === 'conversation_title') {
        return { text: JSON.stringify({ title: 'x' }) };
      }
      if (req.body.tools && !toolDone) {
        toolDone = true;
        return {
          toolCalls: [{ name: 'memory.query', args: { query: 'x' } }],
          usage: { prompt: 500, completion: 20 },
        };
      }
      return { text: 'done', usage: { prompt: 700, completion: 30 } };
    });

    h.service.chat.send({ text: 'look something up' });
    await drain(h);

    const usageActivity = activity.filter((a) => a.kind === 'usage');
    // One per model call, each stamped with its turn and the context size.
    expect(usageActivity).toHaveLength(2);
    expect(usageActivity[0]).toMatchObject({ turn: 1, tokens_in: 500, context_size: 32768 });
    expect(usageActivity[1]).toMatchObject({ turn: 2, tokens_in: 700, tokens_out: 30 });
  });

  it('sends usage and title frames over the websocket', async () => {
    h = await bootService({ onboarded: true });
    const { TestClient } = await import('./service-harness.js');
    const client = await TestClient.connect(h.baseUrl, h.token);
    const welcome = await client.hello();
    // The page checks these before rendering the strip.
    expect(welcome.payload.emits).toContain('chat.usage');
    expect(welcome.payload.emits).toContain('conversation.titled');

    h.fake.always((req) =>
      req.body.response_format?.json_schema?.name === 'conversation_title'
        ? { text: JSON.stringify({ title: 'Oslo weather' }) }
        : { text: 'Rain.', usage: { prompt: 300, completion: 5 } },
    );
    client.send('chat.send', { text: 'weather in Oslo?' });
    await client.next('chat.done');

    const usage = await client.next('chat.usage');
    expect(usage.payload).toMatchObject({
      tokens_in: 300,
      tokens_out: 5,
      context_size: 32768,
      model: 'main',
    });
    const titled = await client.next('conversation.titled', 15000);
    expect(titled.payload.title).toBe('Oslo weather');
    client.close();
  });
});

describe('background work lifecycle', () => {
  it('finishes tracked background work before the database closes', async () => {
    const { BackgroundTasks } = await import('../src/core/background.js');
    const tasks = new BackgroundTasks();
    let finished = false;
    tasks.run('slow', async () => {
      await new Promise((r) => setTimeout(r, 60));
      finished = true;
    });
    expect(tasks.size).toBe(1);
    await tasks.stop();
    expect(finished).toBe(true);
    expect(tasks.size).toBe(0);
  });

  it('swallows a failing background task rather than crashing the process', async () => {
    const { BackgroundTasks } = await import('../src/core/background.js');
    const tasks = new BackgroundTasks();
    tasks.run('broken', async () => {
      throw new Error('nope');
    });
    await expect(tasks.stop()).resolves.toBeUndefined();
  });

  it('refuses new work once shutting down', async () => {
    const { BackgroundTasks } = await import('../src/core/background.js');
    const tasks = new BackgroundTasks();
    await tasks.stop();
    let ran = false;
    tasks.run('late', async () => {
      ran = true;
    });
    expect(ran).toBe(false);
  });

  it('drains the title run when the service stops mid-flight', async () => {
    h = await bootService({ onboarded: true });
    h.fake.always((req) =>
      req.body.response_format?.json_schema?.name === 'conversation_title'
        ? { text: JSON.stringify({ title: 'Named on the way out' }), delayMs: 60 }
        : { text: 'ok' },
    );
    const sent = h.service.chat.send({ text: 'hello' });
    await drain(h);
    // Stop immediately: the title run is still in flight.
    await h.service.stop();
    expect(h.service.repos.conversations.get(sent.conversationId)?.title).toBe(
      'Named on the way out',
    );
    // cleanup() calls stop() again; that must be harmless.
  });
});

describe('title run accounting', () => {
  it('records what the title run cost on its own run row', async () => {
    h = await bootService({ onboarded: true });
    h.fake.always((req) =>
      req.body.response_format?.json_schema?.name === 'conversation_title'
        ? { text: JSON.stringify({ title: 'Named' }), usage: { prompt: 90, completion: 6 } }
        : { text: 'ok', usage: { prompt: 100, completion: 10 } },
    );
    const sent = h.service.chat.send({ text: 'hello' });
    await drain(h);
    await h.service.background.drain();

    const titleRun = (
      h.app.db.prepare(`SELECT * FROM runs WHERE kind='maintenance'`).all() as any[]
    )[0];
    expect(titleRun).toMatchObject({
      status: 'done',
      tokens_in: 90,
      tokens_out: 6,
      model: 'main',
    });

    // And it stays out of the conversation's own total.
    expect(h.service.repos.runs.tokensForConversation(sent.conversationId)).toEqual({
      tokensIn: 100,
      tokensOut: 10,
    });
  });
});
