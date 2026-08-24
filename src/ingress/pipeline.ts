import { log } from '../core/logger.js';
import type { ChatExecutor } from '../chat/executor.js';
import type { DistillExecutor } from '../memory/distill.js';
import type { HandlerExecutor } from '../exec/executor.js';
import type { HandlerLoader } from '../exec/handlers.js';
import type { Repos } from '../db/repos/index.js';
import type { WatcherEngine } from '../watchers/engine.js';
import type { ConfirmBroker } from '../exec/confirm.js';
import type { IngressAgent } from './agent.js';
import type { EventProcessor } from './queue.js';

const l = log('pipeline');

export interface PipelineDeps {
  repos: Repos;
  /**
   * Resolved per event, not per pipeline: setup can bring the model stack (and
   * with it the executors) to life while the queue is already running.
   */
  chat?: () => ChatExecutor | null;
  distill?: () => DistillExecutor | null;
  ingress?: () => IngressAgent | null;
  handlers?: () => { loader: HandlerLoader; executor: HandlerExecutor } | null;
  confirm?: ConfirmBroker;
  /** The §30.2 watcher engine; absent means `watch.due` has no consumer. */
  watchers?: () => WatcherEngine | null;
}

/**
 * Routes an event to whatever should act on it (§5). `chat.message` and
 * `system.onboarding_ready` skip the applicability gate entirely (§9) — a
 * direct message is always applicable, and so is the assistant's own
 * introduction. Everything else is offered to the handlers, gated by the
 * ingress agent.
 */
export function createPipeline(deps: PipelineDeps): EventProcessor {
  return async (event, ctx) => {
    if (event.type === 'chat.message') {
      const chat = deps.chat?.() ?? null;
      if (!chat) throw new Error('chat.message received but no model is configured');
      await chat.handle(event);
      return;
    }

    /**
     * The onboarding greeting (§3c) — the third typed route, and the same
     * argument as `chat.message`: its consumer is the chat layer by definition,
     * so asking the ingress agent whether the assistant should introduce itself
     * would spend a turn deciding something already decided.
     */
    if (event.type === 'system.onboarding_ready') {
      const chat = deps.chat?.() ?? null;
      if (!chat) throw new Error('system.onboarding_ready but no model is configured');
      await chat.handle(event);
      return;
    }

    /**
     * `watch.due` skips the LLM entirely (§30.2) — the second typed routing
     * rule around ingress, and a mirror of the first. `chat.message` skips the
     * applicability gate because a direct message is always applicable;
     * `watch.due` skips it because its consumer is *structural*: a poll is
     * deterministic code, and asking a model whether a scheduled poll is
     * relevant would spend the turn the whole layer exists to avoid. Both are
     * type-level facts, not relevance judgements — §5.2's fail-open rule is
     * untouched.
     */
    if (event.type === 'watch.due') {
      const watchers = deps.watchers?.() ?? null;
      if (!watchers) throw new Error('watch.due received but no watcher engine is running');
      const payload = event.payload as { watch_id?: unknown };
      if (typeof payload?.watch_id !== 'string') {
        throw new Error('watch.due without a watch_id');
      }
      await watchers.step(payload.watch_id, {
        toolCtx: { runId: null, eventId: event.id },
        eventId: event.id,
        causedBy: event.id,
      });
      return;
    }

    if (
      event.type === 'system.conversation_closed' ||
      event.type === 'system.conversation_idle'
    ) {
      const distill = deps.distill?.() ?? null;
      // Nothing to distill with is not a failure: the conversation is where the
      // user left it either way, and a dead-lettered maintenance event helps
      // nobody.
      if (distill) await distill.handle(event);
      return;
    }

    if (event.type === 'notification.action') {
      // A clicked approve/deny button releases the run waiting on it (§7.3).
      // The event still flows on to the handlers: one loop, one audit trail.
      const settled = deps.confirm?.settle(event) ?? false;
      if (settled) {
        deps.repos.trace.append(
          'state',
          { from: 'processing', to: 'confirmation_settled' },
          { eventId: event.id },
        );
      }
    }

    if (await devHooks(event, ctx)) return;

    const ingress = deps.ingress?.() ?? null;
    const handlers = deps.handlers?.() ?? null;
    if (!ingress || !handlers) {
      l.info(
        { id: event.id, type: event.type },
        'event accepted; no model configured to act on it',
      );
      return;
    }

    const offered = handlers.loader.offeredFor(event);
    const excluded = handlers.loader
      .all()
      .filter((h) => !offered.includes(h))
      .map((h) => h.name);
    for (const name of excluded) {
      // Matchers may only exclude (§5.2) — but say so, so "why didn't it fire"
      // is answerable for excluded handlers too.
      deps.repos.trace.append(
        'verdict',
        {
          handler: name,
          offered: false,
          matched: false,
          reason: 'excluded by its match block',
        },
        { eventId: event.id },
      );
    }

    const { verdicts } = await ingress.classify(event, offered);
    const matched = verdicts
      .filter((v) => v.matched)
      .map((v) => handlers.loader.get(v.handler))
      .filter((h): h is NonNullable<typeof h> => h !== null);

    if (!matched.length) {
      l.info(
        { id: event.id, type: event.type, offered: offered.length },
        'no handler applied to this event',
      );
      return;
    }

    // The lifecycle says matched → processing (§4.2); record the transition
    // even though the queue owns the row's terminal states.
    deps.repos.events.setStatus(event.id, 'matched');
    deps.repos.trace.append(
      'state',
      { from: 'processing', to: 'matched' },
      { eventId: event.id },
    );
    deps.repos.events.setStatus(event.id, 'processing');
    deps.repos.trace.append(
      'state',
      { from: 'matched', to: 'processing' },
      { eventId: event.id },
    );

    // Independent runs (§5.4); the inference scheduler decides the real order.
    const outcomes = await Promise.all(matched.map((h) => handlers.executor.run(event, h)));
    const failed = outcomes.filter((o) => !o.ok);
    if (failed.length) {
      // At-least-once (§4.2): the event is retried as a whole, which is why
      // handlers must be idempotent-tolerant.
      throw new Error(
        `handler(s) failed: ${failed.map((f) => `${f.handler}: ${f.error}`).join('; ')}`,
      );
    }
  };
}

/**
 * Dev-only lifecycle probes for exercising retries and dead-letters from the
 * CLI: `test.fail` always throws, `test.flaky` throws until it has been
 * attempted `payload.fail_times` times. Enabled with TURMINDER_DEV_PROCESSOR=1.
 */
async function devHooks(
  event: { type: string; payload: unknown; id: string },
  ctx: { attempt: number },
): Promise<boolean> {
  if (process.env.TURMINDER_DEV_PROCESSOR !== '1') return false;
  if (event.type === 'test.fail') {
    throw new Error(`test.fail always fails (attempt ${ctx.attempt})`);
  }
  if (event.type === 'test.flaky') {
    const failTimes = Number((event.payload as { fail_times?: number })?.fail_times ?? 2);
    if (ctx.attempt <= failTimes) {
      throw new Error(`test.flaky failing attempt ${ctx.attempt} of ${failTimes}`);
    }
    return true;
  }
  if (event.type === 'test.slow') {
    await new Promise((r) =>
      setTimeout(r, Number((event.payload as { ms?: number })?.ms ?? 50)),
    );
    return true;
  }
  return false;
}
