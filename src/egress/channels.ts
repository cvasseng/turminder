import { log } from '../core/logger.js';
import { errMessage } from '../core/errors.js';
import type { Delivery } from '../db/repos/deliveries.js';
import type { DeliveriesRepo } from '../db/repos/deliveries.js';

const l = log('egress');

/** A registered delivery sink (§7.2): identity plus declared capabilities. */
export interface Channel {
  device: string;
  capabilities: string[];
  /** Highest delivery seq this device has ever acked. */
  lastSeen: number;
  send(delivery: Delivery): void;
}

/**
 * The channel router (§7.1, §7.2). Deliveries are addressed to an intent, never
 * to a socket; v1 policy is deliver-to-all-capable, any ack settles.
 */
export class ChannelRouter {
  private readonly channels = new Set<Channel>();

  constructor(private readonly deliveries: DeliveriesRepo) {}

  register(channel: Channel): () => void {
    this.channels.add(channel);
    l.info(
      { device: channel.device, capabilities: channel.capabilities },
      'channel registered',
    );
    // Anything it has not seen yet, replayed now (§7.3).
    const { replay, expired } = this.deliveries.replayFor(channel.lastSeen);
    for (const delivery of replay) this.push(channel, delivery);
    if (expired) l.info({ expired, device: channel.device }, 'expired stale deliveries');
    return () => {
      this.channels.delete(channel);
      l.info({ device: channel.device }, 'channel unregistered');
    };
  }

  get connected(): number {
    return this.channels.size;
  }

  replayCountFor(lastSeen: number): number {
    return this.deliveries.replayFor(lastSeen).replay.length;
  }

  /** Fan a delivery out to every channel that can render it. */
  deliver(delivery: Delivery): { delivered: number } {
    const capable = [...this.channels].filter((c) => this.canRender(c, delivery));
    for (const channel of capable) this.push(channel, delivery);
    if (!capable.length) {
      l.warn(
        { delivery: delivery.id, intent: delivery.intent },
        'no channel connected; delivery waits in the outbox',
      );
    }
    return { delivered: capable.length };
  }

  private canRender(channel: Channel, delivery: Delivery): boolean {
    if (delivery.intent === 'confirm') return channel.capabilities.includes('notify.actions');
    const actions = (delivery.payload.actions as unknown[] | undefined) ?? [];
    if (actions.length) return channel.capabilities.includes('notify.actions');
    return (
      channel.capabilities.includes('notify.actions') || channel.capabilities.includes('notify')
    );
  }

  private push(channel: Channel, delivery: Delivery): void {
    try {
      channel.send(delivery);
      this.deliveries.markDelivered(delivery.id);
    } catch (e) {
      l.warn(
        { device: channel.device, delivery: delivery.id, err: errMessage(e) },
        'delivery push failed',
      );
    }
  }
}
