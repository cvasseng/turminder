import type http from 'node:http';
import type { Service } from '../service.js';

/**
 * `GET /oauth/callback` (App. E, §19.6) — where a browser comes back after a
 * person approves an MCP server's sign-in.
 *
 * No device token: the browser arriving here is whatever the person approved
 * on, and it holds none. The gate is the `state` the link was minted with —
 * unguessable, single-use, matched in the store — and PKCE behind it, so a
 * code alone is worth nothing to anyone who intercepts it.
 *
 * The answer is a page for a person, not JSON: they are looking at a browser
 * tab, and "you can close this" is the whole message. Nothing from the query
 * is echoed except the provider's own error code, escaped, because the query
 * carries the one-time code.
 */
export async function handleOAuthCallback(
  service: Service,
  url: URL,
  res: http.ServerResponse,
): Promise<void> {
  const denied = url.searchParams.get('error');
  if (denied) {
    return page(
      res,
      400,
      'Sign-in not completed',
      `The service said no (${denied.slice(0, 80)}). Nothing was connected. ` +
        'Ask your assistant for a fresh sign-in link if you want to try again.',
    );
  }
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  if (!code || !state) {
    return page(
      res,
      400,
      'Not a sign-in',
      'This address is where a sign-in comes back to, and this one carried nothing to finish. ' +
        'Ask your assistant for a sign-in link.',
    );
  }
  const outcome = await service.tools.completeAuthorization({ code, state });
  if (!outcome.ok) {
    return page(
      res,
      outcome.error === 'unknown_state' ? 403 : 502,
      'Sign-in not completed',
      outcome.error === 'unknown_state'
        ? 'This sign-in link was already used, or was not one your assistant issued. ' +
            'Ask it for a fresh one.'
        : `${outcome.message}. Ask your assistant to try again.`,
    );
  }
  return page(
    res,
    200,
    `Signed in to ${outcome.server}`,
    `Your assistant can use ${outcome.server} now` +
      (outcome.tools.length ? ` (${outcome.tools.length} tools)` : '') +
      '. You can close this tab.',
  );
}

function escape(text: string): string {
  return text.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );
}

function page(res: http.ServerResponse, status: number, title: string, body: string): void {
  const html =
    '<!doctype html><html lang="en"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">' +
    `<title>${escape(title)}</title>` +
    '<style>body{font:16px/1.5 system-ui,sans-serif;max-width:32rem;margin:15vh auto;padding:0 1rem;color:#222;background:#fafafa}' +
    '@media (prefers-color-scheme:dark){body{color:#ddd;background:#161616}}h1{font-size:1.25rem}</style>' +
    `</head><body><h1>${escape(title)}</h1><p>${escape(body)}</p></body></html>`;
  res.writeHead(status, {
    'content-type': 'text/html; charset=utf-8',
    // The address carried a one-time code: keep it out of caches and out of
    // any Referer the page could send.
    'cache-control': 'no-store',
    'referrer-policy': 'no-referrer',
    'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'",
  });
  res.end(html);
}
