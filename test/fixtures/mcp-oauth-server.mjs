/**
 * An external MCP server that will not talk to anyone who has not signed in
 * (§19.6): a protected resource and the smallest authorization server that
 * satisfies the MCP spec's client — RFC 9728 resource metadata, RFC 8414
 * server metadata, RFC 7591 dynamic registration, PKCE (S256 only) and
 * refresh. Consent is automatic: `/authorize` redirects straight back, so a
 * test "approves" by fetching the link with `redirect: 'manual'`.
 *
 * In-process rather than spawned, because the test needs its knobs — expire
 * every access token, withdraw every refresh token — between one call and the
 * next. No dependency beyond the SDK the service already pins.
 */
import crypto from 'node:crypto';
import http from 'node:http';
import { URLSearchParams } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';

const b64url = (buf) => Buffer.from(buf).toString('base64url');
const random = () => b64url(crypto.randomBytes(24));

/**
 * @param {{ dcr?: boolean, clients?: {client_id: string, client_secret?: string, redirect_uris: string[]}[] }} [opts]
 */
export async function startOAuthMcpServer(opts = {}) {
  const dcr = opts.dcr !== false;
  const clients = new Map((opts.clients ?? []).map((c) => [c.client_id, c]));
  const codes = new Map(); // code -> {client_id, redirect_uri, challenge}
  const access = new Map(); // token -> expires_at ms
  const refresh = new Map(); // token -> client_id
  const seen = { registrations: 0, refreshes: 0, authorizations: [], tokenRequests: 0 };
  let base = '';

  const json = (res, status, body, headers = {}) => {
    res.writeHead(status, { 'content-type': 'application/json', ...headers });
    res.end(JSON.stringify(body));
  };
  const readBody = async (req) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    return Buffer.concat(chunks).toString('utf8');
  };
  const issue = (clientId) => {
    const token = random();
    const refreshToken = random();
    access.set(token, Date.now() + 3600_000);
    refresh.set(refreshToken, clientId);
    return {
      access_token: token,
      token_type: 'Bearer',
      expires_in: 3600,
      refresh_token: refreshToken,
    };
  };
  const clientAuthOk = (client, params, req) => {
    if (!client.client_secret) return true;
    const basic = req.headers.authorization?.startsWith('Basic ')
      ? Buffer.from(req.headers.authorization.slice(6), 'base64').toString('utf8')
      : null;
    if (basic) {
      const [id, secret] = basic.split(':').map(decodeURIComponent);
      return id === client.client_id && secret === client.client_secret;
    }
    return params.get('client_secret') === client.client_secret;
  };

  const mcp = () => {
    const server = new McpServer(
      { name: 'locked', version: '1.0.0' },
      { capabilities: { tools: {} } },
    );
    server.registerTool(
      'locked.ping',
      {
        description: 'Answer, for a caller that signed in.',
        inputSchema: { echo: z.string().optional() },
        annotations: { readOnlyHint: true },
      },
      async (args) => ({
        content: [{ type: 'text', text: JSON.stringify({ pong: args.echo ?? 'pong' }) }],
      }),
    );
    return server;
  };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', base);
    try {
      if (url.pathname.startsWith('/.well-known/oauth-protected-resource')) {
        return json(res, 200, {
          resource: `${base}/mcp`,
          authorization_servers: [base],
        });
      }
      if (url.pathname === '/.well-known/oauth-authorization-server') {
        return json(res, 200, {
          issuer: base,
          authorization_endpoint: `${base}/authorize`,
          token_endpoint: `${base}/token`,
          ...(dcr ? { registration_endpoint: `${base}/register` } : {}),
          response_types_supported: ['code'],
          grant_types_supported: ['authorization_code', 'refresh_token'],
          code_challenge_methods_supported: ['S256'],
          token_endpoint_auth_methods_supported: [
            'none',
            'client_secret_post',
            'client_secret_basic',
          ],
        });
      }
      if (url.pathname === '/register' && req.method === 'POST' && dcr) {
        const meta = JSON.parse(await readBody(req));
        const client = {
          ...meta,
          client_id: random(),
          client_id_issued_at: Math.floor(Date.now() / 1000),
        };
        clients.set(client.client_id, client);
        seen.registrations += 1;
        return json(res, 201, client);
      }
      if (url.pathname === '/authorize') {
        const p = url.searchParams;
        const client = clients.get(p.get('client_id') ?? '');
        const redirect = p.get('redirect_uri') ?? '';
        seen.authorizations.push(Object.fromEntries(p));
        if (!client || !client.redirect_uris.includes(redirect)) {
          return json(res, 400, {
            error: 'invalid_request',
            error_description: 'unknown client or redirect',
          });
        }
        // PKCE and state are not optional here, as they are not in §19.6.
        if (
          p.get('code_challenge_method') !== 'S256' ||
          !p.get('code_challenge') ||
          !p.get('state')
        ) {
          return json(res, 400, {
            error: 'invalid_request',
            error_description: 'pkce and state required',
          });
        }
        const code = random();
        codes.set(code, {
          client_id: client.client_id,
          redirect_uri: redirect,
          challenge: p.get('code_challenge'),
        });
        const back = new URL(redirect);
        back.searchParams.set('code', code);
        back.searchParams.set('state', p.get('state'));
        res.writeHead(302, { location: back.toString() });
        return res.end();
      }
      if (url.pathname === '/token' && req.method === 'POST') {
        seen.tokenRequests += 1;
        const params = new URLSearchParams(await readBody(req));
        const grant = params.get('grant_type');
        if (grant === 'authorization_code') {
          const entry = codes.get(params.get('code') ?? '');
          codes.delete(params.get('code') ?? '');
          const verifier = params.get('code_verifier') ?? '';
          const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
          const client = entry && clients.get(entry.client_id);
          if (
            !entry ||
            !client ||
            entry.redirect_uri !== params.get('redirect_uri') ||
            entry.challenge !== challenge ||
            !clientAuthOk(client, params, req)
          ) {
            return json(res, 400, { error: 'invalid_grant' });
          }
          return json(res, 200, issue(entry.client_id));
        }
        if (grant === 'refresh_token') {
          const clientId = refresh.get(params.get('refresh_token') ?? '');
          if (!clientId) return json(res, 400, { error: 'invalid_grant' });
          refresh.delete(params.get('refresh_token'));
          seen.refreshes += 1;
          return json(res, 200, issue(clientId));
        }
        return json(res, 400, { error: 'unsupported_grant_type' });
      }
      if (url.pathname === '/mcp') {
        const header = req.headers.authorization ?? '';
        const token = header.startsWith('Bearer ') ? header.slice(7) : '';
        const expires = access.get(token);
        if (!expires || expires < Date.now()) {
          return json(
            res,
            401,
            { error: 'invalid_token' },
            {
              'www-authenticate': `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource/mcp"`,
            },
          );
        }
        const body =
          req.method === 'POST' ? JSON.parse((await readBody(req)) || 'null') : undefined;
        const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
        const s = mcp();
        res.on('close', () => {
          void transport.close();
          void s.close();
        });
        await s.connect(transport);
        return await transport.handleRequest(req, res, body);
      }
      json(res, 404, { error: 'not_found' });
    } catch (e) {
      json(res, 500, { error: String(e) });
    }
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;

  return {
    url: `${base}/mcp`,
    base,
    seen,
    /** Every access token stops working; refresh tokens still do. */
    expireAccessTokens() {
      for (const k of access.keys()) access.set(k, 0);
    },
    /** Every refresh token stops working too — the sign-in is gone. */
    revokeAll() {
      access.clear();
      refresh.clear();
    },
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}
