import { afterEach, describe, expect, it } from 'vitest';
import { bootService, offeredTools, type ServiceHarness } from './service-harness.js';
import { nextOccurrence } from '../src/scheduler/loop.js';
import { isoPlusSeconds, nowIso } from '../src/core/time.js';
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
  ...over,
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
    expect(event?.payload).toEqual({
      schedule_id: created.id,
      note: 'take the bins out',
      data: { thing: 'bins' },
    });
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

  it('fires a schedule missed inside its grace window (restart case)', async () => {
    h = await bootService({ onboarded: true, runScheduler: false });
    // Fired 10 minutes ago, grace an hour: still owed.
    const created = h.service.repos.schedules.create({
      fireAt: isoPlusSeconds(-600),
      note: 'still owed',
      graceS: 3600,
    });
    expect(h.service.scheduler.recoverMissed()).toBe(0);
    expect(h.service.scheduler.tick()).toBe(1);
    expect(
      h.service.repos.events.recent({ limit: 5 }).some((e) => e.type === 'timer.fired'),
    ).toBe(true);
    expect(h.service.repos.schedules.get(created.id)?.status).toBe('done');
  });

  it('marks a schedule missed past its grace window and says so', async () => {
    h = await bootService({ onboarded: true, runScheduler: false });
    const created = h.service.repos.schedules.create({
      fireAt: isoPlusSeconds(-7200),
      note: 'meeting in 10 minutes',
      graceS: 3600,
    });
    expect(h.service.scheduler.recoverMissed()).toBe(1);
    expect(h.service.repos.schedules.get(created.id)?.status).toBe('missed');

    const report = h.service.repos.events
      .recent({ limit: 10 })
      .find((e) => e.type === 'system.schedule_missed');
    expect(report).toBeTruthy();
    expect((report?.payload as any).schedule_id).toBe(created.id);
    expect((report?.payload as any).note).toBe('meeting in 10 minutes');
    // No timer.fired for a stale reminder.
    expect(
      h.service.repos.events.recent({ limit: 10 }).some((e) => e.type === 'timer.fired'),
    ).toBe(false);
  });

  it('skips a missed occurrence of a recurring schedule but keeps the series', async () => {
    h = await bootService({ onboarded: true, runScheduler: false });
    const created = h.service.repos.schedules.create({
      fireAt: isoPlusSeconds(-7200),
      note: 'daily',
      rrule: 'FREQ=DAILY',
      graceS: 60,
    });
    expect(h.service.scheduler.recoverMissed()).toBe(1);
    const after = h.service.repos.schedules.get(created.id)!;
    expect(after.status).toBe('active');
    expect(Date.parse(after.fire_at)).toBeGreaterThan(Date.now());
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
