import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import path from 'node:path';
import { openDataHome } from '../src/core/datadir.js';
import { Config } from '../src/core/config.js';
import { CalendarClient, calendarTools } from '../src/tools/integrations/google/calendar.js';
import { GoogleTokenStore } from '../src/tools/integrations/google/auth.js';
import { capResult } from '../src/tools/budget.js';
import { FakeGoogle, googleFetch } from './fake-google.js';
import { tmpDir, write } from './helpers.js';

const ctx = { runId: null, eventId: null };

describe('calendar tool results are slim and cut at whole events (§20.3)', () => {
  let fake: FakeGoogle;
  let client: CalendarClient;
  let cleanup: () => void;

  beforeEach(async () => {
    const t = tmpDir('turminder-cal-');
    cleanup = t.cleanup;
    const { home } = openDataHome(path.join(t.dir, 'home'));
    const config = new Config(home);
    fake = new FakeGoogle();
    const base = await fake.start();
    write(
      home.path('secrets', 'secrets.yaml'),
      'GOOGLE_CLIENT_ID: id\nGOOGLE_CLIENT_SECRET: sec\n',
    );
    new GoogleTokenStore(config).save({
      refresh_token: 'fake-refresh',
      obtained_at: new Date().toISOString(),
      scope: 'https://www.googleapis.com/auth/calendar.readonly',
    });
    client = CalendarClient.create(config, googleFetch(base));
  });
  afterEach(async () => {
    await fake.stop();
    cleanup();
  });

  const list = () => calendarTools(client).find((t) => t.name === 'calendar.list_events')!;

  it('drops the low-value fields and keeps the rest', async () => {
    fake.events = [
      {
        id: 'e1',
        summary: 'Planning',
        updated: '2026-08-20T10:00:00Z',
        recurringEventId: 'series',
        organizer: { email: 'me@example.com', self: true },
        start: { dateTime: '2026-08-21T08:00:00Z' },
        end: { dateTime: '2026-08-21T09:00:00Z' },
        attendees: [{ email: 'a@example.com', responseStatus: 'accepted' }],
      } as any,
      {
        id: 'e2',
        summary: 'Review',
        organizer: { email: 'boss@example.com' },
        start: { dateTime: '2026-08-22T08:00:00Z' },
        end: { dateTime: '2026-08-22T09:00:00Z' },
      } as any,
    ];
    const res = (await list().execute({}, ctx)) as any;
    const [mine, theirs] = res.events;
    for (const e of res.events) {
      expect(e).not.toHaveProperty('updated');
      expect(e).not.toHaveProperty('etag');
      expect(e).not.toHaveProperty('calendar_id');
    }
    expect(mine.recurring_event_id).toBe('series');
    expect(mine).not.toHaveProperty('organizer');
    expect(theirs.organizer).toBe('boss@example.com');
    expect(mine).toMatchObject({
      id: 'e1',
      summary: 'Planning',
      start: '2026-08-21T08:00:00.000Z',
      all_day: false,
      attendees: [{ email: 'a@example.com', response: 'accepted' }],
    });
  });

  it('keeps calendar_id when it is not primary', async () => {
    fake.events = [
      {
        id: 'e1',
        summary: 'X',
        start: { dateTime: '2026-08-21T08:00:00Z' },
        end: { dateTime: '2026-08-21T09:00:00Z' },
      },
    ];
    const res = (await list().execute({ calendar_id: 'team@example.com' }, ctx)) as any;
    expect(res.events[0].calendar_id).toBe('team@example.com');
  });

  it('a 20-event listing is cut at whole events with correct counts', async () => {
    fake.events = Array.from({ length: 20 }, (_, i) => ({
      id: `e${i}`,
      summary: `Meeting ${i}`,
      description: 'd'.repeat(400),
      start: { dateTime: `2026-08-${String(10 + i).padStart(2, '0')}T08:00:00Z` },
      end: { dateTime: `2026-08-${String(10 + i).padStart(2, '0')}T09:00:00Z` },
    }));
    const res = await list().execute({}, ctx);
    const capped = capResult(res, 4000);
    const out = capped.output as any;
    expect(out._truncated.field).toBe('events');
    expect(out._truncated.total).toBe(20);
    expect(out._truncated.kept).toBe(out.events.length);
    expect(out.events.length).toBeLessThan(20);
    expect(out.events.map((e: any) => e.id)).toEqual(
      Array.from({ length: out.events.length }, (_, i) => `e${i}`),
    );
    expect(out._truncated.hint).toBe(
      `${out.events.length} of 20 events shown; narrow the call (a smaller window, max_results, a filter) to see the rest`,
    );
    expect((capped.traceOutput as any).events).toHaveLength(20);
  });
});
