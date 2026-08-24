import fs from 'node:fs';
import YAML from 'yaml';
import { z } from 'zod';
import { log } from '../core/logger.js';
import { errMessage } from '../core/errors.js';
import { ModelEndpointSchema } from '../core/config-schemas.js';
import { modelApiKeyName } from '../core/config.js';
import { normaliseEndpointUrl, probeEndpoint } from '../model/probe.js';
import type { Service } from '../service.js';

const l = log('setup');

export const ProbeRequest = z.object({
  url: z.string().min(1),
  api_key: z.string().optional(),
});

export const CommitRequest = z.object({
  endpoints: z.array(ModelEndpointSchema).min(1),
  /**
   * Where embeddings come from. Optional on purpose (§28.5): without one,
   * semantic search degrades to lexical and nothing breaks — a hosted
   * provider that charges per embedding is a reason to say no.
   */
  embedding_url: z.string().optional(),
  /** `false` when the user declined an embedding endpoint outright. */
  embedding: z.boolean().optional(),
});

export interface SetupStatus {
  configured: boolean;
  onboarded: boolean;
  instance_name: string | null;
  endpoints: string[];
}

export function setupStatus(service: Service): SetupStatus {
  const identity = service.app.config.identity();
  return {
    configured: service.configured,
    onboarded: identity !== null,
    instance_name: identity?.frontmatter.instance_name ?? null,
    endpoints: service.modelStack?.router.list().map((e) => e.name) ?? [],
  };
}

/** POST /api/setup/probe — reachability, identity and capability probes (§10.2). */
export async function handleProbe(body: unknown): Promise<unknown> {
  const req = ProbeRequest.parse(body);
  const result = await probeEndpoint(req.url, {
    ...(req.api_key ? { apiKey: req.api_key } : {}),
    timeoutMs: 90_000,
  });
  return result;
}

/**
 * POST /api/setup/commit — writes config/models.yaml, commits it, and brings
 * the model stack up in the running process (plan §3b).
 */
export function handleCommit(
  service: Service,
  body: unknown,
): { ok: true; endpoints: string[]; ui_token?: string } {
  const req = CommitRequest.parse(body);
  const home = service.app.home;
  const file = home.path('config', 'models.yaml');

  /**
   * An API key is a credential, so it goes to the secret store and the config
   * gets a reference (§19.2, §27) — the hosted golden path of §28.5 must not
   * be the one place a key sits in a config file in the clear.
   */
  const endpoints = req.endpoints.map((e) => {
    let apiKey = e.api_key;
    if (apiKey && !apiKey.startsWith('${secret:')) {
      const key = modelApiKeyName(e.name);
      const stored = service.app.config.secretStore.set(key, apiKey);
      if ('error' in stored) throw new Error(stored.message);
      service.app.config.reload();
      apiKey = `\${secret:${key}}`;
    }
    return {
      name: e.name,
      url: e.url,
      ...(e.model ? { model: e.model } : {}),
      ...(apiKey ? { api_key: apiKey } : {}),
      classes: e.classes,
      caps: e.caps,
      ...(e.context_size ? { context_size: e.context_size } : {}),
    };
  });
  const doc: Record<string, unknown> = { endpoints };
  // Declining is a real answer (§28.5): only guess an embedding URL when the
  // user did not say no, and never point a hosted endpoint at one implicitly.
  const embeddingUrl =
    req.embedding === false
      ? null
      : (req.embedding_url ??
        (req.endpoints[0] ? normaliseEndpointUrl(req.endpoints[0].url).root : null));
  if (embeddingUrl) doc.embedding = { url: embeddingUrl };

  fs.writeFileSync(file, YAML.stringify(doc), 'utf8');
  home.git.commit('initial model config', ['config/models.yaml']);
  const ok = service.loadModels();
  if (!ok) {
    throw new Error('models.yaml was written but could not be loaded — check the service log');
  }
  l.info({ endpoints: req.endpoints.map((e) => e.name) }, 'model config committed');

  // First-run convenience: hand the page the ui token so it can open /ws
  // without the operator copying it out of the terminal. Only while the
  // instance has no identity yet — after that, setup requires a token anyway.
  // The value comes from the scaffold's in-memory carrier, not from disk:
  // channels.yaml holds only the hash (§24), so a service that did not create
  // the data dir this boot has nothing to hand over and says so by omission.
  // Models exist now, so onboarding can actually run — ask for the greeting
  // (§3c) before the page redirects, so the conversation is already there with
  // something in it when the chat UI loads.
  if (service.chat.requestOnboarding()) {
    l.info('onboarding greeting requested');
  }

  const uiToken = service.app.newUiToken;
  return {
    ok: true,
    endpoints: req.endpoints.map((e) => e.name),
    ...(uiToken ? { ui_token: uiToken } : {}),
  };
}

export function setupErrorBody(e: unknown): { error: string } {
  return { error: errMessage(e) };
}
