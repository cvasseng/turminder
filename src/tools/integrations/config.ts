import fs from 'node:fs';
import path from 'node:path';
import matter from 'gray-matter';
import { z } from 'zod';
import { parseFrontmatter } from '../../core/config.js';
import type { DataHome } from '../../core/datadir.js';
import { log } from '../../core/logger.js';
import { PathRejected, resolveInside, resolveWritablePath } from '../paths.js';
import { validateWrite } from '../validate-write.js';
import type { FormBroker } from '../../chat/forms.js';
import type { FieldSpec } from '../../chat/forms.js';
import type { ModelRouter } from '../../model/router.js';
import type { ResolvedEndpoint } from '../../model/types.js';
import type { ToolContext, ToolDefinition } from '../types.js';

const l = log('tool:config');

export interface ConfigToolsDeps {
  /** The handler-routing form (§10.6, F.6) raises through the same broker
   *  every other form does — no second mechanism. */
  forms: FormBroker;
  /** Live: the model stack can be rebuilt (a models.yaml reload) after this
   *  integration is constructed, so a snapshot taken here would go stale. */
  router: () => ModelRouter | null;
  /** Drop the handler loader's cache after a `handlers/*.md` write, so the
   *  same run sees what it just wrote. Named as `EmbedStoreDeps` names it —
   *  the cascade that deletes handler files already needed exactly this. */
  onHandlersChanged?: () => void;
}

/** `model_class`, `endpoint`, `effort` (§10.6, G.7) — never accepted from the
 *  model. `config.write` strips these on every `handlers/*.md` write and
 *  decides them through the form below, or keeps what a human already chose. */
export const ROUTING_KEYS = ['model_class', 'endpoint', 'effort'] as const;
type RoutingKey = (typeof ROUTING_KEYS)[number];
export type Routing = Partial<Record<RoutingKey, string>>;

export function pickRouting(data: Record<string, unknown>): Routing {
  const out: Routing = {};
  for (const key of ROUTING_KEYS) {
    if (typeof data[key] === 'string') out[key] = data[key] as string;
  }
  return out;
}

export interface RoutingResult {
  chosen_by: 'user' | 'table' | 'kept';
  endpoint?: string;
  class?: string;
  effort?: string;
  note?: string;
}

function routingResult(routing: Routing, chosenBy: RoutingResult['chosen_by']): RoutingResult {
  return {
    chosen_by: chosenBy,
    ...(routing.endpoint ? { endpoint: routing.endpoint } : {}),
    ...(routing.model_class ? { class: routing.model_class } : {}),
    ...(routing.effort ? { effort: routing.effort } : {}),
  };
}

/**
 * A handler's approved half (§14.4.4, F.6, F.20): what it may call and when it
 * is offered an event. A handler runs these tools with nobody watching, so
 * the model granting them to itself through `config.write` is the same hole
 * `grants.yaml`'s carve-out closes — they change only through `handler.*`'s
 * approval form, or a human editing the file.
 */
export const APPROVED_KEYS = ['match', 'watch', 'embed', 'tools', 'confirm'] as const;
export type ApprovedKey = (typeof APPROVED_KEYS)[number];

/**
 * The frontmatter to write: the model's, in its own key order, with routing
 * keys removed (the caller adds the decided ones back) and every approved key
 * replaced by the file's current value. A key the model left out is kept, not
 * dropped — omitting `tools` from a rewrite must not quietly revoke them.
 * `pinned` names only the keys whose sent value differed, so a read-modify-
 * write that round-trips them faithfully is not told off for it.
 */
function keepApproved(
  sent: Record<string, unknown>,
  current: Record<string, unknown>,
): { data: Record<string, unknown>; pinned: ApprovedKey[] } {
  const approved = new Set<string>(APPROVED_KEYS);
  const routing = new Set<string>(ROUTING_KEYS);
  const data: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(sent)) {
    if (routing.has(key)) continue;
    if (!approved.has(key)) data[key] = value;
    else if (key in current) data[key] = current[key];
  }
  for (const key of APPROVED_KEYS) {
    if (key in current && !(key in data)) data[key] = current[key];
  }
  const pinned = APPROVED_KEYS.filter(
    (key) => key in sent && JSON.stringify(sent[key]) !== JSON.stringify(current[key]),
  );
  return { data, pinned };
}

/** G.2's vocabulary order — the effort field's options follow it rather than
 *  declaration order, which is arbitrary per endpoint. */
const EFFORT_ORDER = ['none', 'low', 'medium', 'high', 'xhigh'] as const;

/** Matches `renderModelPick` in `ui/app.js` — the same three facts, in the
 *  same order, so a handler's picker and the chat selector read as one system. */
function endpointLabel(ep: ResolvedEndpoint): string {
  const bits = [ep.name];
  if (!ep.caps.includes('tools')) bits.push('no tools');
  bits.push(
    ep.cost && 'inPerMtok' in ep.cost
      ? `${ep.cost.inPerMtok}/${ep.cost.outPerMtok} ${ep.cost.currency}`
      : 'local',
  );
  return bits.join(' · ');
}

export type RouteOutcome =
  | { written: true; routing: Routing; result: RoutingResult; ignored: RoutingKey[] }
  | { written: false; result: unknown };

/**
 * The routing form (§10.6, F.6): a real choice — more than one chat endpoint,
 * or a declared reasoning level — is never made by the model. Mutates `data`
 * in place, stripping the routing keys the model may have written, and either
 * hands back what to write (a human's answer, or nothing new to decide) or a
 * verdict that means "write nothing at all".
 */
export async function routeHandlerFrontmatter(
  handlerName: string,
  data: Record<string, unknown>,
  fileIsNew: boolean,
  existing: Routing,
  rechoose: boolean,
  ctx: ToolContext,
  deps: ConfigToolsDeps,
): Promise<RouteOutcome> {
  // Read-only: `data` is the caller's parsed frontmatter and it goes on using
  // it after this returns. Report which routing keys are present; stripping
  // them is the caller's business, on a copy. (This used to carry a warning
  // about corrupting gray-matter's cache — `parseFrontmatter` no longer lets
  // that cache see these parses at all, so the shared-object hazard is gone
  // and only the ordinary don't-edit-your-caller's-object rule remains.)
  const ignored = ROUTING_KEYS.filter((k) => k in data);

  const router = deps.router();
  const chatEndpoints = router?.chatEndpoints() ?? [];
  let defaultEndpointName: string | null = null;
  let defaultEfforts: string[] = [];
  if (router) {
    try {
      const resolved = router.resolve({ purpose: 'handler' });
      defaultEndpointName = resolved.endpoint.name;
      defaultEfforts = resolved.endpoint.efforts ?? [];
    } catch {
      // Nothing qualifies for the handler route right now; nothing to default to.
    }
  }
  const choiceExists =
    router !== null && (chatEndpoints.length > 1 || defaultEfforts.length > 0);
  const hasExisting = Object.keys(existing).length > 0;
  const needsForm = choiceExists && (fileIsNew || !hasExisting || rechoose);

  if (!needsForm) {
    const routing = hasExisting ? existing : {};
    return {
      written: true,
      routing,
      result: routingResult(routing, hasExisting ? 'kept' : 'table'),
      ignored,
    };
  }

  if (!ctx.conversationId) {
    return {
      written: false,
      result: {
        error: 'no_conversation',
        message:
          'choosing a model for a handler needs a form, and forms are rendered in a chat conversation; this run has none',
      },
    };
  }
  if (!ctx.runId) {
    return { written: false, result: { error: 'no_run', message: 'no run to suspend' } };
  }

  const modelOptions = [
    `Default — handler route → ${defaultEndpointName ?? '(nothing qualifies)'}`,
    ...chatEndpoints.map(endpointLabel),
  ];
  const declaredEfforts = EFFORT_ORDER.filter((level) =>
    chatEndpoints.some((e) => e.efforts?.includes(level)),
  );
  const effortOptions = declaredEfforts.length
    ? ['endpoint default', ...declaredEfforts]
    : null;

  const fields: FieldSpec[] = [
    {
      name: 'model',
      label: `Which model should run ${handlerName}?`,
      type: 'select',
      options: modelOptions,
      value: modelOptions[0]!,
    },
    ...(effortOptions
      ? [
          {
            name: 'effort',
            label: 'How hard should it think?',
            type: 'select' as const,
            options: effortOptions,
            value: effortOptions[0]!,
          },
        ]
      : []),
  ];

  const outcome = await deps.forms.request({
    runId: ctx.runId,
    conversationId: ctx.conversationId,
    title: `Which model should run ${handlerName}?`,
    fields,
    ...(ctx.signal ? { signal: ctx.signal } : {}),
  });
  if (!outcome.submitted) {
    return { written: false, result: { submitted: false, reason: outcome.reason } };
  }
  // Answered in the instant the call was given up on: nobody is left to hear
  // which model was chosen, so the whole write — routing and the handler
  // file both — is skipped rather than half-done (§19.1).
  if (ctx.signal?.aborted) {
    return { written: false, result: { submitted: false, reason: 'abandoned' } };
  }

  // By index into the options this call built, never by parsing the label —
  // a select's submitted value is guaranteed to be one of its own options (D.5).
  const modelIndex = modelOptions.indexOf(String(outcome.values.model));
  const chosenEndpoint = modelIndex > 0 ? (chatEndpoints[modelIndex - 1] ?? null) : null;
  const routing: Routing = {};
  if (chosenEndpoint) routing.endpoint = chosenEndpoint.name;

  const result = routingResult(routing, 'user');
  if (effortOptions) {
    const effortIndex = effortOptions.indexOf(String(outcome.values.effort));
    if (effortIndex > 0) {
      const level = effortOptions[effortIndex]!;
      const servingEfforts = chosenEndpoint ? (chosenEndpoint.efforts ?? []) : defaultEfforts;
      if (servingEfforts.includes(level)) {
        routing.effort = level;
        result.effort = level;
      } else {
        result.note = `"${level}" reasoning is not declared by the endpoint that will serve this handler — not written`;
      }
    }
  }

  return { written: true, routing, result, ignored };
}

/**
 * A directory is an outcome `config.read` can act on, not a thrown error
 * (X4): list what is there instead of refusing with "path must name a file".
 */
function directoryResult(abs: string): { error: 'is_directory'; files: string[] } {
  const files = fs.existsSync(abs)
    ? fs
        .readdirSync(abs, { withFileTypes: true })
        .map((d) => (d.isDirectory() ? `${d.name}/` : d.name))
        .sort()
    : [];
  return { error: 'is_directory', files };
}

/**
 * `config` integration (App. F.6). The assistant editing its own configuration
 * is the point; git per mutation is what makes it safe.
 *
 * `handlers/*.md` is the one carve-out (§10.6, §19.2): which model runs a
 * behaviour is a choice with consequences, so `config.write` never accepts it
 * from the model — it strips `model_class`/`endpoint`/`effort`, decides them
 * with the form above when a real choice exists, and keeps what a human
 * already chose otherwise. What a handler may *call* gets the stronger form of
 * the same rule: the approved half is kept as it is on every write, and a new
 * handler is `handler.create`'s to make (F.6, F.20).
 */
export function configTools(home: DataHome, deps: ConfigToolsDeps): ToolDefinition[] {
  return [
    {
      name: 'config.read',
      description:
        'Read a configuration, handler or skill file. Path is relative to the data directory: config/personality.md, handlers/<name>.md, skills/<name>.md. Your own skills and handlers live here, not in the files.* workspace.',
      tier: 'ro',
      args: z.object({
        path: z.string().describe('data-dir-relative path under config/, handlers/ or skills/'),
      }),
      async execute(args: { path: string }) {
        let abs: string;
        try {
          abs = resolveWritablePath(home, args.path);
        } catch (e) {
          if (e instanceof PathRejected) {
            // One of the three roots itself, named bare (`handlers`,
            // `config`, `skills`, with or without a trailing slash) — a
            // directory in every sense that matters, and "what's in here"
            // is a routine thing to ask (X4, evidence 2026-09-11). Any other
            // rejection (escapes the root, a symlink, a carved-out file)
            // really is a bad path.
            if (e.reason === 'path must name a file, not a directory') {
              return directoryResult(resolveInside(home.root, args.path).abs);
            }
            return { error: 'path_rejected', message: e.reason };
          }
          throw e;
        }
        if (fs.existsSync(abs) && fs.statSync(abs).isDirectory()) {
          return directoryResult(abs);
        }
        if (!fs.existsSync(abs)) return { path: args.path, exists: false, content: null };
        return { path: args.path, exists: true, content: fs.readFileSync(abs, 'utf8') };
      },
    },
    {
      name: 'config.write',
      description:
        // Where handlers and skills live is `config.read`'s line, not this
        // one: this description sits on its §21.4 ceiling, and "which drawer"
        // is prose, which is exactly what that ceiling exists to keep out.
        "Write a config, handler or skill file and commit it. Overwrites the whole file — read it first if editing. Refuses anything the loader would reject. Handler routing keys are the user's choice, not yours.",
      tier: 'se',
      // A handler write can raise the routing form (§10.6, F.6) and suspend
      // on a human — the ordinary tool-call timeout would give up while it
      // waits, exactly the K1 bug (App. A).
      awaitsHuman: () => deps.forms.formTimeoutS,
      // §20.6: config.read is the way back to it.
      bulkArgs: ['content'],
      args: z.object({
        path: z.string().describe('data-dir-relative, under config/, handlers/ or skills/'),
        content: z.string(),
        message: z.string().describe('git commit message'),
        rechoose_routing: z
          .boolean()
          .optional()
          .describe('handlers/*.md only: ask the user again which model runs this handler.'),
      }),
      async execute(
        args: { path: string; content: string; message: string; rechoose_routing?: boolean },
        ctx: ToolContext,
      ) {
        let abs: string;
        try {
          abs = resolveWritablePath(home, args.path);
        } catch (e) {
          // A bad path is an expected failure, not a bug (X4): the same
          // `path_rejected` shape `files.*` and `docs.*` already return.
          if (e instanceof PathRejected) return { error: 'path_rejected', message: e.reason };
          throw e;
        }
        const rel = path.relative(home.root, abs);
        let content = args.content;
        let extra: {
          routing: RoutingResult;
          ignored: RoutingKey[];
          pinned?: ApprovedKey[];
          message?: string;
        } | null = null;

        if (/^handlers\/[^/]+\.md$/.test(rel)) {
          // Both refusals come before anything else, the routing form
          // included: a question asked about a write that is then refused is
          // a question the user answered for nothing (§14.4.4, F.6).
          if (!fs.existsSync(abs)) {
            return {
              error: 'use_handler_create',
              message:
                'config.write edits existing handlers only. Create one with handler.create — it takes the triggers and tools as arguments and asks the user to approve the tools.',
            };
          }
          const existing = parseFrontmatter(fs.readFileSync(abs, 'utf8'));
          if (!existing.ok || Object.keys(existing.data).length === 0) {
            return {
              error: 'use_handler_update',
              message:
                'this handler has no readable frontmatter, so there are no approved tools to keep. Rewrite it with handler.update, which asks the user to approve them.',
            };
          }
          // Malformed frontmatter falls through to validateWrite, which reports
          // it consistently — and now says what is actually wrong with it.
          const parsed = parseFrontmatter(content);
          if (parsed.ok && Object.keys(parsed.data).length > 0) {
            const routed = await routeHandlerFrontmatter(
              path.basename(rel, '.md'),
              parsed.data,
              false,
              pickRouting(existing.data),
              args.rechoose_routing === true,
              ctx,
              deps,
            );
            if (!routed.written) return routed.result;
            const kept = keepApproved(parsed.data, existing.data);
            content = matter.stringify(parsed.body, { ...kept.data, ...routed.routing });
            extra = {
              routing: routed.result,
              ignored: routed.ignored,
              ...(kept.pinned.length
                ? {
                    pinned: kept.pinned,
                    message:
                      'Kept the approved values of these keys, not yours. What a handler may call and when it runs changes only through handler.update, which asks the user.',
                  }
                : {}),
            };
          }
        }

        // Refuse before writing: a file the loader will reject, committed and
        // reported as a success, is a mistake the caller cannot see.
        const check = validateWrite(rel, content);
        if (!check.ok) {
          l.warn({ path: rel, reason: check.message }, 'refused an invalid write');
          return { error: check.error, message: check.message, detail: check.detail };
        }
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.writeFileSync(abs, content, 'utf8');
        const committed = home.git.commit(args.message, [rel]);
        // A handler the model just authored must be a handler the next answer
        // can see (§6.2): `schedule.create` reports who will run an event by
        // matching the handlers *on disk now*, and the loader caches them. A
        // model that wrote a handler and then asked who owns its schedule was
        // told someone else's name, believed it, and reported the wrong fix as
        // done (2026-09-11). The reload is free; the stale answer was not.
        if (/^handlers\/[^/]+\.md$/.test(rel)) deps.onHandlersChanged?.();
        l.info({ path: rel, committed }, 'config written');
        return { path: rel, committed, ...(extra ?? {}) };
      },
    },
  ];
}
