import type { ModelClass, ModelsYaml, Route, Routes } from '../core/config-schemas.js';
import { UserFacingError } from '../core/errors.js';
import { DEFAULT_ROUTES, type RoutablePurpose } from './routes.js';
import type { ModelCap, ModelSelector, ResolvedEndpoint } from './types.js';

/**
 * Class + capability + route resolution (§10.2, §10.6). `resolve()` is the
 * one door: override beats frontmatter pin beats configured route beats the
 * kind-default table, and within whatever class that lands on, capability
 * filter then config order — first match wins, deterministically. Listing
 * order is priority order; the user controls it by editing models.yaml.
 */
export class ModelRouter {
  private readonly endpoints: ResolvedEndpoint[];
  private readonly routes: Routes;

  constructor(models: ModelsYaml) {
    this.endpoints = models.endpoints.map((e) => {
      const ep: ResolvedEndpoint = {
        name: e.name,
        url: e.url.replace(/\/+$/, ''),
        model: e.model ?? 'default',
        kind: e.kind,
        // `classes` is optional in the schema for `kind: embedding` endpoints,
        // which never route by class; the schema's own superRefine makes an
        // empty `classes` on a `chat` endpoint unreachable.
        classes: e.classes ?? [],
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
    this.routes = models.routes ?? {};
  }

  list(): ResolvedEndpoint[] {
    return [...this.endpoints];
  }

  /** Chat endpoints only, config order — what a chat surface may ever see
   *  or pick (§10.6): `models.list`, `conversation.model`, a handler's
   *  `endpoint:` pin. */
  chatEndpoints(): ResolvedEndpoint[] {
    return this.endpoints.filter((e) => e.kind === 'chat');
  }

  byName(name: string, kind?: 'chat' | 'embedding'): ResolvedEndpoint | null {
    const ep = this.endpoints.find((e) => e.name === name);
    if (!ep) return null;
    if (kind && ep.kind !== kind) return null;
    return ep;
  }

  /**
   * The `embedding` purpose's target (§8.3, §10.6): `routes.embedding` if
   * configured, else the first `kind: embedding` endpoint, else null — an
   * install with no embedding endpoint runs lexical search, which is not an
   * error. Unlike `resolve()`, this **never throws**: the RAG layer degrades,
   * it does not fail a call.
   */
  embedding(): ResolvedEndpoint | null {
    const named = this.routes.embedding?.endpoint;
    if (named) return this.byName(named, 'embedding');
    return this.endpoints.find((e) => e.kind === 'embedding') ?? null;
  }

  /**
   * Resolve a selector to the endpoint that serves it, and why (§10.6,
   * normative order):
   *
   * 1. `pin.by === 'override'` — the conversation's model override, wins
   *    absolutely.
   * 2. `pin.by === 'frontmatter'` — a handler's exact endpoint or class pin.
   * 3. `purpose === 'probe'` — the endpoint being probed; never a route.
   * 4. `routes[purpose]`, if configured.
   * 5. `DEFAULT_ROUTES[purpose]`, the kind-default table.
   *
   * Within a class (steps 2b/4/5): capability filter, then config order,
   * first match wins — the `pick()` behaviour this replaces, unchanged.
   */
  resolve(sel: ModelSelector): {
    endpoint: ResolvedEndpoint;
    resolved_by: 'override' | 'frontmatter' | 'route' | 'kind_default';
    requested_class?: ModelClass;
  } {
    const wantCaps = sel.caps ?? [];

    if (sel.pin?.by === 'override') {
      const ep = this.checkCaps(this.mustByName(sel.pin.endpoint, 'chat'), wantCaps);
      return { endpoint: ep, resolved_by: 'override' };
    }

    if (sel.pin?.by === 'frontmatter') {
      if (sel.pin.endpoint) {
        const ep = this.checkCaps(this.mustByName(sel.pin.endpoint, 'chat'), wantCaps);
        return { endpoint: ep, resolved_by: 'frontmatter' };
      }
      if (sel.pin.class) {
        const ep = this.matchClass(sel.pin.class, wantCaps);
        return { endpoint: ep, resolved_by: 'frontmatter', requested_class: sel.pin.class };
      }
      // A frontmatter pin naming neither falls through to the route/default,
      // same as no pin at all — G.7's "absent means the handler route".
    }

    if (sel.purpose === 'probe') {
      const ep = this.endpoints[0];
      if (!ep) throw this.noEndpointsError();
      return { endpoint: this.checkCaps(ep, wantCaps), resolved_by: 'kind_default' };
    }

    const route = this.routes[sel.purpose];
    if (route) return { ...this.applyRoute(route, wantCaps), resolved_by: 'route' };

    const fallback = DEFAULT_ROUTES[sel.purpose];
    if (!fallback) {
      throw new UserFacingError(
        'no_endpoint',
        `purpose "${sel.purpose}" has no configured route and no kind-default (§10.6)`,
        'set config/models.yaml routes.' + sel.purpose,
      );
    }
    return { ...this.applyRoute(fallback, wantCaps), resolved_by: 'kind_default' };
  }

  private applyRoute(
    route: Route,
    caps: ModelCap[],
  ): { endpoint: ResolvedEndpoint; requested_class?: ModelClass } {
    if ('endpoint' in route) {
      return { endpoint: this.checkCaps(this.mustByName(route.endpoint, 'chat'), caps) };
    }
    return { endpoint: this.matchClass(route.class, caps), requested_class: route.class };
  }

  private matchClass(wantClass: ModelClass, caps: ModelCap[]): ResolvedEndpoint {
    const byClass = this.chatEndpoints().filter((e) => e.classes.includes(wantClass));
    const match = byClass.find((e) => caps.every((c) => e.caps.includes(c)));
    if (match) return match;
    throw new UserFacingError(
      'no_endpoint',
      `no endpoint satisfies class=${wantClass} caps=[${caps.join(',')}]`,
      this.configuredDetail(),
    );
  }

  private mustByName(name: string, kind: 'chat' | 'embedding'): ResolvedEndpoint {
    const ep = this.byName(name, kind);
    if (!ep) {
      throw new UserFacingError(
        'no_endpoint',
        `no ${kind} endpoint named "${name}" in models.yaml`,
        `known endpoints: ${this.endpoints.map((e) => e.name).join(', ') || '(none)'}`,
      );
    }
    return ep;
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

  private configuredDetail(): string {
    const detail = this.endpoints
      .map((e) => `${e.name}: classes=[${e.classes.join(',')}] caps=[${e.caps.join(',')}]`)
      .join('; ');
    return detail || 'models.yaml has no endpoints — run setup first.';
  }

  private noEndpointsError(): UserFacingError {
    return new UserFacingError(
      'no_endpoint',
      'no endpoints configured',
      'models.yaml has no endpoints — run setup first.',
    );
  }
}

export type { RoutablePurpose };
