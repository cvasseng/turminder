import { z } from 'zod';
import { log } from '../../core/logger.js';
import { errMessage } from '../../core/errors.js';
import type { Config } from '../../core/config.js';
import type { DataHome } from '../../core/datadir.js';
import type { IntegrationRecord } from '../../core/config-schemas.js';
import type { MetaRepo } from '../../db/repos/meta.js';
import type { EventIntake } from '../../ingress/intake.js';
import type { ToolDefinition } from '../types.js';
import { PollingSource, type SourceDeps } from '../../ingress/source.js';
import { CalendarClient, calendarTools } from './google/calendar.js';
import { CalendarSource } from './google/calendar-source.js';
import { AsanaClient } from './asana/client.js';
import { AsanaInboxSource, DEFAULT_ASANA_CONFIG } from './asana/inbox-source.js';
import { asanaTools } from './asana/tools.js';
import { manifestFor, namespaceOf } from './registry.js';

const l = log('source');

/**
 * Non-secret activation settings per integration (G.12). Validated the same way
 * every other config is: a typo in a poll interval should say so, not be
 * silently ignored.
 */
export const AsanaSettingsSchema = z.strictObject({
  poll_interval_s: z.coerce.number().int().min(30).default(180),
  workspaces: z.array(z.string()).default([]),
  inbox_section: z.string().default(DEFAULT_ASANA_CONFIG.inboxSection),
  daily_section: z.string().default(DEFAULT_ASANA_CONFIG.dailySection),
  include_comments: z.boolean().default(true),
  max_per_poll: z.coerce.number().int().min(1).max(200).default(25),
  watch_daily: z.boolean().default(false),
});

export const CalendarSettingsSchema = z.strictObject({
  poll_interval_s: z.coerce.number().int().min(30).default(300),
  upcoming_lead_min: z.coerce.number().int().min(1).default(15),
  calendars: z.array(z.string()).default(['primary']),
  watch_changes: z.boolean().default(true),
  /**
   * Recorded by the activation flow so the file says which OAuth client was
   * used. Not a secret, and not read from here — `loadGoogleCredentials` looks
   * in secrets.yaml, where the form put both halves of the pair.
   */
  client_id: z.string().optional(),
});

function settings<S extends z.ZodTypeAny>(
  schema: S,
  record: IntegrationRecord | undefined,
  label: string,
): z.infer<S> {
  const parsed = schema.safeParse(record?.settings ?? {});
  if (parsed.success) return parsed.data;
  // A bad setting degrades to the default rather than taking the poller down.
  l.warn(
    { integration: label, err: parsed.error.issues.map((i) => i.message).join('; ') },
    'integration settings failed validation; using defaults',
  );
  return schema.parse({});
}

export interface SourceStackDeps {
  home: DataHome;
  config: Config;
  intake: EventIntake;
  meta: MetaRepo;
  fetch?: typeof globalThis.fetch;
}

export interface IntegrationStatus {
  name: string;
  /** Activated, so its tools exist and the agent can see them. */
  active: boolean;
  /** The background poller is running (or would, once authorised). */
  watching: boolean;
  detail?: string;
}

/** One credentialed integration as the running service sees it. */
export interface IntegrationRuntime {
  /** Manifest name, e.g. `google-calendar`. */
  name: string;
  /** Tool namespace and hub key, e.g. `calendar`. */
  namespace: string;
  active: boolean;
  tools: ToolDefinition[];
  source: PollingSource | null;
  detail?: string;
}

export interface SourceStack {
  runtimes: IntegrationRuntime[];
  /** Pollers to start: the active ones only. */
  sources: PollingSource[];
  /** Tools to hand the hub, keyed by namespace. */
  tools: Record<string, ToolDefinition[]>;
  status: IntegrationStatus[];
}

/**
 * Builds the credentialed integrations from their activation records (§19.5).
 *
 * Activation is the switch, not the presence of a credential: an integration
 * ships dormant, `setup.activate` writes the record and its tools appear,
 * `setup.deactivate` removes the record and they go away again — while the
 * secret stays put, so reactivating is one form submit rather than a hunt for
 * the token. A broken integration is reported and skipped: one bad credential
 * must not stop the assistant.
 */
export function createSourceStack(deps: SourceStackDeps): SourceStack {
  const records = deps.config.integrations().integrations;
  const sourceDeps: SourceDeps = { intake: deps.intake, meta: deps.meta };
  const runtimes: IntegrationRuntime[] = [];

  /* ── Google Calendar ──────────────────────────────────────────────────── */
  const calendarRecord = records['google-calendar'];
  const calendarActive = calendarRecord?.active === true;
  const calendarRuntime: IntegrationRuntime = {
    name: 'google-calendar',
    namespace: 'calendar',
    active: calendarActive,
    tools: [],
    source: null,
  };
  if (calendarActive) {
    try {
      const cfg = settings(CalendarSettingsSchema, calendarRecord, 'google-calendar');
      const client = CalendarClient.create(deps.config, deps.fetch);
      calendarRuntime.tools = calendarTools(client);
      calendarRuntime.detail = !client.authorised
        ? 'needs `turminder auth google`'
        : client.canWrite
          ? 'authorised (read and write)'
          : 'authorised read-only — `turminder auth google --force` for writes';
      calendarRuntime.source = new CalendarSource(sourceDeps, client, {
        calendars: cfg.calendars,
        pollSeconds: cfg.poll_interval_s,
        leadMinutes: cfg.upcoming_lead_min,
        watchChanges: cfg.watch_changes,
      });
    } catch (e) {
      // An active record with no OAuth client is a misconfiguration worth saying.
      l.warn({ err: errMessage(e) }, 'google calendar is active but unusable');
      calendarRuntime.active = false;
      calendarRuntime.detail = errMessage(e);
    }
  } else {
    calendarRuntime.detail = 'not activated — "set up google calendar" in chat';
  }
  runtimes.push(calendarRuntime);

  /* ── Asana ────────────────────────────────────────────────────────────── */
  const asanaRecord = records.asana;
  const asanaActive = asanaRecord?.active === true;
  const asanaRuntime: IntegrationRuntime = {
    name: 'asana',
    namespace: 'asana',
    active: asanaActive,
    tools: [],
    source: null,
  };
  const pat = deps.config.secrets.ASANA_PAT ?? '';
  if (asanaActive && pat) {
    try {
      const cfg = settings(AsanaSettingsSchema, asanaRecord, 'asana');
      const client = new AsanaClient({ pat, ...(deps.fetch ? { fetch: deps.fetch } : {}) });
      asanaRuntime.tools = asanaTools(client, {
        inboxSection: cfg.inbox_section,
        dailySection: cfg.daily_section,
      });
      asanaRuntime.source = new AsanaInboxSource(sourceDeps, client, {
        pollSeconds: cfg.poll_interval_s,
        workspaces: cfg.workspaces,
        inboxSection: cfg.inbox_section,
        dailySection: cfg.daily_section,
        includeComments: cfg.include_comments,
        maxPerPoll: cfg.max_per_poll,
        watchDaily: cfg.watch_daily,
      });
      asanaRuntime.detail = 'token from secrets/secrets.yaml';
    } catch (e) {
      l.error({ err: errMessage(e) }, 'asana integration unavailable');
      asanaRuntime.active = false;
      asanaRuntime.detail = errMessage(e);
    }
  } else if (asanaActive) {
    asanaRuntime.active = false;
    asanaRuntime.detail = 'active record but no ASANA_PAT in secrets/secrets.yaml';
  } else {
    asanaRuntime.detail = 'not activated — "set up asana" in chat';
  }
  runtimes.push(asanaRuntime);

  const tools: Record<string, ToolDefinition[]> = {};
  const sources: PollingSource[] = [];
  for (const runtime of runtimes) {
    if (!runtime.active) continue;
    if (runtime.tools.length) tools[namespaceOf(manifestFor(runtime.name)!)] = runtime.tools;
    if (runtime.source) sources.push(runtime.source);
  }
  const status: IntegrationStatus[] = runtimes.map((r) => ({
    name: r.name,
    active: r.active,
    watching: r.active && r.source !== null,
    ...(r.detail ? { detail: r.detail } : {}),
  }));

  l.info(
    {
      active: runtimes.filter((r) => r.active).map((r) => r.name),
      watching: sources.map((s) => s.name),
    },
    'credentialed integrations loaded',
  );
  return { runtimes, sources, tools, status };
}
