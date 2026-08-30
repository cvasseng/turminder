import fs from 'node:fs';
import path from 'node:path';
import matter from 'gray-matter';
import { z } from 'zod';
import type { DataHome } from '../../core/datadir.js';
import { log } from '../../core/logger.js';
import { resolveWritablePath } from '../paths.js';
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
}

/** `model_class`, `endpoint`, `effort` (§10.6, G.7) — never accepted from the
 *  model. `config.write` strips these on every `handlers/*.md` write and
 *  decides them through the form below, or keeps what a human already chose. */
const ROUTING_KEYS = ['model_class', 'endpoint', 'effort'] as const;
type RoutingKey = (typeof ROUTING_KEYS)[number];
type Routing = Partial<Record<RoutingKey, string>>;

function pickRouting(data: Record<string, unknown>): Routing {
  const out: Routing = {};
  for (const key of ROUTING_KEYS) {
    if (typeof data[key] === 'string') out[key] = data[key] as string;
  }
  return out;
}

interface RoutingResult {
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

/** G.2's vocabulary order — the effort field's options follow it rather than
 *  declaration order, which is arbitrary per endpoint. */
const EFFORT_ORDER = ['low', 'medium', 'high', 'xhigh'] as const;

/** Matches `renderModelPick` in `ui/app.js` — the same three facts, in the
 *  same order, so a handler's picker and the chat selector read as one system. */
function endpointLabel(ep: ResolvedEndpoint): string {
  const bits = [ep.name];
  if (!ep.caps.includes('tools')) bits.push('no tools');
  bits.push(
    ep.cost ? `${ep.cost.inPerMtok}/${ep.cost.outPerMtok} ${ep.cost.currency}` : 'local',
  );
  return bits.join(' · ');
}

type RouteOutcome =
  | { written: true; routing: Routing; result: RoutingResult; ignored: RoutingKey[] }
  | { written: false; result: unknown };

/**
 * The routing form (§10.6, F.6): a real choice — more than one chat endpoint,
 * or a declared reasoning level — is never made by the model. Mutates `data`
 * in place, stripping the routing keys the model may have written, and either
 * hands back what to write (a human's answer, or nothing new to decide) or a
 * verdict that means "write nothing at all".
 */
async function routeHandlerFrontmatter(
  handlerName: string,
  data: Record<string, unknown>,
  fileIsNew: boolean,
  existing: Routing,
  rechoose: boolean,
  ctx: ToolContext,
  deps: ConfigToolsDeps,
): Promise<RouteOutcome> {
  // Read-only: `data` is gray-matter's parsed frontmatter, which the library
  // caches by input string (`Object.assign({}, cached)` is a shallow copy —
  // its nested `data` object is shared). Mutating it here would corrupt that
  // cache for the next identical write, silently. The caller strips a fresh
  // copy after this returns.
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
  });
  if (!outcome.submitted) {
    return { written: false, result: { submitted: false, reason: outcome.reason } };
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
 * `config` integration (App. F.6). The assistant editing its own configuration
 * is the point; git per mutation is what makes it safe.
 *
 * `handlers/*.md` is the one carve-out (§10.6, §19.2): which model runs a
 * behaviour is a choice with consequences, so `config.write` never accepts it
 * from the model — it strips `model_class`/`endpoint`/`effort`, decides them
 * with the form above when a real choice exists, and keeps what a human
 * already chose otherwise.
 */
export function configTools(home: DataHome, deps: ConfigToolsDeps): ToolDefinition[] {
  return [
    {
      name: 'config.read',
      description:
        'Read a configuration, handler or skill file. Path is relative to the data directory, e.g. config/personality.md.',
      tier: 'ro',
      args: z.object({
        path: z.string().describe('data-dir-relative path under config/, handlers/ or skills/'),
      }),
      async execute(args: { path: string }) {
        const abs = resolveWritablePath(home, args.path);
        if (!fs.existsSync(abs)) return { path: args.path, exists: false, content: null };
        return { path: args.path, exists: true, content: fs.readFileSync(abs, 'utf8') };
      },
    },
    {
      name: 'config.write',
      description:
        "Write a config, handler or skill file and commit it. Overwrites the whole file — read it first if editing. Refuses anything the loader would reject. Handler routing keys are the user's choice, not yours.",
      tier: 'se',
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
        const abs = resolveWritablePath(home, args.path);
        const rel = path.relative(home.root, abs);
        let content = args.content;
        let extra: { routing: RoutingResult; ignored: RoutingKey[] } | null = null;

        if (/^handlers\/[^/]+\.md$/.test(rel)) {
          let parsed: matter.GrayMatterFile<string> | null;
          try {
            parsed = matter(content);
          } catch {
            parsed = null; // malformed — validateWrite below reports it consistently
          }
          if (parsed && Object.keys(parsed.data ?? {}).length > 0) {
            const fileIsNew = !fs.existsSync(abs);
            let existingRouting: Routing = {};
            if (!fileIsNew) {
              try {
                existingRouting = pickRouting(matter(fs.readFileSync(abs, 'utf8')).data ?? {});
              } catch {
                // An unparsable existing file has nothing to keep.
              }
            }
            const routed = await routeHandlerFrontmatter(
              path.basename(rel, '.md'),
              parsed.data,
              fileIsNew,
              existingRouting,
              args.rechoose_routing === true,
              ctx,
              deps,
            );
            if (!routed.written) return routed.result;
            // A fresh object — never the parsed one, which gray-matter may have
            // cached and handed back shared with a future identical parse.
            const stripped: Record<string, unknown> = { ...parsed.data };
            for (const key of ROUTING_KEYS) delete stripped[key];
            content = matter.stringify(parsed.content, { ...stripped, ...routed.routing });
            extra = { routing: routed.result, ignored: routed.ignored };
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
        l.info({ path: rel, committed }, 'config written');
        return { path: rel, committed, ...(extra ?? {}) };
      },
    },
  ];
}
