/**
 * The daemon's transport seam (§7.3). Exactly one code path lives above this
 * interface: WS for a remote box, in-memory for the bundled case. Bundling is a
 * deployment flag, not a fork.
 */
export interface Frame {
  id: string;
  type: string;
  payload: Record<string, unknown>;
}

export interface DaemonTransport {
  connect(): Promise<void>;
  send(frame: Frame): void;
  onFrame(handler: (frame: Frame) => void): void;
  onClose(handler: () => void): void;
  close(): Promise<void>;
}

/** Both halves of an in-process channel, speaking the same frames as the WS. */
export class InMemoryTransportPair {
  private daemonHandler: ((frame: Frame) => void) | null = null;
  private serverHandler: ((frame: Frame) => void) | null = null;
  private closeHandlers: (() => void)[] = [];
  private closed = false;

  /** Given to the daemon library. */
  readonly daemonSide: DaemonTransport = {
    connect: async () => {},
    send: (frame) => {
      if (!this.closed) this.serverHandler?.(frame);
    },
    onFrame: (handler) => {
      this.daemonHandler = handler;
    },
    onClose: (handler) => {
      this.closeHandlers.push(handler);
    },
    close: async () => {
      this.closed = true;
      for (const h of this.closeHandlers) h();
    },
  };

  /** Used by the service to speak to the bundled daemon. */
  toDaemon(frame: Frame): void {
    if (!this.closed) this.daemonHandler?.(frame);
  }

  onFromDaemon(handler: (frame: Frame) => void): void {
    this.serverHandler = handler;
  }

  get isClosed(): boolean {
    return this.closed;
  }
}
