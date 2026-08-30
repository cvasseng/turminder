import { errMessage } from '../core/errors.js';
import { log } from '../core/logger.js';
import { stripReservedMarkers } from '../core/markers.js';
import type { Config } from '../core/config.js';
import type { Repos } from '../db/repos/index.js';
import type { ChatService } from '../chat/service.js';
import type { ChatStreamHub } from '../chat/stream.js';
import type { ModelGateway } from '../model/gateway.js';
import { readWavHeader } from '../model/wav.js';

const l = log('voice');

/**
 * The utterance adapter (§33.2, App. E, App. I): one HTTP request carries a
 * thing said in and the answer spoken out. Everything between is the ordinary
 * chat path — the transcript is a `chat.message` through the same service
 * method the WS session uses, the run is an ordinary run, the reply is an
 * ordinary reply. Nothing here is a second loop.
 *
 * The only thing this module invents is the seam between them: where audio
 * stops and text starts on the way in, and where text stops and audio starts
 * on the way out.
 */

/**
 * What a transcriber says when it is handed silence. Every whisper build has a
 * favourite hallucination — the model was trained on subtitled video and the
 * end of a clip is where "Thank you for watching" lives. These are not
 * messages from the user, so nothing is written and no run starts (§33.2).
 *
 * Matched on the whole normalised transcript, never on a substring: "thank you
 * for the reminder" is a real thing to say and must survive.
 */
export const SILENCE_HALLUCINATIONS: readonly string[] = [
  'thank you',
  'thanks for watching',
  'thank you for watching',
  'thanks for watching!',
  'you',
  '.',
  'bye',
  'okay',
  'oh',
];

/** Lower-cased, stripped of punctuation and collapsed whitespace — what the
 *  hallucination list is compared against. */
function normalise(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
}

const NORMALISED_HALLUCINATIONS = new Set(SILENCE_HALLUCINATIONS.map(normalise));

export function isSilenceHallucination(transcript: string): boolean {
  return NORMALISED_HALLUCINATIONS.has(normalise(transcript));
}

/**
 * Where a sentence ends, for chunking a reply into speech (§33.2). Terminal
 * punctuation followed by whitespace, or a line break — the speaker starts on
 * the first sentence rather than the last token, which is the whole latency
 * argument.
 */
const SENTENCE_END = /[.!?…]["')\]]?\s|\n/;
/**
 * Below this, a "sentence" is an abbreviation or a decimal point, and sending
 * it costs a whole TTS round trip to say "Dr." on its own.
 */
const MIN_SENTENCE_CHARS = 12;

/** What the speaker says when the run did not get there (§33.2). */
export const FAILURE_SENTENCE = 'Sorry, that went wrong.';
export const CONFIRM_SENTENCE = 'I need your approval on a screen for that.';

/**
 * "I heard you, this one is taking a moment" (§33.2, App. A).
 *
 * Spoken only when the answer is slow — a turn that was going to reply in
 * under a second does not want an announcement in front of it. Rotating,
 * because the same four words every time stops being information and becomes
 * a noise the room learns to ignore.
 *
 * Deliberately *not* composed by the model: it has to be immediate when it
 * fires, and a second call to the same endpoint would queue behind the chat
 * turn it is covering — arriving, at best, after the answer it was there to
 * cover (JUDGMENT, 2026-08-30). The synthesiser is a different endpoint, so
 * speaking a known sentence costs nothing but the audio.
 */
export const ACKNOWLEDGEMENTS: readonly string[] = [
  'One moment.',
  'Let me look.',
  'Working on that.',
  'Just a second.',
  'Looking into it.',
];

export interface VoiceDeps {
  chat: ChatService;
  stream: ChatStreamHub;
  gateway: ModelGateway;
  repos: Repos;
  config: Config;
}

export interface UtteranceRequest {
  /** The authenticated device — the conversation's owner (§33.1). */
  device: string;
  audio: Buffer;
  mime: string;
}

export type UtteranceResult =
  | {
      ok: true;
      conversationId: string;
      transcript: string;
      /** WAV, written sentence by sentence as the reply arrives. */
      audio: ReadableStream<Uint8Array>;
    }
  | { ok: false; status: number; error: string; message: string; kind?: 'stt' | 'tts' };

export class VoiceAdapter {
  constructor(private readonly deps: VoiceDeps) {}

  /**
   * One utterance in, one spoken reply out.
   *
   * Two runs per utterance, both traced, and that is deliberate: the
   * transcription happens before there is a chat run to hang it on — the chat
   * run is created by the executor when the `chat.message` event is picked up,
   * which cannot happen until there is a transcript to send. So the `stt` row
   * belongs to a `maintenance` run of this adapter's own, and the `chat` and
   * `tts` rows belong to the run that answered. The request log shows all
   * three (§10.8), which is what matters for finding where the seconds went.
   */
  async handleUtterance(req: UtteranceRequest): Promise<UtteranceResult> {
    const { config, gateway, repos } = this.deps;
    const settings = config.settings;

    if (!/^audio\/wav\b/i.test(req.mime) && !/^audio\/x-wav\b/i.test(req.mime)) {
      return {
        ok: false,
        status: 415,
        error: 'unsupported_media_type',
        message: `voice takes audio/wav, not "${req.mime}"`,
      };
    }
    if (!gateway.router.speech('stt')) {
      return {
        ok: false,
        status: 503,
        error: 'no_speech_endpoint',
        kind: 'stt',
        message: 'no transcriber is configured — add one with the speech_endpoint setup form',
      };
    }
    if (!gateway.router.speech('tts')) {
      return {
        ok: false,
        status: 503,
        error: 'no_speech_endpoint',
        kind: 'tts',
        message: 'no synthesiser is configured — add one with the speech_endpoint setup form',
      };
    }

    const heard = readWavHeader(req.audio);
    const seconds = heard?.seconds ?? 0;
    if (seconds > settings.voiceMaxUtteranceS) {
      return {
        ok: false,
        status: 413,
        error: 'too_long',
        message: `${seconds.toFixed(1)}s of audio; the cap is ${settings.voiceMaxUtteranceS}s`,
      };
    }
    if (seconds * 1000 < settings.sttMinAudioMs) {
      // Short enough to be a stray key press. Refused before transcription
      // rather than after, because a transcriber handed 80ms invents a sentence.
      return this.nothingHeard(`${Math.round(seconds * 1000)}ms of audio`);
    }

    // The transcription's own run: this is the one piece of work that happens
    // before the conversation knows anything is coming.
    const sttRun = repos.runs.create({ kind: 'maintenance' });
    const locale = config.identity()?.frontmatter.locale;
    let heardText;
    try {
      heardText = await gateway.transcribe({
        audio: req.audio,
        mime: req.mime,
        ...(locale ? { language: locale } : {}),
        priority: 'interactive',
        trace: repos.trace.sink({ runId: sttRun }),
      });
    } catch (e) {
      // A run left `running` is failed on the next start (§11.3's precedent);
      // closing it here keeps the record honest instead.
      repos.runs.finish(sttRun, { status: 'failed', error: errMessage(e) });
      throw e;
    }
    repos.runs.finish(sttRun, { status: 'done', turns: 1 });

    const transcript = heardText.text.trim();
    if (!transcript) return this.nothingHeard('the transcriber returned nothing');
    if (isSilenceHallucination(transcript)) {
      return this.nothingHeard(`"${transcript}" is what silence sounds like`);
    }

    const conversation = this.conversationFor(req.device);
    // Subscribed before the message is sent: the run can start inside `send`
    // on a drained queue, and a listener attached afterwards would miss the
    // opening deltas of its own reply.
    const reply = this.speakReply(conversation.id, sttRun);
    this.deps.chat.send({ conversationId: conversation.id, text: transcript });

    l.info(
      { device: req.device, conversation: conversation.id, audio_s: heardText.audioSeconds },
      'utterance accepted',
    );
    return { ok: true, conversationId: conversation.id, transcript, audio: reply };
  }

  private nothingHeard(why: string): UtteranceResult {
    l.debug({ why }, 'nothing heard');
    return { ok: false, status: 422, error: 'nothing_heard', message: why };
  }

  /**
   * The device's open voice conversation, or a fresh one (§33.1). A device owns
   * one at a time; it rolls over after `voice_idle_min` of quiet, so a year of
   * kitchen questions is a year of conversations rather than one endless thread
   * that distillation can never close.
   */
  private conversationFor(device: string): { id: string } {
    const { repos, config } = this.deps;
    const open = repos.conversations.voiceConversationFor(device, config.settings.voiceIdleMin);
    if (open) return open;
    const created = repos.conversations.create({ voiceDevice: device });
    l.info({ device, conversation: created.id }, 'opened a voice conversation');
    return created;
  }

  /**
   * The reply, as audio, sentence by sentence.
   *
   * The stream is returned before the run has said anything: the HTTP response
   * starts, the client starts reading, and each sentence's WAV is appended as
   * the synthesiser hands it back. The alternative — waiting for `done` and
   * speaking the whole answer — adds the entire generation time to the pause
   * before the first word, which is the number §33.4 is about.
   */
  private speakReply(
    conversationId: string,
    fallbackRunId: string,
  ): ReadableStream<Uint8Array> {
    const { stream, gateway, repos, config } = this.deps;
    const writer = new WavConcatenation();
    let buffer = '';
    let runId: string | null = null;
    /** Serialises the TTS calls: sentences must be spoken in the order written. */
    let queue: Promise<void> = Promise.resolve();
    /** The reply is over — stop listening. Work already queued still runs. */
    let finished = false;
    /** The client hung up. Nothing more is worth synthesising. */
    let abandoned = false;

    return new ReadableStream<Uint8Array>({
      start: (controller) => {
        const say = (text: string): void => {
          const clean = speakable(text);
          if (!clean) return;
          queue = queue
            .then(async () => {
              // `finished` deliberately does not stop this: the last sentence
              // of a reply is queued by `done`, which is also what finishes.
              if (abandoned) return;
              // Traced against the run that said it (§10.9), so the request
              // log shows the whole utterance as `stt`, `chat`, `tts` rows.
              // Before the first delta there is no chat run yet — a spoken
              // failure can arrive that early — so the transcription's run
              // stands in rather than the row going nowhere.
              const spoken = await gateway.speak({
                text: clean,
                priority: 'interactive',
                trace: repos.trace.sink({ runId: runId ?? fallbackRunId }),
              });
              for await (const chunk of spoken.stream as unknown as AsyncIterable<Uint8Array>) {
                const pcm = writer.push(chunk);
                if (pcm.length) controller.enqueue(pcm);
              }
              writer.endPiece();
            })
            .catch((e: unknown) => {
              l.warn({ err: String(e) }, 'speech failed mid-reply');
            });
        };

        // The wait is the thing being covered, so the timer starts with the
        // run and is cancelled by the first thing the model says (§33.2).
        const after = config.settings.voiceAcknowledgeAfterMs;
        let acknowledged = false;
        const waiting =
          after > 0
            ? setTimeout(() => {
                if (finished || acknowledged) return;
                acknowledged = true;
                say(pick(ACKNOWLEDGEMENTS));
              }, after)
            : null;
        const stopWaiting = (): void => {
          if (waiting) clearTimeout(waiting);
        };

        const finish = (): void => {
          if (finished) return;
          finished = true;
          stopWaiting();
          unsubscribe();
          const close = () => {
            try {
              controller.close();
            } catch {
              // Already closed or errored — the response is over either way.
            }
          };
          void queue.then(close, close);
        };

        const unsubscribe = stream.subscribe({
          delta: (e) => {
            if (e.conversationId !== conversationId || finished) return;
            runId ??= e.runId;
            if (e.runId !== runId) return;
            // It is answering: nothing left to apologise for.
            stopWaiting();
            buffer += e.text;
            for (;;) {
              const at = nextSentenceEnd(buffer);
              if (at < 0) break;
              say(buffer.slice(0, at));
              buffer = buffer.slice(at);
            }
          },
          // Whatever was retracted was never spoken *if* it is still in the
          // buffer; anything already sent to the synthesiser has been heard and
          // cannot be unsaid (§20.8, LIMITS).
          retract: (e) => {
            if (e.conversationId === conversationId) buffer = '';
          },
          activity: (e) => {
            if (e.conversationId !== conversationId || finished) return;
            runId ??= e.runId;
            if (e.activity.kind !== 'awaiting_confirm') return;
            // The run is suspended until a human answers on a screen, which
            // may be an hour (App. A). Say so and hang up (§33.2).
            buffer = '';
            say(CONFIRM_SENTENCE);
            finish();
          },
          done: (e) => {
            if (e.conversationId !== conversationId || finished) return;
            runId ??= e.runId;
            say(buffer);
            buffer = '';
            finish();
          },
          failed: (e) => {
            if (e.conversationId !== conversationId || finished) return;
            buffer = '';
            say(FAILURE_SENTENCE);
            finish();
          },
        });
      },
      cancel: () => {
        abandoned = true;
        finished = true;
      },
    });
  }
}

/** One of them, at random — the rotation that keeps it from becoming noise. */
function pick(from: readonly string[]): string {
  return from[Math.floor(Math.random() * from.length)] ?? from[0]!;
}

/** The index just past the first sentence ending in `text`, or -1. */
function nextSentenceEnd(text: string): number {
  const m = SENTENCE_END.exec(text);
  if (!m) return -1;
  const at = m.index + m[0].length;
  return at >= MIN_SENTENCE_CHARS ? at : -1;
}

/**
 * What a speaker should be handed: no reserved markers (§20.8), no markdown
 * scaffolding. The prompt fragment asks the model not to write any; this is
 * the door, because a model that slips a `**` into a sentence must not have it
 * read out as "asterisk asterisk".
 */
export function speakable(text: string): string {
  return stripReservedMarkers(text)
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/^\s{0,3}[-*+]\s+/gm, '')
    .replace(/(\*\*|__|\*|_|~~)/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * One WAV out of many (§33.2).
 *
 * Every sentence comes back as its own complete RIFF file, and a client handed
 * five concatenated RIFF headers plays the first 400 ms and stops. So: one
 * header up front with `0xFFFFFFFF` for the length — the streaming form, which
 * the reference synthesiser itself writes — and then the raw samples of each
 * piece with its own header removed.
 *
 * Every piece comes from one `tts` endpoint at one sample rate, so there is no
 * resampling to do; the first piece's format becomes the stream's, and a later
 * piece that disagrees is dropped loudly rather than played at the wrong pitch.
 */
class WavConcatenation {
  private format: { sampleRate: number; channels: number; bitsPerSample: number } | null = null;
  private headerSent = false;
  /** Bytes of the current piece not yet past its own header. */
  private pending: Buffer = Buffer.alloc(0);
  private headerSkipped = false;

  /** Feed one chunk of one piece; returns the bytes to write to the response. */
  push(chunk: Uint8Array): Uint8Array {
    if (this.headerSkipped) return chunk;
    this.pending = Buffer.concat([this.pending, Buffer.from(chunk)]);
    const info = readWavHeader(this.pending);
    // A RIFF header can be longer than 44 bytes (a `LIST` chunk before `data`),
    // so wait until the parser actually finds `data` rather than counting.
    if (!info) return EMPTY;

    const out: Buffer[] = [];
    if (!this.format) {
      this.format = {
        sampleRate: info.sampleRate,
        channels: info.channels,
        bitsPerSample: info.bitsPerSample,
      };
    } else if (
      this.format.sampleRate !== info.sampleRate ||
      this.format.channels !== info.channels ||
      this.format.bitsPerSample !== info.bitsPerSample
    ) {
      throw new Error(
        `the tts endpoint changed format mid-reply: ${info.sampleRate}Hz/${info.channels}ch ` +
          `after ${this.format.sampleRate}Hz/${this.format.channels}ch`,
      );
    }
    if (!this.headerSent) {
      this.headerSent = true;
      out.push(streamingWavHeader(this.format));
    }
    this.headerSkipped = true;
    out.push(this.pending.subarray(info.dataOffset));
    this.pending = Buffer.alloc(0);
    return out.length === 1 ? out[0]! : Buffer.concat(out);
  }

  /** This sentence is done; the next chunk starts a new RIFF header. */
  endPiece(): void {
    this.headerSkipped = false;
    this.pending = Buffer.alloc(0);
  }
}

const EMPTY = new Uint8Array(0);

/** A 44-byte PCM header declaring a length nobody knows yet. */
function streamingWavHeader(fmt: {
  sampleRate: number;
  channels: number;
  bitsPerSample: number;
}): Buffer {
  const bytesPerSample = fmt.bitsPerSample / 8;
  const buf = Buffer.alloc(44);
  buf.write('RIFF', 0, 'ascii');
  buf.writeUInt32LE(0xffffffff, 4);
  buf.write('WAVE', 8, 'ascii');
  buf.write('fmt ', 12, 'ascii');
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(fmt.channels, 22);
  buf.writeUInt32LE(fmt.sampleRate, 24);
  buf.writeUInt32LE(fmt.sampleRate * fmt.channels * bytesPerSample, 28);
  buf.writeUInt16LE(fmt.channels * bytesPerSample, 32);
  buf.writeUInt16LE(fmt.bitsPerSample, 34);
  buf.write('data', 36, 'ascii');
  buf.writeUInt32LE(0xffffffff, 40);
  return buf;
}
