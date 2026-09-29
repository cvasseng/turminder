import { afterEach, describe, expect, it } from 'vitest';
import { bootService, offeredTools, type ServiceHarness } from './service-harness.js';
import { nextOccurrence } from '../src/scheduler/loop.js';
import { isoPlusSeconds, nowIso } from '../src/core/time.js';
import { renderWhen } from '../src/tools/integrations/schedule.js';
import type { ScheduleRow } from '../src/db/repos/schedules.js';

let h: ServiceHarness;
afterEach(async () => {
  await h?.cleanup();
});

const row = (over: Partial<ScheduleRow> = {}): ScheduleRow => ({
  id: '01SCHED',
  fire_at: '2026-08-20T09:00:00.000Z',
  rrule: null,
  grace_s: 3600,
  note: 'test',
  event_type: 'timer.fired',
  event_payload: '{}',
  created_by_run: null,
  status: 'active',
  last_fired_at: null,
  on_miss: 'fire_late',
  ...over,
});

describe('recurrence keeps the wall clock (§6.1)', () => {
  /**
   * Measured before it was fixed: `rrulestr` works in absolute time, so a
   * daily 08:00 created before a spring transition produced 09:00 for every
   * occurrence after it — permanently, because each fire re-seeds `dtstart`
   * from the drifted value. The correction has to be exercised in a zone that
   * actually observes DST, so this test owns the process clock for its
   * duration and puts it back.
   */
  const inZone = (tz: string, body: () => void): void => {
    const was = process.env.TZ;
    process.env.TZ = tz;
    try {
      body();
    } finally {
      if (was === undefined) delete process.env.TZ;
      else process.env.TZ = was;
    }
  };

  const localHour = (iso: string, tz: string): string =>
    new Date(iso).toLocaleTimeString('en-GB', { timeZone: tz, hour12: false });

  it('holds 08:00 local across a spring transition', () => {
    inZone('Europe/Oslo', () => {
      // 2026-03-29 is when Oslo goes UTC+1 → UTC+2.
      const before = row({ fire_at: '2026-03-28T07:00:00.000Z', rrule: 'FREQ=DAILY' });
      expect(localHour(before.fire_at, 'Europe/Oslo')).toBe('08:00:00');
      const next = nextOccurrence(before, new Date('2026-03-28T07:00:00.000Z'))!;
      expect(next).toBe('2026-03-29T06:00:00.000Z');
      expect(localHour(next, 'Europe/Oslo')).toBe('08:00:00');
    });
  });

  it('holds it across an autumn transition too, and then stops correcting', () => {
    inZone('Europe/Oslo', () => {
      // 2026-10-25: UTC+2 → UTC+1.
      const before = row({ fire_at: '2026-10-24T06:00:00.000Z', rrule: 'FREQ=DAILY' });
      const next = nextOccurrence(before, new Date('2026-10-24T06:00:00.000Z'))!;
      expect(localHour(next, 'Europe/Oslo')).toBe('08:00:00');
      // Self-cancelling: once `fire_at` has moved, the offsets agree again.
      const after = nextOccurrence(
        row({ fire_at: next, rrule: 'FREQ=DAILY' }),
        new Date(next),
      )!;
      expect(after).toBe('2026-10-26T07:00:00.000Z');
      expect(localHour(after, 'Europe/Oslo')).toBe('08:00:00');
    });
  });

  it('leaves a zone with no daylight saving alone', () => {
    inZone('UTC', () => {
      const next = nextOccurrence(
        row({ fire_at: '2026-03-28T07:00:00.000Z', rrule: 'FREQ=DAILY' }),
        new Date('2026-03-28T07:00:00.000Z'),
      );
      expect(next).toBe('2026-03-29T07:00:00.000Z');
    });
  });
});

describe('recurrence (§6)', () => {
  it('returns null for a one-shot', () => {
    expect(nextOccurrence(row(), new Date('2026-08-20T09:00:00.000Z'))).toBeNull();
  });

  it('advances a daily rule past the occurrence just fired', () => {
    const next = nextOccurrence(
      row({ rrule: 'FREQ=DAILY' }),
      new Date('2026-08-20T09:00:00.000Z'),
    );
    expect(next).toBe('2026-08-21T09:00:00.000Z');
  });

  it('respects COUNT and returns null when exhausted', () => {
    const r = row({ rrule: 'FREQ=DAILY;COUNT=1' });
    expect(nextOccurrence(r, new Date('2026-08-20T09:00:00.000Z'))).toBeNull();
  });

  it('treats an invalid rrule as a one-shot rather than throwing', () => {
    expect(nextOccurrence(row({ rrule: 'NOT A RULE' }), new Date())).toBeNull();
  });
});

describe('scheduler loop (§6)', () => {
  it('fires a due schedule as a timer.fired event into the normal ingress', async () => {
    h = await bootService({ onboarded: true, runScheduler: false });
    const created = h.service.repos.schedules.create({
      fireAt: isoPlusSeconds(-1),
      note: 'take the bins out',
      eventPayload: { thing: 'bins' },
    });

    expect(h.service.scheduler.tick()).toBe(1);
    const event = h.service.repos.events
      .recent({ limit: 5 })
      .find((e) => e.type === 'timer.fired');
    expect(event).toBeTruthy();
    expect(event?.source).toBe('scheduler');
    expect(event?.serialization_key).toBe(created.id);
    expect(event?.idempotency_key).toBe(`${created.id}:${created.fire_at}`);
    // Exhaustive, so a field cannot creep onto a payload handlers read.
    expect(event?.payload).toEqual({
      schedule_id: created.id,
      note: 'take the bins out',
      fire_at: created.fire_at,
      late_by_s: expect.any(Number),
      data: { thing: 'bins' },
    });
    expect((event?.payload as any).late_by_s).toBeLessThan(5);
    // A one-shot is done once fired.
    expect(h.service.repos.schedules.get(created.id)?.status).toBe('done');
  });

  it('advances a recurring schedule and keeps it active', async () => {
    h = await bootService({ onboarded: true, runScheduler: false });
    const created = h.service.repos.schedules.create({
      fireAt: isoPlusSeconds(-1),
      note: 'daily check',
      rrule: 'FREQ=DAILY',
    });
    h.service.scheduler.tick();
    const after = h.service.repos.schedules.get(created.id)!;
    expect(after.status).toBe('active');
    expect(Date.parse(after.fire_at)).toBeGreaterThan(Date.now());
    expect(after.last_fired_at).toBeTruthy();
  });

  it('does not fire twice for the same occurrence', async () => {
    h = await bootService({ onboarded: true, runScheduler: false });
    h.service.repos.schedules.create({ fireAt: isoPlusSeconds(-1), note: 'once' });
    expect(h.service.scheduler.tick()).toBe(1);
    expect(h.service.scheduler.tick()).toBe(0);
    expect(
      h.service.repos.events.recent({ limit: 10 }).filter((e) => e.type === 'timer.fired'),
    ).toHaveLength(1);
  });

  it('fires a schedule that is late but inside its grace window', async () => {
    h = await bootService({ onboarded: true, runScheduler: false });
    // Due 10 minutes ago, grace an hour: still owed, and not a miss.
    const created = h.service.repos.schedules.create({
      fireAt: isoPlusSeconds(-600),
      note: 'still owed',
      graceS: 3600,
    });
    expect(h.service.scheduler.tick()).toBe(1);
    const fired = h.service.repos.events
      .recent({ limit: 5 })
      .find((e) => e.type === 'timer.fired');
    expect(fired).toBeTruthy();
    // Ten minutes late is still late, and the payload says how late (App. B).
    expect((fired?.payload as any).late_by_s).toBeGreaterThanOrEqual(595);
    expect(
      h.service.repos.events
        .recent({ limit: 10 })
        .some((e) => e.type === 'system.schedule_missed'),
    ).toBe(false);
    expect(h.service.repos.schedules.get(created.id)?.status).toBe('done');
  });

  it('still fires a one-shot past its grace window, and says how late it is', async () => {
    // §6.1: a missed reminder is still worth having, late — which is why
    // `fire_late` is the default for one-shots.
    h = await bootService({ onboarded: true, runScheduler: false });
    const created = h.service.repos.schedules.create({
      fireAt: isoPlusSeconds(-7200),
      note: 'take the bins out',
      graceS: 3600,
    });
    expect(h.service.scheduler.tick()).toBe(1);
    expect(h.service.repos.schedules.get(created.id)?.status).toBe('missed');

    const report = h.service.repos.events
      .recent({ limit: 10 })
      .find((e) => e.type === 'system.schedule_missed');
    expect((report?.payload as any).schedule_id).toBe(created.id);
    expect((report?.payload as any).note).toBe('take the bins out');
    expect((report?.payload as any).on_miss).toBe('fire_late');

    const fired = h.service.repos.events
      .recent({ limit: 10 })
      .find((e) => e.type === 'timer.fired');
    expect(fired).toBeTruthy();
    expect((fired?.payload as any).late_by_s).toBeGreaterThan(3600);
    expect((fired?.payload as any).fire_at).toBe(created.fire_at);
  });

  it('skips a missed occurrence of a recurring schedule but keeps the series', async () => {
    h = await bootService({ onboarded: true, runScheduler: false });
    const created = h.service.repos.schedules.create({
      fireAt: isoPlusSeconds(-7200),
      note: 'daily',
      rrule: 'FREQ=DAILY',
      graceS: 60,
    });
    // Recurring defaults to `skip`: yesterday's digest is noise (§6.1).
    expect(created.on_miss).toBe('skip');
    expect(h.service.scheduler.tick()).toBe(0);
    const after = h.service.repos.schedules.get(created.id)!;
    expect(after.status).toBe('active');
    expect(Date.parse(after.fire_at)).toBeGreaterThan(Date.now());
    // The negative half: it said it was missed, and it did not run.
    expect(
      h.service.repos.events
        .recent({ limit: 10 })
        .some((e) => e.type === 'system.schedule_missed'),
    ).toBe(true);
    expect(
      h.service.repos.events.recent({ limit: 10 }).some((e) => e.type === 'timer.fired'),
    ).toBe(false);
  });

  it('takes the same branch on a suspend as on a restart', async () => {
    // The bug §6.1 exists to close: grace used to be checked only from
    // `start()`, so a laptop rebooted a day late marked the briefing missed
    // while a laptop *suspended* a day and resumed fired it at teatime.
    h = await bootService({ onboarded: true, runScheduler: false });
    const created = h.service.repos.schedules.create({
      fireAt: isoPlusSeconds(-60),
      note: 'briefing',
      rrule: 'FREQ=DAILY',
      graceS: 3600,
    });
    // The clock jumps past the grace window while the service is running.
    const resumed = new Date(Date.now() + 4 * 3600 * 1000);
    expect(h.service.scheduler.tick(resumed)).toBe(0);
    expect(
      h.service.repos.events.recent({ limit: 10 }).some((e) => e.type === 'timer.fired'),
    ).toBe(false);
    expect(h.service.repos.schedules.get(created.id)?.status).toBe('active');
  });

  it('fires once for a recurring schedule missed many times, and counts them', async () => {
    h = await bootService({ onboarded: true, runScheduler: false });
    const created = h.service.repos.schedules.create({
      fireAt: isoPlusSeconds(-3 * 86_400),
      note: 'daily digest',
      rrule: 'FREQ=DAILY',
      graceS: 3600,
      onMiss: 'fire_late',
    });
    expect(h.service.scheduler.tick()).toBe(1);

    // One fire and one report, for three days away — not three of either.
    const events = h.service.repos.events.recent({ limit: 20 });
    expect(events.filter((e) => e.type === 'timer.fired')).toHaveLength(1);
    const reports = events.filter((e) => e.type === 'system.schedule_missed');
    expect(reports).toHaveLength(1);
    expect((reports[0]?.payload as any).skipped).toBe(4);
    // One outage, one notice (§6.1 S3): the occurrence also fired, so the
    // report is informational — and it says so structurally, via `source`,
    // not only in the payload a matcher cannot see (§5.2).
    expect((reports[0]?.payload as any).also_fired).toBe(true);
    expect(reports[0]?.source).toBe('scheduler');
    // And the series is standing on its next occurrence, in the future.
    const after = h.service.repos.schedules.get(created.id)!;
    expect(after.status).toBe('active');
    expect(Date.parse(after.fire_at)).toBeGreaterThan(Date.now());
  });

  it('offers a fire_late miss to timer.fired’s handler but never to failure-notice (§6.1 S3)', async () => {
    // The evidence case: a three-day outage on a recurring fire_late daily
    // must produce exactly one late fire and zero failure-notice deliveries
    // — the fired event's own handler already says how late it is.
    h = await bootService({ onboarded: true, runScheduler: false });
    h.service.repos.schedules.create({
      fireAt: isoPlusSeconds(-3 * 86_400),
      note: 'daily digest',
      rrule: 'FREQ=DAILY',
      graceS: 3600,
      onMiss: 'fire_late',
    });

    let notified = false;
    h.fake.always((req) => {
      if (req.body.response_format) {
        const offered = String(req.body.messages?.[1]?.content ?? '');
        // failure-notice must not even be on the roster: `system.*` no
        // longer matches this event's `source` (§5.2, structural, not a
        // model judgement call).
        expect(offered).not.toContain('failure-notice');
        return {
          text: JSON.stringify({
            summary: 'a reminder came due, late',
            verdicts: offered.includes('scheduled-task')
              ? [{ handler: 'scheduled-task', matched: true, reason: 'a late reminder' }]
              : [],
          }),
        };
      }
      if (notified) return { text: 'Reminded.' };
      notified = true;
      return {
        toolCalls: [
          { name: 'deliver.notify', args: { title: 'Daily digest', body: 'This is late.' } },
        ],
      };
    });

    expect(h.service.scheduler.tick()).toBe(1);
    await h.service.queue.drain();

    const missed = h.service.repos.events
      .recent({ limit: 20 })
      .find((e) => e.type === 'system.schedule_missed')!;
    expect(missed.source).toBe('scheduler');
    // Never offered, so never run, so never a second delivery on top of the
    // fired event's own.
    expect(
      h.service.repos.runs.forEvent(missed.id).some((r) => r.handler_name === 'failure-notice'),
    ).toBe(false);
    const deliveries = h.service.repos.deliveries.recent(20);
    expect(deliveries).toHaveLength(1);
    expect((deliveries[0]?.payload as any).title).toBe('Daily digest');
  });

  it('puts the grace boundary in one place, from both sides', async () => {
    h = await bootService({ onboarded: true, runScheduler: false });
    const inside = h.service.repos.schedules.create({
      fireAt: isoPlusSeconds(-100),
      note: 'inside',
      graceS: 100,
    });
    const outside = h.service.repos.schedules.create({
      fireAt: isoPlusSeconds(-101),
      note: 'outside',
      graceS: 100,
    });
    h.service.scheduler.tick();
    // Exactly at the boundary is inside it: `late > grace` is the test, so a
    // schedule 100s late with 100s of grace is a normal, punctual-enough fire.
    const missed = h.service.repos.events
      .recent({ limit: 20 })
      .filter((e) => e.type === 'system.schedule_missed')
      .map((e) => (e.payload as any).schedule_id);
    expect(missed).toContain(outside.id);
    expect(missed).not.toContain(inside.id);
  });

  it('carries provenance from the run that created the schedule', async () => {
    h = await bootService({ onboarded: true, runScheduler: false });
    const parent = h.service.intake.submit({
      type: 'chat.message',
      source: 'chat',
      payload: { conversation_id: 'c1', text: 'remind me' },
    });
    const runId = h.service.repos.runs.create({ kind: 'chat', eventId: parent.event.id });
    h.service.repos.schedules.create({
      fireAt: isoPlusSeconds(-1),
      note: 'reminder',
      createdByRun: runId,
    });
    h.service.scheduler.tick();

    const fired = h.service.repos.events
      .recent({ limit: 10 })
      .find((e) => e.type === 'timer.fired')!;
    expect(fired.caused_by).toBe(parent.event.id);
    expect(fired.depth).toBe(1);
  });

  it('runs the loop on a timer and fires without being told', async () => {
    h = await bootService({ onboarded: true, schedulerMaxSleepMs: 50 });
    h.fake.always({ text: JSON.stringify({ summary: 'timer', verdicts: [] }) });
    h.service.repos.schedules.create({ fireAt: isoPlusSeconds(0.2), note: 'soon' });
    for (let i = 0; i < 60; i++) {
      if (h.service.repos.events.recent({ limit: 5 }).some((e) => e.type === 'timer.fired'))
        break;
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(
      h.service.repos.events.recent({ limit: 5 }).some((e) => e.type === 'timer.fired'),
    ).toBe(true);
  });
});

describe('schedule tools (App. F.2)', () => {
  const dispatch = async (harness: ServiceHarness, name: string, args: unknown) => {
    const { GrantedDispatcher } = await import('../src/tools/dispatcher.js');
    const d = new GrantedDispatcher(
      harness.service.tools.handles(),
      { tools: ['schedule.*'] },
      {
        runId: null,
        eventId: null,
      },
    );
    return d.dispatch({ toolCallId: '1', name, args });
  };

  it('creates, lists and cancels', async () => {
    h = await bootService({ onboarded: true, runScheduler: false });
    const created = await dispatch(h, 'schedule.create', {
      fire_at: isoPlusSeconds(3600),
      note: 'water the plants',
      data: { where: 'kitchen' },
    });
    expect(created.ok).toBe(true);
    const id = (created.output as any).schedule_id as string;

    const listed = await dispatch(h, 'schedule.list', {});
    expect((listed.output as any).schedules[0]).toMatchObject({ id, note: 'water the plants' });

    const cancelled = await dispatch(h, 'schedule.cancel', { schedule_id: id });
    expect(cancelled.output).toEqual({ schedule_id: id, cancelled: true });
    expect((await dispatch(h, 'schedule.list', {})).output).toEqual({ schedules: [] });

    const again = await dispatch(h, 'schedule.cancel', { schedule_id: id });
    expect((again.output as any).error).toBe('not_active');
    const ghost = await dispatch(h, 'schedule.cancel', { schedule_id: 'nope' });
    expect((ghost.output as any).error).toBe('not_found');
  });

  it('validates fire_at and rrule', async () => {
    h = await bootService({ onboarded: true, runScheduler: false });
    const bad = await dispatch(h, 'schedule.create', { fire_at: 'next tuesday', note: 'x' });
    expect((bad.output as any).error).toBe('invalid_arguments');
    const badRule = await dispatch(h, 'schedule.create', {
      fire_at: nowIso(),
      note: 'x',
      rrule: 'FREQ=NOPE',
    });
    expect((badRule.output as any).error).toBe('invalid_arguments');
  });

  it('is granted to chat by default', async () => {
    h = await bootService({ onboarded: true, runScheduler: false });
    h.fake.always({ text: 'noted' });
    h.service.chat.send({ text: 'remind me to call the dentist tomorrow' });
    await h.service.queue.drain();
    const tools = offeredTools(h);
    expect(tools).toContain('schedule.create');
    expect(tools).toContain('schedule.list');
  });

  it('lets chat schedule a reminder that then fires a handler', async () => {
    h = await bootService({ onboarded: true, runScheduler: false });
    const fireAt = isoPlusSeconds(-1);
    h.fake.script(
      {
        toolCalls: [
          { name: 'schedule.create', args: { fire_at: fireAt, note: 'call the dentist' } },
        ],
      },
      { text: 'Will remind you.' },
    );
    h.service.chat.send({ text: 'remind me to call the dentist in two minutes' });
    await h.service.queue.drain();

    const schedules = h.service.repos.schedules.list();
    expect(schedules).toHaveLength(1);
    expect(schedules[0]?.note).toBe('call the dentist');

    // Now a handler is waiting for reminders.
    const { write } = await import('./helpers.js');
    const path = await import('node:path');
    write(
      path.join(h.dataDir, 'handlers', 'reminder.md'),
      `---\nname: reminder\ndescription: Use for reminders and timers that have come due.\n---\n\nTell the user what the reminder was.\n`,
    );
    h.fake.always((req) =>
      req.body.response_format
        ? {
            text: JSON.stringify({
              summary: 'reminder due: call the dentist',
              verdicts: [{ handler: 'reminder', matched: true, reason: 'a reminder came due' }],
            }),
          }
        : { text: 'Reminder: call the dentist.' },
    );
    h.service.scheduler.tick();
    await h.service.queue.drain();

    const fired = h.service.repos.events
      .recent({ limit: 10 })
      .find((e) => e.type === 'timer.fired')!;
    expect(fired.status).toBe('done');
    const run = h.service.repos.runs.forEvent(fired.id).find((r) => r.kind === 'handler');
    expect(run?.handler_name).toBe('reminder');
    expect(run?.status).toBe('done');
  });
});

describe('the server says when, so the model doesn’t have to (§6.2 S2)', () => {
  const row = (over: Partial<ScheduleRow> = {}): ScheduleRow => ({
    id: '01WHEN',
    fire_at: '2026-09-30T05:00:00.000Z',
    rrule: null,
    grace_s: 3600,
    note: 'test',
    event_type: 'timer.fired',
    event_payload: '{}',
    created_by_run: null,
    status: 'active',
    last_fired_at: null,
    on_miss: 'fire_late',
    ...over,
  });

  it('renders a one-shot', () => {
    // 2026-09-30T05:00:00Z is 07:00 Europe/Oslo (still on summer time).
    expect(renderWhen(row(), 'Europe/Oslo', new Date('2026-09-01T00:00:00Z'))).toBe(
      'once at 07:00 Europe/Oslo on 30 Sep; if missed: fires late (grace 1h)',
    );
  });

  it('renders a DST-crossing daily the same way on both sides of the transition', () => {
    // Same fixture as the §6.1 wall-clock tests: an 08:00 Oslo daily, once
    // before the spring transition and once after `nextOccurrence` has
    // corrected `fire_at` for it. The sentence has to read 08:00 both
    // times — never 07:00 (the raw UTC hour) or 09:00 (the uncorrected
    // drift) — because that is the whole point of §6.1's correction.
    const before = row({
      fire_at: '2026-03-28T07:00:00.000Z',
      rrule: 'FREQ=DAILY;UNTIL=20260930T050000Z',
      on_miss: 'skip',
    });
    expect(renderWhen(before, 'Europe/Oslo', new Date('2026-03-01T00:00:00Z'))).toBe(
      'daily at 08:00 Europe/Oslo until 30 Sep; if missed: skipped (grace 1h)',
    );
    const after = row({
      fire_at: '2026-03-29T06:00:00.000Z',
      rrule: 'FREQ=DAILY;UNTIL=20260930T050000Z',
      on_miss: 'skip',
    });
    expect(renderWhen(after, 'Europe/Oslo', new Date('2026-03-30T00:00:00Z'))).toBe(
      'daily at 08:00 Europe/Oslo until 30 Sep; if missed: skipped (grace 1h)',
    );
  });

  it('is wired through schedule.create, .list and .trigger, from the identity’s own zone', async () => {
    h = await bootService({ onboarded: true, runScheduler: false });
    const { GrantedDispatcher } = await import('../src/tools/dispatcher.js');
    const dispatch = async (name: string, args: unknown) => {
      const d = new GrantedDispatcher(
        h.service.tools.handles(),
        { tools: ['schedule.*'] },
        {
          runId: null,
          eventId: null,
        },
      );
      return d.dispatch({ toolCallId: name, name, args });
    };

    const created = (
      await dispatch('schedule.create', {
        fire_at: '2026-09-30T05:00:00.000Z',
        note: 'water the plants',
        grace_s: 3600,
      })
    ).output as any;
    // The test harness's identity is Europe/Oslo (service-harness.ts) — the
    // same source `time.now` reads. Year is left optional: `dateHuman` only
    // appends one when it differs from the clock's, and this suite does not
    // control that clock.
    expect(created.when).toMatch(
      /^once at 07:00 Europe\/Oslo on 30 Sep(?: \d{4})?; if missed: fires late \(grace 1h\)$/,
    );

    const listed = (await dispatch('schedule.list', {})).output as any;
    expect(listed.schedules[0].when).toBe(created.when);

    const triggered = (await dispatch('schedule.trigger', { schedule_id: created.schedule_id }))
      .output as any;
    // Triggering fires now, but the booking's own `when` is unchanged.
    expect(triggered.when).toBe(created.when);
  });
});

describe('a schedule needs a consumer (§6.2, F.2)', () => {
  const dispatch = async (harness: ServiceHarness, name: string, args: unknown) => {
    const { GrantedDispatcher } = await import('../src/tools/dispatcher.js');
    const d = new GrantedDispatcher(
      harness.service.tools.handles(),
      { tools: ['schedule.*'] },
      { runId: null, eventId: null },
    );
    return d.dispatch({ toolCallId: '1', name, args });
  };

  const writeHandler = async (harness: ServiceHarness, name: string, frontmatter: string) => {
    const { write } = await import('./helpers.js');
    const path = await import('node:path');
    write(
      path.join(harness.dataDir, 'handlers', `${name}.md`),
      `---\nname: ${name}\n${frontmatter}---\n\nDo the thing.\n`,
    );
    harness.service.handlers.reload();
  };

  it('names the handlers that will run it', async () => {
    h = await bootService({ onboarded: true, runScheduler: false });
    await writeHandler(
      h,
      'reminder',
      'description: Use for reminders that have come due.\nmatch:\n  types: ["timer.fired"]\n',
    );

    const created = await dispatch(h, 'schedule.create', {
      fire_at: isoPlusSeconds(3600),
      note: 'call the dentist',
    });
    const out = created.output as any;
    expect(out.event_type).toBe('timer.fired');
    expect(out.consumers).toContain('reminder');
    expect(out.warning).toBeUndefined();

    const listed = (await dispatch(h, 'schedule.list', {})).output as any;
    expect(listed.schedules[0].consumers).toContain('reminder');
    expect(listed.schedules[0].event_type).toBe('timer.fired');
  });

  it('names a handler with no match block in catch_all, not consumers (§6.2 S4)', async () => {
    // The observed bug (2026-08-25): a handler with no `match:` block offers
    // itself to everything (§5.2) and used to read as a consumer of every
    // schedule in existence — which meant `consumers: []` never happened and
    // the empty-list `warning` never fired. It still runs (unchanged); it is
    // just named in `catch_all` instead.
    h = await bootService({ onboarded: true, runScheduler: false });
    await writeHandler(h, 'file-instructions', 'description: Anything at all.\n');

    const created = await dispatch(h, 'schedule.create', {
      fire_at: isoPlusSeconds(3600),
      note: 'the morning digest',
      event_type: 'digest.due',
    });
    const out = created.output as any;
    expect(out.consumers).toEqual([]);
    expect(out.catch_all).toContain('file-instructions');
    // The whole point: an empty *consumers* list still warns, whatever
    // catch_all holds.
    expect(out.warning).toMatch(/nothing will run/i);

    const listed = (await dispatch(h, 'schedule.list', {})).output as any;
    expect(listed.schedules[0].consumers).toEqual([]);
    expect(listed.schedules[0].catch_all).toContain('file-instructions');
  });

  it('warns, in the same call, when nothing will run it', async () => {
    h = await bootService({ onboarded: true, runScheduler: false });
    // Nothing in a fresh data dir matches a type nobody has claimed.
    const created = await dispatch(h, 'schedule.create', {
      fire_at: isoPlusSeconds(3600),
      note: 'the morning digest',
      event_type: 'digest.due',
    });
    const out = created.output as any;
    expect(out.event_type).toBe('digest.due');
    expect(out.consumers).toEqual([]);
    expect(out.catch_all).toEqual([]);
    expect(out.warning).toMatch(/nothing will run/i);
    // The row still exists: the warning is information, not a refusal.
    expect(h.service.repos.schedules.list()).toHaveLength(1);
  });

  it('computes consumers against the custom type, not always timer.fired', async () => {
    h = await bootService({ onboarded: true, runScheduler: false });
    await writeHandler(
      h,
      'morning-digest',
      'description: Use when the daily digest is due.\nmatch:\n  types: ["digest.due"]\n',
    );

    const digest = (
      await dispatch(h, 'schedule.create', {
        fire_at: isoPlusSeconds(3600),
        note: 'digest',
        event_type: 'digest.due',
      })
    ).output as any;
    expect(digest.consumers).toEqual(['morning-digest']);

    // ...and the same handler is *not* offered for a plain timer.
    const plain = (
      await dispatch(h, 'schedule.create', {
        fire_at: isoPlusSeconds(3600),
        note: 'bins',
      })
    ).output as any;
    expect(plain.consumers).not.toContain('morning-digest');
  });

  it('counts a handler the same run just changed, with nobody reloading by hand', async () => {
    h = await bootService({ onboarded: true, runScheduler: false });
    const { GrantedDispatcher } = await import('../src/tools/dispatcher.js');
    const d = new GrantedDispatcher(
      h.service.tools.handles(),
      { tools: ['schedule.*', 'config.*'] },
      { runId: null, eventId: null },
    );
    // The digest handler exists and owns its type. Creating one is
    // `handler.create`'s now (F.20) and its own test covers the same reload
    // from that side; this one keeps the `config.write` half honest.
    await writeHandler(
      h,
      'morning-digest',
      'description: Use when the daily digest is due.\nmatch:\n  types: ["digest.due"]\ntools: [deliver.notify]\n',
    );
    // The order is the bug, and this first booking is what gives the test
    // teeth: computing its `consumers` loads the handlers and caches them.
    // The observed run warmed the same cache the same way, by asking what was
    // already booked (2026-09-11).
    const before = await d.dispatch({
      toolCallId: '0',
      name: 'schedule.create',
      args: { fire_at: isoPlusSeconds(7200), note: 'digest', event_type: 'digest.due' },
    });
    expect((before.output as any).consumers).toEqual(['morning-digest']);

    // Then retired through the tool, exactly as a chat run does it — and
    // nothing else happens: no reload(), no restart, no next event. The other
    // tests in this block call `handlers.reload()` themselves, which is what
    // hid this: `consumers` is defined as a fact about the files on disk *now*
    // (§6.2), but the loader caches, so a run that changed a handler and asked
    // who owned its event was answered from the set that existed beforehand.
    // The observed model read another handler's name as its own and reported
    // the fix as verified.
    const written = await d.dispatch({
      toolCallId: '1',
      name: 'config.write',
      args: {
        path: 'handlers/morning-digest.md',
        content:
          '---\nname: morning-digest\ndescription: Use when the daily digest is due.\nmatch:\n  types: ["digest.due"]\ntools: [deliver.notify]\nenabled: false\n---\n\nBuild the digest.\n',
        message: 'handlers: retire morning-digest',
      },
    });
    expect((written.output as any).committed).toBe(true);

    const created = await d.dispatch({
      toolCallId: '2',
      name: 'schedule.create',
      args: { fire_at: isoPlusSeconds(3600), note: 'digest', event_type: 'digest.due' },
    });
    const out = created.output as any;
    expect(out.consumers).toEqual([]);
    expect(out.warning).toBeTruthy();
  });

  it('refuses a reserved namespace, and writes nothing', async () => {
    h = await bootService({ onboarded: true, runScheduler: false });
    for (const prefix of [
      'system.',
      'chat.',
      'watch.',
      'file.',
      'email.',
      'embed.',
      'page.',
      'integration.',
    ]) {
      const refused = (
        await dispatch(h, 'schedule.create', {
          fire_at: isoPlusSeconds(3600),
          note: 'sneaky',
          event_type: `${prefix}mine`,
        })
      ).output as any;
      expect(refused.error).toBe('reserved_event_type');
      expect(refused.prefix).toBe(prefix);
    }
    expect(h.service.repos.schedules.list()).toEqual([]);
  });

  it('refuses a malformed event type, and writes nothing', async () => {
    h = await bootService({ onboarded: true, runScheduler: false });
    for (const bad of ['Digest.Due', 'digest', 'digest.', '.due', 'digest..due', '9.due']) {
      const refused = (
        await dispatch(h, 'schedule.create', {
          fire_at: isoPlusSeconds(3600),
          note: 'sneaky',
          event_type: bad,
        })
      ).output as any;
      expect(refused.error).toBe('invalid_arguments');
    }
    expect(h.service.repos.schedules.list()).toEqual([]);
  });

  /**
   * The test that would have caught #2 and did not exist: a schedule created
   * through the tool, fired by the loop, reaching a delivery. Every layer was
   * working the day this broke; only the whole rope was untested.
   */
  it('fires a plain reminder all the way to a notification, with no handler authored', async () => {
    h = await bootService({ onboarded: true, runScheduler: false });
    // The shipped `scheduled-task` handler is the only consumer, and it is
    // there because installShippedAssets put it there.
    const created = (
      await dispatch(h, 'schedule.create', {
        fire_at: isoPlusSeconds(-1),
        note: 'take the bins out',
      })
    ).output as any;
    expect(created.consumers).toContain('scheduled-task');
    expect(created.warning).toBeUndefined();

    let notified = false;
    h.fake.always((req) => {
      if (req.body.response_format) {
        return {
          text: JSON.stringify({
            summary: 'a reminder came due: take the bins out',
            verdicts: [
              { handler: 'scheduled-task', matched: true, reason: 'a plain reminder' },
            ],
          }),
        };
      }
      if (notified) return { text: 'Reminded.' };
      notified = true;
      return {
        toolCalls: [
          {
            name: 'deliver.notify',
            args: { title: 'Take the bins out', body: 'You asked to be reminded.' },
          },
        ],
      };
    });

    expect(h.service.scheduler.tick()).toBe(1);
    await h.service.queue.drain();

    const fired = h.service.repos.events
      .recent({ limit: 10 })
      .find((e) => e.type === 'timer.fired')!;
    expect(fired.status).toBe('done');
    const run = h.service.repos.runs.forEvent(fired.id).find((r) => r.kind === 'handler');
    expect(run?.handler_name).toBe('scheduled-task');
    const delivered = h.service.repos.deliveries.pending();
    expect(delivered.map((d) => (d.payload as any).title)).toContain('Take the bins out');
    // The before-shot for this test had zero runs and zero deliveries.
    expect(delivered.length).toBeGreaterThan(0);
  });

  it('runs a schedule by hand, all the way to the notification, without consuming it', async () => {
    h = await bootService({ onboarded: true, runScheduler: false });
    // Booked for tomorrow and never due during this test: everything that
    // happens below happens because the tool asked for it.
    const created = (
      await dispatch(h, 'schedule.create', {
        fire_at: isoPlusSeconds(86_400),
        note: 'take the bins out',
      })
    ).output as any;
    expect(created.consumers).toContain('scheduled-task');

    let notified = false;
    h.fake.always((req) => {
      if (req.body.response_format) {
        return {
          text: JSON.stringify({
            summary: 'a reminder was run by hand: take the bins out',
            verdicts: [
              { handler: 'scheduled-task', matched: true, reason: 'a plain reminder' },
            ],
          }),
        };
      }
      if (notified) return { text: 'Reminded.' };
      notified = true;
      return {
        toolCalls: [
          {
            name: 'deliver.notify',
            args: { title: 'Take the bins out', body: 'You asked to be reminded.' },
          },
        ],
      };
    });

    const fired = (await dispatch(h, 'schedule.trigger', { schedule_id: created.schedule_id }))
      .output as any;
    expect(fired.event_type).toBe('timer.fired');
    expect(fired.consumers).toContain('scheduled-task');
    expect(fired.warning).toBeUndefined();
    await h.service.queue.drain();

    // The same rope as a timed fire: ingress, the owning handler, a delivery.
    const event = h.service.repos.events
      .recent({ limit: 10 })
      .find((e) => e.id === fired.event_id)!;
    expect(event.type).toBe('timer.fired');
    expect(event.source).toBe('scheduler');
    expect(event.status).toBe('done');
    const run = h.service.repos.runs.forEvent(event.id).find((r) => r.kind === 'handler');
    expect(run?.handler_name).toBe('scheduled-task');
    expect(h.service.repos.deliveries.pending().map((d) => (d.payload as any).title)).toContain(
      'Take the bins out',
    );

    // The one admitted difference, and the two numbers that must not lie: a
    // hand-fired schedule is now, not an occurrence found late (§6.2).
    expect((event.payload as any).manual).toBe(true);
    expect((event.payload as any).late_by_s).toBe(0);
    expect((event.payload as any).note).toBe('take the bins out');
    expect(Date.parse((event.payload as any).fire_at)).toBeGreaterThan(Date.now() - 60_000);

    // And the booking is exactly where it was: triggering is not consuming.
    const row = h.service.repos.schedules.get(created.schedule_id)!;
    expect(row.status).toBe('active');
    expect(row.fire_at).toBe(created.fire_at);
    expect(row.last_fired_at).toBeNull();
    expect(fired.next_fire_at).toBe(created.fire_at);
  });

  it('a hand-fired event never collides with the real occurrence', async () => {
    h = await bootService({ onboarded: true, runScheduler: false });
    const created = (
      await dispatch(h, 'schedule.create', {
        fire_at: isoPlusSeconds(-1),
        note: 'the digest',
        event_type: 'digest.due',
      })
    ).output as any;

    const byHand = (await dispatch(h, 'schedule.trigger', { schedule_id: created.schedule_id }))
      .output as any;
    // Now let the clock fire the occurrence that was already due. Sharing an
    // idempotency key here would make one of these two swallow the other.
    expect(h.service.scheduler.tick()).toBe(1);
    const fires = h.service.repos.events
      .recent({ limit: 20 })
      .filter((e) => e.type === 'digest.due');
    expect(fires).toHaveLength(2);
    expect(fires.some((e) => e.id === byHand.event_id)).toBe(true);
    // One is "now, on purpose", the other is the booking coming due.
    expect(fires.filter((e) => (e.payload as any).manual === true)).toHaveLength(1);
  });

  it('is caught by the depth guard when a chain triggers its way back round', async () => {
    h = await bootService({ onboarded: true, runScheduler: false });
    const created = (
      await dispatch(h, 'schedule.create', { fire_at: isoPlusSeconds(3600), note: 'loop' })
    ).output as any;

    // A provenance chain already at MAX_DEPTH — what a handler firing a
    // schedule that runs that handler builds, a few hops in (§5.5).
    let causedBy: string | null = null;
    for (let depth = 0; depth <= 5; depth += 1) {
      const submitted: any = h.service.intake.submit({
        type: `chain.step${depth}`,
        source: 'test',
        payload: {},
        ...(causedBy ? { caused_by: causedBy } : {}),
      });
      causedBy = submitted.event.id;
    }

    const { GrantedDispatcher } = await import('../src/tools/dispatcher.js');
    const deep = new GrantedDispatcher(
      h.service.tools.handles(),
      { tools: ['schedule.*'] },
      { runId: null, eventId: causedBy },
    );
    const refused = (
      await deep.dispatch({
        toolCallId: '1',
        name: 'schedule.trigger',
        args: { schedule_id: created.schedule_id },
      })
    ).output as any;
    // The guard says no, the tool says so as a value, and nothing spins.
    expect(refused.error).toBe('loop_rejected');
    expect(refused.reason).toBe('depth_exceeded');
    // The row is written and left alone — a rejected event is kept for the
    // audit trail and never processed (App. C.2), so what proves the loop was
    // stopped is its status, not its absence.
    const fires = h.service.repos.events
      .recent({ limit: 30 })
      .filter((e) => e.type === 'timer.fired');
    expect(fires).toHaveLength(1);
    expect(fires[0]?.status).toBe('rejected');
    expect(h.service.repos.runs.forEvent(fires[0]!.id)).toHaveLength(0);
  });

  it('refuses to fire a cancelled schedule, and one that does not exist', async () => {
    h = await bootService({ onboarded: true, runScheduler: false });
    const created = (
      await dispatch(h, 'schedule.create', {
        fire_at: isoPlusSeconds(3600),
        note: 'spent',
      })
    ).output as any;
    await dispatch(h, 'schedule.cancel', { schedule_id: created.schedule_id });

    const refused = (
      await dispatch(h, 'schedule.trigger', { schedule_id: created.schedule_id })
    ).output as any;
    expect(refused.error).toBe('not_active');
    expect(refused.status).toBe('cancelled');
    const missing = (await dispatch(h, 'schedule.trigger', { schedule_id: 'nope' }))
      .output as any;
    expect(missing.error).toBe('not_found');
    // Neither refusal put anything on the rail.
    expect(
      h.service.repos.events.recent({ limit: 20 }).filter((e) => e.type === 'timer.fired'),
    ).toHaveLength(0);
  });

  it('offers a custom type to its own handler only', async () => {
    h = await bootService({ onboarded: true, runScheduler: false });
    await writeHandler(
      h,
      'morning-digest',
      'description: Use when the daily digest is due.\nmatch:\n  types: ["digest.due"]\n',
    );
    h.service.repos.schedules.create({
      fireAt: isoPlusSeconds(-1),
      note: 'digest',
      eventType: 'digest.due',
    });

    const offered: string[][] = [];
    h.fake.always((req) => {
      if (!req.body.response_format) return { text: 'done' };
      const prompt = JSON.stringify(req.body.messages);
      offered.push(['morning-digest', 'scheduled-task'].filter((n) => prompt.includes(n)));
      return {
        text: JSON.stringify({ summary: 'digest due', verdicts: [] }),
      };
    });

    h.service.scheduler.tick();
    await h.service.queue.drain();

    // Structural, before the gate is consulted: `scheduled-task` matches
    // `timer.fired` only, so a custom type never reaches it (§6.2).
    expect(offered[0]).toEqual(['morning-digest']);
  });
});
