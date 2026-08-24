import { log } from '../../../core/logger.js';
import { isoPlusSeconds, nowIso } from '../../../core/time.js';
import type { SubmitInput } from '../../../ingress/intake.js';
import { PollingSource, type PollResult, type SourceDeps } from '../../../ingress/source.js';
import type { CalendarClient, CalendarEvent } from './calendar.js';

const l = log('gcal');

export interface CalendarSourceConfig {
  calendars: string[];
  pollSeconds: number;
  /** How far ahead a meeting is announced. */
  leadMinutes: number;
  /** Also emit when an already-announced event changes (time, place, cancel). */
  watchChanges: boolean;
}

interface SeenEntry {
  /** Google's `updated` stamp when we last announced this occurrence. */
  updated: string;
  start: string;
}

/**
 * Turns the calendar into events (§4.3). Two things are worth an event: a
 * meeting about to start, and a change to one we already announced. Everything
 * else is just the calendar being the calendar.
 */
export class CalendarSource extends PollingSource {
  constructor(
    deps: SourceDeps,
    private readonly client: CalendarClient,
    private readonly config: CalendarSourceConfig,
  ) {
    super('google.calendar', deps, config.pollSeconds * 1000);
  }

  protected override async ready(): Promise<{ ok: boolean; reason?: string }> {
    if (!this.client.authorised) {
      return { ok: false, reason: 'not authorised — run `turminder auth google`' };
    }
    return { ok: true };
  }

  protected async poll(): Promise<PollResult> {
    const seenKey = 'source:google.calendar:seen';
    const seen = this.deps.meta.json<Record<string, SeenEntry>>(seenKey, {});
    const events: SubmitInput[] = [];
    const horizonS = Math.max(this.config.leadMinutes * 60, 900);

    for (const calendarId of this.config.calendars) {
      const upcoming = await this.client.listEvents({
        calendarId,
        timeMin: nowIso(),
        timeMax: isoPlusSeconds(horizonS),
      });
      for (const event of upcoming) {
        if (event.status === 'cancelled') continue;
        if (event.all_day) continue;
        const key = `${calendarId}:${event.id}:${event.start}`;
        const previous = seen[key];
        if (!previous) {
          events.push(this.upcomingEvent(event, key));
          seen[key] = { updated: event.updated ?? '', start: event.start };
        } else if (
          this.config.watchChanges &&
          event.updated &&
          event.updated !== previous.updated
        ) {
          events.push(this.changedEvent(event, key, previous));
          seen[key] = { updated: event.updated, start: event.start };
        }
      }
    }

    // Forget occurrences that are well past: the map is a dedupe set, not history.
    const cutoff = Date.now() - 24 * 3600_000;
    for (const [key, entry] of Object.entries(seen)) {
      if (Date.parse(entry.start) < cutoff) delete seen[key];
    }
    this.deps.meta.setJson(seenKey, seen);
    if (events.length) l.debug({ count: events.length }, 'calendar produced events');
    return { events };
  }

  private upcomingEvent(event: CalendarEvent, key: string): SubmitInput {
    return {
      type: 'calendar.event_upcoming',
      source: `gcal.${event.calendar_id}`,
      payload: {
        event: event,
        minutes_until: Math.round((Date.parse(event.start) - Date.now()) / 60_000),
      },
      occurred_at: nowIso(),
      idempotency_key: `upcoming:${key}`,
      // One meeting at a time, in order.
      serialization_key: `calendar:${event.calendar_id}:${event.id}`,
    };
  }

  private changedEvent(event: CalendarEvent, key: string, previous: SeenEntry): SubmitInput {
    return {
      type: 'calendar.event_changed',
      source: `gcal.${event.calendar_id}`,
      payload: { event, previous_start: previous.start },
      occurred_at: event.updated ?? nowIso(),
      idempotency_key: `changed:${key}:${event.updated ?? ''}`,
      serialization_key: `calendar:${event.calendar_id}:${event.id}`,
    };
  }
}
