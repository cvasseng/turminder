import { z } from 'zod';
import type { Config } from '../../core/config.js';
import type { ToolDefinition } from '../types.js';

export interface TimeDeps {
  config: Config;
  /** Overridden in tests; production reads the wall clock. */
  now?: () => Date;
}

/** Zone offset in minutes at an instant, via the one API that knows tzdata. */
export function offsetMinutes(at: Date, timezone: string): number {
  const formatted = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    timeZoneName: 'longOffset',
  }).format(at);
  const match = /GMT([+-])(\d{2}):(\d{2})/.exec(formatted);
  if (!match) return 0; // "GMT" with no offset means UTC
  const sign = match[1] === '-' ? -1 : 1;
  return sign * (Number(match[2]) * 60 + Number(match[3]));
}

/**
 * Whether a zone is on summer time right now. Derived rather than looked up:
 * standard time is the smaller of the January and July offsets, and anything
 * above it is a DST shift. True for the southern hemisphere too.
 */
export function isDst(at: Date, timezone: string): boolean {
  const year = Number(
    new Intl.DateTimeFormat('en-US', { timeZone: timezone, year: 'numeric' }).format(at),
  );
  const january = offsetMinutes(new Date(Date.UTC(year, 0, 1)), timezone);
  const july = offsetMinutes(new Date(Date.UTC(year, 6, 1)), timezone);
  return offsetMinutes(at, timezone) > Math.min(january, july);
}

/** Y/M/D as they read in a zone, which is what every date question is about. */
export function localParts(
  at: Date,
  timezone: string,
): { year: number; month: number; day: number; hour: number; minute: number; weekday: string } {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    weekday: 'long',
    hour12: false,
  }).formatToParts(at);
  const value = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  return {
    year: Number(value('year')),
    month: Number(value('month')),
    day: Number(value('day')),
    // Midnight formats as hour 24 in some locales; 00 is the same instant.
    hour: Number(value('hour')) % 24,
    minute: Number(value('minute')),
    weekday: value('weekday'),
  };
}

/**
 * ISO 8601 week number: weeks start Monday, and week 1 is the one containing
 * the first Thursday. The naive "day of year / 7" is wrong every January.
 */
export function isoWeek(
  year: number,
  month: number,
  day: number,
): { week: number; year: number } {
  const date = new Date(Date.UTC(year, month - 1, day));
  const dayNumber = date.getUTCDay() || 7; // Monday 1 … Sunday 7
  date.setUTCDate(date.getUTCDate() + 4 - dayNumber);
  const isoYear = date.getUTCFullYear();
  const firstThursday = new Date(Date.UTC(isoYear, 0, 1));
  const week = 1 + Math.round((date.getTime() - firstThursday.getTime()) / 604_800_000 - 0.5);
  return { week, year: isoYear };
}

export function pad(n: number): string {
  return String(n).padStart(2, '0');
}

/**
 * `time.now` (App. F.10). A tool rather than a prompt injection, deliberately:
 * a timestamp in the system prompt goes stale mid-conversation and invalidates
 * everything after it in llama.cpp's prompt cache (App. H.1). The base prompts
 * tell the model to call this whenever the date or time matters.
 */
export function timeTools(deps: TimeDeps): ToolDefinition[] {
  return [
    {
      name: 'time.now',
      description:
        "The current date and time, in the user's timezone. Call it whenever the answer depends on what today, now, tomorrow or this week means — you are not told the time otherwise, and guessing it is always wrong.",
      tier: 'ro',
      args: z.object({
        timezone: z
          .string()
          .optional()
          .describe("IANA timezone, e.g. Europe/Oslo; defaults to the user's own"),
      }),
      async execute(args: { timezone?: string }) {
        const at = (deps.now ?? (() => new Date()))();
        const fallback = deps.config.identity()?.frontmatter.timezone ?? 'UTC';
        const timezone = args.timezone ?? fallback;
        let local;
        try {
          local = localParts(at, timezone);
        } catch {
          return {
            error: 'invalid_timezone',
            message: `"${timezone}" is not an IANA timezone name`,
          };
        }
        const { week } = isoWeek(local.year, local.month, local.day);
        return {
          iso: at.toISOString(),
          unix: Math.floor(at.getTime() / 1000),
          timezone,
          local: `${local.weekday} ${local.year}-${pad(local.month)}-${pad(local.day)} ${pad(local.hour)}:${pad(local.minute)}`,
          week,
          day_of_week: local.weekday,
          dst: isDst(at, timezone),
        };
      },
    },
  ];
}
