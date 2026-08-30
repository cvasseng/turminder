import http from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * A scriptable stand-in for an OpenAI-audio-dialect speech endpoint (§10.9) —
 * Speaches, openedai-speech, whisper.cpp's server, the hosted ones. Real HTTP
 * and a real multipart body, like `FakeLlama`: what is under test is the
 * gateway's wire behaviour, and a mock of `fetch` would test the mock.
 *
 * It answers both kinds from one server. That is not laziness — an install
 * routinely points `stt` and `tts` at two entries on the same box, and a fake
 * that could not do that would make the interesting case unreachable.
 */

export interface RecordedSpeechRequest {
  path: string;
  /** Multipart fields, for `/audio/transcriptions` — file bytes under `file`. */
  fields: Record<string, string>;
  fileBytes?: Buffer;
  /** Parsed JSON body, for `/audio/speech`. */
  json: Record<string, any>;
  headers: Record<string, string>;
  at: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * `n` milliseconds of silence as a 22 050 Hz mono 16-bit WAV. Silence rather
 * than a tone because nothing under test listens — what matters is that the
 * header is real and the length is predictable, so a test can assert that the
 * adapter concatenated exactly the pieces it was given.
 */
export function silenceWav(ms: number, sampleRate = 22_050): Buffer {
  const samples = Math.round((sampleRate * ms) / 1000);
  const dataLen = samples * 2;
  const buf = Buffer.alloc(44 + dataLen);
  buf.write('RIFF', 0, 'ascii');
  buf.writeUInt32LE(36 + dataLen, 4);
  buf.write('WAVE', 8, 'ascii');
  buf.write('fmt ', 12, 'ascii');
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(1, 22); // mono
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36, 'ascii');
  buf.writeUInt32LE(dataLen, 40);
  return buf;
}

export class FakeSpeech {
  private server: http.Server | null = null;
  private transcripts: string[] = [];
  readonly requests: RecordedSpeechRequest[] = [];

  modelId = 'fake-whisper';
  otherModels: string[] = [];
  /** What `/audio/transcriptions` says when the script has run out. */
  fallbackTranscript = 'Turminder is ready to help you today.';
  /** How long the WAV `/audio/speech` returns is, per call. */
  speechMs = 400;
  speechSampleRate = 22_050;
  /** Delay before answering, for latency and ordering tests. */
  delayMs = 0;
  /** Answer with this status and an error body instead. */
  errorStatus: number | null = null;
  /**
   * Voices to serve from `/v1/audio/speech/voices` (§33.5). `null` = 404 on
   * every listing route, which is what openedai-speech and OpenAI itself do.
   */
  voices: string[] | null = null;
  /**
   * Voices nested in the model listing, per model id — the Speaches shape
   * (§33.5): no `/voices` route at all, `voices: [{name, language}]` inside
   * each `/v1/models` entry, and commonly more than one synthesiser on one
   * address. Empty means the flat routes are all this server has.
   */
  modelVoices: Record<string, string[]> = {};

  /** Queue transcripts, consumed in order; then `fallbackTranscript` answers. */
  script(...texts: string[]): this {
    this.transcripts.push(...texts);
    return this;
  }

  reset(): this {
    this.transcripts = [];
    this.requests.length = 0;
    this.errorStatus = null;
    return this;
  }

  /** Every `/audio/speech` body this server was sent, in order. */
  get spoken(): string[] {
    return this.requests
      .filter((r) => r.path.endsWith('/audio/speech'))
      .map((r) => r.json.input);
  }

  async start(): Promise<string> {
    this.server = http.createServer((req, res) => void this.handle(req, res));
    await new Promise<void>((resolve) => this.server!.listen(0, '127.0.0.1', resolve));
    const { port } = this.server!.address() as AddressInfo;
    return `http://127.0.0.1:${port}/v1`;
  }

  async stop(): Promise<void> {
    const s = this.server;
    this.server = null;
    if (!s) return;
    await new Promise<void>((resolve) => s.close(() => resolve()));
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const raw = Buffer.concat(chunks);
    const url = new URL(req.url ?? '/', 'http://localhost');
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.headers)) {
      if (typeof v === 'string') headers[k.toLowerCase()] = v;
    }
    const recorded: RecordedSpeechRequest = {
      path: url.pathname,
      fields: {},
      json: {},
      headers,
      at: Date.now(),
    };

    const contentType = headers['content-type'] ?? '';
    if (contentType.startsWith('multipart/form-data')) {
      const boundary = /boundary=(?:"([^"]+)"|([^;]+))/.exec(contentType);
      const parsed = parseMultipart(raw, (boundary?.[1] ?? boundary?.[2] ?? '').trim());
      recorded.fields = parsed.fields;
      if (parsed.file) recorded.fileBytes = parsed.file;
    } else if (raw.length) {
      try {
        recorded.json = JSON.parse(raw.toString('utf8'));
      } catch {
        recorded.json = { _unparsable: raw.toString('utf8') };
      }
    }
    this.requests.push(recorded);

    const json = (status: number, payload: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(payload));
    };

    if (
      url.pathname === '/v1/models' ||
      url.pathname === '/models' ||
      url.pathname === '/v1/registry'
    ) {
      return json(200, {
        object: 'list',
        data: [this.modelId, ...this.otherModels].map((id) => ({
          id,
          object: 'model',
          ...(this.modelVoices[id]
            ? {
                voices: this.modelVoices[id].map((name) => ({ name, language: 'en-us' })),
              }
            : {}),
        })),
      });
    }
    if (/\/(audio\/speech\/voices|audio\/voices|voices)$/.test(url.pathname)) {
      if (!this.voices) return json(404, { detail: 'Not Found' });
      return json(200, this.voices);
    }
    if (this.delayMs) await sleep(this.delayMs);
    if (this.errorStatus) return json(this.errorStatus, { error: { message: 'fake failure' } });

    if (url.pathname.endsWith('/audio/transcriptions')) {
      return json(200, { text: this.transcripts.shift() ?? this.fallbackTranscript });
    }
    if (url.pathname.endsWith('/audio/speech')) {
      const wav = silenceWav(this.speechMs, this.speechSampleRate);
      res.writeHead(200, { 'content-type': 'audio/wav' });
      // Two writes, so a consumer that reads the body as a stream sees more
      // than one chunk — the whole point of streaming speech (§33.2).
      res.write(wav.subarray(0, Math.min(44, wav.length)));
      res.end(wav.subarray(Math.min(44, wav.length)));
      return;
    }
    return json(404, { error: { message: `no route ${url.pathname}` } });
  }
}

/** Just enough multipart to recover the fields a transcription request sends. */
function parseMultipart(
  body: Buffer,
  boundary: string,
): { fields: Record<string, string>; file?: Buffer } {
  const out: { fields: Record<string, string>; file?: Buffer } = { fields: {} };
  if (!boundary) return out;
  const sep = Buffer.from(`--${boundary}`);
  let at = body.indexOf(sep);
  while (at !== -1) {
    const start = at + sep.length;
    if (body.subarray(start, start + 2).toString('latin1') === '--') break;
    const next = body.indexOf(sep, start);
    const part = body.subarray(start, next === -1 ? body.length : next);
    const headerEnd = part.indexOf('\r\n\r\n');
    if (headerEnd === -1) break;
    const rawHeaders = part.subarray(0, headerEnd).toString('utf8');
    // Trailing CRLF belongs to the delimiter, not the value.
    const value = part.subarray(headerEnd + 4, part.length - 2);
    const name = /name="([^"]+)"/.exec(rawHeaders)?.[1];
    if (name) {
      if (/filename="/.test(rawHeaders)) out.file = Buffer.from(value);
      else out.fields[name] = value.toString('utf8');
    }
    if (next === -1) break;
    at = next;
  }
  return out;
}
