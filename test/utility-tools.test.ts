import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Config } from '../src/core/config.js';
import { openDataHome, type DataHome } from '../src/core/datadir.js';
import { openDb } from '../src/db/index.js';
import { createRepos, type Repos } from '../src/db/repos/index.js';
import { USER_AGENT } from '../src/core/version.js';
import { isDst, isoWeek, localParts, timeTools } from '../src/tools/integrations/time.js';
import {
  MET_ATTRIBUTION,
  describeSymbol,
  roundCoord,
  toDays,
  weatherTools,
} from '../src/tools/integrations/weather.js';
import type { ToolDefinition } from '../src/tools/types.js';
import { bootService, type ServiceHarness } from './service-harness.js';
import { tmpDir, write } from './helpers.js';

let h: ServiceHarness;
afterEach(async () => {
  await h?.cleanup();
});

const ctx = { runId: null, eventId: null };

interface Env {
  home: DataHome;
  config: Config;
  repos: Repos;
  cleanup(): void;
}

function env(timezone = 'Europe/Oslo'): Env {
  const t = tmpDir('turminder-util-');
  const { home } = openDataHome(path.join(t.dir, 'home'));
  write(
    home.path('config', 'identity.md'),
    `---\ninstance_name: Sleeper Service\nuser_name: Alex\ntimezone: ${timezone}\nlocale: en\n---\n\n.\n`,
  );
  const db = openDb(home.dbPath);
  const repos = createRepos(db);
  return {
    home,
    config: new Config(home),
    repos,
    cleanup() {
      db.close();
      t.cleanup();
    },
  };
}

const call = (tool: ToolDefinition, args: unknown) =>
  tool.execute(tool.args.parse(args), ctx) as Promise<any>;

describe('time.now (App. F.10)', () => {
  it('answers in the identity timezone, with the ISO week and a DST flag', async () => {
    const e = env();
    const at = new Date('2026-08-21T12:03:04.000Z');
    const [now] = timeTools({ config: e.config, now: () => at });
    const result = await call(now!, {});
    expect(result).toEqual({
      iso: '2026-08-21T12:03:04.000Z',
      unix: 1787313784,
      timezone: 'Europe/Oslo',
      local: 'Friday 2026-08-21 14:03',
      week: 34,
      day_of_week: 'Friday',
      dst: true,
    });
    e.cleanup();
  });

  it('takes an explicit timezone, and says so when it is not one', async () => {
    const e = env();
    const at = new Date('2026-01-15T23:30:00.000Z');
    const [now] = timeTools({ config: e.config, now: () => at });
    const tokyo = await call(now!, { timezone: 'Asia/Tokyo' });
    // Past midnight in Tokyo: the local date is the next day, and so is the week.
    expect(tokyo.local).toBe('Friday 2026-01-16 08:30');
    expect(tokyo.dst).toBe(false);
    expect(await call(now!, { timezone: 'Middle/Earth' })).toMatchObject({
      error: 'invalid_timezone',
    });
    e.cleanup();
  });

  it('gets the ISO week right across a year boundary', () => {
    expect(isoWeek(2026, 1, 1)).toEqual({ week: 1, year: 2026 });
    // 30 Dec 2024 is in week 1 of 2025, which is the case naive maths fails.
    expect(isoWeek(2024, 12, 30)).toEqual({ week: 1, year: 2025 });
    expect(isoWeek(2021, 1, 3)).toEqual({ week: 53, year: 2020 });
  });

  it('reads DST the right way round in the southern hemisphere', () => {
    expect(isDst(new Date('2026-01-21T12:00:00Z'), 'Australia/Sydney')).toBe(true);
    expect(isDst(new Date('2026-08-21T12:00:00Z'), 'Australia/Sydney')).toBe(false);
    expect(isDst(new Date('2026-08-21T12:00:00Z'), 'UTC')).toBe(false);
    expect(localParts(new Date('2026-03-01T00:30:00Z'), 'Europe/Oslo').day).toBe(1);
  });

  it('is not injected into the prompt, so the cached prefix stays stable', async () => {
    h = await bootService({ onboarded: true, watchFiles: false });
    h.fake.always({ text: 'ask me' });
    h.service.chat.send({ text: 'what day is it?' });
    await h.service.queue.drain();
    const system = h.fake.requests.at(-1)!.body.messages[0].content as string;
    expect(system).not.toContain('Current time:');
    expect(system).toContain('Call `time.now`');
  });
});

/* ── weather ──────────────────────────────────────────────────────────────── */

/** One MET timeseries entry, in the shape the compact endpoint returns. */
const entry = (time: string, temp: number, wind: number, mm: number, code: string) => ({
  time,
  data: {
    instant: { details: { air_temperature: temp, wind_speed: wind } },
    next_1_hours: { summary: { symbol_code: code }, details: { precipitation_amount: mm } },
    next_6_hours: { summary: { symbol_code: code }, details: { precipitation_amount: mm * 6 } },
  },
});

const MET_BODY = {
  properties: {
    meta: { updated_at: '2026-08-21T11:00:00Z' },
    timeseries: [
      entry('2026-08-21T10:00:00Z', 17.2, 3.1, 0, 'clearsky_day'),
      entry('2026-08-21T12:00:00Z', 19.4, 4.6, 0, 'partlycloudy_day'),
      entry('2026-08-21T20:00:00Z', 12.1, 2.0, 0, 'fair_night'),
      entry('2026-08-22T08:00:00Z', 13.0, 6.0, 1.4, 'rain'),
      entry('2026-08-22T12:00:00Z', 15.5, 8.2, 2.1, 'heavyrain'),
      entry('2026-08-23T12:00:00Z', 16.0, 3.0, 0, 'cloudy'),
    ],
  },
};

interface FakeCall {
  url: string;
  headers: Record<string, string>;
}

/** A stand-in for api.met.no and Nominatim that records what was asked of it. */
function fakeUpstream(opts: { notModified?: boolean; forecastStatus?: number } = {}) {
  const calls: FakeCall[] = [];
  const fetchImpl = (async (input: any, init: any = {}) => {
    const url = String(input);
    calls.push({ url, headers: normalise(init.headers) });
    if (url.includes('nominatim')) {
      return json([
        { lat: '60.3943055', lon: '5.3259192', display_name: 'Bergen, Vestland, Norway' },
      ]);
    }
    if (opts.forecastStatus) {
      return new Response('no', { status: opts.forecastStatus });
    }
    if (opts.notModified && calls.filter((c) => c.url.includes('met.no')).length > 1) {
      return new Response(null, { status: 304 });
    }
    return json(MET_BODY, { 'last-modified': 'Fri, 21 Aug 2026 11:00:00 GMT' });
  }) as unknown as typeof globalThis.fetch;
  return { calls, fetchImpl, met: () => calls.filter((c) => c.url.includes('met.no')) };
}

function json(body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

function normalise(headers: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries((headers ?? {}) as Record<string, string>)) {
    out[k.toLowerCase()] = v;
  }
  return out;
}

describe('weather.forecast (App. F.11)', () => {
  it('geocodes a place, folds the forecast into days, and carries the attribution', async () => {
    const e = env();
    const upstream = fakeUpstream();
    const [forecast] = weatherTools({
      config: e.config,
      meta: e.repos.meta,
      fetch: upstream.fetchImpl,
    });
    const result = await call(forecast!, { location: 'Bergen', days: 2 });

    expect(result.location).toEqual({
      name: 'Bergen, Vestland, Norway',
      lat: 60.3943,
      lon: 5.3259,
    });
    expect(result.attribution).toBe(MET_ATTRIBUTION);
    expect(result.issued_at).toBe('2026-08-21T11:00:00Z');
    expect(result.days).toHaveLength(2);
    // Days are grouped in the user's own timezone: 20:00Z is still the 21st.
    expect(result.days[0]).toEqual({
      date: '2026-08-21',
      // The symbol nearest local midday: 10:00Z is 12:00 in Oslo.
      summary: 'clear sky',
      temp_min_c: 12.1,
      temp_max_c: 19.4,
      precipitation_mm: 0,
      wind_ms: 4.6,
    });
    // Precipitation uses the 1-hour figure, not 1h + 6h over the same hours.
    expect(result.days[1]).toMatchObject({
      date: '2026-08-22',
      precipitation_mm: 3.5,
      wind_ms: 8.2,
    });
    e.cleanup();
  });

  it('sends an identifying User-Agent to both services — a generic one is a 403', async () => {
    const e = env();
    const upstream = fakeUpstream();
    const [forecast] = weatherTools({
      config: e.config,
      meta: e.repos.meta,
      fetch: upstream.fetchImpl,
    });
    await call(forecast!, { location: 'Bergen' });

    expect(upstream.calls).toHaveLength(2);
    for (const c of upstream.calls) {
      expect(c.headers['user-agent']).toBe(USER_AGENT);
      expect(c.headers['user-agent']).toMatch(/^turminder\/\d+\.\d+\.\d+ https?:\/\//);
    }
    e.cleanup();
  });

  it('reports a 403 as what it is rather than as a missing forecast', async () => {
    const e = env();
    const upstream = fakeUpstream({ forecastStatus: 403 });
    const [forecast] = weatherTools({
      config: e.config,
      meta: e.repos.meta,
      fetch: upstream.fetchImpl,
    });
    expect(await call(forecast!, { lat: 60.39, lon: 5.32 })).toMatchObject({
      error: 'forecast_refused',
    });
    e.cleanup();
  });

  it('asking twice inside the TTL is exactly one upstream call', async () => {
    const e = env();
    const upstream = fakeUpstream();
    const at = Date.parse('2026-08-21T12:00:00Z');
    const [forecast] = weatherTools({
      config: e.config,
      meta: e.repos.meta,
      fetch: upstream.fetchImpl,
      now: () => new Date(at),
    });
    await call(forecast!, { location: 'Bergen' });
    await call(forecast!, { location: 'Bergen' });
    await call(forecast!, { lat: 60.3943055, lon: 5.3259192 });
    // One geocode (cached 30 days) and one forecast (cached 15 min).
    expect(upstream.met()).toHaveLength(1);
    expect(upstream.calls.filter((c) => c.url.includes('nominatim'))).toHaveLength(1);
    e.cleanup();
  });

  it('revalidates with If-Modified-Since once the TTL is up', async () => {
    const e = env();
    const upstream = fakeUpstream({ notModified: true });
    let at = Date.parse('2026-08-21T12:00:00Z');
    const [forecast] = weatherTools({
      config: e.config,
      meta: e.repos.meta,
      fetch: upstream.fetchImpl,
      now: () => new Date(at),
    });
    await call(forecast!, { lat: 60.39, lon: 5.32 });
    at += 20 * 60_000;
    const second = await call(forecast!, { lat: 60.39, lon: 5.32 });

    expect(upstream.met()).toHaveLength(2);
    expect(upstream.met()[1]!.headers['if-modified-since']).toBe(
      'Fri, 21 Aug 2026 11:00:00 GMT',
    );
    // A 304 keeps the cached body rather than losing the forecast.
    expect(second.days[0]?.date).toBe('2026-08-21');
    e.cleanup();
  });

  it('needs a location or coordinates, and says which', async () => {
    const e = env();
    const [forecast] = weatherTools({
      config: e.config,
      meta: e.repos.meta,
      fetch: fakeUpstream().fetchImpl,
    });
    expect(await call(forecast!, {})).toMatchObject({ error: 'invalid_arguments' });
    e.cleanup();
  });

  it('turns MET symbol codes into something readable', () => {
    expect(describeSymbol('clearsky_day')).toBe('clear sky');
    expect(describeSymbol('partlycloudy_night')).toBe('partly cloudy');
    expect(describeSymbol('lightrainshowers_day')).toBe('light rain showers');
    expect(describeSymbol('heavyrainshowersandthunder_day')).toBe(
      'heavy rain showers and thunder',
    );
    expect(describeSymbol('fair_night')).toBe('fair');
    expect(describeSymbol(null)).toBe('no forecast symbol');
  });

  it('rounds coordinates to the cache key width', () => {
    expect(roundCoord(60.39430555)).toBe(60.3943);
    expect(roundCoord(-5.000051)).toBe(-5.0001);
  });

  it('groups days in the timezone it is given', () => {
    // 22:00 UTC is the next day in Oslo, and the same day in UTC.
    const body = {
      properties: { timeseries: [entry('2026-08-21T22:00:00Z', 10, 1, 0, 'fair_night')] },
    };
    expect(toDays(body, 'Europe/Oslo', 2)[0]?.date).toBe('2026-08-22');
    expect(toDays(body, 'UTC', 2)[0]?.date).toBe('2026-08-21');
  });
});

describe('both are in the default chat grant (App. F.7)', () => {
  it('offers time.now and weather.forecast to chat', async () => {
    h = await bootService({ onboarded: true, watchFiles: false });
    h.fake.always({ text: 'fine' });
    h.service.chat.send({ text: 'hello' });
    await h.service.queue.drain();
    const tools = (h.fake.requests.at(-1)!.body.tools ?? []).map((t: any) => t.function.name);
    expect(tools).toContain('time.now');
    expect(tools).toContain('weather.forecast');
  });
});
