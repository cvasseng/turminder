import fs from 'node:fs';
import path from 'node:path';
import matter from 'gray-matter';
import { z } from 'zod';
import { log } from '../../../core/logger.js';
import { errMessage } from '../../../core/errors.js';
import { validateWrite } from '../../validate-write.js';
import {
  secretKeySlug,
  type FieldSpec,
  type FormBroker,
  type FormOutcome,
} from '../../../chat/forms.js';
import type { RevealBroker } from '../../../chat/reveals.js';
import { DEVICE_NAME, DEVICE_NAME_MAX, type DeviceTokens } from '../../../core/tokens.js';
import type { PairingBroker } from '../../../core/pairing.js';
import type { ToolContext, ToolDefinition } from '../../types.js';
import type { Grants } from '../../dispatcher.js';
import type { GrantStore } from '../../grants.js';
import { MANIFESTS, manifestFor } from '../registry.js';
import {
  LEVEL_CHOICES,
  accessForm,
  accessResult,
  matchAccess,
  patternsToRecord,
} from './access.js';
import {
  recordFor,
  runActivation,
  runDeactivation,
  type ActivationContext,
} from './activate.js';
import {
  TEMPLATES,
  TEMPLATE_NAMES,
  effectFailure,
  type TemplateContext,
  type TemplateName,
} from './templates.js';

const l = log('tool:setup');

export interface SetupDeps extends TemplateContext, ActivationContext {
  forms: FormBroker;
  /** Where a minted token value goes — and the only place it ever exists (§24.2). */
  reveals: RevealBroker;
  /** The one door into channels.yaml (§24.1). */
  tokens: DeviceTokens;
  /** Devices waiting at their own gate for a yes (§24.4). */
  pairing: PairingBroker;
  /** Runtime tool access, and the store the approved answer is written to. */
  grants: GrantStore;
  /** The configured grant of the run asking — what it can already reach. */
  baseGrants: () => Grants;
  /** Wipe and re-derive every search index (§8.3) — memory, files, history. */
  rebuildIndexes: () => Promise<Record<string, { indexed: number; vectors: number }>>;
}

/** The subset of FieldSpec an agent may supply or override (App. F.9, D.5). */
const FieldSpecSchema = z.object({
  name: z.string().min(1),
  label: z.string().optional(),
  type: z.enum(['text', 'url', 'number', 'select', 'secret', 'choice']).optional(),
  required: z.boolean().optional(),
  value: z.union([z.string(), z.number()]).optional(),
  options: z.array(z.string()).optional(),
  // The pattern stays — it is validation, not prose. What the key is *for*
  // lives in the connecting-services skill (§21.4).
  secret_key: z
    .string()
    .regex(/^[A-Za-z0-9_.-]+$/)
    .optional(),
});
type FieldOverride = z.infer<typeof FieldSpecSchema>;

/**
 * Merge the agent's field entries onto a template's fields by name (App. F.9:
 * "templates supply their own fields, `fields` entries then override prefills
 * by name"). Names the template does not know are appended, which is what makes
 * the generic no-template form the same code path.
 */
export function mergeFields(base: FieldSpec[], overrides: FieldOverride[]): FieldSpec[] {
  const merged: FieldSpec[] = base.map((field) => {
    const patch = overrides.find((o) => o.name === field.name);
    if (!patch) return field;
    const { name: _name, ...rest } = patch;
    return { ...field, ...rest } as FieldSpec;
  });
  for (const patch of overrides) {
    if (merged.some((f) => f.name === patch.name)) continue;
    merged.push({
      label: patch.name,
      type: 'text',
      ...patch,
    } as FieldSpec);
  }
  return merged;
}

/**
 * Every secret field needs somewhere to land. The agent can name the key; when
 * it does not, derive one — prefixed by the form's own `name` field, so the
 * second connector someone adds cannot overwrite the first one's credential.
 * `{name}` is resolved against the submitted values, not the prefill, because
 * the user may well rename the thing in front of them.
 */
export function fillSecretKeys(fields: FieldSpec[]): FieldSpec[] {
  const hasName = fields.some((f) => f.name === 'name' && f.type !== 'secret');
  return fields.map((f) => {
    if (f.type !== 'secret' || f.secret_key) return f;
    const suffix = secretKeySlug(f.name);
    return { ...f, secret_key: hasName ? `{name}_${suffix}` : suffix };
  });
}

/** The shape App. F.9 promises the run, whichever way the form ended. */
function outcomeResult(outcome: FormOutcome, effect?: unknown): Record<string, unknown> {
  if (!outcome.submitted) return { submitted: false, reason: outcome.reason };
  return {
    submitted: true,
    values: outcome.values,
    secrets: outcome.secrets,
    ...(effect === undefined ? {} : { effect }),
  };
}

/**
 * The `setup` integration (App. F.9, §19). `setup.form` is the one way an agent
 * can ask the user for structured input — and the only way an MCP server gets
 * installed, because the human submitting the form, with the exact command in
 * front of them, is the install gate (§14.4.1).
 */
export function setupTools(deps: SetupDeps): ToolDefinition[] {
  return [
    {
      name: 'setup.form',
      description:
        'Ask the user for structured input with an inline form, and wait. The only way to take a credential — never as chat text. Templates install connectors on submit. choice = button row; embed_id previews an embed.',
      tier: 'se',
      args: z.object({
        title: z.string().min(1),
        template: z.enum(['mcp_stdio', 'mcp_http', 'model_endpoint']).optional(),
        embed_id: z
          .string()
          .min(1)
          .max(64)
          .optional()
          .describe('preview this embed in the form'),
        fields: z
          .array(FieldSpecSchema)
          .optional()
          .describe('with a template: prefills by name'),
      }),
      async execute(
        args: {
          title: string;
          template?: TemplateName;
          embed_id?: string;
          fields?: FieldOverride[];
        },
        ctx: ToolContext,
      ) {
        if (!ctx.conversationId) {
          return {
            error: 'no_conversation',
            message: 'forms are rendered in a chat conversation; this run has none',
          };
        }
        if (!ctx.runId) return { error: 'no_run', message: 'no run to suspend' };

        const template = args.template ? TEMPLATES[args.template] : null;
        if (args.template && !template) {
          return { error: 'unknown_template', available: TEMPLATE_NAMES };
        }

        const fields = fillSecretKeys(
          mergeFields(template ? template.fields : [], args.fields ?? []),
        );
        if (!fields.length) {
          return {
            error: 'invalid_arguments',
            detail: 'a form with no template needs at least one field',
          };
        }

        const outcome = await deps.forms.request({
          runId: ctx.runId,
          conversationId: ctx.conversationId,
          title: args.title,
          ...(template ? { template: template.name } : {}),
          // Pass-through: an id the UI cannot resolve degrades to no preview,
          // which is the right failure for a cosmetic attachment.
          ...(args.embed_id ? { embedId: args.embed_id } : {}),
          fields,
        });

        if (!outcome.submitted || !template) return outcomeResult(outcome);

        // Server-side effect: deterministic code, never the model (§19.3).
        let effect: unknown;
        try {
          effect = await template.effect(
            { values: outcome.values, secrets: outcome.secrets },
            deps,
          );
        } catch (e) {
          effect = effectFailure(e);
          l.warn({ template: template.name, err: effect }, 'template effect failed');
        }
        return outcomeResult(outcome, effect);
      },
    },
    {
      name: 'setup.request_access',
      description:
        'Ask the user to grant you tools that exist but you cannot call. Reach for it the moment something is missing — before saying you cannot help. Connected is not granted.',
      tier: 'se',
      args: z.object({
        tools: z.array(z.string().min(1)).min(1).describe('names or globs, e.g. ["github.*"]'),
        reason: z.string().min(1).describe('shown to the user verbatim'),
        description: z.string().optional().describe('what these tools do'),
      }),
      async execute(
        args: { tools: string[]; reason: string; description?: string },
        ctx: ToolContext,
      ) {
        const hub = deps.tools();
        if (!hub) return { error: 'not_ready', message: 'the tool layer is not running yet' };

        const request = {
          patterns: args.tools,
          reason: args.reason,
          ...(args.description ? { description: args.description } : {}),
        };
        const matched = matchAccess(request, hub.handles(), deps.baseGrants(), deps.grants);

        if (!matched.missing.length) {
          // Nothing to ask for: either it is already reachable, or it does not
          // exist. Both are answers the agent should act on rather than retry.
          if (matched.already.length) {
            return {
              error: 'nothing_to_grant',
              already_granted: matched.already,
              message: 'You can already call these. Try the call.',
            };
          }
          return {
            error: 'unknown_tools',
            unmatched: matched.unmatched,
            message:
              'No tool in this process matches that. Check setup.list_integrations — you may need to connect or activate something first.',
          };
        }
        if (!ctx.conversationId || !ctx.runId) {
          return {
            error: 'no_conversation',
            message:
              'granting access needs a form, and forms are rendered in a chat conversation',
          };
        }

        const form = accessForm(request, matched.missing);
        const outcome = await deps.forms.request({
          runId: ctx.runId,
          conversationId: ctx.conversationId,
          title: form.title,
          description: form.description,
          template: 'grant_access',
          fields: form.fields,
        });
        if (!outcome.submitted) return accessResult(outcome, matched, null);

        const level = LEVEL_CHOICES[String(outcome.values.decision ?? '')];
        if (!level) return accessResult(outcome, matched, null);

        const patterns = patternsToRecord(request, matched.missing);
        const source = [...new Set(matched.missing.map((t) => t.source))].join(', ');
        deps.grants.add(
          patterns.map((pattern) => ({ pattern, level, reason: args.reason, source })),
          `setup: grant ${patterns.join(', ')} to chat`,
        );
        return accessResult(outcome, matched, {
          level,
          patterns,
          callable: matched.missing.map((t) => t.name),
        });
      },
    },
    {
      name: 'setup.list_integrations',
      /**
       * The roster is the whole answer, so it must not arrive truncated
       * (§20.3, same reasoning as `docs.outline`). It grew past the default
       * 4000 the moment another integration shipped, and a half-listed
       * capability list is worse than none: the model concludes the missing
       * ones do not exist.
       */
      maxResultChars: 20_000,
      description:
        'What this assistant can connect to, and what is already connected: every bundled integration with its activation state, plus any external MCP servers. Use it whenever the user asks what you can do, what you are hooked up to, or before offering to set something up.',
      tier: 'ro',
      args: z.object({}),
      async execute() {
        const records = deps.config.integrations().integrations;
        const hub = deps.tools();
        const base = deps.baseGrants();
        /**
         * Connected is not callable (App. F.7). Reporting the difference is what
         * stops the agent reading a manual for instruments it cannot reach — and
         * points it at setup.request_access instead of at the user.
         */
        const callable = (tools: string[]) =>
          tools.filter((t) => deps.grants.covers(base, t) !== null);

        return {
          integrations: MANIFESTS.map((manifest) => ({
            name: manifest.name,
            description: manifest.description,
            activation: manifest.activation,
            // Core facilities are always on; the rest follow their record.
            active:
              manifest.activation === 'none' ? true : records[manifest.name]?.active === true,
            ...(records[manifest.name]?.activated_at
              ? { activated_at: records[manifest.name]!.activated_at }
              : {}),
            provides: manifest.provides,
          })),
          mcp_servers:
            hub?.serverStatus().map((s) => ({
              name: s.name,
              transport: s.transport,
              connected: s.connected,
              tools: s.tools,
              /** Of those, the ones you may actually call. */
              granted: callable(s.tools),
              ...(s.error ? { error: s.error } : {}),
            })) ?? [],
          /** Everything in the process you cannot call yet, whatever serves it. */
          ungranted_tools: (hub?.handles() ?? [])
            .map((t) => t.name)
            .filter((t) => deps.grants.covers(base, t) === null),
        };
      },
    },
    {
      name: 'setup.activate',
      description:
        'Turn on a bundled integration that needs a credential — it shows the user its activation form, validates what they enter, and starts using it. Ask setup.list_integrations first if you are not sure of the name. Prefill what the conversation already established.',
      tier: 'se',
      args: z.object({
        integration: z.string().min(1).describe('the integration name, e.g. asana'),
        prefill: z
          .record(z.string(), z.union([z.string(), z.number()]))
          .optional()
          .describe('field values you already know, by field name'),
      }),
      async execute(
        args: { integration: string; prefill?: Record<string, string | number> },
        ctx: ToolContext,
      ) {
        const manifest = manifestFor(args.integration);
        if (!manifest) {
          return {
            error: 'unknown_integration',
            available: MANIFESTS.map((m) => m.name),
          };
        }
        if (manifest.activation === 'none') {
          return {
            error: 'always_on',
            message: `${manifest.name} is a core facility — it needs no activation`,
          };
        }
        if (recordFor(deps.config, manifest.name)?.active) {
          return {
            error: 'already_active',
            integration: manifest.name,
            message: 'Deactivate it first if you mean to re-enter its credential.',
          };
        }
        if (!ctx.conversationId || !ctx.runId) {
          return {
            error: 'no_conversation',
            message: 'activation needs a form, and forms are rendered in a chat conversation',
          };
        }

        const fields = fillSecretKeys(
          mergeFields(
            manifest.fields ?? [],
            Object.entries(args.prefill ?? {}).map(([name, value]) => ({ name, value })),
          ),
        );
        const outcome = await deps.forms.request({
          runId: ctx.runId,
          conversationId: ctx.conversationId,
          title: `Set up ${manifest.name}`,
          template: `activate:${manifest.name}`,
          fields,
        });
        if (!outcome.submitted) return outcomeResult(outcome);

        try {
          return {
            submitted: true,
            integration: manifest.name,
            ...(await runActivation(
              manifest,
              { values: outcome.values, secrets: outcome.secrets },
              deps,
            )),
          };
        } catch (e) {
          l.warn({ integration: manifest.name, err: errMessage(e) }, 'activation failed');
          return { submitted: true, integration: manifest.name, ...effectFailure(e) };
        }
      },
    },
    /*
     * Create-blind (§24.2): the model asks for a token, the server makes one,
     * and the value goes straight to the user's screen in a transient frame.
     * The result the model sees says only that it happened — asked later "what
     * was that token?", it cannot answer, because the value was never in its
     * context to begin with. That is the whole mechanism: not a rule the model
     * follows, a shape it cannot escape.
     */
    {
      name: 'setup.token_create',
      description:
        'Create a gateway access token for a new device and show it to the user once, with a QR code to scan. You never see the value.',
      tier: 'se',
      args: z.object({
        device: z
          .string()
          .min(1)
          .max(64)
          .regex(/^[A-Za-z0-9][A-Za-z0-9_.-]*$/, 'device names are slug-shaped'),
        label: z.string().min(1).max(120).optional(),
      }),
      async execute(args: { device: string; label?: string }, ctx: ToolContext) {
        if (deps.tokens.has(args.device)) {
          return {
            error: 'device_exists',
            message: `a device named ${args.device} already has a token — revoke it first, or pick another name`,
          };
        }
        // Audience first: a token nobody saw is a liability, not a credential,
        // so no row is written when there is nowhere to reveal it (§24.2).
        if (!deps.reveals.audience) {
          return {
            error: 'no_reveal_target',
            message:
              'no connected chat device could receive the token, so none was created — ask the user to open the chat UI and try again',
          };
        }

        const created = deps.tokens.create(args.device, {
          ...(args.label ? { label: args.label } : {}),
          ...(ctx.runId ? { runId: ctx.runId } : {}),
        });
        if ('error' in created) return created;

        await deps.reveals.revealToken(deps.config.settings, created);
        // Note what is absent: the value, the URL that carries it, and the QR
        // that encodes it. The model learns that it worked, nothing more.
        return {
          device: created.device,
          label: created.label ?? null,
          created: true,
          revealed_to_user: true,
        };
      },
    },
    /*
     * The same create-blindness, arriving from the other direction (§24.4):
     * the device asked first, from a page that holds no token, and the value
     * goes back to it down the channel it is already waiting on. There is no
     * reveal to render and no QR to scan — and, unlike token_create, no
     * moment where the value is on anybody's screen.
     *
     * Note what this tool cannot do: find out what is waiting. There is no
     * `setup.pair_list`, deliberately (§24.4) — the code has to come from the
     * user, or approving stops being consent and becomes a formality the
     * model can perform on its own.
     */
    {
      name: 'setup.pair_approve',
      description:
        'Approve a device that is waiting at its own login screen, using the code it is showing. ' +
        'Ask the user for the code and for what to call the device. You never see the token.',
      tier: 'se',
      args: z.object({
        code: z.string().min(1).max(32),
        // Same rule the broker enforces at the door (G.4) — this one only
        // exists so the model hears about it before it spends a call.
        device: z
          .string()
          .min(1)
          .max(DEVICE_NAME_MAX)
          .regex(DEVICE_NAME, 'device names are slug-shaped'),
        label: z.string().min(1).max(120).optional(),
      }),
      async execute(args: { code: string; device: string; label?: string }) {
        return deps.pairing.approve(args.code, args.device, args.label);
      },
    },
    {
      name: 'setup.deactivate',
      description:
        'Turn off an integration: its poller stops and its tools disappear. The stored credential is kept, so turning it back on later is one confirmation.',
      tier: 'se',
      args: z.object({ integration: z.string().min(1) }),
      async execute(args: { integration: string }) {
        const manifest = manifestFor(args.integration);
        if (!manifest) {
          return { error: 'unknown_integration', available: MANIFESTS.map((m) => m.name) };
        }
        if (manifest.activation === 'none') {
          return {
            error: 'always_on',
            message: `${manifest.name} is a core facility — it cannot be switched off`,
          };
        }
        try {
          return runDeactivation(manifest, deps);
        } catch (e) {
          return effectFailure(e);
        }
      },
    },
    {
      name: 'setup.rebuild_index',
      description:
        'Discard and rebuild the semantic search indexes (memory, files, history) from ' +
        'their source data. Use after the embedding endpoint or model changes, or when ' +
        'search results look stale. The user confirms via a form before anything is ' +
        'discarded; searches degrade to lexical while the rebuild runs.',
      tier: 'se',
      args: z.strictObject({}),
      async execute(_args: Record<string, never>, ctx: ToolContext) {
        if (!ctx.conversationId) {
          return {
            error: 'no_conversation',
            message: 'the confirmation form renders in a chat conversation; this run has none',
          };
        }
        if (!ctx.runId) return { error: 'no_run', message: 'no run to suspend' };

        const outcome = await deps.forms.request({
          runId: ctx.runId,
          conversationId: ctx.conversationId,
          title:
            'Rebuild the search indexes? Existing vectors for memory, files and ' +
            'history are discarded and re-derived from source.',
          fields: [
            {
              name: 'confirm',
              label: 'Rebuild memory, files and history indexes',
              type: 'choice',
              options: ['Rebuild', 'Cancel'],
            },
          ],
        });

        if (!outcome.submitted) return { submitted: false, reason: outcome.reason };
        if (outcome.values.confirm !== 'Rebuild') {
          return { submitted: true, rebuilt: false, reason: 'declined' };
        }
        // Deterministic server-side effect after human approval (§19.3's shape):
        // the model asked, the user clicked, the code rebuilds.
        const stats = await deps.rebuildIndexes();
        return { submitted: true, rebuilt: true, indexes: stats };
      },
    },
    {
      name: 'setup.rename',
      description:
        'Rename yourself — this assistant instance. Rewrites config/identity.md in one ' +
        'committed step: the name always, and the self-description body when `story` is ' +
        'given (without it the old body keeps, old name swapped for new). The result lists ' +
        'files where the old name still appears; curate those yourself with memory.update ' +
        'and config.read/write where granted — they are prose, not find-and-replace.',
      tier: 'se',
      args: z.object({
        name: z.string().min(1).max(80).describe('the new instance name'),
        story: z
          .string()
          .max(4000)
          .optional()
          .describe(
            'a new identity body — who this name is and why it fits, the prose under the frontmatter',
          ),
      }),
      async execute(args: { name: string; story?: string }) {
        const identity = deps.config.identity();
        if (!identity) {
          return {
            error: 'not_onboarded',
            message: 'there is no identity yet — the first name is chosen during onboarding',
          };
        }
        const name = args.name.trim();
        if (!name) return { error: 'invalid_name', message: 'a name cannot be blank' };
        const previous = identity.frontmatter.instance_name;
        if (name === previous && args.story === undefined) {
          return { error: 'same_name', message: `this instance is already named ${previous}` };
        }

        // Whole-word, so renaming "Graf" leaves "Grafton" and file paths alone;
        // the story arg exists because prose about a new name usually wants
        // rewriting, not substitution. Two regexes on purpose: a `g` flag makes
        // `.test()` stateful across calls, and the scan below calls it per file.
        const oldNameAt = new RegExp(`\\b${escapeRegExp(previous)}\\b`);
        const everyOldName = new RegExp(oldNameAt, 'g');
        const body = args.story?.trim() ?? identity.body.replace(everyOldName, name).trim();
        const content = matter.stringify(body ? `\n${body}\n` : '', {
          ...identity.frontmatter,
          instance_name: name,
        });

        // The same one door every config write passes through (F.6): refuse
        // what the loader would reject, then write and commit.
        const check = validateWrite('config/identity.md', content);
        if (!check.ok) return { error: check.error, message: check.message };
        fs.writeFileSync(deps.home.path('config', 'identity.md'), content, 'utf8');
        const committed = deps.home.git.commit(`setup(rename): ${previous} → ${name}`, [
          'config/identity.md',
        ]);
        l.info({ previous, name, committed }, 'instance renamed');

        // Where the old name lives on: reported, never rewritten — memories and
        // personality prose are curated text, and curation is the model's job.
        const lingering: string[] = [];
        const personality = deps.home.path('config', 'personality.md');
        if (
          fs.existsSync(personality) &&
          oldNameAt.test(fs.readFileSync(personality, 'utf8'))
        ) {
          lingering.push('config/personality.md');
        }
        const memoryDir = deps.home.path('memory');
        if (fs.existsSync(memoryDir)) {
          for (const entry of fs.readdirSync(memoryDir).sort()) {
            if (!entry.endsWith('.md')) continue;
            if (oldNameAt.test(fs.readFileSync(path.join(memoryDir, entry), 'utf8'))) {
              lingering.push(`memory/${entry}`);
            }
          }
        }

        return {
          name,
          previous,
          updated: 'config/identity.md',
          committed,
          old_name_still_in: lingering,
          note: 'connected screens learn the name when they reconnect, not mid-session',
        };
      },
    },
  ];
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
