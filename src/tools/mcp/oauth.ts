import crypto from 'node:crypto';
import type { OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js';
import { auth } from '@modelcontextprotocol/sdk/client/auth.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type {
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js';
import type { Config } from '../../core/config.js';
import type { McpYaml } from '../../core/config-schemas.js';
import { errMessage } from '../../core/errors.js';
import { nowIso } from '../../core/time.js';
import { log } from '../../core/logger.js';
import { secretKeySlug } from '../../chat/forms.js';

const l = log('mcp:oauth');

type McpServerConfig = McpYaml['servers'][number];

/** The one fixed path the browser comes back to (App. E). */
export const OAUTH_CALLBACK_PATH = '/oauth/callback';

/** Where a server's sign-in lives in the secret store (§27). */
export function oauthSecretKey(server: string): string {
  return `MCP_OAUTH_${secretKeySlug(server)}`;
}

/**
 * Everything one server's sign-in needs to survive a restart, as one opaque
 * store value (§27): the client a dynamic registration minted, the tokens, and
 * the in-flight half of an authorization — its PKCE verifier and `state`.
 * Nothing of it is ever written anywhere else, and none of it is ever logged.
 */
interface OAuthBlob {
  /** Dynamically registered only; a client from `mcp.yaml` is never copied here. */
  client?: OAuthClientInformationMixed;
  /** The redirect the registered client was registered with — a new one means re-registering. */
  client_redirect?: string;
  tokens?: OAuthTokens;
  /** The pending authorization: PKCE verifier, `state`, and the redirect it was minted for. */
  verifier?: string;
  state?: string;
  redirect_uri?: string;
  /** Set on the first completed sign-in and kept through token loss — what makes a later loss "expired" rather than "never signed in". */
  authorized_at?: string;
}

/** A store read and write, and nothing else — the provider never sees `Config`. */
interface BlobStore {
  read(): OAuthBlob;
  write(blob: OAuthBlob): void;
}

function storeFor(config: Config, server: string): BlobStore {
  const key = oauthSecretKey(server);
  return {
    read() {
      const raw = config.secretStore.get(key);
      if (!raw) return {};
      try {
        return JSON.parse(raw) as OAuthBlob;
      } catch {
        // An unreadable blob is a sign-in that has to happen again, not a crash.
        l.warn({ server }, 'stored mcp sign-in is unreadable; it will be asked for again');
        return {};
      }
    },
    write(blob) {
      const stored = config.secretStore.set(key, JSON.stringify(blob));
      if ('error' in stored) throw new Error(stored.message);
    },
  };
}

/**
 * The SDK's `OAuthClientProvider`, backed by the secret store (§19.6, §27).
 *
 * `interactive` is the one thing this adds to the SDK's contract, and it
 * matters: the SDK starts a fresh authorization whenever a token is missing or
 * a refresh fails, including in a connect nobody asked for (startup, a call).
 * A non-interactive provider lets that happen without writing a new `state` or
 * verifier, so a background attempt can never invalidate the link a person is
 * in the middle of approving. Only the flow that hands a link to a human
 * persists the pending half.
 */
export class McpOAuthProvider implements OAuthClientProvider {
  /** The last URL the SDK asked us to send a browser to. Never logged. */
  authorizationUrl: URL | null = null;
  private pendingState: string | null = null;
  private pendingVerifier: string | null = null;

  constructor(
    private readonly cfg: McpServerConfig,
    private readonly store: BlobStore,
    private readonly redirect: string,
    private readonly interactive: boolean,
  ) {}

  get redirectUrl(): string {
    return this.redirect;
  }

  get clientMetadata(): OAuthClientMetadata {
    const secret = this.cfg.auth?.client_secret;
    return {
      client_name: 'Turminder',
      redirect_uris: [this.redirect],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: secret ? 'client_secret_post' : 'none',
    };
  }

  /** Mandatory, and unguessable: it is the only thing gating the callback (App. E). */
  state(): string {
    const state = crypto.randomBytes(32).toString('base64url');
    this.pendingState = state;
    return state;
  }

  clientInformation(): OAuthClientInformationMixed | undefined {
    // A client registered by hand wins over dynamic registration — Asana has
    // none, and a provider that has both expects the one it was told about.
    const configured = this.cfg.auth?.client_id;
    if (configured) {
      return {
        client_id: configured,
        ...(this.cfg.auth?.client_secret ? { client_secret: this.cfg.auth.client_secret } : {}),
      };
    }
    const blob = this.store.read();
    // Registered for a different redirect (the public URL was set since):
    // re-register rather than send a redirect the provider will refuse.
    if (blob.client && blob.client_redirect !== this.redirect) return undefined;
    return blob.client;
  }

  saveClientInformation(info: OAuthClientInformationMixed): void {
    const blob = this.store.read();
    this.store.write({ ...blob, client: info, client_redirect: this.redirect });
  }

  tokens(): OAuthTokens | undefined {
    return this.store.read().tokens;
  }

  saveTokens(tokens: OAuthTokens): void {
    const blob = this.store.read();
    // A refresh may omit the refresh token, meaning "keep using the old one".
    const refresh = tokens.refresh_token ?? blob.tokens?.refresh_token;
    this.store.write({
      ...blob,
      tokens: { ...tokens, ...(refresh ? { refresh_token: refresh } : {}) },
    });
  }

  redirectToAuthorization(url: URL): void {
    this.authorizationUrl = url;
    if (!this.interactive) return;
    const blob = this.store.read();
    this.store.write({
      ...blob,
      ...(this.pendingState ? { state: this.pendingState } : {}),
      ...(this.pendingVerifier ? { verifier: this.pendingVerifier } : {}),
      redirect_uri: this.redirect,
    });
  }

  saveCodeVerifier(verifier: string): void {
    // Held until the redirect is recorded, so state and verifier land together.
    this.pendingVerifier = verifier;
  }

  codeVerifier(): string {
    const verifier = this.store.read().verifier;
    if (!verifier) throw new Error('no sign-in is in progress for this server');
    return verifier;
  }

  invalidateCredentials(scope: 'all' | 'client' | 'tokens' | 'verifier' | 'discovery'): void {
    const blob = this.store.read();
    const next: OAuthBlob = { ...blob };
    if (scope === 'all' || scope === 'client') {
      delete next.client;
      delete next.client_redirect;
    }
    if (scope === 'all' || scope === 'tokens') delete next.tokens;
    // The pending half belongs to whichever flow handed a link to a person;
    // a background attempt clearing it would strand them mid-approval.
    if (this.interactive && (scope === 'all' || scope === 'verifier')) {
      delete next.verifier;
      delete next.state;
    }
    this.store.write(next);
  }
}

export interface McpOAuthDeps {
  config: Config;
  /** The address the HTTP server really bound, once it has (§23.4). */
  origin?: () => string | null;
}

export type BeginResult =
  | { authorized: true }
  | { auth_url: string; redirect_uri: string }
  | { error: string; message: string };

/**
 * Sign-in for external MCP servers (§19.6): minting links, finishing them from
 * the callback, and the providers the transports carry. The hub owns the
 * orchestration — reconnecting, the catalog, events — this owns the OAuth.
 */
export class McpOAuth {
  /** Links already handed out, by server — reused so a second ask cannot invalidate the first. */
  private readonly pending = new Map<
    string,
    { url: string; state: string; redirect: string }
  >();

  constructor(private readonly deps: McpOAuthDeps) {}

  /**
   * The one redirect (§19.6, App. E): `gateway.public_url` when set, else the
   * address the server really bound — loopback for a wildcard bind. Fixed and
   * stable on purpose: providers without dynamic registration (Asana) match
   * it exactly, which is why Google's ephemeral loopback port cannot serve.
   */
  redirectUri(): string {
    const settings = this.deps.config.settings;
    const base =
      settings.gatewayPublicUrl ??
      this.deps.origin?.() ??
      `http://127.0.0.1:${settings.bind.port}`;
    return `${base.replace(/\/+$/, '')}${OAUTH_CALLBACK_PATH}`;
  }

  /** What a transport carries: refreshes, never persists a pending sign-in. */
  providerFor(cfg: McpServerConfig): McpOAuthProvider | undefined {
    if (cfg.transport !== 'http' || cfg.auth?.type !== 'oauth') return undefined;
    return new McpOAuthProvider(
      cfg,
      storeFor(this.deps.config, cfg.name),
      this.redirectUri(),
      false,
    );
  }

  /** Has this server ever completed a sign-in? A loss then is an expiry worth telling someone about. */
  everAuthorized(server: string): boolean {
    return Boolean(storeFor(this.deps.config, server).read().authorized_at);
  }

  /**
   * Start a sign-in a human will finish, or say none is needed: a refresh that
   * still works is `authorized`. A link already handed out for this server is
   * handed out again rather than replaced — replacing it would turn the page
   * the person is approving on into a dead end.
   */
  async begin(cfg: McpServerConfig): Promise<BeginResult> {
    if (cfg.transport !== 'http' || cfg.auth?.type !== 'oauth' || !cfg.url) {
      return {
        error: 'not_oauth',
        message: `${cfg.name} does not sign in with a browser (no \`auth: {type: oauth}\` in mcp.yaml)`,
      };
    }
    const store = storeFor(this.deps.config, cfg.name);
    const redirect = this.redirectUri();
    const existing = this.pending.get(cfg.name);
    if (existing && existing.redirect === redirect && store.read().state === existing.state) {
      return { auth_url: existing.url, redirect_uri: redirect };
    }
    const provider = new McpOAuthProvider(cfg, store, redirect, true);
    try {
      const result = await auth(provider, { serverUrl: cfg.url });
      if (result === 'AUTHORIZED') return { authorized: true };
    } catch (e) {
      return {
        error: 'auth_start_failed',
        message: `could not start signing in to ${cfg.name}: ${errMessage(e)}`,
      };
    }
    const url = provider.authorizationUrl;
    const state = store.read().state;
    if (!url || !state) {
      return { error: 'auth_start_failed', message: `${cfg.name} gave no sign-in address` };
    }
    this.pending.set(cfg.name, { url: url.toString(), state, redirect });
    return { auth_url: url.toString(), redirect_uri: redirect };
  }

  /** Is a link out for this server that nobody has come back from yet? */
  hasPending(server: string): boolean {
    const p = this.pending.get(server);
    return Boolean(p && storeFor(this.deps.config, server).read().state === p.state);
  }

  /**
   * Which configured server a callback's `state` belongs to. Compared in
   * constant time; read from the store rather than memory, so a restart
   * between consent and callback still lands.
   */
  serverForState(state: string, servers: McpServerConfig[]): McpServerConfig | null {
    const want = Buffer.from(state);
    for (const cfg of servers) {
      if (cfg.auth?.type !== 'oauth') continue;
      const have = storeFor(this.deps.config, cfg.name).read().state;
      if (!have) continue;
      const got = Buffer.from(have);
      if (got.length === want.length && crypto.timingSafeEqual(got, want)) return cfg;
    }
    return null;
  }

  /**
   * Trade the code for tokens (`transport.finishAuth`). The pending half is
   * single-use: cleared whether the exchange worked or not, so a replayed
   * callback finds nothing.
   */
  async finish(
    cfg: McpServerConfig,
    code: string,
  ): Promise<{ ok: true } | { error: string; message: string }> {
    const store = storeFor(this.deps.config, cfg.name);
    const blob = store.read();
    const redirect = blob.redirect_uri ?? this.redirectUri();
    const provider = new McpOAuthProvider(cfg, store, redirect, false);
    const transport = new StreamableHTTPClientTransport(new URL(cfg.url!), {
      authProvider: provider,
    });
    try {
      await transport.finishAuth(code);
    } catch (e) {
      return {
        error: 'exchange_failed',
        message: `${cfg.name} did not accept the sign-in: ${errMessage(e)}`,
      };
    } finally {
      const after = store.read();
      delete after.state;
      delete after.verifier;
      delete after.redirect_uri;
      store.write(after);
      this.pending.delete(cfg.name);
    }
    store.write({ ...store.read(), authorized_at: nowIso() });
    l.info({ server: cfg.name }, 'mcp server signed in');
    return { ok: true };
  }
}

/**
 * The address a failed redirect left in a browser's address bar, taken apart
 * (§19.6, D.5 paste-back). Only `code` and `state` are read; nothing else in
 * it is trusted or kept.
 */
export function parseRedirect(
  pasted: string,
): { code: string; state: string } | { error: string; message: string } {
  let url: URL;
  try {
    url = new URL(pasted.trim());
  } catch {
    return {
      error: 'not_a_url',
      message: 'that is not a web address — copy the whole address bar',
    };
  }
  const denied = url.searchParams.get('error');
  if (denied) {
    return {
      error: 'provider_refused',
      message: `the sign-in was not completed (${denied.slice(0, 80)}) — start it again`,
    };
  }
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  if (!code || !state) {
    return {
      error: 'no_code',
      message:
        'that address has no sign-in code in it — copy it from the page you land on after approving',
    };
  }
  return { code, state };
}
