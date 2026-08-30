import type http from 'node:http';
import { log } from '../core/logger.js';
import { errMessage } from '../core/errors.js';
import { spokenForm } from '../egress/spoken.js';
import { listVoices } from '../model/probe.js';
import { VoiceAdapter } from '../voice/adapter.js';
import type { Service } from '../service.js';

const l = log('voice-api');

/**
 * The voice routes (§33, App. E): `POST /api/voice`, `POST /api/speak`, and
 * `GET /api/voice/preview`. Their own module because they are the one family
 * that answers with `audio/wav` rather than JSON, and because the adapter they
 * front lives outside `net/` (App. I) — this is the seam, nothing more.
 */
export class VoiceRoutes {
  constructor(private readonly service: Service) {}

  static owns(pathname: string): boolean {
    return pathname === '/api/voice' || pathname === '/api/voice/preview';
  }

  /**
   * The spoken form of a delivery the device already holds (§33.3, App. E).
   *
   * An id, never free text: the shell is not a text-to-speech proxy, and the
   * words are the server's composition — the same rule §14.2 applies to a
   * confirm's title. **No ack side effects**: a device acks a delivery when it
   * displays it, exactly as it does today, and asking to hear it again is not
   * a second display.
   */
  async speak(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    let body: { delivery_id?: unknown };
    try {
      body = JSON.parse((await readBytes(req, 8192)).toString('utf8')) as typeof body;
    } catch {
      return json(res, 400, { error: 'bad_request', message: 'a JSON {delivery_id} body' });
    }
    const id = typeof body.delivery_id === 'string' ? body.delivery_id : '';
    if (!id)
      return json(res, 400, { error: 'bad_request', message: 'delivery_id is required' });

    const delivery = this.service.repos.deliveries.get(id);
    if (!delivery) return json(res, 404, { error: 'not_found', message: `no delivery ${id}` });
    if (
      delivery.status === 'expired' ||
      new Date(delivery.expires_at).getTime() <= Date.now()
    ) {
      // Silence is the answer for a delivery whose moment has passed (§7.1):
      // reading yesterday's reminder aloud is worse than not reading it.
      return json(res, 410, { error: 'expired', message: 'that delivery has expired' });
    }

    const gateway = this.service.modelStack?.gateway;
    if (!gateway?.router.speech('tts')) {
      return json(res, 503, {
        error: 'no_speech_endpoint',
        kind: 'tts',
        message: 'no synthesiser is configured — add one with the speech_endpoint setup form',
      });
    }

    await this.synthesise(res, spokenForm(delivery), gateway);
  }

  /**
   * One voice, one fixed sentence (§33.5, App. E). The **only** text this route
   * ever speaks is App. A's preview line with the instance's own name in it:
   * the voice name is the sole input, because a route that takes free text is
   * a text-to-speech proxy with a device token in front of it.
   */
  async preview(res: http.ServerResponse, url: URL): Promise<void> {
    const wanted = url.searchParams.get('voice')?.trim() ?? '';
    if (!wanted) {
      return json(res, 400, { error: 'bad_request', message: 'voice is required' });
    }
    const gateway = this.service.modelStack?.gateway;
    const endpoint = gateway?.router.speech('tts');
    if (!gateway || !endpoint) {
      return json(res, 503, {
        error: 'no_speech_endpoint',
        kind: 'tts',
        message: 'no synthesiser is configured — add one with the speech_endpoint setup form',
      });
    }
    // Checked only when the endpoint actually says what it has: one that lists
    // nothing takes whatever name it is given, and refusing on an empty list
    // would make every openedai-speech install unpreviewable.
    const listed = await listVoices(endpoint);
    if (listed && !listed.includes(wanted)) {
      return json(res, 400, {
        error: 'unknown_voice',
        message: `${endpoint.name} does not offer a voice called "${wanted}"`,
      });
    }
    await this.synthesise(res, previewSentence(this.instanceName()), gateway, wanted);
  }

  private instanceName(): string {
    // Before onboarding there is no name yet, and the drone the service is
    // named after is the honest stand-in (§12.1).
    return this.service.app.config.identity()?.frontmatter.instance_name ?? 'Turminder';
  }

  /** One sentence, one WAV — the shape both `/api/speak` and the preview want. */
  private async synthesise(
    res: http.ServerResponse,
    text: string,
    gateway: NonNullable<Service['modelStack']>['gateway'],
    voice?: string,
  ): Promise<void> {
    let spoken;
    try {
      spoken = await gateway.speak({
        text,
        ...(voice ? { voice } : {}),
        priority: 'interactive',
        trace: this.service.repos.trace.sink({ runId: null, eventId: null }),
      });
    } catch (e) {
      l.warn({ err: errMessage(e) }, 'speech failed');
      return json(res, 502, { error: 'speech_failed', message: errMessage(e) });
    }
    res.writeHead(200, { 'content-type': 'audio/wav', 'cache-control': 'no-store' });
    await pipeToResponse(spoken.stream, res);
  }

  /**
   * One utterance in, one spoken reply out (§33.2).
   *
   * The body cap is bytes rather than seconds because the seconds are only
   * knowable after the header is read — 16-bit mono at 16 kHz is 32 kB/s, and
   * the cap is generous enough that anything refused here was never a sentence.
   */
  async utterance(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    device: string,
  ): Promise<void> {
    const settings = this.service.app.config.settings;
    const limit = settings.voiceMaxUtteranceS * WAV_BYTES_PER_SECOND;
    let audio: Buffer;
    try {
      audio = await readBytes(req, limit);
    } catch {
      return json(res, 413, {
        error: 'too_long',
        message: `the utterance cap is ${settings.voiceMaxUtteranceS}s`,
      });
    }

    const models = this.service.modelStack;
    if (!models) {
      return json(res, 503, {
        error: 'no_speech_endpoint',
        kind: 'stt',
        message: 'no models are configured yet',
      });
    }

    const adapter = new VoiceAdapter({
      chat: this.service.chat,
      stream: this.service.stream,
      gateway: models.gateway,
      repos: this.service.repos,
      config: this.service.app.config,
    });

    let result;
    try {
      result = await adapter.handleUtterance({
        device,
        audio,
        mime: String(req.headers['content-type'] ?? ''),
      });
    } catch (e) {
      l.warn({ err: errMessage(e) }, 'utterance failed');
      return json(res, 502, { error: 'speech_failed', message: errMessage(e) });
    }
    if (!result.ok) {
      const { status, ...body } = result;
      return json(res, status, body);
    }

    res.writeHead(200, {
      'content-type': 'audio/wav',
      'transfer-encoding': 'chunked',
      'cache-control': 'no-store',
      'x-turminder-conversation': result.conversationId,
      // RFC 8187: the transcript is the user's own words in the user's own
      // language, and a header value is Latin-1 by the letter of the law.
      'x-turminder-transcript': `UTF-8''${encodeRFC8187(result.transcript)}`,
    });
    // Pushed out ahead of the audio rather than riding the first chunk: the
    // transcript is what tells the person they were heard right (§28.6), and
    // it is knowable a second before the first sentence has been synthesised.
    res.flushHeaders();
    await pipeToResponse(result.audio, res);
  }
}

/** 16 kHz mono 16-bit — the format §33.2 asks for, used only to size the cap. */
const WAV_BYTES_PER_SECOND = 32_000;

/** App. A's preview line, and nothing else, ever (§33.5). */
export function previewSentence(instanceName: string): string {
  return `Hello — I'm ${instanceName}. This is how I sound.`;
}

/** Percent-encoding per RFC 8187: `encodeURIComponent` plus the extras it keeps. */
export function encodeRFC8187(text: string): string {
  return encodeURIComponent(text).replace(
    /['()*!]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

async function readBytes(req: http.IncomingMessage, limit: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > limit) throw new Error('too large');
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

function json(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

/**
 * Drain the adapter's stream into the response. Errors mid-stream can only
 * destroy the socket: the 200 and the headers are already gone, and a client
 * hearing half a sentence and then silence is the honest report of what
 * happened (there is no status code left to send).
 */
async function pipeToResponse(
  stream: ReadableStream<Uint8Array>,
  res: http.ServerResponse,
): Promise<void> {
  const reader = stream.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!res.write(value)) {
        await new Promise<void>((resolve) => res.once('drain', resolve));
      }
    }
    res.end();
  } catch (e) {
    l.warn({ err: errMessage(e) }, 'voice stream broke mid-reply');
    res.destroy();
  }
}
