import fs from 'node:fs';
import path from 'node:path';
import matter from 'gray-matter';
import YAML from 'yaml';
import type { z } from 'zod';
import { ConfigError } from './errors.js';
import type { DataHome } from './datadir.js';
import { SystoolRegistry } from './systools.js';
import { SecretStore } from './secret-store/index.js';
import { log } from './logger.js';
import {
  ChannelsYamlSchema,
  GrantsYamlSchema,
  IdentitySchema,
  IntegrationsYamlSchema,
  McpYamlSchema,
  ModelsYamlSchema,
  PersonalitySchema,
  BootYamlSchema,
  TurminderYamlSchema,
  type ChannelsYaml,
  type GrantsYaml,
  type Identity,
  type IntegrationsYaml,
  type McpYaml,
  type ModelsYaml,
  type Personality,
  type TurminderYaml,
} from './config-schemas.js';

const l = log('config');

export type SecretMap = Record<string, string>;

const SECRET_RE = /\$\{secret:([A-Za-z0-9_.-]+)\}/g;

function issues(err: z.ZodError): string {
  return err.issues
    .map((i) => `${i.path.length ? i.path.join('.') : '(root)'}: ${i.message}`)
    .join('; ');
}

const INTEGRATIONS_HEADER = `# Which integrations are active, and their non-secret settings (App. G.12).
# Written by setup.activate / setup.deactivate; carved out of config.write.
`;

/**
 * Write config/integrations.yaml and commit it (§19.5). Only the activation
 * flows call this — the file is carved out of \`config.write\` precisely so that
 * turning an integration on is never something a model does on its own.
 */
export function writeIntegrations(
  home: DataHome,
  doc: IntegrationsYaml,
  message: string,
): void {
  const file = home.path('config', 'integrations.yaml');
  fs.writeFileSync(file, `${INTEGRATIONS_HEADER}${YAML.stringify(doc)}`, 'utf8');
  home.git.commit(message, ['config/integrations.yaml']);
  l.info({ integrations: Object.keys(doc.integrations) }, 'integration records written');
}

const GRANTS_HEADER = `# Tools the user granted access to through a form (§19, App. F.7).
# Written only by setup.request_access; carved out of config.write, because a
# capability an agent can hand itself is not a capability the user granted.
`;

/** Write config/grants.yaml and commit it. Only the request flow calls this. */
export function writeGrants(home: DataHome, doc: GrantsYaml, message: string): void {
  const file = home.path('config', 'grants.yaml');
  fs.writeFileSync(file, `${GRANTS_HEADER}${YAML.stringify(doc)}`, 'utf8');
  home.git.commit(message, ['config/grants.yaml']);
  l.info({ patterns: doc.grants.map((g) => g.pattern) }, 'grants written');
}

/**
 * The store key an endpoint's API key lives under (§27). One function, because
 * the setup flow that writes a key and the self-heal that folds a legacy one in
 * must agree on the name or the reference points at nothing.
 */
export function modelApiKeyName(endpoint: string): string {
  return `MODEL_API_KEY_${endpoint.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}`;
}

/**
 * Pass 1 of `Config.healModelsYaml` (§8.3, §10.6 v2). Mutates `doc` in
 * place: folds a legacy top-level `embedding:` block into a `kind:
 * embedding` entry in `doc.endpoints` plus an explicit `routes.embedding`
 * naming it, and deletes the old block. Returns whether there was anything
 * to fold. A name collision with an existing endpoint called `embedding`
 * gets `embedding-2`, `-3`, … — the config keeps both, nothing is dropped.
 */
function foldEmbeddingBlock(doc: Record<string, unknown>): boolean {
  if (!doc.embedding || typeof doc.embedding !== 'object') return false;
  const embedding = doc.embedding as Record<string, unknown>;
  const endpoints = Array.isArray(doc.endpoints)
    ? (doc.endpoints as Record<string, unknown>[])
    : [];
  const existingNames = new Set(
    endpoints
      .map((e) => (e && typeof e === 'object' ? e.name : undefined))
      .filter((n): n is string => typeof n === 'string'),
  );
  let name = 'embedding';
  for (let n = 2; existingNames.has(name); n += 1) name = `embedding-${n}`;

  const folded: Record<string, unknown> = { name, kind: 'embedding', url: embedding.url };
  if (typeof embedding.model === 'string') folded.model = embedding.model;
  if (typeof embedding.api_key === 'string') folded.api_key = embedding.api_key;
  endpoints.push(folded);
  doc.endpoints = endpoints;

  const routes = doc.routes && typeof doc.routes === 'object' ? doc.routes : {};
  doc.routes = { ...(routes as Record<string, unknown>), embedding: { endpoint: name } };
  delete doc.embedding;
  return true;
}

/**
 * Resolve `${secret:KEY}` references. Done here and only here (G.6) — secrets
 * never appear in traces, logs, or model context because nothing else expands them.
 */
export function interpolateSecrets<T>(value: T, secrets: SecretMap, file: string): T {
  const walk = (v: unknown): unknown => {
    if (typeof v === 'string') {
      return v.replace(SECRET_RE, (_m, key: string) => {
        const found = secrets[key];
        if (found === undefined) {
          throw new ConfigError(file, `references unknown secret \${secret:${key}}`);
        }
        return found;
      });
    }
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') {
      return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]));
    }
    return v;
  };
  return walk(value) as T;
}

/**
 * Replace every `${secret:KEY}` reference with words a person can read. For
 * text a human is about to be shown — the approval dialog (§7.3, App. D.3) is
 * the one that matters — where neither the value nor the key name is theirs to
 * see. It lives beside the resolver so that what a reference *looks like* is
 * one regex in this system rather than two (§27).
 */
export function maskSecretRefs(text: string, mask = '(a stored secret)'): string {
  return text.replace(SECRET_RE, mask);
}

export interface LoadOptions {
  secrets?: SecretMap;
}

/** Load + validate a YAML config file. Returns null when the file is absent. */
export function loadYamlFile<S extends z.ZodTypeAny>(
  absPath: string,
  label: string,
  schema: S,
  opts: LoadOptions = {},
): z.infer<S> | null {
  if (!fs.existsSync(absPath)) return null;
  let raw: unknown;
  try {
    raw = YAML.parse(fs.readFileSync(absPath, 'utf8'));
  } catch (e) {
    throw new ConfigError(label, 'not valid YAML', (e as Error).message);
  }
  const withSecrets = opts.secrets ? interpolateSecrets(raw, opts.secrets, label) : raw;
  const parsed = schema.safeParse(withSecrets ?? {});
  if (!parsed.success) throw new ConfigError(label, 'failed validation', issues(parsed.error));
  return parsed.data;
}

export interface MarkdownDoc<T> {
  frontmatter: T;
  body: string;
  file: string;
}

/** Load + validate a markdown file with YAML frontmatter (gray-matter). */
export function loadMarkdownFile<S extends z.ZodTypeAny>(
  absPath: string,
  label: string,
  schema: S,
): MarkdownDoc<z.infer<S>> | null {
  if (!fs.existsSync(absPath)) return null;
  let parsedMatter: matter.GrayMatterFile<string>;
  try {
    parsedMatter = matter(fs.readFileSync(absPath, 'utf8'));
  } catch (e) {
    throw new ConfigError(label, 'frontmatter is not valid YAML', (e as Error).message);
  }
  const parsed = schema.safeParse(parsedMatter.data ?? {});
  if (!parsed.success) {
    throw new ConfigError(label, 'frontmatter failed validation', issues(parsed.error));
  }
  return { frontmatter: parsed.data, body: parsedMatter.content.trim(), file: absPath };
}

/* ── Resolved settings: Appendix A defaults overridden by G.1 ─────────────── */

export interface Settings {
  bind: { host: string; port: number };
  maxDepth: number;
  retryAttempts: number;
  retryBackoffS: number[];
  budgetMaxTurns: number;
  budgetMaxTokens: number;
  budgetTimeoutS: number;
  ingressExcerptChars: number;
  memoryTopK: number;
  chatContextTurns: number;
  /** How long quiet before a conversation is distilled. Never archives it (§9). */
  conversationIdleMin: number;
  notifyTtlS: number;
  confirmTtlS: number;
  confirmTimeoutS: number;
  scheduleGraceS: number;
  formTimeoutS: number;
  /** Transcript budget for one tool result (§20.3). */
  toolResultMaxChars: number;
  /** Size above which a stale tool result is elided mid-run (§20.4). */
  elideThresholdChars: number;
  /** How many assistant turns old a result must be before elision. */
  elideAfterTurns: number;
  /** Consecutive empty results per namespace before the §20.9 note. */
  futileStreakThreshold: number;
  /** Extracted text below this, with 10× the markup, reads as JS-rendered. */
  spaTextFloorChars: number;
  wsHeartbeatS: number;
  wsMissLimit: number;
  /** Quiet days before an ephemeral embed is reaped (§22.1). */
  embedTtlDays: number;
  searxngUrl: string;
  searchMaxResults: number;
  searchTimeoutS: number;
  fetchMaxChars: number;
  fetchTimeoutS: number;
  fetchAllowPrivateHosts: boolean;
  backgroundConcurrency: number;
  daemonBundled: boolean;
  daemonDevice: string;
  daemonNotifyCommand: string;
  /** Path override for the chromium systool; null probes $PATH (§23.1). */
  systoolChromium: string | null;
  /** Path override for gpg, the §27.1 backend's binary. */
  systoolGpg: string | null;
  /** Path override for git, the §12.2 data-repo binary. */
  systoolGit: string | null;
  /** Where secrets live at rest (§27.1). */
  secretsBackend: 'auto' | 'os' | 'gpg' | 'plain';
  /** Recipient key id for the `gpg` backend. */
  secretsGpgKey: string | null;
  /** Base URL for QR connect (§24.3); null = guess from the interfaces. */
  gatewayPublicUrl: string | null;
  /** Chat attachments (§26.1): size cap, lifetime, and the vision window. */
  uploadMaxMb: number;
  uploadTtlDays: number;
  imageContextTurns: number;
  retentionDays: number;
  /** null = the data dir's own `files/` (§18.2). */
  filesDir: string | null;
  filesQuiescenceS: number;
  filesMarkers: string[];
  filesWatchRateLimitS: number;
  chatTools: string[];
  chatConfirm: string[];
  /** Tool namespaces open in every conversation from the first turn (§21.2.1). */
  chatCoreNamespaces: string[];
  chatMaxTurns: number;
  chatMaxTokens: number;
  chatTimeoutS: number;
}

/** The shipped default set (Appendix A). */
export const DEFAULT_SETTINGS: Settings = {
  bind: { host: '127.0.0.1', port: 7787 },
  maxDepth: 5,
  retryAttempts: 3,
  retryBackoffS: [60, 300, 1500],
  budgetMaxTurns: 10,
  budgetMaxTokens: 30_000,
  budgetTimeoutS: 180,
  ingressExcerptChars: 4000,
  memoryTopK: 5,
  chatContextTurns: 40,
  conversationIdleMin: 30,
  notifyTtlS: 24 * 3600,
  confirmTtlS: 3600,
  confirmTimeoutS: 3600,
  scheduleGraceS: 3600,
  formTimeoutS: 3600,
  toolResultMaxChars: 4000,
  elideThresholdChars: 2000,
  elideAfterTurns: 2,
  futileStreakThreshold: 3,
  spaTextFloorChars: 500,
  wsHeartbeatS: 30,
  wsMissLimit: 2,
  embedTtlDays: 30,
  searxngUrl: 'http://127.0.0.1:8080',
  searchMaxResults: 5,
  searchTimeoutS: 10,
  fetchMaxChars: 20_000,
  fetchTimeoutS: 20,
  fetchAllowPrivateHosts: true,
  backgroundConcurrency: 1,
  daemonBundled: false,
  daemonDevice: 'local',
  daemonNotifyCommand: 'notify-send',
  systoolChromium: null,
  systoolGpg: null,
  systoolGit: null,
  secretsBackend: 'auto',
  secretsGpgKey: null,
  gatewayPublicUrl: null,
  uploadMaxMb: 20,
  uploadTtlDays: 30,
  imageContextTurns: 2,
  retentionDays: 90,
  filesDir: null,
  filesQuiescenceS: 30,
  filesMarkers: ['@turminder'],
  filesWatchRateLimitS: 600,
  // `config.*` is here so the assistant can author its own handlers and tune
  // its own personality from chat (plan §6). Calendar writes are included
  // because the user is present and asked; the destructive one is gated below.
  chatTools: [
    'memory.*',
    'schedule.*',
    'web.*',
    'deliver.notify',
    'skills.fetch',
    'config.read',
    'config.write',
    'calendar.*',
    'asana.*',
    'setup.*',
    'files.*',
    'time.*',
    'weather.*',
    'embeds.*',
    'docs.*',
    'history.*',
    'watch.*',
    'usage.*',
    // Chat text is user-voice (H.2), so "let's work on X" is genuine intent —
    // which is exactly why `project.*` is here and in no handler default
    // (§31.4): a hostile event asking to load an island meets `unknown_tool`.
    'project.*',
  ],
  // Visible, but each call needs an explicit approve/deny (App. F.7). Keeping
  // and deleting an embed are the user's calls, not the model's (§22.1).
  chatConfirm: [
    'calendar.delete_event',
    'files.delete',
    'setup.deactivate',
    'embeds.promote',
    'embeds.delete',
  ],
  // The everyday set (App. A). Everything else granted — `config`, `setup`,
  // `calendar`, `asana`, external MCP servers — is one catalog line until the
  // model opens it (§21.2). Namespaces, not tool globs: paging is coarse on
  // purpose, because a namespace is the unit a user thinks in.
  chatCoreNamespaces: [
    'memory',
    'files',
    'schedule',
    'deliver',
    'time',
    'weather',
    'web',
    'skills',
  ],
  // Chat runs looser than the App. A defaults, which are sized for unattended
  // handlers: someone is watching a chat turn, tool-using answers legitimately
  // take several turns, and the token ceiling has to clear a full-context
  // prompt (40 turns of history plus retrieved memories) with room to answer.
  chatMaxTurns: 16,
  chatMaxTokens: 120_000,
  chatTimeoutS: 600,
};

/**
 * A bind address handed to the process rather than written in its config
 * (§28.1). The desktop shell picks a free localhost port for its sidecar at
 * spawn time and has no business editing `config/turminder.yaml` to say so —
 * config files have owners, and this one's owner is the scaffold.
 */
export interface BindOverride {
  value: string;
  /** Where it came from, so a bad value names the thing to go and fix. */
  label: string;
}

/** Resolution order, mirroring `resolveDataDir`: flag -> env -> nothing. */
export function resolveBindOverride(flag?: string): BindOverride | null {
  if (flag) return { value: flag, label: '--bind' };
  const env = process.env.TURMINDER_BIND;
  if (env) return { value: env, label: 'TURMINDER_BIND' };
  return null;
}

function parseBind(bind: string, label: string): { host: string; port: number } {
  const idx = bind.lastIndexOf(':');
  if (idx <= 0) throw new ConfigError(label, `bind must look like host:port (got "${bind}")`);
  const host = bind.slice(0, idx);
  const port = Number(bind.slice(idx + 1));
  // Port 0 is legitimate: "pick any free port", which tests rely on.
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new ConfigError(label, `bind port out of range in "${bind}"`);
  }
  return { host, port };
}

export function resolveSettings(
  raw: TurminderYaml | null,
  bindOverride: BindOverride | null = null,
): Settings {
  const s = { ...DEFAULT_SETTINGS };
  // Applied before the early return, because an override has to win on a box
  // with no `turminder.yaml` at all — which is every first run of a bundled
  // sidecar (§28.1).
  if (bindOverride) s.bind = parseBind(bindOverride.value, bindOverride.label);
  if (!raw) return s;
  const d = raw.data_defaults ?? {};
  if (raw.bind && !bindOverride) s.bind = parseBind(raw.bind, 'config/turminder.yaml');
  if (d.max_depth !== undefined) s.maxDepth = d.max_depth;
  if (d.retry_attempts !== undefined) s.retryAttempts = d.retry_attempts;
  if (d.retry_backoff_s !== undefined) s.retryBackoffS = d.retry_backoff_s;
  if (d.budget_max_turns !== undefined) s.budgetMaxTurns = d.budget_max_turns;
  if (d.budget_max_tokens !== undefined) s.budgetMaxTokens = d.budget_max_tokens;
  if (d.budget_timeout_s !== undefined) s.budgetTimeoutS = d.budget_timeout_s;
  if (d.ingress_excerpt_chars !== undefined) s.ingressExcerptChars = d.ingress_excerpt_chars;
  if (d.memory_top_k !== undefined) s.memoryTopK = d.memory_top_k;
  if (d.chat_context_turns !== undefined) s.chatContextTurns = d.chat_context_turns;
  if (d.conversation_idle_min !== undefined) s.conversationIdleMin = d.conversation_idle_min;
  if (d.notify_ttl_s !== undefined) s.notifyTtlS = d.notify_ttl_s;
  if (d.confirm_ttl_s !== undefined) s.confirmTtlS = d.confirm_ttl_s;
  if (d.confirm_timeout_s !== undefined) s.confirmTimeoutS = d.confirm_timeout_s;
  if (d.schedule_grace_s !== undefined) s.scheduleGraceS = d.schedule_grace_s;
  if (d.form_timeout_s !== undefined) s.formTimeoutS = d.form_timeout_s;
  if (d.tool_result_max_chars !== undefined) s.toolResultMaxChars = d.tool_result_max_chars;
  if (d.elide_threshold_chars !== undefined) s.elideThresholdChars = d.elide_threshold_chars;
  if (d.elide_after_turns !== undefined) s.elideAfterTurns = d.elide_after_turns;
  if (d.futile_streak_threshold !== undefined) {
    s.futileStreakThreshold = d.futile_streak_threshold;
  }
  if (d.spa_text_floor_chars !== undefined) s.spaTextFloorChars = d.spa_text_floor_chars;
  if (d.ws_heartbeat_s !== undefined) s.wsHeartbeatS = d.ws_heartbeat_s;
  if (d.ws_miss_limit !== undefined) s.wsMissLimit = d.ws_miss_limit;
  if (d.embed_ttl_days !== undefined) s.embedTtlDays = d.embed_ttl_days;
  if (raw.search?.searxng_url) s.searxngUrl = raw.search.searxng_url;
  if (raw.search?.max_results !== undefined) s.searchMaxResults = raw.search.max_results;
  if (raw.search?.timeout_s !== undefined) s.searchTimeoutS = raw.search.timeout_s;
  if (raw.web?.fetch_max_chars !== undefined) s.fetchMaxChars = raw.web.fetch_max_chars;
  if (raw.web?.fetch_timeout_s !== undefined) s.fetchTimeoutS = raw.web.fetch_timeout_s;
  if (raw.web?.fetch_allow_private_hosts !== undefined) {
    s.fetchAllowPrivateHosts = raw.web.fetch_allow_private_hosts;
  }
  if (raw.scheduler?.background_concurrency !== undefined) {
    s.backgroundConcurrency = raw.scheduler.background_concurrency;
  }
  if (raw.daemon?.bundled !== undefined) s.daemonBundled = raw.daemon.bundled;
  if (raw.daemon?.device) s.daemonDevice = raw.daemon.device;
  if (raw.daemon?.notify_command) s.daemonNotifyCommand = raw.daemon.notify_command;
  if (raw.files?.dir !== undefined) s.filesDir = raw.files.dir;
  if (raw.files?.quiescence_s !== undefined) s.filesQuiescenceS = raw.files.quiescence_s;
  if (raw.files?.markers) s.filesMarkers = raw.files.markers;
  if (raw.files?.watch_rate_limit_s !== undefined) {
    s.filesWatchRateLimitS = raw.files.watch_rate_limit_s;
  }
  if (raw.systools?.chromium !== undefined) s.systoolChromium = raw.systools.chromium;
  if (raw.systools?.gpg !== undefined) s.systoolGpg = raw.systools.gpg;
  if (raw.systools?.git !== undefined) s.systoolGit = raw.systools.git;
  if (raw.secrets?.backend !== undefined) s.secretsBackend = raw.secrets.backend;
  if (raw.secrets?.gpg_key !== undefined) s.secretsGpgKey = raw.secrets.gpg_key;
  if (raw.uploads?.max_mb !== undefined) s.uploadMaxMb = raw.uploads.max_mb;
  if (raw.uploads?.ttl_days !== undefined) s.uploadTtlDays = raw.uploads.ttl_days;
  if (raw.uploads?.image_context_turns !== undefined) {
    s.imageContextTurns = raw.uploads.image_context_turns;
  }
  if (raw.gateway?.public_url !== undefined) s.gatewayPublicUrl = raw.gateway.public_url;
  if (raw.retention_days !== undefined) s.retentionDays = raw.retention_days;
  if (raw.chat?.tools) s.chatTools = raw.chat.tools;
  if (raw.chat?.confirm) s.chatConfirm = raw.chat.confirm;
  if (raw.chat?.core_namespaces) s.chatCoreNamespaces = raw.chat.core_namespaces;
  if (raw.chat?.max_turns !== undefined) s.chatMaxTurns = raw.chat.max_turns;
  if (raw.chat?.max_tokens !== undefined) s.chatMaxTokens = raw.chat.max_tokens;
  if (raw.chat?.timeout_s !== undefined) s.chatTimeoutS = raw.chat.timeout_s;
  return s;
}

/* ── The config facade every subsystem uses ──────────────────────────────── */

/**
 * Loads and caches the config half of the data dir. Reload is explicit
 * (`reload()`), so a half-written file can never be picked up mid-run.
 */
export class Config {
  private store: SecretStore | null = null;
  private systoolRegistry: SystoolRegistry | null = null;
  private bootCache: {
    secretsBackend: Settings['secretsBackend'];
    secretsGpgKey: string | null;
    systoolChromium: string | null;
    systoolGpg: string | null;
    systoolGit: string | null;
    daemonNotifyCommand: string;
  } | null = null;
  private settingsCache: Settings | null = null;

  constructor(
    readonly home: DataHome,
    /** Process-level bind override (§28.1); outranks `config/turminder.yaml`. */
    private readonly bindOverride: BindOverride | null = null,
  ) {}

  reload(): void {
    this.store?.reload();
    this.bootCache = null;
    this.settingsCache = null;
  }

  /**
   * The secret store (§27) — the one door to `secrets/`, whichever backend is
   * configured. Owned by the config loader because the loader is the single
   * resolution point for `${secret:KEY}` (G.6), and because the backend choice
   * is a config setting.
   */
  get secretStore(): SecretStore {
    if (!this.store) {
      this.store = new SecretStore({
        dir: this.home.secretsDir,
        systools: this.systools,
        settings: () => ({
          backend: this.bootSettings.secretsBackend,
          gpgKey: this.bootSettings.secretsGpgKey,
        }),
      });
    }
    return this.store;
  }

  /**
   * Settings read **without** `${secret:}` interpolation.
   *
   * Where secrets live, and which binary opens them, cannot themselves be
   * secrets — resolving them would need the store the answer is being used to
   * build. So these few fields come from a pre-pass over the same file, and
   * everything else keeps the fully-resolved `settings`.
   */
  private get bootSettings(): {
    secretsBackend: Settings['secretsBackend'];
    secretsGpgKey: string | null;
    systoolChromium: string | null;
    systoolGpg: string | null;
    systoolGit: string | null;
    daemonNotifyCommand: string;
  } {
    if (!this.bootCache) {
      const raw =
        loadYamlFile(
          this.home.path('config', 'turminder.yaml'),
          'config/turminder.yaml',
          BootYamlSchema,
        ) ?? {};
      this.bootCache = {
        secretsBackend: raw.secrets?.backend ?? DEFAULT_SETTINGS.secretsBackend,
        secretsGpgKey: raw.secrets?.gpg_key ?? DEFAULT_SETTINGS.secretsGpgKey,
        systoolChromium: raw.systools?.chromium ?? DEFAULT_SETTINGS.systoolChromium,
        systoolGpg: raw.systools?.gpg ?? DEFAULT_SETTINGS.systoolGpg,
        systoolGit: raw.systools?.git ?? DEFAULT_SETTINGS.systoolGit,
        daemonNotifyCommand: raw.daemon?.notify_command ?? DEFAULT_SETTINGS.daemonNotifyCommand,
      };
    }
    return this.bootCache;
  }

  /**
   * External binaries this build may shell out to (§23.1). Here rather than in
   * the composition root because the gpg backend needs one before anything
   * else is built, and two registries would probe the same binaries twice.
   */
  get systools(): SystoolRegistry {
    if (!this.systoolRegistry) {
      this.systoolRegistry = new SystoolRegistry({
        configured: (name) => {
          // Explicit per tool: a fall-through default here once handed git
          // the notify-send command, which is the kind of bug that spawns the
          // wrong binary and looks like git not working.
          switch (name) {
            case 'chromium':
              return this.bootSettings.systoolChromium;
            case 'gpg':
              return this.bootSettings.systoolGpg;
            case 'git':
              return this.bootSettings.systoolGit;
            case 'notify-send':
              return this.bootSettings.daemonNotifyCommand;
          }
        },
      });
    }
    return this.systoolRegistry;
  }

  get secrets(): SecretMap {
    return this.secretStore.all();
  }

  get settings(): Settings {
    if (!this.settingsCache) {
      const raw = loadYamlFile(
        this.home.path('config', 'turminder.yaml'),
        'config/turminder.yaml',
        TurminderYamlSchema,
        { secrets: this.secrets },
      );
      this.settingsCache = resolveSettings(raw, this.bindOverride);
    }
    return this.settingsCache;
  }

  /** null when the endpoint config is absent — the setup trigger (plan §3b). */
  models(): ModelsYaml | null {
    return loadYamlFile(
      this.home.path('config', 'models.yaml'),
      'config/models.yaml',
      ModelsYamlSchema,
      { secrets: this.secrets },
    );
  }

  /**
   * One raw-YAML pass over models.yaml that folds two kinds of pre-this-track
   * debt into the current shape, in a single read → mutate → write → commit
   * — a file carrying both gets **one** commit, not two:
   *
   * 1. A legacy `embedding:` block (§8.3, §10.6) becomes a `kind: embedding`
   *    endpoint plus an explicit `routes.embedding`, run first so its own
   *    `api_key` (if any) is healed by pass 2 like any other endpoint's,
   *    rather than needing a second special case.
   * 2. A plaintext `api_key` (§27) moves into `MODEL_API_KEY_<NAME>`; the
   *    store is total, and a credential sitting in the git half of the data
   *    dir because it predates the rule is exactly the exposure §27 exists
   *    to close — the hosted golden path (§28.5) made a literal key the
   *    *normal* thing to write for a while.
   *
   * Both rewrite the file to a reference and commit — the same self-healing
   * the G.4 device tokens and the legacy Google files get. **Never** called
   * on `Config.models()`'s output, which has `${secret:}` expanded and would
   * write a secret to disk; this reads and writes the raw file itself.
   * Comments in models.yaml do not survive the round-trip; that is the trade
   * every config writer here makes (G.1).
   */
  healModelsYaml(): { apiKeys: string[]; embeddingFolded: boolean } {
    const nothing = { apiKeys: [], embeddingFolded: false };
    const file = this.home.path('config', 'models.yaml');
    if (!fs.existsSync(file)) return nothing;
    let doc: Record<string, unknown>;
    try {
      doc = (YAML.parse(fs.readFileSync(file, 'utf8')) ?? {}) as Record<string, unknown>;
    } catch (e) {
      // A models.yaml that will not parse is already "unconfigured" as far as
      // the loader is concerned; healing it is not this method's business.
      l.warn({ err: (e as Error).message }, 'models.yaml unparseable, not healing it');
      return nothing;
    }

    const embeddingFolded = foldEmbeddingBlock(doc);
    const apiKeys = this.healApiKeysInPlace(doc);
    if (!apiKeys.length && !embeddingFolded) return nothing;

    fs.writeFileSync(file, YAML.stringify(doc), 'utf8');
    const messages: string[] = [];
    if (embeddingFolded) messages.push('fold embedding block into a kind: embedding endpoint');
    if (apiKeys.length) messages.push('move model api keys into the secret store (§27)');
    this.home.git.commit(`config: ${messages.join('; ')}`, ['config/models.yaml']);
    if (embeddingFolded)
      l.info('folded legacy embedding: block into a kind: embedding endpoint');
    if (apiKeys.length) {
      l.info({ endpoints: apiKeys }, 'folded plaintext model api keys into the secret store');
    }
    return { apiKeys, embeddingFolded };
  }

  /** Pass 2 of `healModelsYaml` — mutates `doc.endpoints` in place, returns
   *  the endpoint names it rewrote. */
  private healApiKeysInPlace(doc: Record<string, unknown>): string[] {
    const blocks: { name: string; block: Record<string, unknown> }[] = [];
    const endpoints = Array.isArray(doc.endpoints) ? doc.endpoints : [];
    for (const endpoint of endpoints) {
      if (!endpoint || typeof endpoint !== 'object') continue;
      const block = endpoint as Record<string, unknown>;
      if (typeof block.name === 'string') blocks.push({ name: block.name, block });
    }

    const healed: string[] = [];
    for (const { name, block } of blocks) {
      const value = block.api_key;
      if (typeof value !== 'string' || !value || value.startsWith('${secret:')) continue;
      const key = modelApiKeyName(name);
      const existing = this.secretStore.get(key);
      if (existing !== null && existing !== value) {
        // Pointing the endpoint at a value it was not using would swap the
        // credential silently. Leaving the plaintext is the honest failure.
        l.warn(
          { endpoint: name, key },
          'a different value is already stored under that key; leaving the plaintext key in place',
        );
        continue;
      }
      if (existing === null) {
        const stored = this.secretStore.set(key, value);
        if ('error' in stored) {
          l.warn({ endpoint: name, err: stored.error }, 'could not store the model api key');
          continue;
        }
      }
      block.api_key = `\${secret:${key}}`;
      healed.push(name);
    }
    return healed;
  }

  /** Like models(), but never throws: an invalid file also means "unconfigured". */
  modelsOrNull(): { models: ModelsYaml | null; error?: string } {
    try {
      return { models: this.models() };
    } catch (e) {
      l.warn({ err: (e as Error).message }, 'models.yaml invalid, treating as unconfigured');
      return { models: null, error: (e as Error).message };
    }
  }

  channels(): ChannelsYaml {
    return (
      loadYamlFile(
        this.home.path('config', 'channels.yaml'),
        'config/channels.yaml',
        ChannelsYamlSchema,
      ) ?? { devices: [] }
    );
  }

  /** Tool access the user granted at runtime, on top of the configured set. */
  grants(): GrantsYaml {
    return (
      loadYamlFile(
        this.home.path('config', 'grants.yaml'),
        'config/grants.yaml',
        GrantsYamlSchema,
      ) ?? { grants: [] }
    );
  }

  /** Which integrations are switched on, and their non-secret settings (G.12). */
  integrations(): IntegrationsYaml {
    return (
      loadYamlFile(
        this.home.path('config', 'integrations.yaml'),
        'config/integrations.yaml',
        IntegrationsYamlSchema,
      ) ?? { integrations: {} }
    );
  }

  mcp(): McpYaml {
    return (
      loadYamlFile(this.home.path('config', 'mcp.yaml'), 'config/mcp.yaml', McpYamlSchema, {
        secrets: this.secrets,
      }) ?? { servers: [] }
    );
  }

  /** null when onboarding has not run yet (plan §3c). */
  identity(): MarkdownDoc<Identity> | null {
    return loadMarkdownFile(
      this.home.path('config', 'identity.md'),
      'config/identity.md',
      IdentitySchema,
    );
  }

  personality(): MarkdownDoc<Personality> | null {
    return loadMarkdownFile(
      this.home.path('config', 'personality.md'),
      'config/personality.md',
      PersonalitySchema,
    );
  }

  /** Absolute path of a data-dir-relative config path. */
  file(rel: string): string {
    return path.join(this.home.root, rel);
  }
}
