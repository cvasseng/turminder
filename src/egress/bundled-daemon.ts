import { Daemon, type Renderer } from '../../daemon/lib.js';
import { InMemoryTransportPair } from '../../daemon/transport.js';
import { NotifySendRenderer } from '../../daemon/notify-send.js';
import { log } from '../core/logger.js';
import type { Service } from '../service.js';
import { ChannelSession } from '../net/session.js';

const l = log('daemon');

export interface BundledDaemonOptions {
  device?: string;
  capabilities?: string[];
  /** Injected in tests; defaults to notify-send. */
  renderer?: Renderer;
  notifyCommand?: string;
}

/**
 * The daemon, in-process (§7.3, App. D.4). Same frames, same acks, same
 * ChannelSession as a remote daemon over WS — bundling is a deployment flag,
 * not a fork. In-process delivery just acks fast.
 */
export class BundledDaemon {
  private readonly pair = new InMemoryTransportPair();
  private readonly daemon: Daemon;
  private readonly session: ChannelSession;

  constructor(service: Service, opts: BundledDaemonOptions = {}) {
    const device = opts.device ?? 'local';
    this.session = new ChannelSession(service, device, {
      send: (frame) => this.pair.toDaemon(frame),
      close: () => void this.pair.daemonSide.close(),
    });
    this.pair.onFromDaemon((frame) => void this.session.handle(frame));
    this.daemon = new Daemon(this.pair.daemonSide, {
      device,
      capabilities: opts.capabilities ?? ['notify.actions'],
      renderer:
        opts.renderer ??
        new NotifySendRenderer({
          ...(opts.notifyCommand ? { command: opts.notifyCommand } : {}),
          log: (m) => l.warn(m),
        }),
      log: (message, data) => l.debug({ data }, message),
    });
  }

  async start(): Promise<void> {
    await this.daemon.start();
    l.info('bundled daemon attached');
  }

  async stop(): Promise<void> {
    this.session.detach();
    await this.daemon.stop();
  }

  get ready(): boolean {
    return this.daemon.ready;
  }
}
