import type { ModelsYaml } from '../core/config-schemas.js';
import { UserFacingError } from '../core/errors.js';
import type { ModelCap, ModelSelector, ResolvedEndpoint } from './types.js';

export interface EmbeddingEndpoint {
  url: string;
  model: string;
  apiKey?: string;
}

/**
 * Class + capability routing (§10.2). Selection is first-match in config order:
 * predictable beats clever, and the user controls the order.
 */
export class ModelRouter {
  private readonly endpoints: ResolvedEndpoint[];
  private readonly embeddingCfg: EmbeddingEndpoint | null;

  constructor(models: ModelsYaml) {
    this.endpoints = models.endpoints.map((e) => {
      const ep: ResolvedEndpoint = {
        name: e.name,
        url: e.url.replace(/\/+$/, ''),
        model: e.model ?? 'default',
        classes: e.classes,
        caps: e.caps,
        concurrency: e.concurrency ?? 1,
      };
      if (e.api_key) ep.apiKey = e.api_key;
      if (e.context_size) ep.contextSize = e.context_size;
      if (e.efforts) ep.efforts = e.efforts;
      if (e.cost) {
        ep.cost = {
          inPerMtok: e.cost.in_per_mtok,
          outPerMtok: e.cost.out_per_mtok,
          currency: e.cost.currency,
        };
      }
      return ep;
    });
    const dupes = this.endpoints.map((e) => e.name).filter((n, i, all) => all.indexOf(n) !== i);
    if (dupes.length) {
      throw new UserFacingError(
        'config_invalid',
        `config/models.yaml: duplicate endpoint name(s): ${[...new Set(dupes)].join(', ')}`,
      );
    }
    this.embeddingCfg = models.embedding
      ? {
          url: models.embedding.url.replace(/\/+$/, ''),
          model: models.embedding.model ?? 'default',
          ...(models.embedding.api_key ? { apiKey: models.embedding.api_key } : {}),
        }
      : null;
  }

  list(): ResolvedEndpoint[] {
    return [...this.endpoints];
  }

  byName(name: string): ResolvedEndpoint | null {
    return this.endpoints.find((e) => e.name === name) ?? null;
  }

  embedding(): EmbeddingEndpoint | null {
    return this.embeddingCfg;
  }

  /** Resolve a selector, or explain precisely why nothing qualifies. */
  pick(sel: ModelSelector = {}): ResolvedEndpoint {
    if (sel.endpoint) {
      const ep = this.byName(sel.endpoint);
      if (!ep) {
        throw new UserFacingError(
          'no_endpoint',
          `no endpoint named "${sel.endpoint}" in models.yaml`,
          `known endpoints: ${this.endpoints.map((e) => e.name).join(', ') || '(none)'}`,
        );
      }
      return this.checkCaps(ep, sel.caps ?? []);
    }

    const wantClass = sel.class;
    const wantCaps = sel.caps ?? [];
    const byClass = wantClass
      ? this.endpoints.filter((e) => e.classes.includes(wantClass))
      : this.endpoints;
    const match = byClass.find((e) => wantCaps.every((c) => e.caps.includes(c)));
    if (match) return match;

    const detail = this.endpoints
      .map((e) => `${e.name}: classes=[${e.classes.join(',')}] caps=[${e.caps.join(',')}]`)
      .join('; ');
    throw new UserFacingError(
      'no_endpoint',
      `no endpoint satisfies class=${wantClass ?? 'any'} caps=[${wantCaps.join(',')}]`,
      detail ? `configured: ${detail}` : 'models.yaml has no endpoints — run setup first.',
    );
  }

  private checkCaps(ep: ResolvedEndpoint, caps: ModelCap[]): ResolvedEndpoint {
    const missing = caps.filter((c) => !ep.caps.includes(c));
    if (missing.length) {
      throw new UserFacingError(
        'no_endpoint',
        `endpoint "${ep.name}" lacks required capability: ${missing.join(', ')}`,
        `it declares caps=[${ep.caps.join(',')}]`,
      );
    }
    return ep;
  }
}
