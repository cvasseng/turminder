import type { IncomingMessage, Server as HttpServer } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer, type WebSocket } from 'ws';
import { log } from '../core/logger.js';
import { errMessage } from '../core/errors.js';
import { tokenSha256 } from '../core/tokens.js';
import type { Service } from '../service.js';
import { ChannelSession } from './session.js';

const l = log('ws');

interface Connection {
  socket: WebSocket;
  session: ChannelSession;
  missedPongs: number;
  /**
   * SHA-256 of the token this socket presented at upgrade (§24). The hash, not
   * the value — the same thing the config holds — so a revoked or rotated
   * token can be recognised on a connection that is already open.
   */
  tokenHash: string;
}

/**
 * The WS half of the channel protocol (App. D): sockets, auth on upgrade, and
 * heartbeats. The frames themselves are handled by ChannelSession, which the
 * bundled daemon drives over an in-process pipe instead (App. D.4).
 */
export class WsGateway {
  private readonly wss = new WebSocketServer({ noServer: true });
  private readonly connections = new Set<Connection>();
  private heartbeat: NodeJS.Timeout | null = null;
  private unsubscribe: (() => void) | null = null;

  constructor(private readonly service: Service) {}

  attach(server: HttpServer): void {
    server.on('upgrade', (req, socket, head) => this.onUpgrade(req, socket, head));
    this.unsubscribe = this.service.chat.onStream({
      delta: (e) =>
        this.broadcast('chat', 'chat.delta', {
          conversation_id: e.conversationId,
          run_id: e.runId,
          text: e.text,
        }),
      retract: (e) =>
        this.broadcast('chat', 'chat.retract', {
          conversation_id: e.conversationId,
          run_id: e.runId,
        }),
      activity: (e) =>
        this.broadcast('chat', 'chat.activity', {
          conversation_id: e.conversationId,
          run_id: e.runId,
          activity: e.activity,
        }),
      done: (e) =>
        this.broadcast('chat', 'chat.done', {
          conversation_id: e.conversationId,
          run_id: e.runId,
          turn_seq: e.turnSeq,
        }),
      failed: (e) =>
        this.broadcast('chat', 'chat.error', {
          conversation_id: e.conversationId,
          message: e.message,
        }),
      closed: (e) =>
        this.broadcast('chat', 'conversation.closed', {
          conversation_id: e.conversationId,
        }),
      usage: (e) =>
        this.broadcast('chat', 'chat.usage', {
          conversation_id: e.conversationId,
          run_id: e.runId,
          model: e.model,
          turns: e.turns,
          context_used: e.contextUsed,
          prompt_evaluated: e.promptEvaluated,
          billed_with_timings: e.billedWithTimings,
          tokens_in: e.tokensIn,
          tokens_out: e.tokensOut,
          context_size: e.contextSize,
          conversation_tokens_in: e.conversationTokensIn,
          conversation_tokens_out: e.conversationTokensOut,
          cost: e.cost,
          duration_ms: e.durationMs,
          queue_wait_ms: e.queueWaitMs,
        }),
      titled: (e) =>
        this.broadcast('chat', 'conversation.titled', {
          conversation_id: e.conversationId,
          title: e.title,
        }),
      deleted: (e) =>
        this.broadcast('chat', 'conversation.deleted', {
          conversation_id: e.conversationId,
          turns: e.turns,
        }),
      mode: (e) =>
        this.broadcast('chat', 'conversation.mode', {
          conversation_id: e.conversationId,
          mode: e.mode,
        }),
    });

    // The file panel refreshes on anything the store or the watcher changed.
    const unsubscribeFiles = this.service.fileEvents.subscribe((e) =>
      this.broadcast('files', 'files.changed', { path: e.path, change: e.change }),
    );
    // An embed the assistant just edited is stale in every chat showing it.
    const unsubscribeEmbeds = this.service.embedEvents.subscribe((e) =>
      this.broadcast('chat', 'embed.changed', { embed_id: e.embedId }),
    );
    // Revocation bites now, not at the next reconnect (§24.1).
    const unsubscribeTokens = this.service.app.tokens.onChanged(() => this.dropRevoked());
    const unsubscribeChat = this.unsubscribe;
    this.unsubscribe = () => {
      unsubscribeChat?.();
      unsubscribeFiles();
      unsubscribeEmbeds();
      unsubscribeTokens();
    };

    const intervalS = this.service.app.config.settings.wsHeartbeatS;
    this.heartbeat = setInterval(() => this.sweep(), intervalS * 1000);
    this.heartbeat.unref?.();
  }

  async close(): Promise<void> {
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = null;
    this.unsubscribe?.();
    for (const c of this.connections) {
      c.session.detach();
      c.socket.close(1001, 'server shutting down');
    }
    this.connections.clear();
    await new Promise<void>((resolve) => this.wss.close(() => resolve()));
  }

  get connectionCount(): number {
    return this.connections.size;
  }

  /** Token auth on the upgrade (App. D): browsers cannot set headers here. */
  private deviceForToken(token: string | null): string | null {
    if (!token) return null;
    return this.service.app.tokens.authenticate(token);
  }

  private onUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname !== '/ws') return;
    const device = this.deviceForToken(url.searchParams.get('token'));
    if (!device) {
      l.warn({ ip: req.socket.remoteAddress }, 'ws upgrade rejected: bad token');
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    const tokenHash = tokenSha256(url.searchParams.get('token') ?? '');
    this.wss.handleUpgrade(req, socket, head, (ws) => this.onConnection(ws, device, tokenHash));
  }

  private onConnection(socket: WebSocket, device: string, tokenHash: string): void {
    const session = new ChannelSession(this.service, device, {
      send: (frame) => {
        if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(frame));
      },
      close: (code, reason) => socket.close(code, reason),
    });
    const connection: Connection = { socket, session, missedPongs: 0, tokenHash };
    this.connections.add(connection);
    l.info({ device }, 'channel connected');

    socket.on('pong', () => {
      connection.missedPongs = 0;
    });
    socket.on('message', (raw) => void session.handleRaw(raw.toString()));
    socket.on('close', () => {
      session.detach();
      this.connections.delete(connection);
      l.info({ device }, 'channel disconnected');
    });
    socket.on('error', (e) => l.warn({ device, err: errMessage(e) }, 'channel error'));
  }

  private broadcast(capability: string, type: string, payload: Record<string, unknown>): void {
    for (const c of this.connections) {
      if (c.session.can(capability)) c.session.send(type, payload);
    }
  }

  /**
   * Close every socket whose token no longer authenticates — revoked, or
   * rotated out from under it (§24.1). Driven by the store's change
   * notification for in-process revocations, and by the heartbeat for
   * everything else: a `turminder token revoke` in another terminal is a
   * different process, and one heartbeat is the interval it takes to bite.
   */
  private dropRevoked(): void {
    for (const c of [...this.connections]) {
      if (this.service.app.tokens.hasHash(c.tokenHash)) continue;
      l.warn({ device: c.session.device }, 'device token revoked, closing channel');
      c.session.send('error', { code: 'auth_failed', message: 'device token revoked' });
      c.session.detach();
      c.socket.close(4401, 'token revoked');
      this.connections.delete(c);
    }
  }

  /** Heartbeat: ping everyone; two missed pongs and the socket is gone (App. A). */
  private sweep(): void {
    this.dropRevoked();
    const limit = this.service.app.config.settings.wsMissLimit;
    for (const c of [...this.connections]) {
      if (c.missedPongs >= limit) {
        l.warn({ device: c.session.device }, 'channel missed heartbeats, closing');
        c.session.detach();
        c.socket.terminate();
        this.connections.delete(c);
        continue;
      }
      c.missedPongs += 1;
      try {
        c.socket.ping();
      } catch {
        c.session.detach();
        this.connections.delete(c);
      }
    }
  }
}
