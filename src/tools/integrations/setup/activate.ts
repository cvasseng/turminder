import { log } from '../../../core/logger.js';
import { errMessage } from '../../../core/errors.js';
import { writeIntegrations, type Config } from '../../../core/config.js';
import type { DataHome } from '../../../core/datadir.js';
import type { IntegrationsYaml } from '../../../core/config-schemas.js';
import { nowIso } from '../../../core/time.js';
import type { EventIntake } from '../../../ingress/intake.js';
import type { FormValues } from '../../../chat/forms.js';
import { AsanaClient } from '../asana/client.js';
import {
  loadGoogleCredentials,
  startGoogleAuthorization,
  CALENDAR_SCOPES,
  GoogleTokenStore,
} from '../google/auth.js';
import type { IntegrationManifest } from '../registry.js';
import { resolveRef } from './templates.js';

const l = log('tool:setup');

export interface ActivationContext {
  home: DataHome;
  config: Config;
  intake: EventIntake;
  /**
   * Rebuilds the source stack and the tool hub from the activation records —
   * how tools appear and pollers start without a restart (§19.5).
   */
  reloadIntegrations: () => Promise<string[]>;
  fetch?: typeof globalThis.fetch;
}

export interface ActivationSubmission {
  values: FormValues;
  secrets: Record<string, string>;
}

export type ActivationOutcome = Record<string, unknown>;

/** Non-secret form values become the activation record's settings (G.12). */
function settingsFrom(values: FormValues): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(values)) {
    if (key === 'name') continue;
    out[key] = value;
  }
  return out;
}

export function recordFor(
  config: Config,
  name: string,
): IntegrationsYaml['integrations'][string] | undefined {
  return config.integrations().integrations[name];
}

/** Write one activation record, leaving the others alone. */
export function writeRecord(
  ctx: ActivationContext,
  name: string,
  record: { active: boolean; activated_at?: string; settings?: Record<string, unknown> } | null,
  message: string,
): void {
  const doc = ctx.config.integrations();
  const integrations = { ...doc.integrations };
  if (record === null) delete integrations[name];
  else {
    integrations[name] = {
      active: record.active,
      ...(record.activated_at ? { activated_at: record.activated_at } : {}),
      settings: record.settings ?? {},
    };
  }
  writeIntegrations(ctx.home, { integrations }, message);
  ctx.config.reload();
}

/**
 * Asana (`activation: form`, §19.5). One live probe validates the token before
 * anything is written: an activation record for a credential that does not work
 * is worse than no record, because the poller then fails every three minutes.
 */
async function activateAsana(
  submission: ActivationSubmission,
  ctx: ActivationContext,
): Promise<ActivationOutcome> {
  const pat = resolveRef(ctx.config, submission.secrets.pat);
  if (!pat) {
    return { activated: false, error: 'no_credential', message: 'no token was submitted' };
  }
  const client = new AsanaClient({ pat, ...(ctx.fetch ? { fetch: ctx.fetch } : {}) });
  const check = await client.check();
  if (!check.ok) {
    return {
      activated: false,
      error: 'credential_rejected',
      message: check.error ?? 'Asana rejected the token',
    };
  }

  writeRecord(
    ctx,
    'asana',
    { active: true, activated_at: nowIso(), settings: settingsFrom(submission.values) },
    'setup: activate asana',
  );
  const tools = await ctx.reloadIntegrations();
  l.info({ user: check.user }, 'asana activated');
  return {
    activated: true,
    account: check.user ?? null,
    tools: tools.filter((t) => t.startsWith('asana.')),
  };
}

/**
 * Google Calendar (`activation: oauth`, §19.5). The form collects the client
 * credentials — or nothing, when one is bundled — and the effect starts the
 * loopback flow and hands back the URL. The run does **not** stay suspended
 * across the browser round-trip: the callback finishes activation later and
 * emits `system.integration_activated`, which a shipped handler turns into a
 * notification.
 */
async function activateGoogleCalendar(
  submission: ActivationSubmission,
  ctx: ActivationContext,
): Promise<ActivationOutcome> {
  // The id is not itself a secret, but `loadGoogleCredentials` looks for it in
  // secrets.yaml next to the matching secret, which is where the form already
  // put that half of the pair. One place to look beats two.
  const clientId = String(submission.values.client_id ?? '').trim();
  if (clientId) {
    ctx.config.secretStore.merge({ GOOGLE_CLIENT_ID: clientId });
    ctx.config.reload();
  }

  let credentials;
  try {
    credentials = loadGoogleCredentials(ctx.home, ctx.config.secrets);
  } catch (e) {
    return {
      activated: false,
      error: 'no_oauth_client',
      message: errMessage(e),
    };
  }

  let pending;
  try {
    pending = await startGoogleAuthorization({
      credentials,
      scopes: CALENDAR_SCOPES,
      ...(ctx.fetch ? { fetch: ctx.fetch } : {}),
    });
  } catch (e) {
    return { activated: false, error: 'auth_start_failed', message: errMessage(e) };
  }

  // Deliberately not awaited: this resolves when the user finishes consenting,
  // which may be minutes after the run that asked for it has ended.
  void pending.completed.then(
    async (token) => {
      try {
        new GoogleTokenStore(ctx.config).save(token);
        writeRecord(
          ctx,
          'google-calendar',
          {
            active: true,
            activated_at: nowIso(),
            settings: {
              ...(recordFor(ctx.config, 'google-calendar')?.settings ?? {}),
              ...settingsFrom(submission.values),
            },
          },
          'setup: activate google calendar',
        );
        const tools = await ctx.reloadIntegrations();
        const calendarTools = tools.filter((t) => t.startsWith('calendar.'));
        ctx.intake.submit({
          type: 'system.integration_activated',
          source: 'system',
          payload: { integration: 'google-calendar', tools: calendarTools },
          idempotency_key: `google-calendar:${token.obtained_at}`,
        });
        l.info({ tools: calendarTools }, 'google calendar activated');
      } catch (e) {
        l.error({ err: errMessage(e) }, 'finishing google calendar activation failed');
      }
    },
    (e) => l.warn({ err: errMessage(e) }, 'google calendar authorisation did not complete'),
  );

  return {
    pending: true,
    auth_url: pending.authUrl,
    oauth_client: credentials.source,
    message:
      'Give the user this link to approve access. Activation finishes on its own when they do — you will not be told here.',
  };
}

const EFFECTS: Record<
  string,
  (submission: ActivationSubmission, ctx: ActivationContext) => Promise<ActivationOutcome>
> = {
  asana: activateAsana,
  'google-calendar': activateGoogleCalendar,
};

export async function runActivation(
  manifest: IntegrationManifest,
  submission: ActivationSubmission,
  ctx: ActivationContext,
): Promise<ActivationOutcome> {
  const effect = EFFECTS[manifest.name];
  if (!effect) {
    return {
      activated: false,
      error: 'not_activatable',
      message: `${manifest.name} has no activation effect in this build`,
    };
  }
  return effect(submission, ctx);
}

/**
 * Deactivation (§19.5): pollers stop, the record goes, the tools disappear —
 * and the secret stays, deliberately, so switching it back on is one form
 * confirm rather than a hunt for the token.
 */
export async function runDeactivation(
  manifest: IntegrationManifest,
  ctx: ActivationContext,
): Promise<ActivationOutcome> {
  const existing = recordFor(ctx.config, manifest.name);
  if (!existing) {
    return { integration: manifest.name, deactivated: false, error: 'not_active' };
  }
  writeRecord(ctx, manifest.name, null, `setup: deactivate ${manifest.name}`);
  await ctx.reloadIntegrations();
  l.info({ integration: manifest.name }, 'integration deactivated');
  return {
    integration: manifest.name,
    deactivated: true,
    secrets_retained: true,
    message: 'Its tools and poller are gone; the credential is kept for reactivation.',
  };
}
