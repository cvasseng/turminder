import fs from 'node:fs';
import YAML from 'yaml';
import { log } from '../../../core/logger.js';
import { errMessage } from '../../../core/errors.js';
import type { Config } from '../../../core/config.js';
import type { DataHome } from '../../../core/datadir.js';
import { McpServerSchema, ModelEndpointSchema } from '../../../core/config-schemas.js';
import { normaliseEndpointUrl, probeEndpoint, probeSpeech } from '../../../model/probe.js';
import type { FieldSpec, FormValues } from '../../../chat/forms.js';
import type { ToolHub } from '../../hub.js';

const l = log('tool:setup');

export type TemplateName = 'mcp_stdio' | 'mcp_http' | 'model_endpoint' | 'speech_endpoint';

export interface TemplateContext {
  home: DataHome;
  config: Config;
  /** Resolved late: the hub is built after the integration that uses it. */
  tools: () => ToolHub | null;
  /** Rebuilds the model stack after models.yaml changes. */
  reloadModels: () => boolean;
  fetch?: typeof globalThis.fetch;
}

export interface TemplateSubmission {
  values: FormValues;
  /** `${secret:KEY}` references, keyed by field name (§19.2). */
  secrets: Record<string, string>;
}

export interface ConnectorTemplate {
  name: TemplateName;
  title: string;
  /**
   * Static for most templates. `model_endpoint`'s `classes` prefill depends on
   * whether this install already has a chat endpoint (§10.6) — a function
   * form is resolved with the ctx at the moment the form is requested.
   */
  fields: FieldSpec[] | ((ctx: TemplateContext) => FieldSpec[]);
  /**
   * Deterministic code, not the model (§19.3): validate, write config, connect,
   * probe, report. Throwing is fine — the caller reports the failure to the run.
   */
  effect(submission: TemplateSubmission, ctx: TemplateContext): Promise<unknown>;
}

/** Resolve a template's fields against the ctx it is being requested with. */
export function templateFields(template: ConnectorTemplate, ctx: TemplateContext): FieldSpec[] {
  return typeof template.fields === 'function' ? template.fields(ctx) : template.fields;
}

/* ── Raw YAML I/O ─────────────────────────────────────────────────────────── */

/**
 * Read a config file *without* resolving `${secret:KEY}` references. Editing a
 * file through the normal loader would expand them and write the expansion
 * back — i.e. commit the credential. So the editing path never uses it.
 */
export function readRaw(file: string): Record<string, unknown> {
  if (!fs.existsSync(file)) return {};
  const parsed = YAML.parse(fs.readFileSync(file, 'utf8')) as unknown;
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : {};
}

export function writeRaw(home: DataHome, rel: string, doc: unknown, message: string): boolean {
  fs.writeFileSync(home.path(rel), YAML.stringify(doc), 'utf8');
  return home.git.commit(message, [rel]);
}

/** Replace the entry with this `name`, or append it. Order is otherwise kept. */
export function upsertByName<T extends { name: string }>(list: T[], entry: T): T[] {
  const i = list.findIndex((e) => e.name === entry.name);
  if (i < 0) return [...list, entry];
  const next = [...list];
  next[i] = entry;
  return next;
}

/**
 * Split a command line the way a shell would, minus the parts an assistant has
 * no business with: no expansion, no substitution, no operators — just quoting.
 */
export function splitCommand(line: string): string[] {
  const out: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;
  let started = false;
  for (const ch of line.trim()) {
    if (quote) {
      if (ch === quote) quote = null;
      else current += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      started = true;
      continue;
    }
    if (/\s/.test(ch)) {
      if (started || current) out.push(current);
      current = '';
      started = false;
      continue;
    }
    current += ch;
  }
  if (started || current) out.push(current);
  if (quote) throw new Error('unbalanced quote in the command');
  return out;
}

/**
 * Read back the value behind a `${secret:KEY}` reference. Only the two places
 * that must talk to the credentialed service do this — a probe cannot validate
 * a key it cannot send.
 */
export function resolveRef(config: Config, ref: string | undefined): string | undefined {
  const key = ref?.match(/^\$\{secret:(.+)\}$/)?.[1];
  return key ? config.secrets[key] : undefined;
}

const SERVER_NAME = /^[a-z0-9][a-z0-9._-]*$/i;

function serverName(values: FormValues): string {
  const name = String(values.name ?? '').trim();
  if (!SERVER_NAME.test(name)) {
    throw new Error(`"${name}" is not a usable server name — letters, digits, dash, dot`);
  }
  return name;
}

/**
 * Write one entry into config/mcp.yaml, connect it, and report its tools. The
 * file is rolled back when the server will not come up, so a failed attempt
 * leaves no dead entry behind.
 */
/**
 * The optional `description:` the paging catalog reads (§21.2.2). Asked for on
 * the form because the run installing a server has just worked out what it is
 * for — and the alternative catalog line is three tool names and a guess.
 */
function describedBy(values: FormValues): { description?: string } {
  const description = String(values.description ?? '').trim();
  return description ? { description } : {};
}

async function installMcp(
  entry: Record<string, unknown>,
  ctx: TemplateContext,
): Promise<unknown> {
  const parsed = McpServerSchema.safeParse(entry);
  if (!parsed.success) {
    return {
      installed: false,
      error: 'invalid_server',
      detail: parsed.error.issues
        .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
        .join('; '),
    };
  }

  const file = ctx.home.path('config', 'mcp.yaml');
  const before = readRaw(file);
  const servers = Array.isArray(before.servers) ? (before.servers as { name: string }[]) : [];
  const next = { ...before, servers: upsertByName(servers, parsed.data as { name: string }) };
  writeRaw(ctx.home, 'config/mcp.yaml', next, `setup: connect mcp server ${parsed.data.name}`);
  ctx.config.reload();

  const hub = ctx.tools();
  if (!hub) {
    return { installed: true, connected: false, error: 'the tool layer is not running yet' };
  }
  const status = await hub.connectExternal(parsed.data.name);
  if (!status.connected) {
    // Roll back: an entry that cannot connect is retried on every restart and
    // explains nothing. Keep the error, drop the config.
    const rolled = { ...before, servers };
    writeRaw(
      ctx.home,
      'config/mcp.yaml',
      servers.length ? rolled : { servers: [] },
      `setup: back out mcp server ${parsed.data.name} (would not connect)`,
    );
    ctx.config.reload();
    return { installed: false, connected: false, error: status.error ?? 'connection failed' };
  }
  l.info({ server: parsed.data.name, tools: status.tools }, 'mcp server installed');
  return {
    installed: true,
    connected: true,
    tools: status.tools,
    // Connecting a server is not the same as being allowed to use it (App.
    // F.7). Say so here, at the moment the caller could otherwise assume it.
    granted: false,
    next_step:
      status.tools.length > 0
        ? `You cannot call these yet. Ask the user with setup.request_access {tools: ["${parsed.data.name}.*"]}.`
        : 'The server connected but served no tools.',
  };
}

/* ── The shipped templates (§19.3) ────────────────────────────────────────── */

const mcpStdio: ConnectorTemplate = {
  name: 'mcp_stdio',
  title: 'Connect an MCP server (local command)',
  fields: [
    { name: 'name', label: 'Short name for this server', type: 'text' },
    {
      name: 'description',
      label: 'One line on what this server is for',
      type: 'text',
      required: false,
    },
    {
      name: 'command',
      label: 'Exact command to run, e.g. npx -y @modelcontextprotocol/server-github',
      type: 'text',
    },
    {
      name: 'env_var',
      label: 'Environment variable the server reads its credential from (blank if none)',
      type: 'text',
      required: false,
    },
    {
      name: 'credential',
      label: 'The credential itself — stored in secrets/secrets.yaml, never shown to the model',
      type: 'secret',
      required: false,
    },
  ],
  async effect({ values, secrets }, ctx) {
    const name = serverName(values);
    const command = splitCommand(String(values.command ?? ''));
    if (!command.length) throw new Error('the command is empty');
    const envVar = String(values.env_var ?? '').trim();
    const ref = secrets.credential;
    if (ref && !envVar) {
      return {
        installed: false,
        error: 'invalid_server',
        detail: 'a credential was supplied but no environment variable to put it in',
      };
    }
    return installMcp(
      {
        name,
        transport: 'stdio',
        ...describedBy(values),
        command,
        ...(ref && envVar ? { env: { [envVar]: ref } } : {}),
      },
      ctx,
    );
  },
};

const mcpHttp: ConnectorTemplate = {
  name: 'mcp_http',
  title: 'Connect an MCP server (http endpoint)',
  fields: [
    { name: 'name', label: 'Short name for this server', type: 'text' },
    {
      name: 'description',
      label: 'One line on what this server is for',
      type: 'text',
      required: false,
    },
    { name: 'url', label: 'Base URL of the MCP endpoint', type: 'url' },
    {
      name: 'auth_header',
      label: 'Header to send the credential in',
      type: 'text',
      required: false,
      value: 'Authorization',
    },
    {
      name: 'credential',
      label:
        'Full header value, including any scheme prefix (e.g. "Bearer ghp_…") — stored in secrets/secrets.yaml',
      type: 'secret',
      required: false,
    },
  ],
  async effect({ values, secrets }, ctx) {
    const name = serverName(values);
    const header = String(values.auth_header ?? 'Authorization').trim() || 'Authorization';
    const ref = secrets.credential;
    return installMcp(
      {
        name,
        transport: 'http',
        ...describedBy(values),
        url: String(values.url ?? '').trim(),
        ...(ref ? { headers: { [header]: ref } } : {}),
      },
      ctx,
    );
  },
};

const CLASS_CHOICES: Record<string, ('fast' | 'best')[]> = {
  'fast and best': ['fast', 'best'],
  fast: ['fast'],
  best: ['best'],
};

const modelEndpoint: ConnectorTemplate = {
  name: 'model_endpoint',
  title: 'Add a model endpoint',
  /**
   * The `classes` prefill is only honest on an install with no other chat
   * endpoint (§10.6): "fast and best" is a reasonable default for the first
   * one, and furniture — or actively wrong — for a second, where the whole
   * point is usually to split fast from best. So a second endpoint gets no
   * prefill; the human chooses.
   */
  fields: (ctx) => {
    const doc = readRaw(ctx.home.path('config', 'models.yaml'));
    const hasChatEndpoint = Array.isArray(doc.endpoints)
      ? (doc.endpoints as Record<string, unknown>[]).some(
          (e) => e && typeof e === 'object' && (e.kind ?? 'chat') === 'chat',
        )
      : false;
    return [
      { name: 'name', label: 'Short name for this endpoint', type: 'text' },
      {
        name: 'url',
        label: 'OpenAI-compatible base URL, e.g. http://localhost:8080/v1',
        type: 'url',
      },
      {
        name: 'api_key',
        label: 'API key, if the endpoint needs one — stored in secrets/secrets.yaml',
        type: 'secret',
        required: false,
      },
      {
        name: 'classes',
        label: hasChatEndpoint
          ? 'What to use it for — this install already has a chat endpoint, so choose deliberately (e.g. split fast from best) rather than accept a default'
          : 'What to use it for — the first endpoint usually serves everything',
        type: 'select',
        options: Object.keys(CLASS_CHOICES),
        ...(hasChatEndpoint ? {} : { value: 'fast and best' }),
      },
    ];
  },
  /**
   * Probe, don't ask (plan §3b): the same suite the first-run setup page uses,
   * so capability tags come from what the endpoint actually did.
   */
  async effect({ values, secrets }, ctx) {
    const name = serverName(values);
    const url = normaliseEndpointUrl(String(values.url ?? '')).api;
    // The probe needs the real key, so resolve the reference we just wrote.
    const ref = secrets.api_key;
    const apiKey = resolveRef(ctx.config, ref);
    const probe = await probeEndpoint(url, {
      ...(apiKey ? { apiKey } : {}),
      ...(ctx.fetch ? { fetch: ctx.fetch } : {}),
      timeoutMs: 90_000,
    });
    if (!probe.reachable) {
      return { added: false, error: 'unreachable', detail: probe.error, notes: probe.notes };
    }

    const endpoint = ModelEndpointSchema.parse({
      name,
      kind: 'chat',
      url,
      ...(probe.model_id ? { model: probe.model_id } : {}),
      ...(ref ? { api_key: ref } : {}),
      classes: CLASS_CHOICES[String(values.classes ?? 'fast and best')] ?? ['fast', 'best'],
      caps: probe.caps,
      ...(probe.context_size ? { context_size: probe.context_size } : {}),
    });

    const file = ctx.home.path('config', 'models.yaml');
    const doc = readRaw(file);
    const existing = Array.isArray(doc.endpoints) ? (doc.endpoints as { name: string }[]) : [];
    // No embedding auto-add here (§10.6 v2): this template adds `kind: chat`
    // endpoints only — an embedding endpoint is added by the first-run setup
    // wizard or by hand; there is deliberately no chat-driven route to one
    // (multi-endpoint setup UI is out of scope, LIMITS.md).
    const next: Record<string, unknown> = {
      ...doc,
      endpoints: upsertByName(existing, endpoint as { name: string }),
    };
    writeRaw(ctx.home, 'config/models.yaml', next, `setup: add model endpoint ${name}`);

    const loaded = ctx.reloadModels();
    l.info({ endpoint: name, caps: probe.caps, loaded }, 'model endpoint added');
    return {
      added: true,
      endpoint: name,
      caps: probe.caps,
      context_size: probe.context_size ?? null,
      model_id: probe.model_id ?? null,
      smoke: probe.smoke ?? null,
      notes: probe.notes,
      models_loaded: loaded,
    };
  },
};

/**
 * A transcriber or a synthesiser (§10.9, F.9). Deliberately the *same* shape as
 * `model_endpoint`: probe first, refuse on failure, write one entry, reload.
 *
 * The `voice` field is free text here rather than a pick from the endpoint's
 * listing, because the listing lives behind a URL the form is asking for — it
 * cannot be read before the answer exists. Choosing a voice from what the
 * endpoint actually offers, with a preview, is `setup.voice`'s job (§33.5);
 * this form's result names the voices it found so the assistant can say so.
 */
const speechEndpoint: ConnectorTemplate = {
  name: 'speech_endpoint',
  title: 'Connect a transcriber or a speech synthesiser',
  fields: [
    {
      name: 'kind',
      label: 'What it does — stt turns speech into text, tts turns text into speech',
      type: 'choice',
      options: ['stt', 'tts'],
    },
    { name: 'name', label: 'Short name for this endpoint', type: 'text' },
    {
      name: 'url',
      label: 'OpenAI-audio-compatible base URL, e.g. http://localhost:8000/v1',
      type: 'url',
    },
    {
      name: 'api_key',
      label: 'API key, if the endpoint needs one — stored in secrets/secrets.yaml',
      type: 'secret',
      required: false,
    },
    {
      name: 'model',
      label: 'Model to use — blank takes the first the endpoint lists',
      type: 'text',
      required: false,
    },
    {
      name: 'voice',
      label: 'tts only: the voice to speak with (change it later with setup.voice)',
      type: 'text',
      required: false,
    },
    {
      name: 'language',
      label: 'stt only: the language to transcribe — blank follows the identity locale',
      type: 'text',
      required: false,
    },
  ],
  async effect({ values, secrets }, ctx) {
    const name = serverName(values);
    const kind = String(values.kind ?? '').trim();
    if (kind !== 'stt' && kind !== 'tts') {
      return {
        added: false,
        error: 'bad_kind',
        detail: `kind must be stt or tts, not "${kind}"`,
      };
    }
    const url = normaliseEndpointUrl(String(values.url ?? '')).api;
    const ref = secrets.api_key;
    const apiKey = resolveRef(ctx.config, ref);
    const model = String(values.model ?? '').trim();
    const voice = String(values.voice ?? '').trim();
    const language = String(values.language ?? '').trim();

    const probe = await probeSpeech(kind, url, {
      ...(apiKey ? { apiKey } : {}),
      ...(model ? { model } : {}),
      ...(kind === 'tts' && voice ? { voice } : {}),
      ...(ctx.fetch ? { fetch: ctx.fetch } : {}),
      timeoutMs: 90_000,
    });
    // Nothing is written by a probe that did not pass: an entry that cannot
    // transcribe is worse than no entry, because `routes` would point at it.
    const passed = 'matched' in probe ? probe.matched : probe.ok;
    if (!passed) {
      return {
        added: false,
        error: probe.reachable ? 'probe_failed' : 'unreachable',
        detail: probe.error ?? null,
        ...('transcript' in probe && probe.transcript ? { transcript: probe.transcript } : {}),
      };
    }

    const endpoint = ModelEndpointSchema.parse({
      name,
      kind,
      url,
      ...(model || probe.model_id ? { model: model || probe.model_id } : {}),
      ...(ref ? { api_key: ref } : {}),
      ...(kind === 'tts' && voice ? { voice } : {}),
      ...(kind === 'stt' && language ? { language } : {}),
    });

    const file = ctx.home.path('config', 'models.yaml');
    const doc = readRaw(file);
    const existing = Array.isArray(doc.endpoints) ? (doc.endpoints as { name: string }[]) : [];
    const routes = (doc.routes ?? {}) as Record<string, unknown>;
    // Route the purpose here only when nothing does yet: the first transcriber
    // an install gets should just work, and a second one must not silently
    // steal the route from the one that was chosen (§10.6).
    const routed = routes[kind] === undefined;
    const next: Record<string, unknown> = {
      ...doc,
      endpoints: upsertByName(existing, endpoint as { name: string }),
      routes: routed ? { ...routes, [kind]: { endpoint: name } } : routes,
    };
    writeRaw(ctx.home, 'config/models.yaml', next, `setup: add ${kind} endpoint ${name}`);

    const loaded = ctx.reloadModels();
    l.info({ endpoint: name, kind, routed, loaded }, 'speech endpoint added');
    return {
      added: true,
      endpoint: name,
      kind,
      model_id: probe.model_id ?? null,
      routed,
      ...('transcript' in probe ? { transcript: probe.transcript ?? null } : {}),
      ...('sample_rate' in probe ? { sample_rate: probe.sample_rate ?? null } : {}),
      ...('voices' in probe && probe.voices ? { voices: probe.voices } : {}),
      models_loaded: loaded,
    };
  },
};

export const TEMPLATES: Record<TemplateName, ConnectorTemplate> = {
  mcp_stdio: mcpStdio,
  mcp_http: mcpHttp,
  model_endpoint: modelEndpoint,
  speech_endpoint: speechEndpoint,
};

export const TEMPLATE_NAMES = Object.keys(TEMPLATES) as TemplateName[];

/** Reported to the run when an effect throws, rather than failing the tool. */
export function effectFailure(e: unknown): { ok: false; error: string } {
  return { ok: false, error: errMessage(e) };
}
