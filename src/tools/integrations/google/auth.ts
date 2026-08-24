import http from 'node:http';
import crypto from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { log } from '../../../core/logger.js';
import { errMessage, UserFacingError } from '../../../core/errors.js';
import type { DataHome } from '../../../core/datadir.js';
import type { Config } from '../../../core/config.js';
import type { SecretMap } from '../../../core/config.js';
import { readBundledClient } from './bundled-client.js';

const l = log('google');

/** Read calendars and their events. */
export const CALENDAR_READ_SCOPE = 'https://www.googleapis.com/auth/calendar.readonly';
/**
 * Create, change and delete events. Narrower than the full `calendar` scope on
 * purpose: the assistant has no business creating or deleting *calendars*.
 */
export const CALENDAR_WRITE_SCOPE = 'https://www.googleapis.com/auth/calendar.events';

/** What `turminder auth google` asks for. */
export const CALENDAR_SCOPES = [CALENDAR_READ_SCOPE, CALENDAR_WRITE_SCOPE];

/** @deprecated use CALENDAR_READ_SCOPE. Kept so older call sites still compile. */
export const CALENDAR_SCOPE = CALENDAR_READ_SCOPE;

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';

export interface GoogleCredentials {
  clientId: string;
  clientSecret: string;
  /** Where they came from, for the "why doesn't it work" question. */
  source: string;
}

export interface StoredToken {
  refresh_token: string;
  access_token?: string;
  /** ISO timestamp; refreshed a minute early. */
  expires_at?: string;
  scope?: string;
  obtained_at: string;
}

/**
 * OAuth client identifiers — Turminder's, not the user's token. Resolution
 * order mirrors the Go daemon this is ported from:
 *
 *  1. bundled   — shipped with the app, so a user never visits the Google
 *                 console (`google-client.json` next to the app, or
 *                 TURMINDER_GOOGLE_CLIENT_ID/_SECRET in the environment).
 *  2. env       — GOOGLE_CLIENT_ID/_SECRET, for a one-off override.
 *  3. file      — GOOGLE_CLIENT_ID/_SECRET in the data dir's secrets.yaml.
 *  4. file      — secrets/credentials.json, the console download verbatim.
 *
 * Empty at every level is a normal state, and the error names all four places.
 */
export function loadGoogleCredentials(home: DataHome, secrets: SecretMap): GoogleCredentials {
  const bundled = readBundledClient();
  if (bundled) {
    return {
      clientId: bundled.clientId,
      clientSecret: bundled.clientSecret,
      source: bundled.source,
    };
  }

  const envId = process.env.GOOGLE_CLIENT_ID;
  const envSecret = process.env.GOOGLE_CLIENT_SECRET;
  if (envId && envSecret) {
    return { clientId: envId, clientSecret: envSecret, source: 'environment' };
  }

  if (secrets.GOOGLE_CLIENT_ID && secrets.GOOGLE_CLIENT_SECRET) {
    return {
      clientId: secrets.GOOGLE_CLIENT_ID,
      clientSecret: secrets.GOOGLE_CLIENT_SECRET,
      source: 'secret store',
    };
  }

  // A console `credentials.json` dropped into `secrets/` is read once and
  // folded into this key by the store, which then deletes the file (§27).
  const blob = secrets.GOOGLE_CLIENT_CREDENTIALS;
  if (blob) {
    let parsed: {
      installed?: { client_id: string; client_secret: string };
      web?: { client_id: string; client_secret: string };
      client_id?: string;
      client_secret?: string;
    };
    try {
      parsed = JSON.parse(blob) as typeof parsed;
    } catch {
      throw new UserFacingError(
        'google_credentials_invalid',
        'GOOGLE_CLIENT_CREDENTIALS is not valid JSON',
      );
    }
    const wrap = parsed.installed ?? parsed.web ?? parsed;
    if (wrap.client_id && wrap.client_secret) {
      return {
        clientId: wrap.client_id,
        clientSecret: wrap.client_secret,
        source: 'GOOGLE_CLIENT_CREDENTIALS',
      };
    }
    throw new UserFacingError(
      'google_credentials_invalid',
      'GOOGLE_CLIENT_CREDENTIALS has no client_id/client_secret',
    );
  }

  throw new UserFacingError(
    'google_credentials_missing',
    'no Google OAuth client available',
    'bundle one with `turminder auth google-client --from <path-to-.env>` (or --id/--secret), ' +
      'or put GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET in the secret store, ' +
      'or drop a console credentials.json into secrets/ (it is folded in and deleted on load)',
  );
}

/** The store key the refresh token lives under (§27). */
export const GOOGLE_TOKEN_KEY = 'GOOGLE_OAUTH_TOKEN';

/**
 * The user's refresh token, in the secret store like every other credential
 * (§27). It used to be `secrets/google-token.json`; a JSON blob is an ordinary
 * opaque value, and keeping it in a file of its own meant one credential the
 * `os` backend would never protect. Installs carrying the old file have it
 * folded in on load.
 */
export class GoogleTokenStore {
  constructor(private readonly config: Config) {}

  load(): StoredToken | null {
    const raw = this.config.secretStore.get(GOOGLE_TOKEN_KEY);
    if (!raw) return null;
    try {
      return JSON.parse(raw) as StoredToken;
    } catch (e) {
      l.warn({ err: errMessage(e) }, 'stored google token is unreadable');
      return null;
    }
  }

  save(token: StoredToken): void {
    const stored = this.config.secretStore.set(GOOGLE_TOKEN_KEY, JSON.stringify(token));
    if ('error' in stored) throw new Error(stored.message);
    this.config.reload();
  }

  clear(): void {
    this.config.secretStore.delete(GOOGLE_TOKEN_KEY);
    this.config.reload();
  }

  /**
   * Whether the stored grant covers a scope. Scopes are granted at consent
   * time, so adding a write tool to the code does not grant it on an old
   * token — the caller says "re-run auth" instead of failing with a bare 403.
   */
  hasScope(scope: string): boolean {
    const stored = this.load();
    if (!stored) return false;
    // No recorded scope means a token from before we tracked it: assume the
    // narrower thing and make the user re-consent.
    const granted = (stored.scope ?? '').split(/\s+/).filter(Boolean);
    if (!granted.length) return false;
    if (granted.includes(scope)) return true;
    // The full calendar scope subsumes both of ours.
    return granted.includes('https://www.googleapis.com/auth/calendar');
  }
}

export interface AuthorizeOptions {
  credentials: GoogleCredentials;
  scopes?: string[];
  /** Called with the consent URL; defaults to printing it. */
  printUrl?: (url: string) => void;
  /** Overridden in tests. */
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
}

export interface PendingAuthorization {
  /** Hand this to the user; the flow completes when they come back. */
  authUrl: string;
  /** Resolves with the token once the callback lands, rejects on failure. */
  completed: Promise<StoredToken>;
  /** Give up waiting and release the loopback port. */
  cancel(): void;
}

/**
 * Start the loopback OAuth flow: pick a free localhost port, build the consent
 * URL, and return without waiting. The callback is caught later and exchanged
 * for a refresh token.
 *
 * Split from `authorizeGoogle` because the chat-driven activation flow cannot
 * block on a browser round-trip (§19.5): the run hands the user a link and
 * finishes, and the integration completes activation when the callback lands
 * minutes later. The CLI still wants the blocking shape, and gets it below.
 */
export async function startGoogleAuthorization(
  opts: AuthorizeOptions,
): Promise<PendingAuthorization> {
  const scopes = opts.scopes ?? CALENDAR_SCOPES;
  const state = crypto.randomBytes(24).toString('base64url');

  const server = http.createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  const redirectUri = `http://127.0.0.1:${port}/oauth/callback`;

  let settle: { resolve(t: StoredToken): void; reject(e: unknown): void } | null = null;
  let timer: NodeJS.Timeout | null = null;
  /** Release the port and make sure nothing settles the promise twice. */
  const release = (): typeof settle => {
    const held = settle;
    settle = null;
    if (timer) clearTimeout(timer);
    timer = null;
    server.close();
    return held;
  };

  const completed = new Promise<StoredToken>((resolve, reject) => {
    settle = { resolve, reject };
  });
  // Nobody may be waiting on `completed` yet — a rejection minutes from now
  // must not take the process down in the meantime.
  completed.catch(() => {});

  timer = setTimeout(
    () => {
      release()?.reject(new UserFacingError('google_auth_timeout', 'authorisation timed out'));
    },
    opts.timeoutMs ?? 5 * 60_000,
  );
  timer.unref?.();

  server.on('request', (req, res) => {
    const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);
    if (url.pathname !== '/oauth/callback') {
      res.writeHead(404).end();
      return;
    }
    const page = (status: number, body: string) => {
      res.writeHead(status, { 'content-type': 'text/html; charset=utf-8' }).end(body);
    };
    const fail = (shown: string, detail: string) => {
      page(400, `<p>${shown}</p>`);
      release()?.reject(new UserFacingError('google_auth_failed', detail));
    };

    const error = url.searchParams.get('error');
    if (error) return fail(`Authorisation failed: ${error}`, `Google said: ${error}`);
    if (url.searchParams.get('state') !== state) {
      return fail('State mismatch.', 'state mismatch (possible CSRF)');
    }
    const code = url.searchParams.get('code');
    if (!code) return fail('No code in callback.', 'no code in the callback');

    page(
      200,
      `<html><body style="font-family:system-ui;padding:40px">
<h2>Turminder is authorised</h2><p>You can close this tab.</p></body></html>`,
    );
    const held = release();
    exchangeCode(code, redirectUri, opts).then(
      (token) => held?.resolve(token),
      (e) => held?.reject(e),
    );
  });

  const authUrl = new URL(AUTH_URL);
  authUrl.searchParams.set('client_id', opts.credentials.clientId);
  authUrl.searchParams.set('redirect_uri', redirectUri);
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('scope', scopes.join(' '));
  authUrl.searchParams.set('access_type', 'offline');
  // Without this, a second authorization returns no refresh token.
  authUrl.searchParams.set('prompt', 'consent');
  authUrl.searchParams.set('state', state);

  return {
    authUrl: authUrl.toString(),
    completed,
    cancel: () => {
      release()?.reject(
        new UserFacingError('google_auth_cancelled', 'authorisation cancelled'),
      );
    },
  };
}

async function exchangeCode(
  code: string,
  redirectUri: string,
  opts: AuthorizeOptions,
): Promise<StoredToken> {
  const doFetch = opts.fetch ?? globalThis.fetch;
  const res = await doFetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: opts.credentials.clientId,
      client_secret: opts.credentials.clientSecret,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code',
    }).toString(),
  });
  if (!res.ok) {
    throw new UserFacingError(
      'google_auth_failed',
      `token exchange failed: HTTP ${res.status}`,
      await res.text().catch(() => ''),
    );
  }
  const body = (await res.json()) as {
    access_token: string;
    refresh_token?: string;
    expires_in?: number;
    scope?: string;
  };
  if (!body.refresh_token) {
    throw new UserFacingError(
      'google_auth_no_refresh_token',
      'Google returned no refresh token',
      'revoke Turminder at https://myaccount.google.com/permissions and try again',
    );
  }
  return {
    refresh_token: body.refresh_token,
    access_token: body.access_token,
    expires_at: new Date(Date.now() + (body.expires_in ?? 3600) * 1000).toISOString(),
    ...(body.scope ? { scope: body.scope } : {}),
    obtained_at: new Date().toISOString(),
  };
}

/**
 * The blocking form, for the CLI: start the flow, print the URL, and wait for
 * the user to come back. Same machinery as the chat-driven flow above.
 */
export async function authorizeGoogle(opts: AuthorizeOptions): Promise<StoredToken> {
  const pending = await startGoogleAuthorization(opts);
  const print =
    opts.printUrl ??
    ((url: string) =>
      process.stdout.write(`Open this URL to authorise Turminder:\n\n  ${url}\n\n`));
  print(pending.authUrl);
  return pending.completed;
}

/** Refreshes the access token when it is missing or nearly expired. */
export async function accessTokenFor(
  store: GoogleTokenStore,
  credentials: GoogleCredentials,
  fetchImpl: typeof globalThis.fetch = globalThis.fetch,
): Promise<string> {
  const token = store.load();
  if (!token) {
    throw new UserFacingError(
      'google_not_authorised',
      'Google Calendar is not authorised yet — run `turminder auth google`',
    );
  }
  const expiresAt = token.expires_at ? Date.parse(token.expires_at) : 0;
  if (token.access_token && expiresAt - 60_000 > Date.now()) return token.access_token;

  const res = await fetchImpl(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      refresh_token: token.refresh_token,
      client_id: credentials.clientId,
      client_secret: credentials.clientSecret,
      grant_type: 'refresh_token',
    }).toString(),
  });
  if (!res.ok) {
    throw new UserFacingError(
      'google_refresh_failed',
      res.status === 400 || res.status === 401
        ? 'Google rejected the stored refresh token — it was revoked or expired. Run `turminder auth google --force`.'
        : `refreshing the Google token failed: HTTP ${res.status}`,
      await res.text().catch(() => ''),
    );
  }
  const body = (await res.json()) as { access_token: string; expires_in?: number };
  store.save({
    ...token,
    access_token: body.access_token,
    expires_at: new Date(Date.now() + (body.expires_in ?? 3600) * 1000).toISOString(),
  });
  return body.access_token;
}
