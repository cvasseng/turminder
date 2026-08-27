import fs from 'node:fs';
import http from 'node:http';
import { z } from 'zod';
import { log } from '../core/logger.js';
import { errMessage } from '../core/errors.js';
import { dbVersion } from '../db/index.js';
import { LAYOUT_VERSION } from '../core/datadir.js';
import type { Service } from '../service.js';
import { readUiFile } from './static.js';
import { handleCommit, handleProbe, setupErrorBody, setupStatus } from './setup-api.js';
import { EmbedRoutes } from './embed-api.js';
import { mimeForPath } from '../files/store.js';
import { PageCapturedPayload } from '../core/config-schemas.js';
import { PathRejected } from '../tools/paths.js';
import { WsGateway } from './ws.js';

const l = log('http');

const MAX_BODY = 1_000_000;

/** The claim poll's body (§24.4, App. E) — the ticket and nothing else. */
const PairClaimRequest = z.strictObject({ ticket: z.string().min(1).max(256) });

/**
 * What may accompany a pairing request (§24.4, App. E): what kind of thing is
 * asking, from a closed set, because it picks the name the approval dialog
 * offers and an unauthenticated caller writes none of that text itself.
 */
const PairStartRequest = z.strictObject({
  kind: z.enum(['phone', 'browser', 'desktop']).optional(),
});

/**
 * The two routes the §29 browser extension calls from its moz-extension://
 * origin. Firefox subjects an extension fetch to CORS whenever no *granted*
 * host pattern matches it, and a preflight nobody answers kills the request
 * before it is sent (App. E) — so these two answers are what keeps proving a
 * token and sending a capture working with the grant missing or handed back.
 * A grant that does match exempts the fetch outright, which is why `/api/pair/*`
 * needs nothing here and gets nothing. `*` because extension origins are
 * per-install UUIDs; it concedes nothing — bearer auth still decides
 * everything, CORS only lets the browser ask.
 */
const EXTENSION_CORS_PATHS = new Set(['/api/whoami', '/api/events']);

/** Raw bytes, refused past `limit` rather than buffered and then rejected. */
async function readBytes(req: http.IncomingMessage, limit: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > limit) throw new Error('too large');
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

async function readBody(req: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY) throw new Error('request body too large');
    chunks.push(chunk as Buffer);
  }
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

/**
 * Validate a payload against its declared shape where one exists (App. B).
 * Only `page.captured` declares caps today (§29.3); everything else passes
 * through untouched, because the generic ingress is deliberately generic.
 */
function checkPayload(
  type: string,
  payload: unknown,
): { payload: unknown } | { error: 'too_large'; message: string } {
  if (type !== 'page.captured') return { payload };
  const parsed = PageCapturedPayload.safeParse(payload);
  if (parsed.success) return { payload: parsed.data };
  const tooBig = parsed.error.issues.find((i) => i.code === 'too_big');
  return {
    error: 'too_large',
    message: tooBig
      ? `${tooBig.path.join('.') || 'payload'} is over the capture limit`
      : parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
  };
}

/**
 * The image and document types a browser may render for us (§18.5). Exported
 * because `ui/preview.js` decides which element to use from the same list, and
 * a test asserts the two agree — a type served inline that the panel cannot
 * render (or the reverse) is a preview that silently does nothing.
 */
export const INLINE_RENDERABLE = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'application/pdf',
]);

/**
 * What `Content-Type` a store file is served as (App. E).
 *
 * Not always its own: **HTML is never served as HTML**, and SVG is served
 * under a no-script CSP. A file in the store may have been written by the
 * assistant, and this route answers on the UI's origin — the origin holding
 * the device token. Assistant-authored pages have a way to run in a browser,
 * and it is the §22.3 embed sandbox, never here. Everything unrenderable is
 * `text/plain`, which previews honestly and executes nothing.
 */
function servedType(rel: string): Record<string, string> {
  const mime = mimeForPath(rel);
  if (mime === 'image/svg+xml') {
    return {
      'content-type': mime,
      // An SVG is a document, and a document can carry script. This turns it
      // back into a picture.
      'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'",
    };
  }
  if (INLINE_RENDERABLE.has(mime)) return { 'content-type': mime };
  return { 'content-type': 'text/plain; charset=utf-8' };
}

/**
 * One HTTP server (App. E): the UI, health, the setup API, event injection, and
 * the WS upgrade. Binds to localhost by default; cross-machine security is the
 * network layer's job (§7.3).
 */
export class HttpServer {
  private readonly server: http.Server;
  readonly ws: WsGateway;
  private readonly embeds: EmbedRoutes;

  constructor(private readonly service: Service) {
    this.embeds = new EmbedRoutes(service);
    this.server = http.createServer((req, res) => void this.handle(req, res));
    this.ws = new WsGateway(service);
    this.ws.attach(this.server);
  }

  async listen(): Promise<{ host: string; port: number }> {
    const { host, port } = this.service.app.config.settings.bind;
    await new Promise<void>((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(port, host, () => {
        this.server.removeListener('error', reject);
        resolve();
      });
    });
    const addr = this.server.address();
    const actual = typeof addr === 'object' && addr ? addr.port : port;
    // The PDF pipeline prints a served URL (§23.4), so the service has to know
    // the address it really got — a configured port of 0 is a real case.
    this.service.setListening(host, actual);
    l.info({ host, port: actual }, 'http server listening');
    return { host, port: actual };
  }

  async close(): Promise<void> {
    await this.ws.close();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  /** Bearer auth against config/channels.yaml (App. E), hash-compared (§24). */
  private authorised(req: http.IncomingMessage): boolean {
    return this.deviceFor(req) !== null;
  }

  /** Which device this request authenticated as — `/api/whoami`, and the
   *  server-side `source` stamp on injected events (App. E, §29.3). */
  private deviceFor(req: http.IncomingMessage): string | null {
    const header = req.headers.authorization ?? '';
    const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
    if (!token) return null;
    return this.service.app.tokens.authenticate(token);
  }

  private json(res: http.ServerResponse, status: number, body: unknown): void {
    const text = JSON.stringify(body);
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
    res.end(text);
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    const route = `${req.method} ${url.pathname}`;
    try {
      // Before the switch: these paths carry an id, and they are the one family
      // of routes that must never see a device token (§22.3.2).
      if (EmbedRoutes.owns(url.pathname)) return await this.embeds.handle(req, res, url);
      if (EXTENSION_CORS_PATHS.has(url.pathname)) {
        res.setHeader('access-control-allow-origin', '*');
        if (req.method === 'OPTIONS') {
          res.writeHead(204, {
            'access-control-allow-methods': 'GET, POST, OPTIONS',
            'access-control-allow-headers': 'authorization, content-type',
            'access-control-max-age': '600',
          });
          return void res.end();
        }
      }
      switch (route) {
        case 'GET /healthz':
          return this.json(res, 200, {
            status: 'ok',
            db_version: dbVersion(this.service.app.db),
            layout_version: LAYOUT_VERSION,
            // Whether any device holds a token (§24). The chat UI's gate has to
            // choose what to tell someone *before* it has a credential to ask
            // with: an install with devices sends them to the assistant for a
            // QR, one without has nobody to ask and gets the CLI. A boolean is
            // the whole answer — never how many, never which.
            linked: this.service.app.tokens.list().length > 0,
          });

        case 'GET /':
        case 'GET /index.html': {
          // The setup page stands in for the chat UI until models exist (App. E).
          const page = this.service.configured ? 'index.html' : 'setup.html';
          const file = readUiFile(page);
          if (!file) return this.json(res, 500, { error: `missing ui asset: ${page}` });
          res.writeHead(200, { 'content-type': file.contentType });
          return void res.end(file.body);
        }

        case 'GET /api/setup/status':
          return this.json(res, 200, setupStatus(this.service));

        case 'POST /api/setup/probe': {
          if (this.service.configured && !this.authorised(req)) {
            return this.json(res, 401, { error: 'unauthorized' });
          }
          try {
            return this.json(res, 200, await handleProbe(await readBody(req)));
          } catch (e) {
            return this.json(res, 400, setupErrorBody(e));
          }
        }

        case 'POST /api/setup/commit': {
          if (this.service.configured && !this.authorised(req)) {
            return this.json(res, 401, { error: 'unauthorized' });
          }
          try {
            return this.json(res, 200, handleCommit(this.service, await readBody(req)));
          } catch (e) {
            return this.json(res, 400, setupErrorBody(e));
          }
        }

        /*
         * Pairing (§24.4). Both routes are unauthenticated by necessity — the
         * device asking has nothing to authenticate with, which is why it is
         * asking. Neither one mints anything: `request` hands out a code for
         * the page to show and a ticket for it to hold, and the token only ever
         * exists after a human at an already-linked device approved it by name.
         */
        case 'POST /api/pair/request': {
          const start = PairStartRequest.safeParse(await readBody(req));
          if (!start.success) return this.json(res, 400, { error: 'bad_request' });
          // Taking the request and raising the approval dialog is one step, in
          // that order (§24.4) — the service owns it so a route cannot get the
          // order wrong.
          return this.json(res, 200, this.service.requestPairing(start.data.kind));
        }

        case 'POST /api/pair/claim': {
          // The ticket rides the body, never the URL: a query string is logged
          // and proxied, which is the same reason §24.3 uses a fragment.
          const body = PairClaimRequest.safeParse(await readBody(req));
          if (!body.success) return this.json(res, 400, { error: 'bad_request' });
          return this.json(res, 200, this.service.pairing.claim(body.data.ticket));
        }

        case 'GET /api/whoami': {
          // The pairing probe (§29.5, App. E): which device is this token?
          const identity = this.deviceFor(req);
          if (!identity) return this.json(res, 401, { error: 'unauthorized' });
          const row = this.service.app.tokens.list().find((d) => d.device === identity);
          return this.json(res, 200, {
            device: identity,
            ...(row?.label ? { label: row.label } : {}),
          });
        }

        case 'POST /api/events': {
          const device = this.deviceFor(req);
          if (!device) return this.json(res, 401, { error: 'unauthorized' });
          const body = (await readBody(req)) as Record<string, unknown>;
          if (typeof body.type !== 'string') {
            return this.json(res, 400, { error: 'type is required' });
          }
          // Payload caps are the server's rule, not the client's courtesy
          // (§29.3): an oversize capture is refused, never quietly trimmed.
          const checked = checkPayload(body.type, body.payload ?? {});
          if ('error' in checked) return this.json(res, 413, checked);
          const result = this.service.intake.submit({
            type: body.type,
            // Provenance comes from the token, identity from the type (App. E):
            // a caller-supplied `source` is ignored, exactly as the WS `event`
            // frame already does.
            source: device,
            payload: checked.payload,
            occurred_at: typeof body.occurred_at === 'string' ? body.occurred_at : null,
            idempotency_key:
              typeof body.idempotency_key === 'string' ? body.idempotency_key : null,
            serialization_key:
              typeof body.serialization_key === 'string' ? body.serialization_key : null,
          });
          return this.json(res, result.status === 'rejected' ? 409 : 200, {
            event_id: result.event.id,
            status: result.status,
            ...(result.status === 'rejected' ? { reason: result.reason } : {}),
          });
        }

        /*
         * The file-panel preview source (§18.5, App. E). Path resolution is
         * F.8's, through the store's own `resolve` — one door, so a traversal
         * that the tools refuse cannot get in through the browser instead.
         */
        case 'GET /api/files/raw': {
          if (!this.authorised(req)) return this.json(res, 401, { error: 'unauthorized' });
          const rel = url.searchParams.get('path') ?? '';
          if (!rel) return this.json(res, 400, { error: 'path is required' });
          let abs: string;
          try {
            abs = this.service.files.resolve(rel);
          } catch (e) {
            if (e instanceof PathRejected)
              return this.json(res, 403, { error: 'path_rejected' });
            throw e;
          }
          let body: Buffer;
          try {
            if (fs.statSync(abs).isDirectory()) {
              return this.json(res, 404, { error: 'not found' });
            }
            body = fs.readFileSync(abs);
          } catch {
            return this.json(res, 404, { error: 'not found' });
          }
          res.writeHead(200, {
            ...servedType(rel),
            'content-length': body.length,
            'content-disposition': 'inline',
            // Never let a browser upgrade a served file into something
            // executable by sniffing its bytes.
            'x-content-type-options': 'nosniff',
          });
          return void res.end(body);
        }

        /*
         * Chat attachments (§26.2). The body is the file itself, not JSON:
         * base64 in a JSON envelope would mean the bytes pass through a string
         * on their way in, and §26 is built on the server moving bytes the
         * model never narrates.
         */
        case 'POST /api/uploads': {
          if (!this.authorised(req)) return this.json(res, 401, { error: 'unauthorized' });
          const limitMb = this.service.app.config.settings.uploadMaxMb;
          let body: Buffer;
          try {
            body = await readBytes(req, limitMb * 1024 * 1024);
          } catch {
            return this.json(res, 413, { error: 'too_large' });
          }
          const stored = this.service.uploads.put({
            data: body,
            mime: req.headers['content-type'] ?? '',
            name: String(req.headers['x-upload-name'] ?? 'image'),
          });
          if ('error' in stored) {
            return this.json(res, stored.error === 'too_large' ? 413 : 415, stored);
          }
          return this.json(res, 200, {
            upload_id: stored.id,
            sha256: stored.sha256,
            mime: stored.mime,
            bytes: stored.bytes,
          });
        }

        case 'POST /v1/chat/completions':
          // The OpenAI-compatible adapter lands in phase 10; our own UI never
          // touches it, so it is deliberately last.
          return this.json(res, 501, { error: 'not implemented yet' });

        default: {
          // `GET /api/uploads/<id>` — transcript re-display (§26.2).
          if (req.method === 'GET' && url.pathname.startsWith('/api/uploads/')) {
            if (!this.authorised(req)) return this.json(res, 401, { error: 'unauthorized' });
            const id = url.pathname.slice('/api/uploads/'.length);
            const row = this.service.uploads.repo.get(id);
            const bytes = row ? this.service.uploads.read(row) : null;
            // A reaped upload and an id that never existed are the same answer:
            // the transcript renders a placeholder either way (§26.1).
            if (!row || !bytes) return this.json(res, 404, { error: 'not found' });
            res.writeHead(200, {
              'content-type': row.mime,
              'content-length': bytes.length,
              'content-disposition': 'inline',
              'x-content-type-options': 'nosniff',
            });
            return void res.end(bytes);
          }
          if (req.method === 'GET') {
            const file = readUiFile(url.pathname);
            if (file) {
              res.writeHead(200, { 'content-type': file.contentType });
              return void res.end(file.body);
            }
          }
          return this.json(res, 404, { error: 'not found' });
        }
      }
    } catch (e) {
      l.warn({ route, err: errMessage(e) }, 'request failed');
      return this.json(res, 500, { error: errMessage(e) });
    }
  }
}
