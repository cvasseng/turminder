import fs from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ModelsYamlSchema } from '../src/core/config-schemas.js';
import { ModelGateway } from '../src/model/gateway.js';
import { ModelRouter } from '../src/model/router.js';
import { InferenceScheduler } from '../src/model/scheduler.js';
import {
  probeSpeech,
  STT_FIXTURE_WAV,
  type SttProbeResult,
  type TtsProbeResult,
} from '../src/model/probe.js';
import { MemoryTraceSink, type LlmCallTrace } from '../src/model/types.js';
import { readWavHeader } from '../src/model/wav.js';
import { probeEndpoint } from '../src/model/probe.js';
import { FakeLlama } from './fake-llama.js';
import { FakeSpeech, silenceWav } from './fake-speech.js';

/** The gateway wired to one fake serving both speech kinds (§10.9). */
function speechGateway(
  url: string,
  extra: { sttCost?: unknown; ttsCost?: unknown; language?: string; voice?: string } = {},
): ModelGateway {
  const router = new ModelRouter(
    ModelsYamlSchema.parse({
      endpoints: [
        { name: 'main', url: 'http://chat/v1', classes: ['fast', 'best'] },
        {
          name: 'whisper',
          url,
          kind: 'stt',
          model: 'fake-whisper',
          ...(extra.language ? { language: extra.language } : {}),
          ...(extra.sttCost ? { cost: extra.sttCost } : {}),
        },
        {
          name: 'piper',
          url,
          kind: 'tts',
          model: 'fake-piper',
          ...(extra.voice ? { voice: extra.voice } : {}),
          ...(extra.ttsCost ? { cost: extra.ttsCost } : {}),
        },
      ],
    }),
  );
  return new ModelGateway(router, new InferenceScheduler(1));
}

async function collect(stream: ReadableStream<Uint8Array>): Promise<Buffer> {
  const parts: Buffer[] = [];
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(Buffer.from(value));
  }
  return Buffer.concat(parts);
}

describe('the gateway speaks and listens (§10.9, V1.3)', () => {
  let fake: FakeSpeech;
  let url: string;
  const fixture = fs.readFileSync(STT_FIXTURE_WAV);
  const fixtureSeconds = readWavHeader(fixture)!.seconds;

  beforeEach(async () => {
    fake = new FakeSpeech();
    url = await fake.start();
  });
  afterEach(async () => {
    await fake.stop();
  });

  it('sends file, model and language, and returns the transcript', async () => {
    const gw = speechGateway(url, { language: 'nb' });
    const trace = new MemoryTraceSink();
    fake.script('Hei, hva skjer?');
    const r = await gw.transcribe({
      audio: fixture,
      mime: 'audio/wav',
      language: 'en',
      priority: 'interactive',
      trace,
    });
    expect(r.text).toBe('Hei, hva skjer?');
    expect(r.audioSeconds).toBeCloseTo(fixtureSeconds, 3);

    const sent = fake.requests.find((q) => q.path.endsWith('/audio/transcriptions'))!;
    expect(sent.fields.model).toBe('fake-whisper');
    expect(sent.fields.response_format).toBe('json');
    // The endpoint's own pin beats the caller's locale (§10.9).
    expect(sent.fields.language).toBe('nb');
    expect(sent.fileBytes?.length).toBe(fixture.length);
  });

  it('falls back to the caller language, and omits it entirely for auto', async () => {
    const withLocale = speechGateway(url);
    await withLocale.transcribe({
      audio: fixture,
      mime: 'audio/wav',
      language: 'en',
      priority: 'interactive',
    });
    expect(fake.requests.at(-1)!.fields.language).toBe('en');

    const auto = speechGateway(url, { language: 'auto' });
    await auto.transcribe({
      audio: fixture,
      mime: 'audio/wav',
      language: 'nb',
      priority: 'interactive',
    });
    expect(fake.requests.at(-1)!.fields.language).toBeUndefined();
  });

  it('traces a transcription as an llm_call priced by the minute', async () => {
    const gw = speechGateway(url, { sttCost: { per_minute: 0.6, currency: 'USD' } });
    const trace = new MemoryTraceSink();
    await gw.transcribe({ audio: fixture, mime: 'audio/wav', priority: 'interactive', trace });
    const [rec] = trace.ofKind('llm_call') as LlmCallTrace[];
    expect(rec).toMatchObject({
      purpose: 'stt',
      endpoint: 'whisper',
      resolved_by: 'kind_default',
      tokens_in: 0,
      tokens_out: 0,
      stop_reason: 'stop',
      currency: 'USD',
    });
    expect(rec!.audio_s).toBeCloseTo(fixtureSeconds, 3);
    expect(rec!.cost).toBeCloseTo((fixtureSeconds / 60) * 0.6, 8);
    expect(rec!.chars).toBeUndefined();
  });

  it('streams speech back and traces it priced by the character', async () => {
    const gw = speechGateway(url, {
      ttsCost: { per_kchar: 2, currency: 'USD' },
      voice: 'nova',
    });
    const trace = new MemoryTraceSink();
    fake.speechMs = 500;
    const text = 'Twelve characters and then some.';
    const r = await gw.speak({ text, priority: 'interactive', trace });
    expect(r.chars).toBe(text.length);

    const audio = await collect(r.stream);
    expect(readWavHeader(audio)).toMatchObject({ sampleRate: 22_050, channels: 1 });
    expect(audio.length).toBe(silenceWav(500).length);

    const sent = fake.requests.find((q) => q.path.endsWith('/audio/speech'))!;
    expect(sent.json).toMatchObject({
      model: 'fake-piper',
      input: text,
      voice: 'nova',
      response_format: 'wav',
    });

    const [rec] = trace.ofKind('llm_call') as LlmCallTrace[];
    expect(rec).toMatchObject({ purpose: 'tts', endpoint: 'piper', chars: text.length });
    expect(rec!.cost).toBeCloseTo((text.length / 1000) * 2, 8);
    expect(rec!.audio_s).toBeUndefined();
  });

  it('leaves an error row and throws when the endpoint fails', async () => {
    const gw = speechGateway(url);
    const trace = new MemoryTraceSink();
    fake.errorStatus = 500;
    await expect(
      gw.transcribe({ audio: fixture, mime: 'audio/wav', priority: 'interactive', trace }),
    ).rejects.toThrow(/HTTP 500/);
    await expect(gw.speak({ text: 'hello', priority: 'interactive', trace })).rejects.toThrow(
      /HTTP 500/,
    );
    const rows = trace.ofKind('llm_call') as LlmCallTrace[];
    expect(rows.map((r) => r.stop_reason)).toEqual(['error', 'error']);
    expect(rows.map((r) => r.purpose)).toEqual(['stt', 'tts']);
  });

  it('refuses to call an endpoint that is not configured', async () => {
    const bare = new ModelGateway(
      new ModelRouter(
        ModelsYamlSchema.parse({
          endpoints: [{ name: 'main', url: 'http://chat/v1', classes: ['fast'] }],
        }),
      ),
      new InferenceScheduler(1),
    );
    await expect(bare.speak({ text: 'hi', priority: 'interactive' })).rejects.toThrow(
      /no tts endpoint configured/,
    );
  });

  it('presents the api key as a bearer and never in the message', async () => {
    const router = new ModelRouter(
      ModelsYamlSchema.parse({
        endpoints: [
          { name: 'piper', url, kind: 'tts', model: 'm', api_key: 'sk-secret-value' },
        ],
      }),
    );
    const gw = new ModelGateway(router, new InferenceScheduler(1));
    const r = await gw.speak({ text: 'hi', priority: 'interactive' });
    await collect(r.stream);
    const sent = fake.requests.at(-1)!;
    expect(sent.headers.authorization).toBe('Bearer sk-secret-value');
    expect(JSON.stringify(sent.json)).not.toContain('sk-secret-value');
  });
});

describe('probeSpeech (§10.2, §10.9, V1.4)', () => {
  let fake: FakeSpeech;
  let url: string;

  beforeEach(async () => {
    fake = new FakeSpeech();
    url = await fake.start();
  });
  afterEach(async () => {
    await fake.stop();
  });

  it('passes an stt endpoint that hears the fixture, mangled name and all', async () => {
    // Six words of seven: the reference result, and the reason the threshold
    // is 80% rather than 100%.
    fake.script('Reminder is ready to help you today.');
    const r = (await probeSpeech('stt', url)) as SttProbeResult;
    expect(r).toMatchObject({ reachable: true, matched: true, model_id: 'fake-whisper' });
    expect(r.transcript).toBe('Reminder is ready to help you today.');
    // It sent the fixture, not something it made up.
    const sent = fake.requests.find((q) => q.path.endsWith('/audio/transcriptions'))!;
    expect(sent.fileBytes).toEqual(fs.readFileSync(STT_FIXTURE_WAV));
    expect(sent.fields.language).toBe('en');
  });

  it('fails an stt endpoint that hallucinates, and says what it heard', async () => {
    fake.script('Thank you for watching.');
    const r = (await probeSpeech('stt', url)) as SttProbeResult;
    expect(r.reachable).toBe(true);
    expect(r.matched).toBe(false);
    expect(r.error).toContain('Thank you for watching.');
  });

  it('reports an unreachable stt endpoint rather than a bad transcriber', async () => {
    fake.errorStatus = 502;
    const r = (await probeSpeech('stt', url)) as SttProbeResult;
    expect(r.reachable).toBe(false);
    expect(r.matched).toBe(false);
    expect(r.error).toContain('502');
  });

  it('passes a tts endpoint that returns real audio', async () => {
    fake.speechMs = 900;
    const r = (await probeSpeech('tts', url)) as TtsProbeResult;
    expect(r).toMatchObject({ reachable: true, ok: true, sample_rate: 22_050 });
    expect(r.seconds).toBeCloseTo(0.9, 2);
    expect(r.voices).toBeUndefined();
  });

  it('refuses a tts endpoint that answers with a click, or with the wrong rate', async () => {
    fake.speechMs = 100;
    const short = (await probeSpeech('tts', url)) as TtsProbeResult;
    expect(short.ok).toBe(false);
    expect(short.error).toContain('0.100s');

    fake.speechMs = 900;
    fake.speechSampleRate = 96_000;
    const fast = (await probeSpeech('tts', url)) as TtsProbeResult;
    expect(fast.ok).toBe(false);
    expect(fast.error).toContain('96000');
  });

  it('lists voices when the endpoint offers them', async () => {
    fake.voices = ['alloy', 'nb_NO-talesyntese-medium'];
    const r = (await probeSpeech('tts', url)) as TtsProbeResult;
    expect(r.ok).toBe(true);
    expect(r.voices).toEqual(['alloy', 'nb_NO-talesyntese-medium']);
  });

  it('writes nothing anywhere', async () => {
    // The probe reports; `setup.form` decides. Nothing to assert but the
    // absence of a config argument — this test exists to keep it that way.
    expect(probeSpeech.length).toBeLessThanOrEqual(3);
  });
});

describe('the `none` effort probe (§10.6, V2.3)', () => {
  let fake: FakeLlama;
  let url: string;

  beforeEach(async () => {
    fake = new FakeLlama();
    url = await fake.startV1();
  });
  afterEach(async () => {
    await fake.stop();
  });

  /** Answer with reasoning unless the request carries the no-think fragment. */
  function thinksUnlessTold(fragment: (body: any) => boolean): void {
    fake.always((req) =>
      fragment(req.body) ? { text: '9' } : { text: '9', reasoning: 'seventeen minus…' },
    );
  }

  it('tags `none` when the fragment actually stops the thinking', async () => {
    thinksUnlessTold((b) => b.reasoning_effort === 'none');
    const r = await probeEndpoint(url, { timeoutMs: 5000 });
    expect(r.checks.no_think).toBe(true);
    expect(r.efforts).toEqual(['none']);
  });

  it('does not tag it when the endpoint keeps reasoning anyway', async () => {
    // The knob is accepted and ignored — the failure this check exists for.
    fake.always({ text: '9', reasoning: 'still thinking about it' });
    const r = await probeEndpoint(url, { timeoutMs: 5000 });
    expect(r.checks.no_think).toBe(false);
    expect(r.efforts).toBeUndefined();
    expect(r.notes.join(' ')).toContain('kept reasoning');
  });

  it('does not tag an endpoint that never reasoned in the first place', async () => {
    // Nothing to turn off is not the same as a working switch: tagging it
    // would promise a voice conversation something this endpoint cannot do.
    fake.always({ text: '9' });
    const r = await probeEndpoint(url, { timeoutMs: 5000 });
    expect(r.checks.no_think).toBe(false);
    expect(r.efforts).toBeUndefined();
    expect(r.notes.join(' ')).toContain('nothing for `none` to turn off');
  });

  it('tests the fragment the caller names, not only the default', async () => {
    thinksUnlessTold((b) => b.chat_template_kwargs?.enable_thinking === false);
    const wrong = await probeEndpoint(url, { timeoutMs: 5000 });
    expect(wrong.checks.no_think).toBe(false);

    const right = await probeEndpoint(url, {
      timeoutMs: 5000,
      noThink: { chat_template_kwargs: { enable_thinking: false } },
    });
    expect(right.checks.no_think).toBe(true);
  });
});
