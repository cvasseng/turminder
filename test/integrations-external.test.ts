import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDataHome, type DataHome } from '../src/core/datadir.js';
import { openDb, type Db } from '../src/db/index.js';
import { createRepos, type Repos } from '../src/db/repos/index.js';
import { DEFAULT_SETTINGS } from '../src/core/config.js';
import { EventIntake } from '../src/ingress/intake.js';
import { PollingSource, type PollResult } from '../src/ingress/source.js';
import { AsanaClient } from '../src/tools/integrations/asana/client.js';
import {
  AsanaInboxSource,
  DEFAULT_ASANA_CONFIG,
} from '../src/tools/integrations/asana/inbox-source.js';
import { asanaTools } from '../src/tools/integrations/asana/tools.js';
import type { FakeTask } from './fake-asana.js';
import { CalendarClient, calendarTools } from '../src/tools/integrations/google/calendar.js';
import { CalendarSource } from '../src/tools/integrations/google/calendar-source.js';
import { GoogleTokenStore } from '../src/tools/integrations/google/auth.js';
import { FakeAsana, asanaFetch } from './fake-asana.js';
import { FakeGoogle, googleFetch } from './fake-google.js';
import { Config } from '../src/core/config.js';
import { tmpDir, write } from './helpers.js';

interface Env {
  home: DataHome;
  /** The secret store lives on the config (§27), so tests need one. */
  config: Config;
  db: Db;
  repos: Repos;
  intake: EventIntake;
  cleanup(): void;
}

function env(): Env {
  const t = tmpDir('turminder-src-');
  const { home } = openDataHome(path.join(t.dir, 'home'));
  const db = openDb(home.dbPath);
  const repos = createRepos(db);
  return {
    home,
    config: new Config(home),
    db,
    repos,
    intake: new EventIntake(repos, DEFAULT_SETTINGS),
    cleanup() {
      db.close();
      t.cleanup();
    },
  };
}

const ctx = { runId: null, eventId: null };

describe('polling source framework', () => {
  let e: Env;
  beforeEach(() => {
    e = env();
  });
  afterEach(() => e.cleanup());

  class Scripted extends PollingSource {
    results: PollResult[] = [];
    polls = 0;
    seenCursors: (string | null)[] = [];
    constructor(deps: { intake: EventIntake; meta: Repos['meta'] }) {
      super('test.source', deps, 60_000);
    }
    protected async poll(cursor: string | null): Promise<PollResult> {
      this.polls += 1;
      this.seenCursors.push(cursor);
      const next = this.results.shift();
      if (!next) throw new Error('nothing scripted');
      return next;
    }
  }

  it('submits events and persists the cursor', async () => {
    const source = new Scripted({ intake: e.intake, meta: e.repos.meta });
    source.results.push({
      events: [
        { type: 'x.happened', source: 'test', payload: { n: 1 }, idempotency_key: 'k1' },
        { type: 'x.happened', source: 'test', payload: { n: 2 }, idempotency_key: 'k2' },
      ],
      cursor: '2026-08-20T00:00:00.000Z',
    });
    expect(await source.tick()).toBe(2);
    expect(e.repos.meta.cursor('test.source')).toBe('2026-08-20T00:00:00.000Z');
    expect(e.repos.events.recent({ limit: 10 })).toHaveLength(2);
  });

  it('passes the stored cursor back on the next poll', async () => {
    const source = new Scripted({ intake: e.intake, meta: e.repos.meta });
    source.results.push({ events: [], cursor: 'cursor-1' });
    source.results.push({ events: [], cursor: 'cursor-2' });
    await source.tick();
    await source.tick();
    expect(source.seenCursors).toEqual([null, 'cursor-1']);
  });

  it('dedupes repeated events by idempotency key', async () => {
    const source = new Scripted({ intake: e.intake, meta: e.repos.meta });
    const event = { type: 'x.happened', source: 'test', payload: {}, idempotency_key: 'same' };
    source.results.push({ events: [event] });
    source.results.push({ events: [event] });
    expect(await source.tick()).toBe(1);
    expect(await source.tick()).toBe(0);
    expect(e.repos.events.recent({ limit: 10 })).toHaveLength(1);
  });

  it('survives a failing poll without losing the cursor', async () => {
    const source = new Scripted({ intake: e.intake, meta: e.repos.meta });
    source.results.push({ events: [], cursor: 'good' });
    await source.tick();
    // Next poll throws (nothing scripted).
    expect(await source.tick()).toBe(0);
    expect(e.repos.meta.cursor('test.source')).toBe('good');
  });
});

describe('asana inbox source (My Tasks sections)', () => {
  let e: Env;
  let fake: FakeAsana;
  let client: AsanaClient;

  beforeEach(async () => {
    e = env();
    fake = new FakeAsana();
    const base = await fake.start();
    client = new AsanaClient({
      pat: 'test-pat',
      fetch: asanaFetch(base),
      sleep: async () => {},
    });
    // My Tasks as the user actually has it: an inbox plus a triage section.
    fake.section('Inbox');
    fake.section('Do today');
  });
  afterEach(async () => {
    await fake.stop();
    e.cleanup();
  });

  const source = (over: Partial<typeof DEFAULT_ASANA_CONFIG> = {}) =>
    new AsanaInboxSource({ intake: e.intake, meta: e.repos.meta }, client, {
      ...DEFAULT_ASANA_CONFIG,
      workspaces: ['ws1'],
      ...over,
    });

  const task = (over: Partial<FakeTask> = {}): FakeTask => ({
    gid: over.gid ?? 't1',
    name: over.name ?? 'Ship the thing',
    notes: over.notes ?? '',
    completed: over.completed ?? false,
    modified_at: over.modified_at ?? new Date().toISOString(),
    created_at: over.created_at ?? new Date().toISOString(),
    assignee: over.assignee ?? { gid: '999', name: 'Test User' },
    created_by: over.created_by ?? { gid: 'other', name: 'Roger Ulvestad' },
    projects: over.projects ?? [{ gid: 'p1', name: 'Weekly' }],
    tags: over.tags ?? [],
    permalink_url: over.permalink_url ?? 'https://app.asana.com/0/1/t1',
    due_on: over.due_on ?? null,
  });

  it('does not announce the standing inbox on the first poll', async () => {
    fake.section('Inbox').tasks.push(task({ gid: 'old1' }), task({ gid: 'old2' }));
    const s = source();
    expect(await s.tick()).toBe(0);
    // But it remembers them, so they are not announced later either.
    expect(await s.tick()).toBe(0);
  });

  it('announces a task that arrives in the inbox afterwards', async () => {
    fake.section('Inbox').tasks.push(task({ gid: 'old' }));
    const s = source();
    await s.tick();

    fake
      .section('Inbox')
      .tasks.push(task({ gid: 'fresh', name: 'Review the PR', due_on: '2026-08-25' }));
    fake.stories.fresh = [
      {
        created_at: '2026-08-20T10:00:00.000Z',
        text: 'Roger: can you look at this today?',
        resource_subtype: 'comment_added',
      },
      {
        created_at: '2026-08-20T10:01:00.000Z',
        text: 'moved it',
        resource_subtype: 'section_changed',
      },
    ];
    expect(await s.tick()).toBe(1);

    const event = e.repos.events.recent({ limit: 5 })[0]!;
    expect(event.type).toBe('asana.inbox_item');
    expect(event.source).toBe('asana.ws1');
    expect(event.serialization_key).toBe('asana:fresh');
    expect(event.idempotency_key).toMatch(/^asana:fresh:Inbox:/);
    const payload = event.payload as any;
    expect(payload.section).toBe('Inbox');
    expect(payload.task.name).toBe('Review the PR');
    expect(payload.task.created_by).toBe('Roger Ulvestad');
    // Only real comments, not every activity story.
    expect(payload.comments).toHaveLength(1);
    expect(payload.comments[0].text).toMatch(/can you look at this/);
  });

  it('says nothing when the user triages a task out of the inbox', async () => {
    fake.section('Inbox').tasks.push(task({ gid: 'old' }));
    const s = source();
    await s.tick();
    fake.section('Inbox').tasks.push(task({ gid: 'fresh' }));
    expect(await s.tick()).toBe(1);

    // The user moves it to Do today: triage is not news.
    fake.move('fresh', 'Do today');
    expect(await s.tick()).toBe(0);
  });

  it('announces a task that comes back to the inbox', async () => {
    fake.section('Inbox').tasks.push(task({ gid: 'a' }));
    const s = source();
    await s.tick();
    fake.section('Inbox').tasks.push(task({ gid: 'b' }));
    await s.tick();
    fake.move('b', 'Do today');
    await s.tick();
    fake.move('b', 'Inbox');
    expect(await s.tick()).toBe(1);
  });

  it('optionally announces work moved into the daily section', async () => {
    fake.section('Inbox').tasks.push(task({ gid: 'a' }));
    const s = source({ watchDaily: true });
    await s.tick();
    fake.section('Inbox').tasks.push(task({ gid: 'b' }));
    await s.tick();
    fake.move('b', 'Do today');
    expect(await s.tick()).toBe(1);
    const event = e.repos.events.recent({ limit: 5 })[0]!;
    expect(event.type).toBe('asana.task_scheduled');
    expect((event.payload as any).section).toBe('Do today');
  });

  it('ignores completed tasks', async () => {
    fake.section('Inbox').tasks.push(task({ gid: 'a' }));
    const s = source();
    await s.tick();
    fake.section('Inbox').tasks.push(task({ gid: 'done', completed: true }));
    expect(await s.tick()).toBe(0);
  });

  it('strips Asana markup out of notes', async () => {
    fake.section('Inbox').tasks.push(task({ gid: 'a' }));
    const s = source();
    await s.tick();
    fake.section('Inbox').tasks.push(
      task({
        gid: 'marked',
        notes:
          'These goals need an update:\n<UL><LI><ASANA_OBJECT OBJECT_ID="1"></ASANA_OBJECT></LI></UL>\nGo &amp; do it.',
      }),
    );
    await s.tick();
    const payload = e.repos.events.recent({ limit: 5 })[0]!.payload as any;
    expect(payload.task.notes).not.toContain('ASANA_OBJECT');
    expect(payload.task.notes).not.toContain('<UL>');
    expect(payload.task.notes).toContain('Go & do it.');
  });

  it("matches Asana's own default section name", async () => {
    fake.sections = [];
    fake.section('Recently assigned').tasks.push(task({ gid: 'a' }));
    const s = source();
    await s.tick();
    fake.section('Recently assigned').tasks.push(task({ gid: 'b' }));
    // Configured as "Inbox", but "Recently assigned" is the same thing.
    expect(await s.tick()).toBe(1);
  });

  it('warns rather than failing when no inbox section exists', async () => {
    fake.sections = [];
    fake.section('Something Else').tasks.push(task({ gid: 'a' }));
    expect(await source().tick()).toBe(0);
  });

  it('caps how much one poll can announce', async () => {
    fake.section('Inbox').tasks.push(task({ gid: 'seed' }));
    const s = source({ maxPerPoll: 2 });
    await s.tick();
    for (let i = 0; i < 5; i++) fake.section('Inbox').tasks.push(task({ gid: `n${i}` }));
    expect(await s.tick()).toBe(2);
  });

  it('reports an unusable token instead of starting', async () => {
    fake.failNext = 401;
    const s = source();
    await s.start();
    expect(e.repos.events.recent({ limit: 5 })).toHaveLength(0);
    s.stop();
  });
});

describe('asana client mechanics', () => {
  let fake: FakeAsana;
  let client: AsanaClient;
  let base: string;

  beforeEach(async () => {
    fake = new FakeAsana();
    base = await fake.start();
    client = new AsanaClient({
      pat: 'test-pat',
      fetch: asanaFetch(base),
      sleep: async () => {},
    });
    fake.section('Inbox');
  });
  afterEach(async () => {
    await fake.stop();
  });

  it('follows next_page.offset until the collection is exhausted', async () => {
    fake.paginate = true;
    for (let i = 0; i < 5; i++) {
      fake.section('Inbox').tasks.push({ gid: `t${i}`, name: `Task ${i}`, completed: false });
    }
    const grouped = await client.myTasks('ws1');
    expect(grouped[0]?.tasks.map((t) => t.gid)).toEqual(['t0', 't1', 't2', 't3', 't4']);
    // One request per page, so pagination really happened.
    const taskRequests = fake.requests.filter(
      (r) => r.path.includes('/tasks') && r.method === 'GET',
    );
    expect(taskRequests.length).toBeGreaterThanOrEqual(5);
  });

  it('retries a 429 using Retry-After, then succeeds', async () => {
    const waited: number[] = [];
    const retrying = new AsanaClient({
      pat: 'p',
      fetch: asanaFetch(base),
      sleep: async (ms) => void waited.push(ms),
    });
    fake.failNext = 429;
    fake.retryAfter = '2';
    const me = await retrying.me();
    expect(me.name).toBe('Test User');
    // Retry-After honoured, not a fixed guess.
    expect(waited[0]).toBe(2000);
  });

  it('stamps the section onto tasks from a section listing', async () => {
    fake.section('Inbox').tasks.push({ gid: 't1', name: 'One', completed: false });
    const grouped = await client.myTasks('ws1');
    expect(grouped[0]?.tasks[0]?.section?.name).toBe('Inbox');
    const detail = await client.task('t1');
    expect(detail.section?.name).toBe('Inbox');
  });

  it('wraps write bodies in a data envelope', async () => {
    fake.section('Inbox').tasks.push({ gid: 't1', name: 'One', completed: false });
    await client.setCompleted('t1', true);
    const put = fake.requests.find((r) => r.method === 'PUT')!;
    expect(put.body).toEqual({ data: { completed: true } });
    expect(fake.section('Inbox').tasks[0]?.completed).toBe(true);
  });

  it('returns only comments from the story stream', async () => {
    fake.stories.t1 = [
      {
        created_at: '2026-08-20T10:00:00.000Z',
        text: 'a comment',
        resource_subtype: 'comment_added',
      },
      {
        created_at: '2026-08-20T10:01:00.000Z',
        text: 'due date set',
        resource_subtype: 'due_date_changed',
      },
    ];
    const comments = await client.comments('t1');
    expect(comments).toHaveLength(1);
    expect(comments[0]?.text).toBe('a comment');
    // stories() keeps everything, for handlers that want the activity.
    expect(await client.stories('t1')).toHaveLength(2);
  });
});

describe('asana tools', () => {
  let fake: FakeAsana;
  let client: AsanaClient;
  const config = { inboxSection: 'Inbox', dailySection: 'Do today' };

  beforeEach(async () => {
    fake = new FakeAsana();
    client = new AsanaClient({
      pat: 'test-pat',
      fetch: asanaFetch(await fake.start()),
      sleep: async () => {},
    });
    fake.section('Inbox');
    fake.section('Do today');
  });
  afterEach(async () => {
    await fake.stop();
  });

  const tool = (name: string) => asanaTools(client, config).find((t) => t.name === name)!;

  it('lists the inbox section, skipping completed work', async () => {
    fake
      .section('Inbox')
      .tasks.push(
        { gid: 't1', name: 'Open thing', completed: false },
        { gid: 't2', name: 'Done thing', completed: true },
      );
    const result = (await tool('asana.inbox').execute({}, ctx)) as any;
    expect(result.section).toBe('Inbox');
    expect(result.tasks.map((t: any) => t.gid)).toEqual(['t1']);
    expect(result.untrusted).toBe(true);
  });

  it('lists My Tasks grouped by section', async () => {
    fake.section('Inbox').tasks.push({ gid: 't1', name: 'Untriaged', completed: false });
    fake.section('Do today').tasks.push({ gid: 't2', name: 'Today', completed: false });
    const result = (await tool('asana.my_tasks').execute({}, ctx)) as any;
    expect(result.sections.map((s: any) => s.section)).toEqual(['Inbox', 'Do today']);
    expect(result.sections[1].tasks[0].name).toBe('Today');
  });

  it('triages a task into the daily section by default', async () => {
    fake.section('Inbox').tasks.push({ gid: 't1', name: 'Untriaged', completed: false });
    const result = (await tool('asana.triage').execute({ gid: 't1' }, ctx)) as any;
    expect(result.moved_to).toBe('Do today');
    expect(fake.section('Do today').tasks.map((t) => t.gid)).toEqual(['t1']);
    expect(fake.section('Inbox').tasks).toHaveLength(0);
  });

  it('names the sections it has when asked for one that does not exist', async () => {
    fake.section('Inbox').tasks.push({ gid: 't1', name: 'x', completed: false });
    const result = (await tool('asana.triage').execute(
      { gid: 't1', section: 'Nowhere' },
      ctx,
    )) as any;
    expect(result.error).toBe('section_not_found');
  });

  it('comments, completes, sets due dates and creates tasks', async () => {
    fake.section('Inbox').tasks.push({ gid: 't1', name: 'x', completed: false });

    const commented = (await tool('asana.comment').execute(
      { gid: 't1', text: 'on it' },
      ctx,
    )) as any;
    expect(commented.comment_gid).toBeTruthy();
    expect(fake.stories.t1?.[0]?.text).toBe('on it');

    const completed = (await tool('asana.complete_task').execute({ gid: 't1' }, ctx)) as any;
    expect(completed.completed).toBe(true);

    const dated = (await tool('asana.set_due_date').execute(
      { gid: 't1', due_on: '2026-09-01' },
      ctx,
    )) as any;
    expect(dated.due_on).toBe('2026-09-01');

    const created = (await tool('asana.create_task').execute({ name: 'New work' }, ctx)) as any;
    expect(created.name).toBe('New work');
  });

  it('tiers reads read-only and writes side-effecting (§11.3)', () => {
    const tiers = Object.fromEntries(asanaTools(client, config).map((t) => [t.name, t.tier]));
    expect(tiers['asana.inbox']).toBe('ro');
    expect(tiers['asana.my_tasks']).toBe('ro');
    expect(tiers['asana.task_detail']).toBe('ro');
    expect(tiers['asana.triage']).toBe('se');
    expect(tiers['asana.comment']).toBe('se');
    expect(tiers['asana.complete_task']).toBe('se');
    expect(tiers['asana.create_task']).toBe('se');
  });

  it('returns an error object rather than throwing', async () => {
    fake.failNext = 500;
    const result = (await tool('asana.task_detail').execute({ gid: 'nope' }, ctx)) as any;
    expect(result.error).toBe('asana_failed');
  });
});

describe('google calendar', () => {
  let e: Env;
  let fake: FakeGoogle;
  let client: CalendarClient;

  const authorise = (scope?: string) => {
    new GoogleTokenStore(e.config).save({
      refresh_token: 'fake-refresh',
      obtained_at: new Date().toISOString(),
      scope:
        scope ??
        'https://www.googleapis.com/auth/calendar.readonly https://www.googleapis.com/auth/calendar.events',
    });
  };

  beforeEach(async () => {
    e = env();
    fake = new FakeGoogle();
    const base = await fake.start();
    write(
      e.home.path('secrets', 'secrets.yaml'),
      'GOOGLE_CLIENT_ID: id\nGOOGLE_CLIENT_SECRET: sec\n',
    );
    client = CalendarClient.create(e.config, googleFetch(base));
  });
  afterEach(async () => {
    await fake.stop();
    e.cleanup();
  });

  it('reads events, converting Google shapes into ours', async () => {
    authorise();
    fake.events = [
      {
        id: 'e1',
        summary: 'Standup',
        location: 'Meet',
        start: { dateTime: '2026-08-21T08:00:00Z' },
        end: { dateTime: '2026-08-21T08:15:00Z' },
        attendees: [{ email: 'a@example.com', responseStatus: 'accepted' }],
        htmlLink: 'https://calendar.google.com/e1',
        updated: '2026-08-20T10:00:00.000Z',
      },
      {
        id: 'e2',
        summary: 'Holiday',
        start: { date: '2026-08-22' },
        end: { date: '2026-08-23' },
      },
    ];
    const events = await client.listEvents({
      timeMin: '2026-08-21T00:00:00.000Z',
      timeMax: '2026-08-24T00:00:00.000Z',
    });
    expect(events.map((x) => x.summary)).toEqual(['Standup', 'Holiday']);
    expect(events[0]?.all_day).toBe(false);
    expect(events[0]?.attendees[0]).toEqual({ email: 'a@example.com', response: 'accepted' });
    expect(events[1]?.all_day).toBe(true);
    // singleEvents keeps recurrence expanded into occurrences.
    const listRequest = fake.requests.find(
      (r) => r.path.endsWith('/events') && r.method === 'GET',
    )!;
    expect(listRequest.query.singleEvents).toBe('true');
  });

  it('creates an event, and only emails attendees when there are some', async () => {
    authorise();
    const created = await client.createEvent({
      summary: 'Coffee with Roger',
      start: '2026-08-25T09:00:00.000Z',
      end: '2026-08-25T09:30:00.000Z',
      location: 'Kaffebrenneriet',
    });
    expect(created.summary).toBe('Coffee with Roger');
    // The first POST is the token exchange; we want the events call.
    const post = fake.requests.find((r) => r.method === 'POST' && r.path.includes('/events'))!;
    expect(post.body.start.dateTime).toBe('2026-08-25T09:00:00.000Z');
    expect(post.query.sendUpdates).toBe('none');

    await client.createEvent({
      summary: 'Review',
      start: '2026-08-26T09:00:00.000Z',
      end: '2026-08-26T10:00:00.000Z',
      attendees: ['roger@example.com'],
    });
    const withAttendees = fake.requests
      .filter((r) => r.method === 'POST' && r.path.includes('/events'))
      .at(-1)!;
    expect(withAttendees.body.attendees).toEqual([{ email: 'roger@example.com' }]);
    expect(withAttendees.query.sendUpdates).toBe('all');
  });

  it('writes an all-day event as a date, not a time', async () => {
    authorise();
    await client.createEvent({ summary: 'Off', start: '2026-09-01', end: '2026-09-02' });
    const post = fake.requests
      .filter((r) => r.method === 'POST' && r.path.includes('/events'))
      .at(-1)!;
    expect(post.body.start).toEqual({ date: '2026-09-01' });
    expect(post.body.end).toEqual({ date: '2026-09-02' });
  });

  it('updates and deletes events', async () => {
    authorise();
    const created = await client.createEvent({
      summary: 'Draft',
      start: '2026-08-25T09:00:00.000Z',
      end: '2026-08-25T09:30:00.000Z',
    });
    const updated = await client.updateEvent(created.id, { summary: 'Final' });
    expect(updated.summary).toBe('Final');
    await client.deleteEvent(created.id);
    expect(fake.events.find((x) => x.id === created.id)).toBeUndefined();
  });

  it('RSVPs as the user, writing the guest list back whole', async () => {
    authorise();
    fake.events = [
      {
        id: 'inv',
        summary: 'Invitation',
        start: { dateTime: '2026-08-25T09:00:00Z' },
        end: { dateTime: '2026-08-25T10:00:00Z' },
        attendees: [
          { email: 'organizer@example.com', responseStatus: 'accepted' },
          { email: 'me@example.com', self: true, responseStatus: 'needsAction' },
        ],
      },
    ];
    const event = await client.respond('inv', 'accepted');
    // PATCHing attendees replaces the list — the other guests must survive.
    const patch = fake.requests.filter((r) => r.method === 'PATCH').at(-1)!;
    expect(patch.body.attendees).toEqual([
      { email: 'organizer@example.com', responseStatus: 'accepted' },
      { email: 'me@example.com', self: true, responseStatus: 'accepted' },
    ]);
    expect(patch.query.sendUpdates).toBe('all');
    expect(event.my_response).toBe('accepted');
  });

  it('says not_an_invitee when there is no invitation to answer', async () => {
    authorise();
    fake.events = [
      {
        id: 'own',
        summary: 'Focus time',
        start: { dateTime: '2026-08-25T09:00:00Z' },
        end: { dateTime: '2026-08-25T10:00:00Z' },
      },
    ];
    const respond = calendarTools(client).find((t) => t.name === 'calendar.respond')!;
    const result = (await respond.execute(
      { event_id: 'own', response: 'accepted' },
      ctx,
    )) as any;
    expect(result.error).toBe('not_an_invitee');
    expect(fake.requests.some((r) => r.method === 'PATCH')).toBe(false);
  });

  it('fetches one event by id, and teaches on an unknown id', async () => {
    authorise();
    fake.events = [
      {
        id: 'weekly_20260825T090000Z',
        summary: 'Standup',
        recurringEventId: 'weekly',
        start: { dateTime: '2026-08-25T09:00:00Z' },
        end: { dateTime: '2026-08-25T09:15:00Z' },
        attendees: [{ email: 'me@example.com', self: true, responseStatus: 'needsAction' }],
      },
    ];
    const get = calendarTools(client).find((t) => t.name === 'calendar.get_event')!;
    const found = (await get.execute({ event_id: 'weekly_20260825T090000Z' }, ctx)) as any;
    expect(found.event.summary).toBe('Standup');
    // The fields the model needs to target its writes correctly.
    expect(found.event.my_response).toBe('needsAction');
    expect(found.event.recurring_event_id).toBe('weekly');
    expect(found.untrusted).toBe(true);

    const missing = (await get.execute({ event_id: 'nope' }, ctx)) as any;
    expect(missing.error).toBe('event_not_found');
    expect(missing.message).toMatch(/calendar\.list_events/);
  });

  it('passes a free-text query through to the search parameter', async () => {
    authorise();
    const list = calendarTools(client).find((t) => t.name === 'calendar.list_events')!;
    await list.execute({ query: 'dentist' }, ctx);
    const request = fake.requests.find(
      (r) => r.path.endsWith('/events') && r.method === 'GET',
    )!;
    expect(request.query.q).toBe('dentist');
  });

  it('refuses to write when the grant is read-only, and says how to fix it', async () => {
    authorise('https://www.googleapis.com/auth/calendar.readonly');
    expect(client.canWrite).toBe(false);
    const tools = calendarTools(client);
    const create = tools.find((t) => t.name === 'calendar.create_event')!;
    const result = (await create.execute(
      { summary: 'Nope', start: '2026-08-25T09:00:00.000Z', end: '2026-08-25T10:00:00.000Z' },
      ctx,
    )) as any;
    expect(result.error).toBe('missing_scope');
    expect(result.message).toMatch(/auth google --force/);
    expect(fake.requests.some((r) => r.method === 'POST' && r.path.includes('/events'))).toBe(
      false,
    );
  });

  it('tiers reads as read-only and writes as side-effecting (§11.3)', () => {
    const tools = calendarTools(client);
    const tier = (name: string) => tools.find((t) => t.name === name)?.tier;
    expect(tier('calendar.list_events')).toBe('ro');
    expect(tier('calendar.get_event')).toBe('ro');
    expect(tier('calendar.next_event')).toBe('ro');
    expect(tier('calendar.create_event')).toBe('se');
    expect(tier('calendar.update_event')).toBe('se');
    expect(tier('calendar.delete_event')).toBe('se');
    expect(tier('calendar.respond')).toBe('se');
  });

  it('reports being unauthorised rather than crashing', async () => {
    const tools = calendarTools(client);
    const list = tools.find((t) => t.name === 'calendar.list_events')!;
    const result = (await list.execute({}, ctx)) as any;
    expect(result.error).toBe('calendar_failed');
    expect(result.message).toMatch(/not authorised/);
  });
});

describe('calendar source', () => {
  let e: Env;
  let fake: FakeGoogle;
  let client: CalendarClient;

  beforeEach(async () => {
    e = env();
    fake = new FakeGoogle();
    const base = await fake.start();
    e.config.secretStore.merge({ GOOGLE_CLIENT_ID: 'id', GOOGLE_CLIENT_SECRET: 'sec' });
    e.config.reload();
    client = CalendarClient.create(e.config, googleFetch(base));
    new GoogleTokenStore(e.config).save({
      refresh_token: 'r',
      obtained_at: new Date().toISOString(),
      scope: 'https://www.googleapis.com/auth/calendar.readonly',
    });
  });
  afterEach(async () => {
    await fake.stop();
    e.cleanup();
  });

  const source = (over: Partial<{ leadMinutes: number; watchChanges: boolean }> = {}) =>
    new CalendarSource({ intake: e.intake, meta: e.repos.meta }, client, {
      calendars: ['primary'],
      pollSeconds: 300,
      leadMinutes: 15,
      watchChanges: true,
      ...over,
    });

  const soon = (minutes: number) => new Date(Date.now() + minutes * 60_000).toISOString();

  it('announces an upcoming meeting once', async () => {
    fake.events = [
      {
        id: 'm1',
        summary: 'Sprint review',
        start: { dateTime: soon(10) },
        end: { dateTime: soon(40) },
        updated: '2026-08-20T09:00:00.000Z',
      },
    ];
    const s = source();
    expect(await s.tick()).toBe(1);
    expect(await s.tick()).toBe(0);

    const event = e.repos.events.recent({ limit: 5 })[0]!;
    expect(event.type).toBe('calendar.event_upcoming');
    expect(event.source).toBe('gcal.primary');
    const payload = event.payload as any;
    expect(payload.event.summary).toBe('Sprint review');
    expect(payload.minutes_until).toBeGreaterThan(5);
    expect(payload.minutes_until).toBeLessThan(15);
  });

  it('emits a change event when an announced meeting moves', async () => {
    fake.events = [
      {
        id: 'm1',
        summary: 'Sprint review',
        start: { dateTime: soon(10) },
        end: { dateTime: soon(40) },
        updated: '2026-08-20T09:00:00.000Z',
      },
    ];
    const s = source();
    await s.tick();
    fake.events[0]!.updated = '2026-08-20T11:00:00.000Z';
    fake.events[0]!.location = 'Room 2';
    expect(await s.tick()).toBe(1);
    const latest = e.repos.events.recent({ limit: 5 })[0]!;
    expect(latest.type).toBe('calendar.event_changed');
  });

  it('ignores changes when watch_changes is off', async () => {
    fake.events = [
      {
        id: 'm1',
        summary: 'Standup',
        start: { dateTime: soon(5) },
        end: { dateTime: soon(20) },
        updated: '2026-08-20T09:00:00.000Z',
      },
    ];
    const s = source({ watchChanges: false });
    await s.tick();
    fake.events[0]!.updated = '2026-08-20T12:00:00.000Z';
    expect(await s.tick()).toBe(0);
  });

  it('skips all-day and cancelled events', async () => {
    fake.events = [
      {
        id: 'a',
        summary: 'Holiday',
        start: { date: '2026-08-21' },
        end: { date: '2026-08-22' },
      },
      {
        id: 'b',
        summary: 'Cancelled',
        status: 'cancelled',
        start: { dateTime: soon(5) },
        end: { dateTime: soon(30) },
      },
    ];
    expect(await source().tick()).toBe(0);
  });

  it('does not start without authorisation', async () => {
    new GoogleTokenStore(e.config).clear();
    fake.events = [
      { id: 'm', summary: 'x', start: { dateTime: soon(5) }, end: { dateTime: soon(10) } },
    ];
    const s = source();
    await s.start();
    expect(e.repos.events.recent({ limit: 5 })).toHaveLength(0);
    s.stop();
  });

  it('stores the token in the secret store, not a file of its own (§27)', () => {
    // The plain backend's file, chmod 600 like everything else in it — and no
    // `google-token.json` beside it for the vault to miss later.
    const file = e.home.path('secrets', 'secrets.yaml');
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(fs.existsSync(e.home.path('secrets', 'google-token.json'))).toBe(false);
    expect(e.config.secretStore.list()).toContain('GOOGLE_OAUTH_TOKEN');
  });
});

describe('integration wiring (activation vs watcher)', () => {
  let e: Env;
  beforeEach(() => {
    e = env();
  });
  afterEach(() => e.cleanup());

  const build = async (opts: { secrets?: Record<string, string>; records?: string } = {}) => {
    const { Config } = await import('../src/core/config.js');
    const { createSourceStack } = await import('../src/tools/integrations/external.js');
    if (opts.records !== undefined) {
      write(e.home.path('config', 'integrations.yaml'), opts.records);
    }
    // Through the store, not over the file: a test that overwrites
    // secrets.yaml wipes whatever else the store already holds (§27).
    if (opts.secrets) {
      e.config.secretStore.merge(opts.secrets);
      e.config.reload();
    }
    const config = new Config(e.home);
    return createSourceStack({
      home: e.home,
      config,
      intake: e.intake,
      meta: e.repos.meta,
    });
  };

  const names = (stack: { tools: Record<string, { name: string }[]> }) =>
    Object.values(stack.tools)
      .flat()
      .map((t) => t.name);

  it('keeps an integration dormant until it is activated (§19.5)', async () => {
    // The token alone does nothing: activation is the switch.
    const stack = await build({ secrets: { ASANA_PAT: 'test-pat' } });
    expect(names(stack).some((n) => n.startsWith('asana.'))).toBe(false);
    expect(stack.sources.map((s) => s.name)).not.toContain('asana.inbox');
    const status = stack.status.find((s) => s.name === 'asana')!;
    expect(status.active).toBe(false);
    expect(status.detail).toMatch(/not activated/);
  });

  it('gives the agent the tools and the watcher once activated', async () => {
    const stack = await build({
      secrets: { ASANA_PAT: 'test-pat' },
      records: 'integrations:\n  asana:\n    active: true\n',
    });
    expect(names(stack)).toContain('asana.inbox');
    expect(names(stack)).toContain('asana.triage');
    expect(stack.sources.map((s) => s.name)).toContain('asana.inbox');
    expect(stack.status.find((s) => s.name === 'asana')).toMatchObject({
      active: true,
      watching: true,
    });
  });

  it('says so when a record is active but the secret is missing', async () => {
    const stack = await build({ records: 'integrations:\n  asana:\n    active: true\n' });
    expect(names(stack).some((n) => n.startsWith('asana.'))).toBe(false);
    const status = stack.status.find((s) => s.name === 'asana')!;
    expect(status.active).toBe(false);
    expect(status.detail).toMatch(/no ASANA_PAT/);
  });

  it('reports calendar as needing authorisation once activated', async () => {
    const stack = await build({
      secrets: { GOOGLE_CLIENT_ID: 'id', GOOGLE_CLIENT_SECRET: 'sec' },
      records: 'integrations:\n  google-calendar:\n    active: true\n',
    });
    expect(names(stack)).toContain('calendar.list_events');
    expect(names(stack)).toContain('calendar.create_event');
    const status = stack.status.find((s) => s.name === 'google-calendar')!;
    expect(status.active).toBe(true);
    expect(status.detail).toMatch(/auth google/);
  });

  it('distinguishes read-only calendar consent from unauthorised', async () => {
    const { GoogleTokenStore } = await import('../src/tools/integrations/google/auth.js');
    new GoogleTokenStore(e.config).save({
      refresh_token: 'r',
      obtained_at: new Date().toISOString(),
      scope: 'https://www.googleapis.com/auth/calendar.readonly',
    });
    const stack = await build({
      secrets: { GOOGLE_CLIENT_ID: 'id', GOOGLE_CLIENT_SECRET: 'sec' },
      records: 'integrations:\n  google-calendar:\n    active: true\n',
    });
    expect(stack.status.find((s) => s.name === 'google-calendar')?.detail).toMatch(/read-only/);
  });
});

describe('credential failures explain themselves', () => {
  let fake: FakeAsana;
  let client: AsanaClient;
  let base: string;

  beforeEach(async () => {
    fake = new FakeAsana();
    base = await fake.start();
    client = new AsanaClient({
      pat: 'wrong-token',
      fetch: asanaFetch(base),
      sleep: async () => {},
    });
    fake.section('Inbox');
  });
  afterEach(async () => {
    await fake.stop();
  });

  it('turns an Asana 401 into an actionable message, not a raw blob', async () => {
    fake.failNext = 401;
    const check = await client.check();
    expect(check.ok).toBe(false);
    expect(check.error).toMatch(/rejected the token/);
    expect(check.error).toMatch(/ASANA_PAT/);
    expect(check.error).toMatch(/asana-check/);
  });

  it('names rate limiting once the retries are spent', async () => {
    const impatient = new AsanaClient({
      pat: 'p',
      fetch: asanaFetch(base),
      maxRetries: 0,
      sleep: async () => {},
    });
    fake.failNext = 429;
    const check = await impatient.check();
    expect(check.ok).toBe(false);
    expect(check.error).toMatch(/rate-limiting/);
  });

  it('surfaces the same message through the tool result', async () => {
    fake.failNext = 401;
    const inbox = asanaTools(client, { inboxSection: 'Inbox', dailySection: 'Do today' }).find(
      (t) => t.name === 'asana.inbox',
    )!;
    const result = (await inbox.execute({}, { runId: null, eventId: null })) as any;
    expect(result.error).toBe('asana_failed');
    expect(result.message).toMatch(/ASANA_PAT/);
  });
});

describe('google loopback oauth flow', () => {
  let e: Env;
  let fake: FakeGoogle;
  let tokenBase: string;

  beforeEach(async () => {
    e = env();
    fake = new FakeGoogle();
    tokenBase = await fake.start();
  });
  afterEach(async () => {
    await fake.stop();
    e.cleanup();
  });

  it('walks the whole consent round trip and stores a refresh token', async () => {
    const { authorizeGoogle, CALENDAR_SCOPES, GoogleTokenStore } =
      await import('../src/tools/integrations/google/auth.js');

    let consentUrl = '';
    const authorising = authorizeGoogle({
      credentials: { clientId: 'client-id', clientSecret: 'client-secret', source: 'test' },
      printUrl: (url) => {
        consentUrl = url;
      },
      fetch: googleFetch(tokenBase),
      timeoutMs: 20_000,
    });

    // Wait for the listener to come up and the URL to be offered.
    for (let i = 0; i < 100 && !consentUrl; i++) await new Promise((r) => setTimeout(r, 10));
    const url = new URL(consentUrl);
    expect(url.origin + url.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(url.searchParams.get('client_id')).toBe('client-id');
    // Offline + consent, or Google returns no refresh token at all.
    expect(url.searchParams.get('access_type')).toBe('offline');
    expect(url.searchParams.get('prompt')).toBe('consent');
    expect(url.searchParams.get('scope')).toBe(CALENDAR_SCOPES.join(' '));
    // A loopback redirect on a random port: no registered URI needed for a
    // desktop-type client.
    const redirect = new URL(url.searchParams.get('redirect_uri')!);
    expect(redirect.hostname).toBe('127.0.0.1');
    expect(Number(redirect.port)).toBeGreaterThan(0);
    const state = url.searchParams.get('state')!;
    expect(state.length).toBeGreaterThan(20);

    // The browser comes back with the code.
    const callback = await fetch(
      `${redirect.origin}/oauth/callback?code=abc123&state=${state}`,
    );
    expect(callback.status).toBe(200);
    expect(await callback.text()).toMatch(/authorised/i);

    const token = await authorising;
    expect(token.refresh_token).toBe('fake-refresh-token');
    expect(token.scope).toContain('calendar.events');

    // Stored chmod 600, and the write scope is recognised.
    const store = new GoogleTokenStore(e.config);
    store.save(token);
    // The token is a store key now (§27), not a file of its own.
    expect(fs.existsSync(e.home.path('secrets', 'google-token.json'))).toBe(false);
    expect(e.config.secretStore.get('GOOGLE_OAUTH_TOKEN')).toContain('refresh');
    expect(store.hasScope('https://www.googleapis.com/auth/calendar.events')).toBe(true);
  });

  it('refuses a callback whose state does not match (CSRF)', async () => {
    const { authorizeGoogle } = await import('../src/tools/integrations/google/auth.js');
    let consentUrl = '';
    // Attach the handler immediately: the rejection can land before the test
    // gets back to awaiting, and an unhandled rejection is noise either way.
    const settled = authorizeGoogle({
      credentials: { clientId: 'id', clientSecret: 'sec', source: 'test' },
      printUrl: (url) => {
        consentUrl = url;
      },
      fetch: googleFetch(tokenBase),
      timeoutMs: 20_000,
    }).catch((e: Error) => e);
    for (let i = 0; i < 100 && !consentUrl; i++) await new Promise((r) => setTimeout(r, 10));
    const redirect = new URL(new URL(consentUrl).searchParams.get('redirect_uri')!);
    const res = await fetch(`${redirect.origin}/oauth/callback?code=abc&state=not-the-state`);
    expect(res.status).toBe(400);
    expect(String(await settled)).toMatch(/state mismatch/);
  });

  it('says what to do when Google returns no refresh token', async () => {
    const { authorizeGoogle } = await import('../src/tools/integrations/google/auth.js');
    // A consent that hands back only an access token.
    const noRefresh = (async () =>
      new Response(JSON.stringify({ access_token: 'a', expires_in: 3600 }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })) as unknown as typeof globalThis.fetch;

    let consentUrl = '';
    const settled = authorizeGoogle({
      credentials: { clientId: 'id', clientSecret: 'sec', source: 'test' },
      printUrl: (url) => {
        consentUrl = url;
      },
      fetch: noRefresh,
      timeoutMs: 20_000,
    }).catch((e: Error & { detail?: string }) => e);
    for (let i = 0; i < 100 && !consentUrl; i++) await new Promise((r) => setTimeout(r, 10));
    const redirect = new URL(new URL(consentUrl).searchParams.get('redirect_uri')!);
    const state = new URL(consentUrl).searchParams.get('state')!;
    await fetch(`${redirect.origin}/oauth/callback?code=abc&state=${state}`);
    const error = (await settled) as Error & { detail?: string };
    expect(error.message).toMatch(/no refresh token/);
    // And it says how to get out of the hole.
    expect(error.detail).toMatch(/myaccount\.google\.com\/permissions/);
  });

  it('folds a dropped console credentials.json into the store and deletes it (§27)', async () => {
    const { loadGoogleCredentials } = await import('../src/tools/integrations/google/auth.js');
    const dropped = e.home.path('secrets', 'credentials.json');
    write(
      dropped,
      JSON.stringify({
        installed: {
          client_id: 'from-file.apps.googleusercontent.com',
          client_secret: 'shh',
          redirect_uris: ['http://localhost'],
        },
      }),
    );
    // Reading the store is what folds it in: the value becomes a key and the
    // file stops existing, so the vault backend has nothing left to miss.
    const secrets = e.config.secrets;
    expect(fs.existsSync(dropped)).toBe(false);
    expect(secrets.GOOGLE_CLIENT_CREDENTIALS).toContain('from-file');

    const creds = loadGoogleCredentials(e.home, secrets);
    expect(creds.clientId).toBe('from-file.apps.googleusercontent.com');
    expect(creds.source).toBe('GOOGLE_CLIENT_CREDENTIALS');
  });
});

describe('bundled oauth client (the ldflags equivalent)', () => {
  let e: Env;
  const savedEnv = { ...process.env };

  beforeEach(() => {
    e = env();
    delete process.env.TURMINDER_GOOGLE_CLIENT_ID;
    delete process.env.TURMINDER_GOOGLE_CLIENT_SECRET;
    delete process.env.GOOGLE_CLIENT_ID;
    delete process.env.GOOGLE_CLIENT_SECRET;
  });
  afterEach(() => {
    process.env = { ...savedEnv };
    e.cleanup();
  });

  it('prefers the bundled client over the user supplying their own', async () => {
    const { loadGoogleCredentials } = await import('../src/tools/integrations/google/auth.js');
    delete process.env.TURMINDER_IGNORE_BUNDLED_GOOGLE_CLIENT;
    process.env.TURMINDER_GOOGLE_CLIENT_ID = 'bundled-id';
    process.env.TURMINDER_GOOGLE_CLIENT_SECRET = 'bundled-secret';
    write(
      e.home.path('secrets', 'secrets.yaml'),
      'GOOGLE_CLIENT_ID: "user-id"\nGOOGLE_CLIENT_SECRET: "user-secret"\n',
    );
    const creds = loadGoogleCredentials(e.home, {
      GOOGLE_CLIENT_ID: 'user-id',
      GOOGLE_CLIENT_SECRET: 'user-secret',
    });
    expect(creds.clientId).toBe('bundled-id');
    expect(creds.source).toMatch(/bundled/);
  });

  it('falls back through env, the store, then a folded credentials.json', async () => {
    const { loadGoogleCredentials } = await import('../src/tools/integrations/google/auth.js');

    process.env.GOOGLE_CLIENT_ID = 'env-id';
    process.env.GOOGLE_CLIENT_SECRET = 'env-secret';
    expect(loadGoogleCredentials(e.home, {}).source).toBe('environment');

    delete process.env.GOOGLE_CLIENT_ID;
    delete process.env.GOOGLE_CLIENT_SECRET;
    expect(
      loadGoogleCredentials(e.home, {
        GOOGLE_CLIENT_ID: 'yaml-id',
        GOOGLE_CLIENT_SECRET: 'yaml-secret',
      }).source,
    ).toBe('secret store');

    write(
      e.home.path('secrets', 'credentials.json'),
      JSON.stringify({ installed: { client_id: 'file-id', client_secret: 'file-secret' } }),
    );
    expect(loadGoogleCredentials(e.home, e.config.secrets).source).toBe(
      'GOOGLE_CLIENT_CREDENTIALS',
    );
  });

  it('names every place to put a client when there is none', async () => {
    const { loadGoogleCredentials } = await import('../src/tools/integrations/google/auth.js');
    try {
      loadGoogleCredentials(e.home, {});
      throw new Error('should have thrown');
    } catch (err) {
      const e2 = err as Error & { code?: string; detail?: string };
      expect(e2.code).toBe('google_credentials_missing');
      expect(e2.detail).toMatch(/google-client/);
      expect(e2.detail).toMatch(/secret store/);
      expect(e2.detail).toMatch(/credentials\.json/);
    }
  });

  it('reads a client out of a .env file, whatever the prefix', async () => {
    const { readEnvFile } = await import('../src/tools/integrations/google/bundled-client.js');
    const file = e.home.path('secrets', 'dotenv');
    write(
      file,
      '# a comment\nTIMETRACK_GOOGLE_CLIENT_ID=abc.apps.googleusercontent.com\nexport TIMETRACK_GOOGLE_CLIENT_SECRET="GOCSPX-shh"\n',
    );
    expect(readEnvFile(file)).toEqual({
      clientId: 'abc.apps.googleusercontent.com',
      clientSecret: 'GOCSPX-shh',
    });
    expect(readEnvFile(e.home.path('secrets', 'nope'))).toBeNull();
  });

  it('asks for read-only scopes when told to', async () => {
    const { authorizeGoogle, CALENDAR_READ_SCOPE } =
      await import('../src/tools/integrations/google/auth.js');
    let consentUrl = '';
    const settled = authorizeGoogle({
      credentials: { clientId: 'id', clientSecret: 'sec', source: 'test' },
      scopes: [CALENDAR_READ_SCOPE],
      printUrl: (url) => {
        consentUrl = url;
      },
      timeoutMs: 500,
    }).catch((err: Error) => err);
    for (let i = 0; i < 100 && !consentUrl; i++) await new Promise((r) => setTimeout(r, 10));
    expect(new URL(consentUrl).searchParams.get('scope')).toBe(CALENDAR_READ_SCOPE);
    await settled;
  });
});
