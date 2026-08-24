import { log } from '../core/logger.js';
import { connectBase, connectQrSvg, connectUrl } from '../core/connect.js';

const l = log('reveals');

/**
 * One-time reveals (§24.2). The `token.reveal` frame is the only place a
 * gateway token value ever exists after creation: transient like `chat.delta`,
 * never outboxed, never replayed, never persisted. This broker is the fan-out
 * — the same shape as the form broker, minus the round trip, because nothing
 * comes back.
 *
 * It exists as its own thing rather than riding the delivery pipeline for one
 * reason: a delivery is durable by definition, and a durable token value is
 * exactly what §24 forbids.
 */
export interface RevealSink {
  send(type: string, payload: Record<string, unknown>): void;
}

/** What composing a reveal needs from settings (§24.3). */
export interface RevealSettings {
  gatewayPublicUrl: string | null;
  bind: { host: string; port: number };
}

export class RevealBroker {
  private readonly sinks = new Set<RevealSink>();

  /** Register a `chat`-capable channel; the returned function detaches it. */
  attach(sink: RevealSink): () => void {
    this.sinks.add(sink);
    return () => this.sinks.delete(sink);
  }

  /** How many devices could show a reveal right now (§24.2's audience test). */
  get audience(): number {
    return this.sinks.size;
  }

  /**
   * Compose and fan out a token reveal (App. D.2, §24.3): the value, the
   * connect URL that carries it in a fragment, and a server-rendered QR of
   * that URL. Both surfaces that mint a token — the model's
   * `setup.token_create` and the UI's `token.create` — come through here, so
   * they cannot disagree about what a reveal contains.
   *
   * Nothing is retried and nothing is stored: a reveal that reaches no one is
   * a token nobody saw, which is why callers check `audience` *before* writing
   * the row.
   */
  async revealToken(
    settings: RevealSettings,
    created: { device: string; label?: string; token: string },
  ): Promise<{ revealed: number }> {
    const base = connectBase(settings.gatewayPublicUrl, settings.bind);
    const url = connectUrl(base.base_url, created.token, created.device);
    const payload = {
      device: created.device,
      ...(created.label ? { label: created.label } : {}),
      token: created.token,
      connect_url: url,
      qr_svg: await connectQrSvg(url),
      base_url_guessed: base.guessed,
    };
    for (const sink of this.sinks) sink.send('token.reveal', payload);
    l.info({ device: created.device, devices: this.sinks.size }, 'token revealed');
    return { revealed: this.sinks.size };
  }
}
