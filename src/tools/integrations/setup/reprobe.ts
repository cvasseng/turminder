import { log } from '../../../core/logger.js';
import type { Config } from '../../../core/config.js';
import type { DataHome } from '../../../core/datadir.js';
import { tagFreshness } from '../../../core/config-schemas.js';
import { probeEndpoint } from '../../../model/probe.js';
import { readRaw, resolveRef, upsertByName, writeRaw } from './templates.js';

const l = log('tool:setup');

/**
 * Enough to re-measure and write one endpoint. Narrower than
 * `TemplateContext` on purpose: `turminder models probe` has no tool hub and
 * no running model stack, and the one implementation §10.2 asks for has to be
 * reachable from a CLI that boots nothing.
 */
export interface ReprobeDeps {
  home: DataHome;
  config: Config;
  /** Absent from the CLI, where there is no stack to rebuild. */
  reloadModels?: () => boolean;
  fetch?: typeof globalThis.fetch;
}

export type ReprobeResult =
  | {
      endpoint: string;
      model: string | null;
      caps: string[];
      context_size: number | null;
      probed_model: string | null;
      changed: boolean;
      committed: boolean;
      models_loaded: boolean;
      notes: string[];
    }
  | { error: string; message: string; detail?: string };

/** Same members, order ignored — `changed` must mean re-measured differently. */
function sameCaps(a: string[], b: string[]): boolean {
  return a.length === b.length && [...a].sort().join() === [...b].sort().join();
}

/**
 * Re-derive one endpoint's capability tags against the model it currently
 * names (§10.2), the shared half of `setup.reprobe` and
 * `turminder models probe <name>`.
 *
 * Exactly three fields move: `caps`, `context_size` and `probed_model`.
 * `classes`, `cost`, `api_key` and any route pointing here are decisions
 * somebody made, and re-measuring a capability is not re-making a decision —
 * so this reads the raw YAML (never `Config.models()`, whose `${secret:}`
 * references are expanded and would be written back as values, §27) and puts
 * the entry back with everything else untouched.
 */
export async function reprobeEndpoint(deps: ReprobeDeps, name: string): Promise<ReprobeResult> {
  const file = deps.home.path('config', 'models.yaml');
  const doc = readRaw(file);
  const endpoints = Array.isArray(doc.endpoints)
    ? (doc.endpoints as Record<string, unknown>[])
    : [];
  const entry = endpoints.find((e) => e?.name === name);
  if (!entry) {
    return {
      error: 'unknown_endpoint',
      message: `no endpoint named "${name}"; configured: ${
        endpoints.map((e) => String(e?.name)).join(', ') || 'none'
      }`,
    };
  }
  // The capability suite is a chat suite (§10.1): an embedding or speech
  // endpoint declares no caps at all, so there is nothing here to re-derive.
  const kind = String(entry.kind ?? 'chat');
  if (kind !== 'chat') {
    return {
      error: 'not_a_chat_endpoint',
      message: `${name} is a ${kind} endpoint — capability tags belong to chat endpoints (§10.1)`,
    };
  }

  const model = typeof entry.model === 'string' ? entry.model : undefined;
  const apiKey = resolveRef(deps.config, entry.api_key as string | undefined);
  const probe = await probeEndpoint(String(entry.url ?? ''), {
    ...(apiKey ? { apiKey } : {}),
    ...(model ? { model } : {}),
    ...(deps.fetch ? { fetch: deps.fetch } : {}),
    timeoutMs: 120_000,
  });
  if (!probe.reachable) {
    // Nothing written: tags measured a working endpoint once, and a network
    // that is down today is not evidence that the model lost a capability.
    return {
      error: 'unreachable',
      message: `${name} did not answer, so its tags were left alone`,
      ...(probe.error ? { detail: probe.error } : {}),
    };
  }

  const notes = [...probe.notes];
  const previousCaps = Array.isArray(entry.caps) ? (entry.caps as string[]) : [];
  const previousContext =
    typeof entry.context_size === 'number' ? entry.context_size : undefined;
  const previousProbed =
    typeof entry.probed_model === 'string' ? entry.probed_model : undefined;

  /**
   * A context size the probe could not read leaves the configured one alone.
   * Hosted providers report neither `/props` nor `meta.n_ctx`, and deleting a
   * figure somebody set by hand because this run could not see it would be
   * re-making their decision (§10.2) rather than re-measuring anything.
   */
  const contextSize = probe.context_size ?? previousContext;
  if (!probe.context_size && previousContext) {
    notes.push(
      `this endpoint reports no context length; keeping the configured ${previousContext}`,
    );
  }
  if (!probe.model_id) {
    notes.push('the endpoint did not name the model it served, so probed_model is unchanged');
  }
  const probedModel = probe.model_id ?? previousProbed;

  const changed =
    !sameCaps(previousCaps, probe.caps) ||
    contextSize !== previousContext ||
    probedModel !== previousProbed;

  let committed = false;
  let loaded = false;
  if (changed) {
    const next: Record<string, unknown> = {
      ...entry,
      caps: probe.caps,
      ...(contextSize ? { context_size: contextSize } : {}),
      ...(probedModel ? { probed_model: probedModel } : {}),
    };
    committed = writeRaw(
      deps.home,
      'config/models.yaml',
      {
        ...doc,
        endpoints: upsertByName(endpoints as { name: string }[], next as { name: string }),
      },
      `setup: re-probe ${name} against ${probedModel ?? 'its configured model'}`,
    );
    loaded = deps.reloadModels?.() ?? false;
  }
  l.info({ endpoint: name, caps: probe.caps, changed, committed }, 'endpoint re-probed');
  return {
    endpoint: name,
    model: model ?? null,
    caps: probe.caps,
    context_size: contextSize ?? null,
    probed_model: probedModel ?? null,
    changed,
    committed,
    models_loaded: loaded,
    notes,
  };
}

/** Endpoints whose tags no longer describe the model they name (§10.2). */
export function staleEndpoints(
  endpoints: { name: string; model?: string | undefined; probed_model?: string | undefined }[],
): { endpoint: string; model: string; probed_model: string }[] {
  return endpoints
    .filter((e) => tagFreshness(e) === 'stale')
    .map((e) => ({
      endpoint: e.name,
      model: e.model ?? '',
      probed_model: e.probed_model ?? '',
    }));
}
