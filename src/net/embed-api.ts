import type http from 'node:http';
import { log } from '../core/logger.js';
import { errMessage } from '../core/errors.js';
import {
  embedCsp,
  isSafeEmbedId,
  printCsp,
  renderEmbed,
  renderPrintDoc,
} from '../embeds/serve.js';
import { readVendorFile } from '../embeds/vendor.js';
import { EMBED_STATE_MAX_BYTES } from '../embeds/store.js';
import { TokenBuckets } from '../embeds/limits.js';
import { embedSecret, scopedToken, tokenMatches } from '../embeds/tokens.js';
import type { Service } from '../service.js';

const l = log('embeds');

/** App. A: 1/s sustained with burst 10 for events, 1/s for state writes. */
const EVENT_RATE = { ratePerS: 1, burst: 10 } as const;
const STATE_RATE = { ratePerS: 1, burst: 1 } as const;

/** Bodies are a pouch at most; anything larger is refused before parsing. */
const MAX_BODY = EMBED_STATE_MAX_BYTES + 1024;

/**
 * Refused on the way in rather than after buffering. Its own class because the
 * answer is 413 with the size code, not the 400 that a malformed body gets —
 * "your JSON is broken" would send an embed author looking in the wrong place.
 */
class BodyTooLarge extends Error {}

async function readText(req: http.IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY) throw new BodyTooLarge('request body too large');
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * The embed surface (§22.3–22.4): one route that serves an embed and three that
 * are the entire outward capability of one. Deliberately separate from the
 * `/api/*` routes, because these are reached with a per-embed scoped token and
 * must never accept a device token — an embed that could authenticate as the
 * device would own the system.
 */
export class EmbedRoutes {
  private readonly events = new TokenBuckets(EVENT_RATE);
  private readonly stateWrites = new TokenBuckets(STATE_RATE);

  constructor(private readonly service: Service) {}

  /** Does this path belong to us? Keeps the main router a flat switch. */
  static owns(pathname: string): boolean {
    return (
      pathname === '/embed' ||
      pathname.startsWith('/embed/') ||
      pathname === '/embed-api' ||
      pathname.startsWith('/embed-api/') ||
      pathname.startsWith('/embed-vendor/') ||
      pathname.startsWith('/embed-print/')
    );
  }

  async handle(req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<void> {
    const parts = url.pathname.split('/').filter(Boolean);
    // `/embed/<id>`, `/embed-api/<id>/<verb>`, `/embed-vendor/<lib>/<file>`,
    // `/embed-print/<id>`.
    const root = parts[0];

    if (root === 'embed-vendor') {
      if (req.method !== 'GET') return this.fail(res, 405, 'method_not_allowed');
      return this.vendor(res, parts.slice(1).join('/'));
    }

    const id = parts[1] ?? '';
    if (!id || !isSafeEmbedId(id)) return this.fail(res, 404, 'not_found');

    if (root === 'embed-print') {
      if (req.method !== 'GET') return this.fail(res, 405, 'method_not_allowed');
      return this.servePrintDoc(req, res, url, id);
    }

    if (root === 'embed') {
      if (req.method !== 'GET') return this.fail(res, 405, 'method_not_allowed');
      return await this.serve(req, res, url, id);
    }

    // Opaque origins make an Origin check meaningless here; the scoped token is
    // the auth, and `ACAO: *` is what lets the sandboxed page talk at all
    // (§22.3.3). Only ever on these routes.
    res.setHeader('access-control-allow-origin', '*');
    if (req.method === 'OPTIONS') {
      res.setHeader('access-control-allow-methods', 'GET, POST, PUT, OPTIONS');
      res.setHeader('access-control-allow-headers', 'content-type');
      res.setHeader('access-control-max-age', '600');
      res.writeHead(204);
      return void res.end();
    }

    const verb = parts[2] ?? '';
    const authed = this.authorise(id, url);
    if (!authed.ok) return this.fail(res, authed.status, authed.error);

    if (verb === 'event' && req.method === 'POST') return this.event(req, res, id);
    if (verb === 'state' && req.method === 'GET') return this.readState(res, id);
    if (verb === 'state' && req.method === 'PUT') return this.writeState(req, res, id);
    return this.fail(res, 404, 'not_found');
  }

  /**
   * Constant-time comparison against the token this embed's current generation
   * would produce (§22.3.4). A rotated generation makes every outstanding link
   * fail here without touching anything else.
   */
  private authorise(
    id: string,
    url: URL,
  ): { ok: true } | { ok: false; status: number; error: string } {
    const row = this.service.embeds.repo.get(id);
    if (!row) return { ok: false, status: 404, error: 'not_found' };
    const given = url.searchParams.get('t') ?? '';
    const secret = embedSecret(this.service.app.home, this.service.app.config);
    if (!given || !tokenMatches(scopedToken(secret, id, row.token_generation), given)) {
      return { ok: false, status: 403, error: 'forbidden' };
    }
    return { ok: true };
  }

  private async serve(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    url: URL,
    id: string,
  ): Promise<void> {
    const authed = this.authorise(id, url);
    if (!authed.ok) return this.fail(res, authed.status, authed.error);
    const row = this.service.embeds.repo.get(id)!;
    const html = this.service.embeds.html(row);
    if (html === null) return this.fail(res, 404, 'not_found');
    const token = url.searchParams.get('t')!;
    // `on_serve` bindings re-execute here, TTL-gated, before a byte goes out
    // (§23.2). A failing upstream leaves the previous value in place marked
    // stale — the page still serves, which is the point.
    await this.service.binder.refresh(id, { staleOnly: true });
    // Every serve counts as use, from any conversation (§22.1) — this is what
    // keeps a dashboard someone opens weekly out of the reaper's way.
    this.service.embeds.repo.markServed(id);
    const origin = this.origin(req);
    res.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'content-security-policy': embedCsp(origin, id),
      // The page is per-embed and per-generation; a stale copy would outlive a
      // rotation, which is the one thing rotation exists to prevent.
      'cache-control': 'no-store',
      'referrer-policy': 'no-referrer',
      'x-content-type-options': 'nosniff',
    });
    res.end(renderEmbed(html, id, token, this.service.binder.values(id)));
  }

  /**
   * The pinned client libs (§23.3). Unauthenticated on purpose: these are npm
   * packages, byte for byte, and an embed running in an opaque origin has no
   * token to present. The allowlist in `embeds/vendor.ts` is the containment —
   * nothing else under node_modules is nameable here.
   */
  private vendor(res: http.ServerResponse, name: string): void {
    const file = readVendorFile(name);
    if (!file) return this.fail(res, 404, 'not_found');
    res.writeHead(200, {
      'content-type': file.contentType,
      // Pinned by package version, so caching is safe and the print pipeline
      // does not re-fetch reveal.js for every page of a deck.
      'cache-control': 'public, max-age=3600',
      'x-content-type-options': 'nosniff',
    });
    res.end(file.body);
  }

  /**
   * A document that exists only to be printed (§23.4): a markdown or HTML file
   * from the store, rendered with the shipped theme so an export looks like
   * every other artifact. It is not an embed — no row, no state, no runtime —
   * and it is gone as soon as the print finishes.
   */
  private servePrintDoc(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    url: URL,
    id: string,
  ): void {
    const html = this.service.transient.get(id, url.searchParams.get('t') ?? '');
    if (html === null) return this.fail(res, 404, 'not_found');
    res.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'content-security-policy': printCsp(this.origin(req)),
      'cache-control': 'no-store',
      'referrer-policy': 'no-referrer',
      'x-content-type-options': 'nosniff',
    });
    res.end(renderPrintDoc(html));
  }

  /** The origin the requester used, so CSP path prefixes match what it typed. */
  private origin(req: http.IncomingMessage): string {
    const bind = this.service.app.config.settings.bind;
    return `http://${req.headers.host ?? `${bind.host}:${bind.port}`}`;
  }

  /**
   * `turminder.event()` (§22.4). The event is fenced untrusted downstream: the
   * JS that produced it is LLM-authored and may be relaying anything a user
   * typed into the page. Nothing acts on it except a handler the user bound.
   */
  private async event(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    id: string,
  ): Promise<void> {
    if (!this.events.take(id)) return this.limited(res);
    let body: Record<string, unknown>;
    try {
      body = parseJsonObject(await readText(req));
    } catch (e) {
      if (e instanceof BodyTooLarge) {
        return this.json(res, 413, { accepted: false, error: 'body_too_large' });
      }
      l.debug({ embed: id, err: errMessage(e) }, 'unparsable embed event');
      return this.json(res, 400, { accepted: false, error: 'bad_body' });
    }
    const action = typeof body.action === 'string' ? body.action.trim() : '';
    if (!action) return this.json(res, 400, { accepted: false, error: 'action_required' });

    const row = this.service.embeds.repo.get(id);
    // Provenance (§22.4): the run that authored the embed is the parent, so a
    // click inherits the lineage — and the depth limit — of the conversation
    // that built the thing being clicked.
    const creatingRun = row?.created_by_run
      ? this.service.repos.runs.get(row.created_by_run)
      : null;
    const result = this.service.intake.submit({
      type: 'embed.action',
      source: `embed.${id}`,
      payload: {
        embed_id: id,
        action,
        ...(body.data !== undefined ? { data: body.data } : {}),
      },
      serialization_key: id,
      caused_by: creatingRun?.event_id ?? null,
    });
    if (result.status === 'rejected') {
      l.warn({ embed: id, reason: result.reason }, 'embed event rejected');
      return this.json(res, 202, { accepted: false, error: result.reason });
    }
    return this.json(res, 200, { accepted: true });
  }

  private readState(res: http.ServerResponse, id: string): void {
    this.json(res, 200, { state: this.service.embeds.repo.state(id) });
  }

  private async writeState(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    id: string,
  ): Promise<void> {
    if (!this.stateWrites.take(id)) return this.limited(res);
    let body: Record<string, unknown>;
    try {
      body = parseJsonObject(await readText(req));
    } catch (e) {
      if (e instanceof BodyTooLarge) {
        return this.json(res, 413, { accepted: false, error: 'state_too_large' });
      }
      l.debug({ embed: id, err: errMessage(e) }, 'unparsable embed state');
      return this.json(res, 400, { accepted: false, error: 'bad_body' });
    }
    const written = this.service.embeds.writeState(id, body);
    if ('error' in written) {
      return this.json(res, 413, { accepted: false, error: written.error });
    }
    return this.json(res, 200, { accepted: true, bytes: written.bytes });
  }

  private limited(res: http.ServerResponse): void {
    // A looping embed meets this before it meets MAX_DEPTH (§22.4).
    res.setHeader('retry-after', '1');
    this.json(res, 429, { accepted: false, error: 'rate_limited' });
  }

  private json(res: http.ServerResponse, status: number, body: unknown): void {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(body));
  }

  private fail(res: http.ServerResponse, status: number, error: string): void {
    this.json(res, status, { error });
  }
}

function parseJsonObject(text: string): Record<string, unknown> {
  const parsed = text.trim() ? (JSON.parse(text) as unknown) : {};
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('expected a JSON object');
  }
  return parsed as Record<string, unknown>;
}
