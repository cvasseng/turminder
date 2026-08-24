import { log } from '../core/logger.js';
import type { Config } from '../core/config.js';
import type { EventRecord } from '../db/repos/events.js';
import type { ToolHandle } from '../tools/types.js';
import type { DispatchCall } from '../model/dispatcher.js';
import type { Outbox } from '../egress/outbox.js';

const l = log('confirm');

interface Pending {
  runId: string;
  tool: string;
  deliveryId: string;
  resolve(approved: boolean): void;
  timer: NodeJS.Timeout;
}

/**
 * The human confirmation round-trip (§7.3, §11.3, App. F.7). A gated tool call
 * queues a `confirm` delivery, the run suspends, and the button click comes
 * back as a `notification.action` event through the normal ingress — one loop,
 * one audit trail.
 *
 * V1 limitation, accepted (App. D.3): a suspended run does not survive a
 * restart. Runs waiting here are failed on startup rather than persisted.
 */
export class ConfirmBroker {
  private readonly pending = new Map<string, Pending>();

  constructor(
    private readonly outbox: Outbox,
    /** Read at call time: a config reload must actually take effect. */
    private readonly config: Config,
  ) {}

  get waiting(): number {
    return this.pending.size;
  }

  /** Ask the human. Resolves false on deny, and on timeout (App. A). */
  request(
    call: DispatchCall,
    handle: ToolHandle,
    ctx: { runId: string | null; eventId: string | null; handlerName?: string | null },
  ): Promise<boolean> {
    const runId = ctx.runId;
    if (!runId) {
      l.warn({ tool: call.name }, 'no run id to correlate a confirmation; denying');
      return Promise.resolve(false);
    }

    const delivery = this.outbox.queue({
      intent: 'confirm',
      payload: {
        title: `Approve ${call.name}?`,
        body:
          `${ctx.handlerName ? `Handler ${ctx.handlerName}` : 'The assistant'} wants to call ` +
          `${call.name}.\n\n${argsSummary(call.args)}`,
        run_id: runId,
        tool: call.name,
        args_summary: argsSummary(call.args),
        actions: [
          { id: 'approve', label: 'Approve' },
          { id: 'deny', label: 'Deny' },
        ],
      },
      createdByRun: runId,
      eventId: ctx.eventId,
    });

    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(runId);
        l.warn({ run: runId, tool: call.name }, 'confirmation timed out; treating as deny');
        resolve(false);
      }, this.config.settings.confirmTimeoutS * 1000);
      timer.unref?.();
      this.pending.set(runId, {
        runId,
        tool: call.name,
        deliveryId: delivery.id,
        resolve,
        timer,
      });
      l.info(
        { run: runId, tool: call.name, delivery: delivery.id },
        'waiting for the user to approve a tool call',
      );
    });
  }

  /**
   * Settle a pending confirmation from a `notification.action` event.
   * Returns true when this event was a confirmation answer.
   */
  settle(event: EventRecord): boolean {
    const payload = event.payload as {
      delivery_id?: string;
      action?: string;
      run_id?: string;
    };
    const runId =
      payload.run_id ??
      [...this.pending.values()].find((p) => p.deliveryId === payload.delivery_id)?.runId;
    if (!runId) return false;
    const waiting = this.pending.get(runId);
    if (!waiting) return false;
    if (payload.delivery_id && payload.delivery_id !== waiting.deliveryId) return false;

    clearTimeout(waiting.timer);
    this.pending.delete(runId);
    const approved = payload.action === 'approve';
    l.info({ run: runId, tool: waiting.tool, approved }, 'confirmation answered');
    waiting.resolve(approved);
    return true;
  }

  /** Fail everything waiting — called when the process is going down. */
  denyAll(reason = 'confirm_interrupted'): number {
    const count = this.pending.size;
    for (const waiting of this.pending.values()) {
      clearTimeout(waiting.timer);
      waiting.resolve(false);
    }
    this.pending.clear();
    if (count) l.warn({ count, reason }, 'denied pending confirmations');
    return count;
  }
}

function argsSummary(args: unknown): string {
  if (args === null || args === undefined) return '(no arguments)';
  const text = typeof args === 'string' ? args : JSON.stringify(args);
  return text.length > 400 ? `${text.slice(0, 400)}…` : text;
}
