import type { DaemonTransport, Frame } from './transport.js';

/**
 * The daemon library (§7.3): hold deliveries, render them, emit interaction
 * events. It knows nothing about sockets — the transport is injected — and it
 * has no execute capability (§14.3).
 */
export interface DeliveryFrame {
  seq: number;
  delivery_id: string;
  intent: 'notify' | 'confirm';
  payload: {
    title?: string;
    body?: string;
    actions?: { id: string; label: string }[];
    [key: string]: unknown;
  };
  expires_at: string;
}

/**
 * What happened when we tried to show a delivery. `shown: false` matters:
 * `delivered` is not `acked` (§7.1), so a delivery nobody could see must stay
 * unacked and be replayed later rather than quietly disappearing.
 */
export type RenderOutcome =
  { shown: true; action?: string | null } | { shown: false; reason: string };

export interface Renderer {
  show(delivery: DeliveryFrame): Promise<RenderOutcome>;
}

export interface DaemonOptions {
  device: string;
  capabilities?: string[];
  renderer: Renderer;
  /** Persisted cursor: the highest delivery seq this device has acked. */
  lastSeen?: number;
  onLastSeen?: (seq: number) => void;
  log?: (message: string, data?: unknown) => void;
}

let frameCounter = 0;
const nextFrameId = (): string => `d-${Date.now().toString(36)}-${(frameCounter += 1)}`;

export class Daemon {
  private lastSeen: number;
  private welcomed = false;
  private readonly seen = new Set<string>();

  constructor(
    private readonly transport: DaemonTransport,
    private readonly opts: DaemonOptions,
  ) {
    this.lastSeen = opts.lastSeen ?? 0;
  }

  get cursor(): number {
    return this.lastSeen;
  }

  get ready(): boolean {
    return this.welcomed;
  }

  async start(): Promise<void> {
    this.transport.onFrame((frame) => void this.onFrame(frame));
    this.transport.onClose(() => {
      this.welcomed = false;
      this.log('transport closed');
    });
    await this.transport.connect();
    this.greet();
  }

  /**
   * Say hello with the current cursor. Separate from start() on purpose: a
   * transport that reconnects must re-greet, and re-running start() would
   * reconnect again — once around that loop is enough.
   */
  greet(): void {
    this.send('hello', {
      device: this.opts.device,
      capabilities: this.opts.capabilities ?? ['notify.actions'],
      last_seen: this.lastSeen,
    });
  }

  async stop(): Promise<void> {
    await this.transport.close();
  }

  /** Emit an event upstream — the daemon is also a source (§7.3). */
  emit(type: string, payload: Record<string, unknown>): void {
    this.send('event', { type, payload });
  }

  private send(type: string, payload: Record<string, unknown>): void {
    this.transport.send({ id: nextFrameId(), type, payload });
  }

  private log(message: string, data?: unknown): void {
    this.opts.log?.(message, data);
  }

  private async onFrame(frame: Frame): Promise<void> {
    switch (frame.type) {
      case 'welcome':
        this.welcomed = true;
        this.log('connected', frame.payload);
        return;
      case 'delivery':
        await this.onDelivery(frame.payload as unknown as DeliveryFrame);
        return;
      case 'error':
        this.log('server error frame', frame.payload);
        return;
      default:
        // Unknown types are ignored on purpose (forward compatibility, App. D).
        return;
    }
  }

  private async onDelivery(delivery: DeliveryFrame): Promise<void> {
    // Replay can repeat a delivery the daemon has already shown.
    if (this.seen.has(delivery.delivery_id)) return;
    this.seen.add(delivery.delivery_id);

    if (delivery.expires_at && Date.parse(delivery.expires_at) <= Date.now()) {
      this.log('dropping expired delivery', delivery.delivery_id);
      return;
    }

    let outcome: RenderOutcome;
    try {
      outcome = await this.opts.renderer.show(delivery);
    } catch (e) {
      outcome = { shown: false, reason: (e as Error).message };
    }

    if (!outcome.shown) {
      // Not acked, not cursored, and forgotten from `seen` so a reconnect
      // tries again: an unseen notification is still owed to the user.
      this.seen.delete(delivery.delivery_id);
      this.log('could not show delivery; leaving it unacked', {
        delivery_id: delivery.delivery_id,
        reason: outcome.reason,
      });
      return;
    }

    // Ack: the user has seen it, whatever they clicked.
    this.send('ack', { delivery_id: delivery.delivery_id });
    if (typeof delivery.seq === 'number' && delivery.seq > this.lastSeen) {
      this.lastSeen = delivery.seq;
      this.opts.onLastSeen?.(this.lastSeen);
    }

    const action = outcome.action;
    if (action) {
      // A clicked button re-enters the loop as an event (§7.3).
      this.emit('notification.action', {
        delivery_id: delivery.delivery_id,
        action,
        ...(typeof delivery.payload.run_id === 'string'
          ? { run_id: delivery.payload.run_id }
          : {}),
      });
    }
  }
}
