import { z } from 'zod';
import { log } from '../../core/logger.js';
import { errMessage } from '../../core/errors.js';
import type { Config } from '../../core/config.js';
import { USER_AGENT } from '../../core/version.js';
import type { MetaRepo } from '../../db/repos/meta.js';
import type { ToolDefinition } from '../types.js';
import { localParts, pad } from './time.js';

const l = log('tool:weather');

const FORECAST_URL = 'https://api.met.no/weatherapi/locationforecast/2.0/compact';
const NOMINATIM_URL = 'https://nominatim.openstreetmap.org/search';

/** NLOD / CC BY 4.0 requires this to travel with the data, so it is in the result. */
export const MET_ATTRIBUTION = 'Data from MET Norway (NLOD/CC BY 4.0)';

/** App. A: 15 min per rounded coordinate, 30 days for a geocode. */
const FORECAST_TTL_MS = 15 * 60_000;
const GEOCODE_TTL_MS = 30 * 24 * 3600_000;
/** Nominatim's usage policy, enforced on our side rather than theirs. */
const NOMINATIM_MIN_INTERVAL_MS = 1000;

export interface WeatherDeps {
  config: Config;
  meta: MetaRepo;
  fetch?: typeof globalThis.fetch;
  now?: () => Date;
}

export interface Place {
  name: string;
  lat: number;
  lon: number;
}

interface CachedForecast {
  fetched_at: number;
  /** From the response, honoured on the next call (App. F.11). */
  expires_at: number | null;
  last_modified: string | null;
  body: MetResponse;
}

interface MetResponse {
  properties?: {
    meta?: { updated_at?: string };
    timeseries?: {
      time: string;
      data?: {
        instant?: { details?: Record<string, number> };
        next_1_hours?: { summary?: { symbol_code?: string }; details?: Record<string, number> };
        next_6_hours?: { summary?: { symbol_code?: string }; details?: Record<string, number> };
      };
    }[];
  };
}

/** 4 decimals is ~11 m: precise enough for weather, coarse enough to cache. */
export function roundCoord(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

/**
 * A single-file rate limiter for Nominatim. One request per second, serialised
 * across the process, because the policy is per client and not per caller.
 */
class Throttle {
  private next = 0;

  async wait(intervalMs: number): Promise<void> {
    const now = Date.now();
    const at = Math.max(now, this.next);
    this.next = at + intervalMs;
    if (at > now) await new Promise((r) => setTimeout(r, at - now));
  }
}

const nominatim = new Throttle();

/**
 * MET's `symbol_code` is one run-together word — `heavyrainshowersandthunder`.
 * Split it at the vocabulary boundaries rather than keeping a table of the
 * hundred-odd codes: every one of them is built from these pieces.
 */
const SYMBOL_WORDS = /(?<=[a-z])(and|showers|rain|snow|sleet|thunder|cloudy|sky|fog)/g;

export function describeSymbol(code: string | null): string {
  if (!code) return 'no forecast symbol';
  return code
    .replace(/_(day|night|polartwilight)$/, '')
    .replace(/_/g, ' ')
    .replace(SYMBOL_WORDS, ' $1')
    .replace(/\s+/g, ' ')
    .trim();
}

export interface DayForecast {
  date: string;
  summary: string;
  temp_min_c: number | null;
  temp_max_c: number | null;
  precipitation_mm: number;
  wind_ms: number | null;
}

/**
 * Fold MET's hourly-then-six-hourly series into days, in the timezone the user
 * lives in — "tomorrow" is a local question. Precipitation prefers the 1-hour
 * figure where it exists, because the 6-hour figure covers the same hours and
 * adding both counts the rain twice.
 */
export function toDays(body: MetResponse, timezone: string, days: number): DayForecast[] {
  const byDate = new Map<
    string,
    {
      temps: number[];
      winds: number[];
      precip: number;
      symbols: { hour: number; code: string }[];
    }
  >();

  for (const entry of body.properties?.timeseries ?? []) {
    const at = new Date(entry.time);
    if (Number.isNaN(at.getTime())) continue;
    const local = localParts(at, timezone);
    const date = `${local.year}-${pad(local.month)}-${pad(local.day)}`;
    const bucket = byDate.get(date) ?? { temps: [], winds: [], precip: 0, symbols: [] };
    byDate.set(date, bucket);

    const instant = entry.data?.instant?.details ?? {};
    if (typeof instant.air_temperature === 'number') bucket.temps.push(instant.air_temperature);
    if (typeof instant.wind_speed === 'number') bucket.winds.push(instant.wind_speed);

    const hourly = entry.data?.next_1_hours;
    const sixHourly = entry.data?.next_6_hours;
    const window = hourly ?? sixHourly;
    const amount = window?.details?.precipitation_amount;
    if (typeof amount === 'number') bucket.precip += amount;
    const code = window?.summary?.symbol_code;
    if (code) bucket.symbols.push({ hour: local.hour, code });
  }

  return [...byDate.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .slice(0, days)
    .map(([date, bucket]) => ({
      date,
      // The symbol nearest midday: it is the one a person means by "tomorrow".
      summary: describeSymbol(
        bucket.symbols.sort((a, b) => Math.abs(a.hour - 12) - Math.abs(b.hour - 12))[0]?.code ??
          null,
      ),
      temp_min_c: bucket.temps.length ? round1(Math.min(...bucket.temps)) : null,
      temp_max_c: bucket.temps.length ? round1(Math.max(...bucket.temps)) : null,
      precipitation_mm: round1(bucket.precip),
      wind_ms: bucket.winds.length ? round1(Math.max(...bucket.winds)) : null,
    }));
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

/**
 * `weather.forecast` (App. F.11), over MET Norway's Locationforecast 2.0 — the
 * yr.no data source. Free and keyless, on two conditions this code honours:
 * an identifying `User-Agent` (a generic one is a hard 403) and attribution
 * travelling with the data.
 */
export function weatherTools(deps: WeatherDeps): ToolDefinition[] {
  const doFetch = () => deps.fetch ?? globalThis.fetch;
  const clock = () => (deps.now ?? (() => new Date()))().getTime();

  /** Nominatim, cached hard: place names do not move. */
  async function geocode(query: string): Promise<Place | { error: string; message: string }> {
    const key = `weather:geocode:${query.trim().toLowerCase()}`;
    const cached = deps.meta.json<{ at: number; place: Place | null } | null>(key, null);
    if (cached && clock() - cached.at < GEOCODE_TTL_MS) {
      return (
        cached.place ?? { error: 'unknown_location', message: `nothing found for "${query}"` }
      );
    }

    await nominatim.wait(NOMINATIM_MIN_INTERVAL_MS);
    const url = new URL(NOMINATIM_URL);
    url.searchParams.set('q', query);
    url.searchParams.set('format', 'jsonv2');
    url.searchParams.set('limit', '1');
    const res = await doFetch()(url, {
      headers: { 'user-agent': USER_AGENT, accept: 'application/json' },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      return { error: 'geocoding_failed', message: `Nominatim returned HTTP ${res.status}` };
    }
    const body = (await res.json()) as { lat: string; lon: string; display_name: string }[];
    const first = body[0];
    if (!first) {
      deps.meta.setJson(key, { at: clock(), place: null });
      return { error: 'unknown_location', message: `nothing found for "${query}"` };
    }
    const place: Place = {
      name: first.display_name,
      lat: roundCoord(Number(first.lat)),
      lon: roundCoord(Number(first.lon)),
    };
    deps.meta.setJson(key, { at: clock(), place });
    l.debug({ query, lat: place.lat, lon: place.lon }, 'geocoded');
    return place;
  }

  /**
   * One forecast, cached per rounded coordinate. `Expires` is honoured when MET
   * sends one, and a conditional request means a re-fetch after the TTL usually
   * costs a 304 rather than a payload.
   */
  async function forecast(
    lat: number,
    lon: number,
  ): Promise<
    | { body: MetResponse; issued_at: string | null; cached: boolean }
    | { error: string; message: string }
  > {
    const key = `weather:forecast:${lat},${lon}`;
    const cached = deps.meta.json<CachedForecast | null>(key, null);
    const now = clock();
    const fresh =
      cached &&
      (cached.expires_at
        ? now < cached.expires_at
        : now - cached.fetched_at < FORECAST_TTL_MS) &&
      now - cached.fetched_at < FORECAST_TTL_MS;
    if (cached && fresh) {
      return {
        body: cached.body,
        issued_at: cached.body.properties?.meta?.updated_at ?? null,
        cached: true,
      };
    }

    const url = new URL(FORECAST_URL);
    url.searchParams.set('lat', String(lat));
    url.searchParams.set('lon', String(lon));
    const res = await doFetch()(url, {
      headers: {
        'user-agent': USER_AGENT,
        accept: 'application/json',
        ...(cached?.last_modified ? { 'if-modified-since': cached.last_modified } : {}),
      },
      signal: AbortSignal.timeout(20_000),
    });

    if (res.status === 304 && cached) {
      deps.meta.setJson(key, { ...cached, fetched_at: now });
      return {
        body: cached.body,
        issued_at: cached.body.properties?.meta?.updated_at ?? null,
        cached: true,
      };
    }
    if (res.status === 403) {
      return {
        error: 'forecast_refused',
        message: 'api.met.no refused the request — the User-Agent must identify this client',
      };
    }
    if (!res.ok) {
      return { error: 'forecast_failed', message: `api.met.no returned HTTP ${res.status}` };
    }

    const body = (await res.json()) as MetResponse;
    const expires = res.headers.get('expires');
    const expiresAt = expires ? Date.parse(expires) : NaN;
    deps.meta.setJson(key, {
      fetched_at: now,
      expires_at: Number.isNaN(expiresAt) ? null : expiresAt,
      last_modified: res.headers.get('last-modified'),
      body,
    } satisfies CachedForecast);
    return { body, issued_at: body.properties?.meta?.updated_at ?? null, cached: false };
  }

  return [
    {
      name: 'weather.forecast',
      description:
        'The weather forecast for a place, by name or by coordinates. Use it for anything about weather, rain, temperature or whether to take a coat. Cite the attribution the result carries.',
      tier: 'ro',
      args: z
        .object({
          location: z.string().optional().describe('place name, e.g. Bergen — or use lat/lon'),
          lat: z.number().min(-90).max(90).optional(),
          lon: z.number().min(-180).max(180).optional(),
          days: z.number().int().min(1).max(9).optional().describe('how many days, default 2'),
        })
        .describe('either location, or both lat and lon'),
      async execute(args: { location?: string; lat?: number; lon?: number; days?: number }) {
        const hasCoords = typeof args.lat === 'number' && typeof args.lon === 'number';
        if (!hasCoords && !args.location?.trim()) {
          return {
            error: 'invalid_arguments',
            detail: 'give either a location name or both lat and lon',
          };
        }

        let place: Place;
        try {
          if (hasCoords) {
            place = {
              name:
                args.location?.trim() || `${roundCoord(args.lat!)}, ${roundCoord(args.lon!)}`,
              lat: roundCoord(args.lat!),
              lon: roundCoord(args.lon!),
            };
          } else {
            const found = await geocode(args.location!);
            if ('error' in found) return found;
            place = found;
          }
        } catch (e) {
          return { error: 'geocoding_failed', message: errMessage(e) };
        }

        let result;
        try {
          result = await forecast(place.lat, place.lon);
        } catch (e) {
          return { error: 'forecast_failed', message: errMessage(e) };
        }
        if ('error' in result) return result;

        const timezone = deps.config.identity()?.frontmatter.timezone ?? 'UTC';
        const days = toDays(result.body, timezone, args.days ?? 2);
        if (!days.length) {
          return { error: 'forecast_failed', message: 'the forecast contained no timeseries' };
        }
        l.debug({ place: place.name, days: days.length, cached: result.cached }, 'forecast');
        return {
          location: place,
          issued_at: result.issued_at,
          timezone,
          days,
          attribution: MET_ATTRIBUTION,
        };
      },
    },
  ];
}
