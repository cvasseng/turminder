import { z } from 'zod';

/**
 * Every config file has a schema (App. G). Objects are strict: an unknown key
 * is a typo, and a silently ignored typo in a personal assistant's config is
 * a bug you find weeks later.
 */

/**
 * ISO timestamp. gray-matter parses frontmatter with js-yaml, whose default
 * schema turns unquoted `2026-08-20T12:00:00.000Z` into a Date — accept both
 * and normalise to the string form the rest of the system uses.
 */
const iso = z.preprocess(
  (v) => (v instanceof Date ? v.toISOString() : v),
  z.string().min(1),
) as unknown as z.ZodType<string>;

/* ── config/turminder.yaml (G.1) ─────────────────────────────────────────── */

export const DataDefaultsSchema = z.strictObject({
  max_depth: z.number().int().positive().optional(),
  retry_attempts: z.number().int().nonnegative().optional(),
  retry_backoff_s: z.array(z.number().int().nonnegative()).optional(),
  budget_max_turns: z.number().int().positive().optional(),
  budget_max_tokens: z.number().int().positive().optional(),
  budget_timeout_s: z.number().int().positive().optional(),
  ingress_excerpt_chars: z.number().int().positive().optional(),
  memory_top_k: z.number().int().positive().optional(),
  chat_context_turns: z.number().int().positive().optional(),
  conversation_idle_min: z.number().int().positive().optional(),
  notify_ttl_s: z.number().int().positive().optional(),
  confirm_ttl_s: z.number().int().positive().optional(),
  confirm_timeout_s: z.number().int().positive().optional(),
  schedule_grace_s: z.number().int().nonnegative().optional(),
  form_timeout_s: z.number().int().positive().optional(),
  tool_result_max_chars: z.number().int().positive().optional(),
  elide_threshold_chars: z.number().int().positive().optional(),
  elide_after_turns: z.number().int().nonnegative().optional(),
  futile_streak_threshold: z.number().int().positive().optional(),
  spa_text_floor_chars: z.number().int().positive().optional(),
  ws_heartbeat_s: z.number().int().positive().optional(),
  ws_miss_limit: z.number().int().positive().optional(),
  embed_ttl_days: z.number().int().positive().optional(),
});

/**
 * The few settings that must be readable *before* secrets exist (§27): where
 * the store is, and which binaries open it. Deliberately loose — it ignores
 * every other key rather than validating them, because the full load does that
 * and a `${secret:}` reference in some unrelated field must not stop the
 * loader from finding out where secrets live.
 */
export const BootYamlSchema = z
  .object({
    systools: z
      .object({
        chromium: z.string().nullable().optional(),
        gpg: z.string().nullable().optional(),
        git: z.string().nullable().optional(),
      })
      .partial()
      .optional(),
    secrets: z
      .object({
        backend: z.enum(['auto', 'os', 'gpg', 'plain']).optional(),
        gpg_key: z.string().nullable().optional(),
      })
      .partial()
      .optional(),
    daemon: z.object({ notify_command: z.string().optional() }).partial().optional(),
  })
  .partial();
export type BootYaml = z.infer<typeof BootYamlSchema>;

export const TurminderYamlSchema = z.strictObject({
  bind: z.string().optional(),
  data_defaults: DataDefaultsSchema.optional(),
  search: z
    .strictObject({
      searxng_url: z.string().url().optional(),
      max_results: z.number().int().positive().optional(),
      timeout_s: z.number().int().positive().optional(),
    })
    .optional(),
  web: z
    .strictObject({
      fetch_max_chars: z.number().int().positive().optional(),
      fetch_timeout_s: z.number().int().positive().optional(),
      /** Allow fetching LAN/loopback addresses. On by default: this is a
       *  self-hosted assistant and the user's own services live there. */
      fetch_allow_private_hosts: z.boolean().optional(),
    })
    .optional(),
  scheduler: z
    .strictObject({ background_concurrency: z.number().int().positive().optional() })
    .optional(),
  files: z
    .strictObject({
      /** Point the store at an external directory (an Obsidian vault, §18.2). */
      dir: z.string().nullable().optional(),
      quiescence_s: z.number().int().positive().optional(),
      markers: z.array(z.string().min(1)).optional(),
      watch_rate_limit_s: z.number().int().positive().optional(),
    })
    .optional(),
  daemon: z
    .strictObject({
      /** Run the desktop daemon inside the service process (§7.3). */
      bundled: z.boolean().optional(),
      device: z.string().optional(),
      notify_command: z.string().optional(),
    })
    .optional(),
  chat: z
    .strictObject({
      tools: z.array(z.string()).optional(),
      /** Tools chat may see but not call without an approve/deny (App. F.7). */
      confirm: z.array(z.string()).optional(),
      /**
       * Namespaces whose granted tools are rendered in every conversation
       * (§21.2.1). Everything else granted starts as a one-line catalog entry
       * and is paged in with `tools.open`.
       */
      core_namespaces: z.array(z.string()).optional(),
      /**
       * Budgets for a chat turn. Chat is attended — the user is watching and
       * can interrupt — so it runs looser than an unattended handler.
       */
      max_turns: z.number().int().positive().optional(),
      max_tokens: z.number().int().positive().optional(),
      timeout_s: z.number().int().positive().optional(),
    })
    .optional(),
  systools: z
    .strictObject({
      /** Absolute path to a chromium build; null probes $PATH (§23.1). */
      chromium: z.string().nullable().optional(),
      /** Absolute path to gpg for the §27.1 `gpg` secret backend. */
      gpg: z.string().nullable().optional(),
      /** Absolute path to git for data-repo versioning (§12.2). */
      git: z.string().nullable().optional(),
    })
    .optional(),
  secrets: z
    .strictObject({
      /**
       * Where secrets live at rest (§27.1). `auto` is the pre-onboarding
       * default and resolves to a concrete choice when the user picks one; a
       * pinned backend that stops working is a startup failure, never a
       * silent downgrade.
       */
      backend: z.enum(['auto', 'os', 'gpg', 'plain']).optional(),
      /** Recipient key id, `gpg` backend only. */
      gpg_key: z.string().nullable().optional(),
    })
    .optional(),
  uploads: z
    .strictObject({
      /** §26.1 — chat attachments; images only in v1. */
      max_mb: z.number().int().positive().optional(),
      ttl_days: z.number().int().positive().optional(),
      /** §26.3 — how many recent user turns keep their image parts. */
      image_context_turns: z.number().int().nonnegative().optional(),
    })
    .optional(),
  gateway: z
    .strictObject({
      /**
       * The URL a second device should connect to (§24.3). null = guess from
       * the primary non-loopback interface, which is wrong often enough on
       * multi-homed and tailnet boxes that the guess is flagged to the user.
       */
      public_url: z.string().url().nullable().optional(),
    })
    .optional(),
  retention_days: z.number().int().positive().optional(),
});
export type TurminderYaml = z.infer<typeof TurminderYamlSchema>;

/* ── config/models.yaml (G.2) ────────────────────────────────────────────── */

export const ModelClassSchema = z.enum(['fast', 'best']);
export type ModelClass = z.infer<typeof ModelClassSchema>;

export const ModelCapSchema = z.enum(['json', 'tools', 'long_context', 'vision']);
export type ModelCap = z.infer<typeof ModelCapSchema>;

/** Reasoning levels an endpoint may declare (§10.6, G.2). */
export const ModelEffortSchema = z.enum(['low', 'medium', 'high', 'xhigh']);
export type ModelEffort = z.infer<typeof ModelEffortSchema>;

export const ModelEndpointSchema = z.strictObject({
  name: z.string().min(1),
  url: z.string().min(1),
  api_key: z.string().optional(),
  model: z.string().optional(),
  classes: z.array(ModelClassSchema).min(1),
  caps: z.array(ModelCapSchema).default([]),
  context_size: z.number().int().positive().optional(),
  /**
   * Reasoning levels this model honors (§10.6). Omitted means the knob is
   * never sent — an endpoint that has not said it understands
   * `reasoning_effort` does not get handed it, and its own default stands
   * unguessed. An empty list is a typo, not a declaration.
   */
  efforts: z.array(ModelEffortSchema).min(1).optional(),
  /** Hard cap on concurrent in-flight calls for this endpoint (§10.3). */
  concurrency: z.number().int().positive().optional(),
  /**
   * Pricing per million tokens (§10.5). Omit the block entirely for a
   * costless local box: absent means **costless by declaration**, reported as
   * `local` rather than `0.00`, because free and unpriced are different
   * statements.
   */
  cost: z
    .strictObject({
      in_per_mtok: z.number().nonnegative(),
      out_per_mtok: z.number().nonnegative(),
      currency: z.string().min(1),
    })
    .optional(),
});
export type ModelEndpoint = z.infer<typeof ModelEndpointSchema>;

export const ModelsYamlSchema = z.strictObject({
  endpoints: z.array(ModelEndpointSchema).min(1),
  embedding: z
    .strictObject({
      url: z.string().min(1),
      model: z.string().optional(),
      api_key: z.string().optional(),
    })
    .optional(),
});
export type ModelsYaml = z.infer<typeof ModelsYamlSchema>;

/* ── config/channels.yaml (G.4) ──────────────────────────────────────────── */

/**
 * One device row (§24, G.4). `token_sha256` is what a row holds; the plaintext
 * `token` is the pre-§24 form, accepted on load only so `healLegacy()` can
 * rewrite it — a row carrying neither is a load error, because a device that
 * cannot authenticate anything is a typo, not a configuration.
 */
export const ChannelsDeviceSchema = z
  .strictObject({
    device: z.string().min(1),
    token: z.string().min(8).optional(),
    token_sha256: z
      .string()
      .regex(/^[0-9a-f]{64}$/, 'token_sha256 must be 64 lowercase hex characters')
      .optional(),
    label: z.string().min(1).optional(),
    created_at: z.string().min(1).optional(),
    created_by_run: z.string().min(1).optional(),
  })
  .refine((d) => d.token !== undefined || d.token_sha256 !== undefined, {
    message: 'a device needs token_sha256 (or a legacy token to be healed into one)',
  });
export type ChannelsDevice = z.infer<typeof ChannelsDeviceSchema>;

export const ChannelsYamlSchema = z.strictObject({
  devices: z.array(ChannelsDeviceSchema).default([]),
});
export type ChannelsYaml = z.infer<typeof ChannelsYamlSchema>;

/* ── event payloads with server-enforced caps (App. A, App. B) ───────────── */

/** App. A capture caps (§29.3). Client-side truncation is UX; this is the contract. */
export const CAPTURE_MAX_CHARS = 100_000;
export const CAPTURE_FIELD_MAX_CHARS = 4000;
export const CAPTURE_NOTE_MAX_CHARS = 2000;

/**
 * `page.captured` (§29.3, App. B) — the browser extension's one event.
 *
 * `note` is the only user-authored field and is declared in the App. B trust
 * map, so it renders outside the fence; everything else came off a page and
 * stays inside it. Caps are enforced here because the client's truncation is a
 * courtesy and the server's is the rule.
 */
export const PageCapturedPayload = z.strictObject({
  url: z.string().min(1),
  title: z.string().default(''),
  domain: z.string().default(''),
  matcher: z.string().default('fulltext'),
  fields: z.record(z.string(), z.string().max(CAPTURE_FIELD_MAX_CHARS)).optional(),
  content: z.string().max(CAPTURE_MAX_CHARS),
  note: z.string().max(CAPTURE_NOTE_MAX_CHARS).optional(),
  truncated: z.boolean().default(false),
});
export type PageCaptured = z.infer<typeof PageCapturedPayload>;

/* ── config/mcp.yaml (G.5) ───────────────────────────────────────────────── */

export const McpServerSchema = z
  .strictObject({
    name: z.string().min(1),
    transport: z.enum(['stdio', 'http']),
    /**
     * One line on what this server is for. Shown in the closed-namespace
     * catalog (§21.2.2), where the alternative is three tool names and a
     * guess. Optional because most `mcp.yaml` entries are hand-written.
     */
    description: z.string().optional(),
    command: z.array(z.string()).optional(),
    url: z.string().optional(),
    env: z.record(z.string(), z.string()).optional(),
    /**
     * http servers only. `${secret:KEY}` references are resolved at load like
     * anywhere else, which is how an http MCP server gets a credential without
     * one appearing in a committed file (§19.3).
     */
    headers: z.record(z.string(), z.string()).optional(),
    /** Tools from this server are side-effecting unless listed here. */
    read_only_tools: z.array(z.string()).optional(),
  })
  .refine((s) => (s.transport === 'stdio' ? Boolean(s.command?.length) : Boolean(s.url)), {
    message: 'stdio servers need `command`, http servers need `url`',
  });

export const McpYamlSchema = z.strictObject({
  servers: z.array(McpServerSchema).default([]),
});
export type McpYaml = z.infer<typeof McpYamlSchema>;

/* ── config/integrations.yaml (G.12, §19.5) ──────────────────────────────── */

export const IntegrationRecordSchema = z.strictObject({
  active: z.boolean().default(true),
  activated_at: iso.optional(),
  /** Non-secret only: poll intervals, account identifiers. Secrets go to G.6. */
  settings: z.record(z.string(), z.unknown()).default({}),
});
export type IntegrationRecord = z.infer<typeof IntegrationRecordSchema>;

export const IntegrationsYamlSchema = z.strictObject({
  integrations: z.record(z.string(), IntegrationRecordSchema).default({}),
});
export type IntegrationsYaml = z.infer<typeof IntegrationsYamlSchema>;

/* ── config/grants.yaml — tool access the user granted through a form ────── */

export const GrantLevelSchema = z.enum(['tools', 'confirm']);
export type GrantLevel = z.infer<typeof GrantLevelSchema>;

/**
 * One grant the user approved at runtime. Recorded rather than folded into
 * `chat.tools` because provenance is the point: who asked, why, and when.
 */
export const GrantRecordSchema = z.strictObject({
  pattern: z.string().min(1),
  /** `tools` auto-executes; `confirm` stays human-gated per call (App. F.7). */
  level: GrantLevelSchema.default('tools'),
  granted_at: iso.optional(),
  /** What the assistant said it needed this for, in its own words. */
  reason: z.string().optional(),
  /** Which integration or MCP server serves it, for the "what is this" question. */
  source: z.string().optional(),
});
export type GrantRecord = z.infer<typeof GrantRecordSchema>;

export const GrantsYamlSchema = z.strictObject({
  grants: z.array(GrantRecordSchema).default([]),
});
export type GrantsYaml = z.infer<typeof GrantsYamlSchema>;

/* ── config/identity.md + personality.md (G.3) ───────────────────────────── */

export const IdentitySchema = z.strictObject({
  instance_name: z.string().min(1),
  user_name: z.string().min(1),
  timezone: z.string().default('UTC'),
  locale: z.string().default('en'),
  onboarded_at: iso.optional(),
});
export type Identity = z.infer<typeof IdentitySchema>;

export const PersonalitySchema = z.strictObject({
  formality: z.enum(['relaxed', 'neutral', 'formal']).default('neutral'),
  verbosity: z.enum(['terse', 'normal', 'chatty']).default('normal'),
  humor: z.enum(['dry', 'none', 'playful']).default('dry'),
});
export type Personality = z.infer<typeof PersonalitySchema>;

/* ── handlers/<name>.md (G.7) ────────────────────────────────────────────── */

export const HandlerFrontmatterSchema = z.strictObject({
  name: z.string().min(1),
  description: z.string().min(1),
  match: z
    .strictObject({
      types: z.array(z.string()).optional(),
      sources: z.array(z.string()).optional(),
    })
    .optional(),
  model_class: ModelClassSchema.default('fast'),
  /**
   * Pin this handler to one endpoint by name (§10.6) — for the behaviour that
   * must run local for privacy, or hosted for quality. Mutually exclusive
   * with `model_class`: two answers to "which model" is how a pin quietly
   * stops applying.
   */
  endpoint: z.string().min(1).optional(),
  /**
   * How hard the model should think for this behaviour (§10.6, G.2
   * `efforts:`). Most handlers are mechanical — file this, notify that — and
   * do not need a reasoning budget; declaring `low` is how a behaviour says
   * so. Sent only if the endpoint that serves the run declares the level, so
   * a handler asking for one on a model that never claimed to understand the
   * knob costs nothing and changes nothing.
   */
  effort: ModelEffortSchema.optional(),
  tools: z.array(z.string()).default([]),
  confirm: z.array(z.string()).default([]),
  /** File-store subscription (§18.4 tier 3): store-relative path globs. */
  watch: z.array(z.string().min(1)).default([]),
  /**
   * Embed binding (§22.5): with no explicit `match:`, this handler fires only
   * for `embed.action` from this embed — and is deleted with it.
   */
  embed: z.string().min(1).optional(),
  budgets: z
    .strictObject({
      max_turns: z.number().int().positive().optional(),
      max_tokens: z.number().int().positive().optional(),
      timeout_s: z.number().int().positive().optional(),
    })
    .optional(),
  enabled: z.boolean().default(true),
});
export type HandlerFrontmatter = z.infer<typeof HandlerFrontmatterSchema>;

/* ── skills/<name>.md (G.8) ──────────────────────────────────────────────── */

export const SkillFrontmatterSchema = z.strictObject({
  name: z.string().min(1),
  description: z.string().min(1),
});
export type SkillFrontmatter = z.infer<typeof SkillFrontmatterSchema>;

/* ── memory/<name>.md (G.9) ──────────────────────────────────────────────── */

export const MemoryTypeSchema = z.enum(['fact', 'preference', 'note', 'reference']);
export type MemoryType = z.infer<typeof MemoryTypeSchema>;

export const MemoryFrontmatterSchema = z.strictObject({
  name: z.string().min(1),
  description: z.string().min(1),
  type: MemoryTypeSchema,
  created: iso,
  updated: iso,
  /**
   * The project island this memory belongs to (§31.2, G.9). Absent means
   * general: retrievable everywhere, which is what every memory written
   * before projects existed is.
   */
  project: z.string().min(1).optional(),
});
export type MemoryFrontmatter = z.infer<typeof MemoryFrontmatterSchema>;

/* ── files/projects/<name>/project.md (§31.2, G.14) ──────────────────────── */

/** The slug: kebab, ≤ 50 chars, and the directory name it lives under. */
export const PROJECT_SLUG_MAX = 50;
/** One line, the roster entry that rides every system prompt. */
export const PROJECT_DESCRIPTION_MAX = 140;
export const PROJECT_SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export const ProjectFrontmatterSchema = z.strictObject({
  name: z.string().min(1).max(PROJECT_SLUG_MAX).regex(PROJECT_SLUG_RE),
  description: z.string().min(1).max(PROJECT_DESCRIPTION_MAX),
});
export type ProjectFrontmatter = z.infer<typeof ProjectFrontmatterSchema>;
