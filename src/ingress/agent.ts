import { z } from 'zod';
import { log } from '../core/logger.js';
import { errMessage } from '../core/errors.js';
import type { Config } from '../core/config.js';
import type { Repos } from '../db/repos/index.js';
import type { EventRecord } from '../db/repos/events.js';
import type { LoadedHandler } from '../exec/handlers.js';
import { runAgent } from '../model/agent-loop.js';
import type { ModelGateway } from '../model/gateway.js';
import { assembleSystemPrompt, renderEventPayload } from '../prompts/index.js';
import { nowIso } from '../core/time.js';

const l = log('ingress');

export interface Verdict {
  handler: string;
  matched: boolean;
  reason: string;
}

export interface IngressResult {
  summary: string;
  verdicts: Verdict[];
  /** false when there was nothing to classify and no model call was made. */
  classified: boolean;
}

const IngressOutput = z.object({
  summary: z.string(),
  verdicts: z.array(
    z.object({ handler: z.string(), matched: z.boolean(), reason: z.string() }),
  ),
});

/** App. H.3 output grammar. */
function schemaFor(handlerNames: string[]): { name: string; schema: Record<string, unknown> } {
  return {
    name: 'ingress_verdicts',
    schema: {
      type: 'object',
      properties: {
        summary: {
          type: 'string',
          description: 'at most 280 characters, the important bits of the event only',
        },
        verdicts: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              handler: { type: 'string', enum: handlerNames },
              matched: { type: 'boolean' },
              reason: { type: 'string', description: 'at most 140 characters' },
            },
            required: ['handler', 'matched', 'reason'],
            additionalProperties: false,
          },
        },
      },
      required: ['summary', 'verdicts'],
      additionalProperties: false,
    },
  };
}

export interface IngressAgentDeps {
  repos: Repos;
  config: Config;
  gateway: ModelGateway;
}

/**
 * The applicability gate (§5.3): one fast-model, grammar-constrained, tool-less
 * call per event. Every verdict is logged, not just the winners — this log is
 * the answer to "why didn't my handler fire".
 */
export class IngressAgent {
  constructor(private readonly deps: IngressAgentDeps) {}

  async classify(event: EventRecord, offered: LoadedHandler[]): Promise<IngressResult> {
    const { repos, config, gateway } = this.deps;

    if (offered.length === 0) {
      // Nothing to decide: don't spend a model call proving it.
      const summary = `${event.type} from ${event.source}`;
      repos.events.setSummary(event.id, summary);
      return { summary, verdicts: [], classified: false };
    }

    const runId = repos.runs.create({ kind: 'ingress', eventId: event.id });
    const trace = repos.trace.sink({ eventId: event.id, runId });
    const names = offered.map((h) => h.name);
    const roster = offered.map((h) => `- ${h.name}: ${h.description}`).join('\n');
    const payload = renderEventPayload(event, {
      maxChars: config.settings.ingressExcerptChars,
      userName: config.identity()?.frontmatter.user_name ?? null,
    });
    const prompt =
      `Handlers offered (return a verdict for every one, and only these):\n${roster}\n\n` +
      `Event envelope:\n- type: ${event.type}\n- source: ${event.source}\n` +
      `- occurred_at: ${event.occurred_at ?? event.received_at}\n\n` +
      `Event payload:\n${payload}`;

    const system = assembleSystemPrompt({
      kind: 'ingress',
      identity: config.identity(),
      now: nowIso(),
    });

    let lastError = '';
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      try {
        const result = await runAgent(gateway, {
          selector: { purpose: 'ingress', caps: ['json'] },
          priority: 'event',
          system,
          messages: [{ role: 'user', content: prompt }],
          trace,
          // The ingress agent has no tools at all (§5.3).
          budgets: { maxTurns: 1, timeoutS: config.settings.budgetTimeoutS },
          jsonSchema: schemaFor(names),
        });
        if (result.stopReason !== 'stop') {
          throw new Error(
            `ingress run stopped early: ${result.stopReason} ${result.error ?? ''}`,
          );
        }
        const parsed = IngressOutput.parse(JSON.parse(result.text.trim()));
        const verdicts = reconcile(parsed.verdicts, names);
        const summary = parsed.summary.slice(0, 280) || `${event.type} from ${event.source}`;

        repos.events.setSummary(event.id, summary);
        for (const v of verdicts) {
          trace.append('verdict', {
            handler: v.handler,
            offered: true,
            matched: v.matched,
            reason: v.reason,
          });
        }
        repos.runs.finish(runId, {
          status: 'done',
          turns: result.turns,
          tokensIn: result.tokensIn,
          tokensOut: result.tokensOut,
          model: result.endpoint || null,
        });
        l.info(
          { event: event.id, matched: verdicts.filter((v) => v.matched).map((v) => v.handler) },
          'ingress verdicts',
        );
        return { summary, verdicts, classified: true };
      } catch (e) {
        lastError = errMessage(e);
        l.warn({ event: event.id, attempt, err: lastError }, 'ingress classification failed');
      }
    }

    repos.runs.finish(runId, { status: 'failed', error: lastError });
    trace.append('error', { message: `ingress failed: ${lastError}` });
    throw new Error(`ingress classification failed: ${lastError}`);
  }
}

/**
 * A verdict must come back for every offered handler (App. H.3). A model that
 * forgets one gets the fail-open treatment rather than silently dropping it.
 */
function reconcile(verdicts: Verdict[], names: string[]): Verdict[] {
  const byName = new Map(
    verdicts.filter((v) => names.includes(v.handler)).map((v) => [v.handler, v]),
  );
  return names.map(
    (name) =>
      byName.get(name) ?? {
        handler: name,
        matched: true,
        reason: 'no verdict returned for this handler; matched to fail open',
      },
  );
}
