import fs from 'node:fs';
import path from 'node:path';
import matter from 'gray-matter';
import { z } from 'zod';
import { parseFrontmatter, type Config } from '../../core/config.js';
import type { DataHome } from '../../core/datadir.js';
import { globMatchAny } from '../../core/glob.js';
import { log } from '../../core/logger.js';
import type { FieldSpec, FormBroker } from '../../chat/forms.js';
import type { ModelRouter } from '../../model/router.js';
import type { GrantStore } from '../grants.js';
import { resolveWritablePath } from '../paths.js';
import type { ToolContext, ToolDefinition, ToolHandle } from '../types.js';
import { validateWrite } from '../validate-write.js';
import { APPROVED_KEYS, routeHandlerFrontmatter } from './config.js';
import { matchAccess } from './setup/access.js';

const l = log('tool:handler');

export interface HandlerToolsDeps {
  home: DataHome;
  /** Read at call time: `form_timeout_s` is reloadable (App. A). */
  config: Config;
  /** The one form broker (§19.1) — the grant form and the routing form both. */
  forms: FormBroker;
  /** Live, for the routing form (F.6): the model stack is rebuilt on reload. */
  router: () => ModelRouter | null;
  /** Late-bound: the catalog grants are checked against is the hub's (§19.4). */
  tools: () => { handles(): ToolHandle[] } | null;
  /** `matchAccess` takes it; a handler's grant ignores what chat can reach. */
  grants: GrantStore;
  /** Drop the handler loader's cache after a write (F.6), for `consumers`. */
  onHandlersChanged?: () => void;
}

/** The two answers per tool (F.7's `tools` and `confirm` levels, D.5). */
const ON_ITS_OWN = 'On its own';
const ASK_EACH_TIME = 'Ask me each time';

/** `handlers/<name>.md` — the loader insists the name equals the filename. */
const NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** The approved half of a handler (F.20), in the shape the file carries it. */
interface Approved {
  types: string[];
  sources: string[];
  watch: string[];
  embed?: string;
  tools: string[];
  confirm: string[];
}

type Refusal = { error: string; message: string; [k: string]: unknown };

const globs = z.array(z.string().min(1));

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

function approvedOf(data: Record<string, unknown>): Approved {
  const match = (data.match ?? {}) as Record<string, unknown>;
  return {
    types: strings(match.types),
    sources: strings(match.sources),
    watch: strings(data.watch),
    ...(typeof data.embed === 'string' ? { embed: data.embed } : {}),
    tools: strings(data.tools),
    confirm: strings(data.confirm),
  };
}

const sameSet = (a: string[], b: string[]) =>
  a.length === b.length && [...a].sort().join('\n') === [...b].sort().join('\n');

/**
 * One sentence is enough to judge a tool by — the same cut the access form
 * makes (§19.4), taken from the tool's *catalog* description, never from
 * anything the model wrote about its own request (§11.3).
 */
function firstSentence(text: string): string {
  const trimmed = text.trim().replace(/\s+/g, ' ');
  const stop = trimmed.search(/\.\s|\.$/);
  const sentence = stop > 0 ? trimmed.slice(0, stop + 1) : trimmed;
  return sentence.length > 160 ? `${sentence.slice(0, 157)}…` : sentence;
}

/**
 * §5.2: a handler with no matcher is offered every event. That is a real thing
 * to want, and a very easy thing to write by accident — so it has to be said.
 * `watch` is deliberately not a matcher here, because it is not one in
 * `matches()`: the handler it subscribes still sees every other event too.
 */
function catchAllRefusal(a: Approved, catchAll: boolean): Refusal | null {
  if (catchAll || a.types.length || a.sources.length || a.embed) return null;
  return {
    error: 'catch_all',
    message: a.watch.length
      ? 'watch makes file changes arrive but does not stop every other event being offered to this handler. Add event_types: ["file.changed"], or pass catch_all: true if it really should see everything.'
      : 'this handler has no event_types, sources or embed, so it would be offered every event. Name what should trigger it, or pass catch_all: true if that is really what you want.',
  };
}

/** When the handler runs, in the server's words, for the form (§11.3). */
function triggerLine(a: Approved): string {
  const parts: string[] = [];
  if (a.embed && !a.types.length && !a.sources.length) {
    parts.push(`when someone uses the embed ${a.embed}`);
  }
  if (a.types.length) parts.push(`on events of type ${a.types.join(', ')}`);
  if (a.sources.length) parts.push(`from ${a.sources.join(', ')}`);
  if (!parts.length) parts.push('on every event the assistant receives');
  const watching = a.watch.length ? ` It watches files matching ${a.watch.join(', ')}.` : '';
  return `It runs on its own, ${parts.join(' ')}.${watching}`;
}

type Resolved = { handles: ToolHandle[]; confirm: Set<string> } | Refusal;

/**
 * Names and globs → the concrete tools they mean right now (§19.4). Globs are
 * expanded here and never written: `calendar.*` approved today must not grow to
 * cover a tool that ships next month without anyone being asked.
 */
function resolveTools(
  deps: HandlerToolsDeps,
  patterns: string[],
  confirmPatterns: string[],
): Resolved {
  const hub = deps.tools();
  if (!hub) return { error: 'not_ready', message: 'the tool layer is not running yet' };
  const available = hub.handles();
  // The matcher `setup.request_access` uses. Its missing/already split is
  // about *chat's* grant, which a handler's does not inherit, so both halves
  // are what was asked for.
  const matched = matchAccess(
    { patterns: [...new Set([...patterns, ...confirmPatterns])], reason: '' },
    available,
    { tools: [], confirm: [] },
    deps.grants,
  );
  if (matched.unmatched.length) {
    return {
      error: 'unknown_tools',
      unmatched: matched.unmatched,
      message:
        'No tool in this process has that name. Check the spelling against your tool list, or setup.list_integrations — an integration may need connecting first. Nothing was written.',
    };
  }
  const names = new Set([
    ...matched.missing.map((t) => t.name),
    ...matched.already.map((t) => t.name),
  ]);
  const handles = available
    .filter((t) => names.has(t.name))
    .sort((a, b) => a.name.localeCompare(b.name));
  return {
    handles,
    confirm: new Set(
      handles.filter((t) => globMatchAny(confirmPatterns, t.name)).map((t) => t.name),
    ),
  };
}

type Approval =
  { ok: true; tools: string[]; confirm: string[] } | { ok: false; result: unknown };

/**
 * The grant form (F.20, D.5 `handler_grants`): every tool by name with its own
 * description, and a per-tool choice. Cancel is the decline, and nothing about
 * the model's request is shown as fact — its `reason` is shown as its reason.
 */
async function askApproval(
  deps: HandlerToolsDeps,
  ctx: ToolContext,
  name: string,
  reason: string,
  approved: Approved,
  resolved: { handles: ToolHandle[]; confirm: Set<string> },
): Promise<Approval> {
  const fields: FieldSpec[] = resolved.handles.map((t) => ({
    name: t.name,
    label: `${t.name} — ${firstSentence(t.description)}`,
    type: 'select',
    options: [ON_ITS_OWN, ASK_EACH_TIME],
    value: resolved.confirm.has(t.name) ? ASK_EACH_TIME : ON_ITS_OWN,
  }));
  const count = resolved.handles.length;
  const outcome = await deps.forms.request({
    runId: ctx.runId!,
    conversationId: ctx.conversationId!,
    title: `Let the handler "${name}" use ${count} tool${count === 1 ? '' : 's'}?`,
    description:
      `It wants these for: ${reason.trim()}\n\n${triggerLine(approved)}\n\n` +
      '"On its own" lets it call a tool without asking; "Ask me each time" sends you an approve/deny first. ' +
      `Approving writes handlers/${name}.md, which you can edit or revert like any other config.`,
    template: 'handler_grants',
    fields,
    ...(ctx.signal ? { signal: ctx.signal } : {}),
  });
  if (!outcome.submitted) {
    if (outcome.reason === 'form_pending') {
      return {
        ok: false,
        result: { error: 'form_pending', form_id: outcome.form_id, message: outcome.message },
      };
    }
    return { ok: false, result: { approved: false, reason: outcome.reason } };
  }
  // Answered in the instant the call was given up on: nobody is left to hear
  // what was written, so nothing is (§19.1).
  if (ctx.signal?.aborted)
    return { ok: false, result: { approved: false, reason: 'abandoned' } };

  const tools: string[] = [];
  const confirm: string[] = [];
  for (const t of resolved.handles) {
    (String(outcome.values[t.name]) === ASK_EACH_TIME ? confirm : tools).push(t.name);
  }
  return { ok: true, tools, confirm };
}

/** Frontmatter in the order a person reads it: who, when, what it may call, then the rest. */
function render(
  name: string,
  description: string,
  body: string,
  a: Approved,
  rest: Record<string, unknown>,
): string {
  const match =
    a.types.length || a.sources.length
      ? {
          ...(a.types.length ? { types: a.types } : {}),
          ...(a.sources.length ? { sources: a.sources } : {}),
        }
      : undefined;
  const data: Record<string, unknown> = {
    name,
    description,
    ...(match ? { match } : {}),
    ...(a.embed ? { embed: a.embed } : {}),
    ...(a.watch.length ? { watch: a.watch } : {}),
    tools: a.tools,
    ...(a.confirm.length ? { confirm: a.confirm } : {}),
    ...rest,
  };
  return matter.stringify(`\n${body.trim()}\n`, data);
}

function needsConversation(ctx: ToolContext): Refusal | null {
  if (!ctx.conversationId) {
    return {
      error: 'no_conversation',
      message:
        "approving a handler's tools needs a form, and forms are rendered in a chat conversation; this run has none",
    };
  }
  if (!ctx.runId) return { error: 'no_run', message: 'no run to suspend' };
  return null;
}

/** Validate, write, commit, reload — the tail every successful call shares. */
function commit(
  deps: HandlerToolsDeps,
  rel: string,
  abs: string,
  content: string,
  message: string,
): { committed: boolean } | Refusal {
  const check = validateWrite(rel, content);
  if (!check.ok) {
    l.warn({ path: rel, reason: check.message }, 'refused an invalid handler');
    return { error: check.error, message: check.message, detail: check.detail };
  }
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, 'utf8');
  const committed = deps.home.git.commit(message, [rel]);
  deps.onHandlersChanged?.();
  l.info({ path: rel, committed }, 'handler written');
  return { committed };
}

interface CreateArgs {
  name: string;
  description: string;
  event_types?: string[];
  sources?: string[];
  watch?: string[];
  embed?: string;
  body: string;
  requested_tools: string[];
  requested_confirm?: string[];
  reason: string;
  catch_all?: boolean;
}

type UpdateArgs = Partial<Omit<CreateArgs, 'name'>> & { name: string };

/**
 * `handler` integration (App. F.20). A handler's tools run with nobody
 * watching, so what it may call is approved by a person, once, on a form — and
 * then kept out of the model's reach (`config.write` pins it, F.6). The model
 * supplies structured arguments; the server writes the YAML, which ends the
 * quoting failures along with the self-granting.
 */
export function handlerTools(deps: HandlerToolsDeps): ToolDefinition[] {
  const locate = (name: string) => {
    const rel = `handlers/${name}.md`;
    return { rel, abs: resolveWritablePath(deps.home, rel) };
  };
  const badName = (name: string): Refusal | null =>
    NAME.test(name)
      ? null
      : {
          error: 'bad_name',
          message: 'a handler name is kebab-case: lowercase letters, digits and dashes',
        };

  return [
    {
      name: 'handler.create',
      description:
        'Create a handler: a behaviour that runs on its own when a matching event arrives. The user approves its tools on a form; nothing is written until they do.',
      tier: 'se',
      bulkArgs: ['body'],
      // The grant form, then — only when a real choice exists — the routing
      // form (§19.3): two waits, one after the other.
      awaitsHuman: () => 2 * deps.config.settings.formTimeoutS,
      args: z.object({
        name: z.string().min(1).describe('kebab-case; the file is handlers/<name>.md'),
        description: z.string().min(1).describe('when to use me — the matcher reads this'),
        event_types: globs.optional(),
        sources: globs.optional(),
        watch: globs.optional().describe('file-store globs to subscribe to'),
        embed: z.string().min(1).optional().describe('embed id to bind to'),
        body: z.string().min(1).describe('the instructions the run gets'),
        requested_tools: globs.min(1),
        requested_confirm: globs.optional().describe('tools to ask the user before each call'),
        reason: z.string().min(1).describe('shown to the user verbatim'),
        catch_all: z.boolean().optional().describe('true: offered every event'),
      }),
      // A cancelled or unanswered form writes nothing and says so without an
      // `{error}` — so only a result that reached the commit is an effect.
      effect: (args: CreateArgs, result: { committed?: unknown }) =>
        result.committed === undefined ? null : `created handler ${args.name}`,
      async execute(args: CreateArgs, ctx: ToolContext) {
        const bad = badName(args.name);
        if (bad) return bad;
        const { rel, abs } = locate(args.name);
        if (fs.existsSync(abs)) {
          return {
            error: 'exists',
            message: `handlers/${args.name}.md already exists — change it with handler.update`,
          };
        }
        const triggers: Approved = {
          types: args.event_types ?? [],
          sources: args.sources ?? [],
          watch: args.watch ?? [],
          ...(args.embed ? { embed: args.embed } : {}),
          tools: [],
          confirm: [],
        };
        const catchAll = catchAllRefusal(triggers, args.catch_all === true);
        if (catchAll) return catchAll;
        const resolved = resolveTools(deps, args.requested_tools, args.requested_confirm ?? []);
        if ('error' in resolved) return resolved;
        const noForm = needsConversation(ctx);
        if (noForm) return noForm;

        const approval = await askApproval(
          deps,
          ctx,
          args.name,
          args.reason,
          triggers,
          resolved,
        );
        if (!approval.ok) return approval.result;

        // Which model runs it: `config.write`'s routing rule, unchanged (F.6).
        const routed = await routeHandlerFrontmatter(args.name, {}, true, {}, false, ctx, {
          forms: deps.forms,
          router: deps.router,
        });
        if (!routed.written) return routed.result;
        if (ctx.signal?.aborted) return { approved: false, reason: 'abandoned' };

        const approved = { ...triggers, tools: approval.tools, confirm: approval.confirm };
        const content = render(
          args.name,
          args.description,
          args.body,
          approved,
          routed.routing,
        );
        const written = commit(deps, rel, abs, content, `handlers: create ${args.name}`);
        if ('error' in written) return written;
        return {
          name: args.name,
          path: rel,
          committed: written.committed,
          tools: approved.tools,
          confirm: approved.confirm,
          routing: routed.result,
        };
      },
    },
    {
      name: 'handler.update',
      description:
        'Change a handler. Body and description change freely; a change to its tools or triggers asks the user again, and the file is untouched until they approve.',
      tier: 'se',
      bulkArgs: ['body'],
      awaitsHuman: () => deps.config.settings.formTimeoutS,
      args: z.object({
        name: z.string().min(1),
        description: z.string().min(1).optional(),
        event_types: globs.optional(),
        sources: globs.optional(),
        watch: globs.optional(),
        embed: z.string().min(1).optional(),
        body: z.string().min(1).optional(),
        requested_tools: globs.min(1).optional().describe('the whole new set, not a diff'),
        requested_confirm: globs.optional(),
        reason: z.string().min(1).optional().describe('needed when tools or triggers change'),
        catch_all: z.boolean().optional(),
      }),
      effect: (args: UpdateArgs, result: { committed?: unknown }) =>
        result.committed === undefined ? null : `updated handler ${args.name}`,
      async execute(args: UpdateArgs, ctx: ToolContext) {
        const bad = badName(args.name);
        if (bad) return bad;
        const { rel, abs } = locate(args.name);
        if (!fs.existsSync(abs)) {
          return {
            error: 'not_found',
            message: `no handlers/${args.name}.md — create it with handler.create`,
          };
        }
        const parsed = parseFrontmatter(fs.readFileSync(abs, 'utf8'));
        // A file with no readable frontmatter has nothing approved to keep, so
        // every part of it is new and the form covers all of it.
        const current = parsed.ok ? parsed.data : {};
        const was = approvedOf(current);
        const description =
          args.description ??
          (typeof current.description === 'string' ? current.description : '');
        const body = args.body ?? (parsed.ok ? parsed.body : '');
        if (!description || !body.trim()) {
          return {
            error: 'invalid_arguments',
            message: 'this handler has no readable description or body to keep; pass both',
          };
        }

        const proposed: Approved = {
          types: args.event_types ?? was.types,
          sources: args.sources ?? was.sources,
          watch: args.watch ?? was.watch,
          ...((args.embed ?? was.embed) ? { embed: (args.embed ?? was.embed)! } : {}),
          tools: was.tools,
          confirm: was.confirm,
        };
        const triggersChanged =
          !sameSet(proposed.types, was.types) ||
          !sameSet(proposed.sources, was.sources) ||
          !sameSet(proposed.watch, was.watch) ||
          proposed.embed !== was.embed;
        const toolsTouched =
          args.requested_tools !== undefined || args.requested_confirm !== undefined;

        if (!parsed.ok && !args.requested_tools) {
          return {
            error: 'invalid_arguments',
            message:
              'this handler has no readable frontmatter; pass requested_tools for the user to approve',
          };
        }

        // Everything the file carries besides who it is and the approved half —
        // routing keys (never the model's, F.6), budgets, `enabled` — goes
        // through untouched.
        const rest: Record<string, unknown> = {};
        const skip = new Set<string>(['name', 'description', ...APPROVED_KEYS]);
        for (const [key, value] of Object.entries(current)) {
          if (!skip.has(key)) rest[key] = value;
        }

        let resolved: { handles: ToolHandle[]; confirm: Set<string> } | null = null;
        let grantsChanged = !parsed.ok;
        if (toolsTouched || triggersChanged || grantsChanged) {
          // The whole resulting set, prefilled with what is already approved:
          // "also let it delete calendar events" is a question about the lot.
          const confirmPrefill = args.requested_confirm ?? was.confirm;
          const r = resolveTools(
            deps,
            args.requested_tools ?? [...was.tools, ...was.confirm],
            args.requested_confirm ?? [],
          );
          if ('error' in r) return r;
          resolved = {
            handles: r.handles,
            confirm: new Set(
              r.handles.filter((t) => globMatchAny(confirmPrefill, t.name)).map((t) => t.name),
            ),
          };
          const tools = resolved.handles
            .map((t) => t.name)
            .filter((n) => !resolved!.confirm.has(n));
          grantsChanged =
            grantsChanged ||
            (toolsTouched &&
              (!sameSet(tools, was.tools) || !sameSet([...resolved.confirm], was.confirm)));
        }

        let approval: 'asked' | 'unchanged' = 'unchanged';
        let approved = proposed;
        if (resolved && (grantsChanged || triggersChanged)) {
          const catchAll = catchAllRefusal(proposed, args.catch_all === true);
          if (catchAll) return catchAll;
          if (!args.reason) {
            return {
              error: 'reason_required',
              message:
                "changing a handler's tools or triggers asks the user, and reason is what they are shown as why",
            };
          }
          const noForm = needsConversation(ctx);
          if (noForm) return noForm;
          const answer = await askApproval(
            deps,
            ctx,
            args.name,
            args.reason,
            proposed,
            resolved,
          );
          if (!answer.ok) return answer.result;
          approved = { ...proposed, tools: answer.tools, confirm: answer.confirm };
          approval = 'asked';
        }

        const content = render(args.name, description, body, approved, rest);
        const written = commit(deps, rel, abs, content, `handlers: update ${args.name}`);
        if ('error' in written) return written;
        return {
          name: args.name,
          path: rel,
          committed: written.committed,
          tools: approved.tools,
          confirm: approved.confirm,
          approval,
        };
      },
    },
  ];
}
