import http from 'node:http';
import https from 'node:https';
import type { TLSSocket } from 'node:tls';
import { log } from '../../../core/logger.js';
import { USER_AGENT } from '../../../core/version.js';

const l = log('tool:print');

/**
 * Why this exists at all, given `fetch` (§34.2): printers ship self-signed
 * certificates and a good many refuse plaintext IPP outright, so trust here is
 * per-device and per-fingerprint. The platform `fetch` has no way to say that
 * — its dispatcher is not reachable from a Node builtin — so the one place in
 * this system that needs a custom TLS policy gets a `fetch`-shaped function
 * built on `node:https` instead, and every caller above it stays ordinary.
 */

export class CertificateChanged extends Error {
  constructor(
    readonly expected: string,
    readonly seen: string,
  ) {
    super(`the device presented a different certificate (expected ${expected}, saw ${seen})`);
    this.name = 'CertificateChanged';
  }
}

export interface DeviceFetchOptions {
  /**
   * The fingerprint recorded when this device was added (§34.2). Null on the
   * very first probe, which is the "trust" half of trust-on-first-use — every
   * request after that compares.
   */
  fingerprint?: string | null;
  /** Called with what the device actually presented, so setup can record it. */
  onCertificate?: (fingerprint: string) => void;
}

/** SHA-256 of the peer certificate, in the `AB:CD:…` form Node reports. */
function fingerprintOf(socket: TLSSocket): string | null {
  const cert = socket.getPeerCertificate();
  return cert && 'fingerprint256' in cert ? (cert.fingerprint256 ?? null) : null;
}

/**
 * A `fetch` for one device. Redirects are deliberately not followed: a printer
 * has no reason to redirect an IPP or eSCL call, and a device that was reached
 * over HTTPS must never be walked down to HTTP by something it said (§34.2).
 */
export function deviceFetch(opts: DeviceFetchOptions = {}): typeof globalThis.fetch {
  return (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(typeof input === 'string' ? input : input.toString());
    const secure = url.protocol === 'https:';
    const body = init.body;
    const payload =
      body === undefined || body === null
        ? null
        : typeof body === 'string'
          ? Buffer.from(body, 'utf8')
          : Buffer.from(body as ArrayBuffer);

    const headers: Record<string, string> = {
      'user-agent': USER_AGENT,
      // Both of these are here because a printer noticed their absence. The
      // device is an embedded HTTP server, not nginx: it is entitled to be
      // fussy, and every client that works against it sends these.
      accept: '*/*',
      connection: 'close',
    };
    for (const [k, v] of Object.entries((init.headers ?? {}) as Record<string, string>)) {
      headers[k.toLowerCase()] = v;
    }
    if (payload) headers['content-length'] = String(payload.length);

    return await new Promise<Response>((resolve, reject) => {
      const request = (secure ? https : http).request(
        {
          protocol: url.protocol,
          hostname: url.hostname,
          port: url.port || (secure ? 443 : 80),
          path: `${url.pathname}${url.search}`,
          method: init.method ?? 'GET',
          headers,
          /*
           * One connection per request, never a pool. Node's global agent
           * keeps sockets alive and hands them to the next request, and this
           * device does not survive that: a scan pull issued on a reused
           * socket never answers, and the *next* call to the same host comes
           * back `socket hang up`. Volume here is a handful of requests
           * against a machine in the next room, so a fresh connection costs
           * nothing and removes the whole class of embedded-keep-alive bugs.
           */
          agent: false,
          // The whole reason for this module. Verification is not skipped so
          // much as replaced: what a CA cannot vouch for, the pin does.
          ...(secure ? { rejectUnauthorized: false } : {}),
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (c: Buffer) => chunks.push(c));
          res.on('error', reject);
          res.on('end', () => {
            const responseHeaders = new Headers();
            for (const [k, v] of Object.entries(res.headers)) {
              if (typeof v === 'string') responseHeaders.set(k, v);
              else if (Array.isArray(v)) responseHeaders.set(k, v.join(', '));
            }
            resolve(
              new Response(Buffer.concat(chunks), {
                status: res.statusCode ?? 0,
                statusText: res.statusMessage ?? '',
                headers: responseHeaders,
              }),
            );
          });
        },
      );

      if (secure) {
        request.on('socket', (socket) => {
          const verify = () => {
            const seen = fingerprintOf(socket as TLSSocket);
            if (!seen) return;
            if (opts.fingerprint && opts.fingerprint !== seen) {
              // Destroyed before a byte of the request goes out: a device we
              // cannot identify does not get told what we wanted from it.
              // Synchronous inside the socket handler on purpose — Node emits
              // `socket` and only then flushes what `write` buffered.
              request.destroy(new CertificateChanged(opts.fingerprint, seen));
              return;
            }
            opts.onCertificate?.(seen);
          };
          // Per *request*, not per connection. `agent: false` above means
          // every request gets its own socket today, so `secureConnect` is
          // what fires — but a socket that has already shaken hands never
          // will, and a pin that only checks new connections is a pin that
          // silently stops applying the day someone reintroduces pooling.
          if (fingerprintOf(socket as TLSSocket)) verify();
          else socket.once('secureConnect', verify);
        });
      }

      const signal = init.signal;
      if (signal) {
        if (signal.aborted) {
          request.destroy(new Error('aborted'));
        } else {
          signal.addEventListener('abort', () => request.destroy(new Error('timed out')), {
            once: true,
          });
        }
      }

      request.on('error', (e) => {
        l.debug(
          { url: `${url.protocol}//${url.host}${url.pathname}`, err: e.message },
          'device request failed',
        );
        reject(e);
      });
      if (payload) request.write(payload);
      request.end();
    });
  }) as typeof globalThis.fetch;
}
