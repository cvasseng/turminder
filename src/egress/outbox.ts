import { log } from '../core/logger.js';
import type { Config } from '../core/config.js';
import type { Repos } from '../db/repos/index.js';
import type { Delivery, DeliveryIntent } from '../db/repos/deliveries.js';
import type { ChannelRouter } from './channels.js';

const l = log('egress');

export interface QueueDeliveryInput {
  intent: DeliveryIntent;
  payload: Record<string, unknown>;
  ttlS?: number;
  createdByRun?: string | null;
  /** Trace attribution, when the delivery belongs to an event. */
  eventId?: string | null;
}

/**
 * The delivery outbox (§7.1). Durable in every deployment mode — bundled
 * in-process delivery just acks fast — so delivery semantics never differ
 * between deployments.
 */
export class Outbox {
  private sweepTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly repos: Repos,
    private readonly router: ChannelRouter,
    /** Read at call time: a config reload must actually take effect. */
    private readonly config: Config,
  ) {}

  queue(input: QueueDeliveryInput): Delivery {
    const ttlS =
      input.ttlS ??
      (input.intent === 'confirm'
        ? this.config.settings.confirmTtlS
        : this.config.settings.notifyTtlS);
    const delivery = this.repos.deliveries.create({
      intent: input.intent,
      payload: input.payload,
      ttlS,
      createdByRun: input.createdByRun ?? null,
    });
    this.repos.trace.append(
      'delivery',
      { delivery_id: delivery.id, intent: delivery.intent },
      { eventId: input.eventId ?? null, runId: input.createdByRun ?? null },
    );
    const { delivered } = this.router.deliver(delivery);
    l.info(
      { delivery: delivery.id, intent: delivery.intent, channels: delivered },
      'delivery queued',
    );
    return delivery;
  }

  ack(deliveryId: string, device: string): Delivery | null {
    return this.repos.deliveries.ack(deliveryId, device);
  }

  /** Expiry sweep; also runs on connect via the replay path. */
  startSweep(intervalMs = 60_000): void {
    if (this.sweepTimer) return;
    this.sweepTimer = setInterval(() => {
      const expired = this.repos.deliveries.expireStale();
      if (expired) l.info({ expired }, 'expired stale deliveries');
    }, intervalMs);
    this.sweepTimer.unref?.();
  }

  stopSweep(): void {
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    this.sweepTimer = null;
  }
}
