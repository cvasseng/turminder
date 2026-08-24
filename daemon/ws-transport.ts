import WebSocket from 'ws';
import type { DaemonTransport, Frame } from './transport.js';

export interface WsTransportOptions {
  url: string;
  token: string;
  /** Reconnect backoff ceiling. */
  maxBackoffMs?: number;
  log?: (message: string, data?: unknown) => void;
}

/**
 * WS transport for a daemon on another machine (§7.3). Transport security is
 * the network's job — Tailscale or WireGuard — so this is a plain socket with a
 * bearer token on the query string.
 */
export class WsDaemonTransport implements DaemonTransport {
  private socket: WebSocket | null = null;
  private frameHandler: ((frame: Frame) => void) | null = null;
  private closeHandlers: (() => void)[] = [];
  private backoffMs = 500;
  private stopped = false;
  private onOpen: (() => void) | null = null;
  private everOpened = false;

  constructor(private readonly opts: WsTransportOptions) {}

  async connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.open(resolve, reject);
    });
  }

  private open(resolve?: () => void, reject?: (e: Error) => void): void {
    if (this.stopped) return;
    if (this.socket && this.socket.readyState === WebSocket.OPEN) {
      resolve?.();
      return;
    }
    const url = `${this.opts.url.replace(/^http/, 'ws')}/ws?token=${encodeURIComponent(this.opts.token)}`;
    const socket = new WebSocket(url);
    this.socket = socket;

    socket.on('open', () => {
      this.backoffMs = 500;
      this.opts.log?.('connected', { url: this.opts.url });
      // The first open is the caller's own connect(); only *re*-connections
      // need the reconnect hook, or the daemon greets twice.
      if (this.everOpened) this.onOpen?.();
      this.everOpened = true;
      resolve?.();
    });
    socket.on('message', (raw) => {
      try {
        this.frameHandler?.(JSON.parse(raw.toString()) as Frame);
      } catch {
        this.opts.log?.('unparsable frame');
      }
    });
    socket.on('error', (e) => {
      this.opts.log?.('socket error', (e as Error).message);
      reject?.(e as Error);
      reject = undefined;
      resolve = undefined;
    });
    socket.on('close', () => {
      for (const h of this.closeHandlers) h();
      if (this.stopped) return;
      const delay = this.backoffMs;
      this.backoffMs = Math.min(this.backoffMs * 2, this.opts.maxBackoffMs ?? 30_000);
      this.opts.log?.('reconnecting', { in_ms: delay });
      setTimeout(() => this.open(), delay).unref?.();
    });
  }

  /** Called after every (re)connection, so the daemon can say hello again. */
  onReconnect(handler: () => void): void {
    this.onOpen = handler;
  }

  send(frame: Frame): void {
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(frame));
  }

  onFrame(handler: (frame: Frame) => void): void {
    this.frameHandler = handler;
  }

  onClose(handler: () => void): void {
    this.closeHandlers.push(handler);
  }

  async close(): Promise<void> {
    this.stopped = true;
    this.socket?.close();
    this.socket = null;
  }
}
