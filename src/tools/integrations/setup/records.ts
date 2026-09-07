import { writeIntegrations, type Config } from '../../../core/config.js';
import type { DataHome } from '../../../core/datadir.js';
import type { IntegrationsYaml } from '../../../core/config-schemas.js';
import type { EventIntake } from '../../../ingress/intake.js';

/**
 * The activation record and the one door that writes it (§19.6, G.12).
 *
 * Its own module because two flows write records now — activation, and the
 * printer wizard adding a device (§34.6) — and the F.6 carve-out's promise is
 * that there is exactly *one* writer. A module both can import is that
 * promise made structural instead of remembered.
 */
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
