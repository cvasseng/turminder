import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { afterEach, describe, expect, it } from 'vitest';
import { readWavHeader } from '../src/model/wav.js';
import { clearVoiceCache } from '../src/model/probe.js';
import { spokenForm } from '../src/egress/spoken.js';
import { ACKNOWLEDGEMENTS, isSilenceHallucination, speakable } from '../src/voice/adapter.js';
import { bootService, TestClient, type ServiceHarness } from './service-harness.js';
import { tmpDir } from './helpers.js';
import { FakeSpeech, silenceWav } from './fake-speech.js';

let h: ServiceHarness;
let speech: FakeSpeech;

afterEach(async () => {
  await h?.cleanup();
  await speech?.stop();
});

/** A WAV of `ms` at 16 kHz mono — what a device sends up (§33.2). */
function utterance(ms: number): Buffer {
  return silenceWav(ms, 16_000);
}

/**
 * A harness whose models.yaml also points at a speech endpoint, written after
 * boot the way `test/cost.test.ts` rewrites efforts — the boot fixture knows
 * nothing about voice and does not need to.
 */
async function bootVoice(
  opts: {
    efforts?: string[];
    noThink?: Record<string, unknown>;
    config?: Record<string, unknown>;
  } = {},
): Promise<void> {
  h = await bootService({
    onboarded: true,
    watchFiles: false,
    ...(opts.config ? { config: opts.config } : {}),
  });
  speech = new FakeSpeech();
  const url = await speech.start();
  const file = path.join(h.dataDir, 'config', 'models.yaml');
  const models = YAML.parse(fs.readFileSync(file, 'utf8')) as {
    endpoints: Record<string, unknown>[];
  };
  if (opts.efforts) models.endpoints[0]!.efforts = opts.efforts;
  if (opts.noThink) models.endpoints[0]!.no_think = opts.noThink;
  models.endpoints.push(
    { name: 'whisper', url, kind: 'stt', model: 'fake-whisper' },
    { name: 'piper', url, kind: 'tts', model: 'fake-piper', voice: 'alloy' },
  );
  fs.writeFileSync(file, YAML.stringify(models), 'utf8');
  h.app.config.reload();
  h.service.loadModels();
}

interface VoiceResponse {
  status: number;
  headers: Headers;
  body: Buffer;
  json: any;
}

async function speak(ms = 1500, mime = 'audio/wav'): Promise<VoiceResponse> {
  const res = await fetch(`${h.baseUrl}/api/voice`, {
    method: 'POST',
    headers: { authorization: `Bearer ${h.token}`, 'content-type': mime },
    body: new Uint8Array(utterance(ms)),
  });
  const body = Buffer.from(await res.arrayBuffer());
  let parsed: any = null;
  if (res.headers.get('content-type')?.includes('json')) {
    try {
      parsed = JSON.parse(body.toString('utf8'));
    } catch {
      parsed = null;
    }
  }
  return { status: res.status, headers: res.headers, body, json: parsed };
}

/** The chat completions the fake model served, for prompt assertions. */
const completions = () => h.fake.requests.filter((r) => r.path.endsWith('/chat/completions'));

describe('POST /api/voice (§33.2, App. E)', () => {
  it('transcribes, answers, and streams one playable WAV of every sentence', async () => {
    await bootVoice();
    speech.script('What is on my calendar today?');
    speech.speechMs = 400;
    h.fake.always({ text: 'Nothing until four. Then a call with Sam.' });

    const res = await speak();
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('audio/wav');
    expect(res.headers.get('x-turminder-conversation')).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(res.headers.get('x-turminder-transcript')).toBe(
      "UTF-8''What%20is%20on%20my%20calendar%20today%3F",
    );

    // One header, then the samples of both sentences — not two RIFF files
    // glued together, which plays as the first 400ms and then silence.
    const info = readWavHeader(res.body)!;
    expect(info).toMatchObject({ sampleRate: 22_050, channels: 1, bitsPerSample: 16 });
    expect(info.dataOffset).toBe(44);
    const piece = silenceWav(400).length - 44;
    expect(speech.spoken).toEqual(['Nothing until four.', 'Then a call with Sam.']);
    expect(res.body.length).toBe(44 + piece * 2);
    // Exactly one RIFF marker in the whole body.
    expect(res.body.toString('latin1').split('RIFF').length - 1).toBe(1);
  });

  it('leaves an stt, a chat and a tts row in the request log (§10.9)', async () => {
    await bootVoice();
    speech.script('One question.');
    h.fake.always({ text: 'One answer. And a second sentence.' });
    await speak();

    const rows = (
      h.app.db.prepare(`SELECT data FROM trace WHERE kind = 'llm_call' ORDER BY seq`).all() as {
        data: string;
      }[]
    ).map((r) => JSON.parse(r.data) as Record<string, any>);
    // The background titling run (§9) interleaves; the utterance's own three
    // purposes are what this is about.
    const spokenRows = rows.filter((r) => r.purpose !== 'title');
    expect(spokenRows.map((r) => r.purpose)).toEqual(['stt', 'chat', 'tts', 'tts']);
    expect(rows[0]).toMatchObject({ endpoint: 'whisper', tokens_in: 0, tokens_out: 0 });
    expect(rows[0]!.audio_s).toBeCloseTo(1.5, 1);
    // One row per sentence spoken, charged by the characters that were said.
    expect(spokenRows.slice(2).map((r) => r.chars)).toEqual([
      'One answer.'.length,
      'And a second sentence.'.length,
    ]);
    // Every speech row hangs off a real run, so the log can be read per turn.
    for (const row of rows) expect(row.endpoint).toBeTruthy();
    const orphans = h.app.db
      .prepare(`SELECT COUNT(*) AS n FROM trace WHERE kind = 'llm_call' AND run_id IS NULL`)
      .get() as { n: number };
    expect(orphans.n).toBe(0);
  });

  it('keeps the conversation for a follow-up and opens a new one after the idle window', async () => {
    await bootVoice();
    h.fake.always({ text: 'Yes.' });

    speech.script('Are you there?');
    const first = await speak();
    const conversationId = first.headers.get('x-turminder-conversation')!;

    speech.script('And now?');
    const second = await speak();
    expect(second.headers.get('x-turminder-conversation')).toBe(conversationId);

    // Age the conversation past `voice_idle_min` (App. A: 10 minutes).
    const stale = new Date(Date.now() - 20 * 60_000).toISOString();
    h.app.db
      .prepare(`UPDATE conversations SET last_activity_at = ? WHERE id = ?`)
      .run(stale, conversationId);

    speech.script('Still there?');
    const third = await speak();
    expect(third.headers.get('x-turminder-conversation')).not.toBe(conversationId);
    expect(h.service.repos.conversations.list().length).toBe(2);
  });

  it('writes nothing when what came back is what silence sounds like', async () => {
    await bootVoice();
    speech.script('Thank you for watching.');
    const res = await speak();
    expect(res.status).toBe(422);
    expect(res.json).toMatchObject({ error: 'nothing_heard' });
    expect(h.service.repos.conversations.list()).toEqual([]);
    // The transcription itself is real work and is traced; what must not exist
    // is a conversation, a turn, or a chat run (§33.2).
    expect(runKinds()).toEqual(['maintenance']);
  });

  it('refuses audio too short to be a sentence before it transcribes anything', async () => {
    await bootVoice();
    const res = await speak(100);
    expect(res.status).toBe(422);
    expect(res.json.error).toBe('nothing_heard');
    expect(speech.requests).toEqual([]);
    expect(runKinds()).toEqual([]);
  });

  it('refuses too much audio, the wrong media type, and an anonymous caller', async () => {
    await bootVoice();
    const long = await speak(31_000);
    expect(long.status).toBe(413);
    expect(long.json.error).toBe('too_long');

    const wrong = await speak(1500, 'audio/ogg');
    expect(wrong.status).toBe(415);
    expect(wrong.json.error).toBe('unsupported_media_type');

    const anon = await fetch(`${h.baseUrl}/api/voice`, {
      method: 'POST',
      headers: { 'content-type': 'audio/wav' },
      body: new Uint8Array(utterance(1500)),
    });
    expect(anon.status).toBe(401);
    expect(h.service.repos.conversations.list()).toEqual([]);
  });

  it('says which speech endpoint is missing rather than failing obscurely', async () => {
    // No stt/tts entries at all — the ordinary state of an install that has
    // not been given a transcriber.
    h = await bootService({ onboarded: true, watchFiles: false });
    const res = await speak();
    expect(res.status).toBe(503);
    expect(res.json).toMatchObject({ error: 'no_speech_endpoint', kind: 'stt' });
  });

  it('says approval is needed on a screen rather than holding the line open', async () => {
    // A confirm suspends the run until a human answers or the App. A hour
    // runs out (§11.3). Nobody is going to hold an HTTP response for that, and
    // §33.1 rules out approving by voice — so the room is told where to look.
    // `files.delete` is confirm-tier in the shipped defaults (App. A).
    await bootVoice();
    speech.script('Delete the old invoices.');
    let asked = false;
    h.fake.always((req: any) => {
      if (req.body.tools && !asked) {
        asked = true;
        return { toolCalls: [{ name: 'files.delete', args: { path: 'invoices/old.md' } }] };
      }
      return { text: 'Done.' };
    });

    const res = await speak();
    expect(res.status).toBe(200);
    expect(speech.spoken).toEqual(['I need your approval on a screen for that.']);
    // The confirm itself is still queued for whatever *can* show it (§7.3).
    const deliveries = h.app.db.prepare(`SELECT intent FROM deliveries`).all() as {
      intent: string;
    }[];
    expect(deliveries.map((d) => d.intent)).toContain('confirm');
  });

  it('says it is working when the answer is slow, and stays quiet when it is not', async () => {
    // The complaint this exists for: a turn that takes a while is silence in a
    // room, and silence is indistinguishable from a machine that did not hear
    // you (Christer, 2026-08-30).
    await bootVoice({ config: { voice: { acknowledge_after_ms: 60 } } });
    speech.script('What is the weather like?');
    // Slower than the threshold, so the wait is real.
    h.fake.always({ text: 'Sunny.', delayMs: 250 });
    await speak();
    expect(speech.spoken[0]).toBeOneOf(ACKNOWLEDGEMENTS as string[]);
    expect(speech.spoken.at(-1)).toBe('Sunny.');

    // And a fast one gets no announcement in front of it.
    speech.reset();
    speech.script('And now?');
    h.fake.always({ text: 'Still sunny.' });
    await speak();
    expect(speech.spoken).toEqual(['Still sunny.']);
  });

  it('never acknowledges when the setting is off', async () => {
    await bootVoice({ config: { voice: { acknowledge_after_ms: 0 } } });
    speech.script('Take your time.');
    h.fake.always({ text: 'Done.', delayMs: 200 });
    await speak();
    expect(speech.spoken).toEqual(['Done.']);
  });

  it('speaks the failure sentence when the run fails', async () => {
    await bootVoice();
    speech.script('Do the thing.');
    // An endpoint that answers with nothing is a failed run (§20).
    h.fake.always({ text: '' });
    const res = await speak();
    expect(res.status).toBe(200);
    expect(speech.spoken).toEqual(['Sorry, that went wrong.']);
  });
});

describe('the voice conversation (§33.1)', () => {
  it('is labelled voice, carries the fragment, and a typed one does not', async () => {
    await bootVoice();
    speech.script('Say something short.');
    h.fake.always({ text: 'Right.' });
    await speak();
    const spokenPrompt = completions().at(-1)!.body.messages[0].content as string;
    expect(spokenPrompt).toContain('You are being heard, not read');

    // A typed conversation through the ordinary path: same base prompt,
    // without the fragment — the prefix guard for §20.5.
    h.fake.requests.length = 0;
    h.service.chat.send({ text: 'and typed?' });
    await h.service.queue.drain();
    const typedPrompt = completions().at(-1)!.body.messages[0].content as string;
    expect(typedPrompt).not.toContain('You are being heard, not read');
    // The fragment is appended to the same base prompt, not a different one.
    expect(spokenPrompt.startsWith(typedPrompt.split('\n\n---\n\n')[0]!)).toBe(true);

    const conversations = h.service.repos.conversations.list();
    const voice = conversations.find((c) => c.voice_device)!;
    expect(voice.mode).toBe('voice');
    expect(voice.voice_device).toBe('ui');
  });

  it('shows the transcript and the reply in history like any other conversation', async () => {
    await bootVoice();
    speech.script('What did I say?');
    h.fake.always({ text: 'You asked what you said.' });
    const res = await speak();
    const id = res.headers.get('x-turminder-conversation')!;

    const client = await TestClient.connect(h.baseUrl, h.token);
    await client.hello(['chat']);
    client.send('chat.history', { conversation_id: id });
    const history = await client.next('chat.history.result');
    const turns = history.payload.turns as { role: string; text: string }[];
    expect(turns.map((t) => [t.role, t.text])).toEqual([
      ['user', 'What did I say?'],
      ['assistant', 'You asked what you said.'],
    ]);
    // And the list labels it, with the device that spoke (D.1).
    client.send('conversation.list', {});
    const listed = await client.next('conversation.list.result');
    expect(listed.payload.conversations[0]).toMatchObject({
      mode: 'voice',
      voice_device: 'ui',
    });
    client.close();
  });

  it('pins `none` only where the endpoint declares it', async () => {
    await bootVoice({ efforts: ['none', 'low'], noThink: { enable_thinking: false } });
    speech.script('Quickly now.');
    h.fake.always({ text: 'Quick.' });
    await speak();
    const body = completions().at(-1)!.body;
    expect(body.enable_thinking).toBe(false);
    expect(body.reasoning_effort).toBeUndefined();
  });

  it('sends nothing when the endpoint has not declared `none`', async () => {
    await bootVoice();
    speech.script('Quickly now.');
    h.fake.always({ text: 'Quick.' });
    await speak();
    const body = completions().at(-1)!.body;
    expect(body.reasoning_effort).toBeUndefined();
    expect(body.enable_thinking).toBeUndefined();
  });

  it('never speaks reasoning', async () => {
    await bootVoice();
    speech.script('Think about it.');
    // A thinking model: the reasoning streams on its own channel and must not
    // reach the synthesiser, or the room hears the model talking to itself.
    h.fake.always({ text: 'The answer is four.', reasoning: 'let me consider this carefully' });
    await speak();
    expect(speech.spoken).toEqual(['The answer is four.']);
    expect(speech.spoken.join(' ')).not.toContain('consider');
  });
});

describe('what a speaker is handed', () => {
  it('recognises the silence hallucinations whatever their punctuation', () => {
    expect(isSilenceHallucination('Thank you.')).toBe(true);
    expect(isSilenceHallucination('  thanks for watching!  ')).toBe(true);
    expect(isSilenceHallucination('You')).toBe(true);
    // A real sentence that merely starts the same way must survive.
    expect(isSilenceHallucination('Thank you for the reminder')).toBe(false);
    expect(isSilenceHallucination('bye for now')).toBe(false);
  });

  it('strips markdown and reserved markers before anything is spoken', () => {
    expect(speakable('**Bold** and `code`')).toBe('Bold and code');
    expect(speakable('- one\n- two')).toBe('one two');
    expect(speakable('See [the docs](http://x/y)')).toBe('See the docs');
    expect(speakable('Done. [[used tools: files.append]]')).toBe('Done.');
    expect(speakable('# Heading\ntext')).toBe('Heading text');
  });
});

function runKinds(): string[] {
  return (
    h.app.db.prepare(`SELECT kind FROM runs ORDER BY started_at`).all() as { kind: string }[]
  ).map((r) => r.kind);
}

describe('spoken deliveries (§33.3, F.3, App. E)', () => {
  /** Queue a notify through the tool the model actually calls. */
  async function notify(args: Record<string, unknown>): Promise<any> {
    const tool = h.service.tools.handles().find((t) => t.name === 'deliver.notify')!;
    return (await tool.call(args, { runId: null, eventId: null })).output as any;
  }

  async function speakDelivery(deliveryId: unknown, token = h.token): Promise<VoiceResponse> {
    const res = await fetch(`${h.baseUrl}/api/speak`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ delivery_id: deliveryId }),
    });
    const body = Buffer.from(await res.arrayBuffer());
    let parsed: any = null;
    if (res.headers.get('content-type')?.includes('json')) {
      parsed = JSON.parse(body.toString('utf8'));
    }
    return { status: res.status, headers: res.headers, body, json: parsed };
  }

  it('speaks the handler line when there is one, and the title and body when there is not', async () => {
    await bootVoice();
    const withSpoken = await notify({
      title: 'Invoice from Hafslund',
      body: 'NOK 2300.00\nDue 2026-09-04\nFiled under bills',
      spoken: 'Invoice from Hafslund, two thousand three hundred kroner, due Friday.',
    });
    const heard = await speakDelivery(withSpoken.delivery_id);
    expect(heard.status).toBe(200);
    expect(heard.headers.get('content-type')).toBe('audio/wav');
    expect(readWavHeader(heard.body)).toMatchObject({ sampleRate: 22_050 });
    expect(speech.spoken).toEqual([
      'Invoice from Hafslund, two thousand three hundred kroner, due Friday.',
    ]);

    const plain = await notify({ title: 'Bin day', body: 'Paper and glass, tomorrow' });
    await speakDelivery(plain.delivery_id);
    // Title then body, each ending in punctuation so the synthesiser pauses.
    expect(speech.spoken.at(-1)).toBe('Bin day. Paper and glass, tomorrow.');
  });

  it('carries `spoken` into the payload and the delivery frame, and refuses one over the cap', async () => {
    await bootVoice();
    const client = await TestClient.connect(h.baseUrl, h.token);
    await client.hello(['notify.actions', 'voice']);
    await notify({ title: 'A thing', body: 'happened', spoken: 'A thing happened.' });
    const frame = await client.next('delivery');
    expect(frame.payload.payload).toMatchObject({ spoken: 'A thing happened.' });
    client.close();

    const tool = h.service.tools.handles().find((t) => t.name === 'deliver.notify')!;
    const tooLong = await tool.call(
      { title: 'x', body: 'y', spoken: 'a'.repeat(301) },
      { runId: null, eventId: null },
    );
    expect(JSON.stringify(tooLong.output)).toMatch(/300/);
  });

  it('composes a confirm server-side and never speaks a secret reference', async () => {
    await bootVoice();
    const delivery = h.service.outbox.queue({
      intent: 'confirm',
      payload: {
        title: 'Sleeper Service wants to send a message',
        body: 'to: ops@example.com\nkey: (a stored secret)',
        run_id: '01RUN',
        tool: 'mail.send',
        args_summary: 'to ops@example.com, using a stored secret',
        details: [{ label: 'key', value: '(a stored secret)' }],
        actions: [
          { id: 'approve', label: 'Approve' },
          { id: 'deny', label: 'Deny' },
        ],
      },
      ttlS: 3600,
    });
    const heard = await speakDelivery(delivery.id);
    expect(heard.status).toBe(200);
    expect(speech.spoken).toEqual([
      'Sleeper Service wants to send a message. to ops@example.com, using a stored secret. ' +
        'Approve or deny on a screen.',
    ]);
    expect(speech.spoken.join(' ')).not.toContain('${secret:');
  });

  it('is an id and never free text, and never acks', async () => {
    await bootVoice();
    const queued = await notify({ title: 'Bin day', body: 'tomorrow' });
    await speakDelivery(queued.delivery_id);
    const row = h.service.repos.deliveries.get(queued.delivery_id)!;
    // Hearing it is not displaying it: the device acks as it always has.
    expect(row.acked_at).toBeNull();
    expect(row.status).not.toBe('acked');

    const anon = await fetch(`${h.baseUrl}/api/speak`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ delivery_id: queued.delivery_id }),
    });
    expect(anon.status).toBe(401);
  });

  it('answers 404 for an unknown delivery, 410 for one whose moment has passed', async () => {
    await bootVoice();
    expect((await speakDelivery('01NOSUCHDELIVERY')).status).toBe(404);

    const queued = await notify({ title: 'Old news', body: 'from yesterday' });
    h.app.db
      .prepare(`UPDATE deliveries SET expires_at = ? WHERE id = ?`)
      .run(new Date(Date.now() - 60_000).toISOString(), queued.delivery_id);
    const stale = await speakDelivery(queued.delivery_id);
    expect(stale.status).toBe(410);
    expect(stale.json.error).toBe('expired');
    expect(speech.spoken).toEqual([]);
  });

  it('says which endpoint is missing when nothing can speak', async () => {
    h = await bootService({ onboarded: true, watchFiles: false });
    const queued = await notify({ title: 'Bin day', body: 'tomorrow' });
    const res = await speakDelivery(queued.delivery_id);
    expect(res.status).toBe(503);
    expect(res.json).toMatchObject({ error: 'no_speech_endpoint', kind: 'tts' });
  });

  it('is invisible to a screen renderer', async () => {
    // `notify-send` reads title, body and actions and nothing else (§7.3), so
    // a `spoken` line changes nothing about what a screen shows. Driven
    // through the real renderer with a script standing in for the binary.
    const { NotifySendRenderer } = await import('../daemon/notify-send.js');
    const seen: string[] = [];
    const script = path.join(scriptDir(), 'echo-args.sh');
    const renderer = new NotifySendRenderer({ command: script, log: (m) => seen.push(m) });
    const out = await renderer.show({
      seq: 1,
      delivery_id: '01D',
      intent: 'notify',
      expires_at: new Date(Date.now() + 60_000).toISOString(),
      payload: { title: 'Bin day', body: 'tomorrow', spoken: 'Bins go out tonight.' },
    });
    expect(out.shown).toBe(true);
    const args = fs.readFileSync(path.join(scriptDir(), 'args.txt'), 'utf8');
    expect(args).toContain('Bin day');
    expect(args).toContain('tomorrow');
    expect(args).not.toContain('Bins go out tonight.');
  });

  it('accepts `voice` in hello and changes nothing about routing', async () => {
    await bootVoice();
    const client = await TestClient.connect(h.baseUrl, h.token);
    const welcome = await client.hello(['notify.actions', 'voice']);
    expect(welcome).toBeTruthy();
    // A voice device is still a notify.actions device: the same delivery
    // reaches it, spoken or not (§7.2).
    await notify({ title: 'A thing', body: 'happened' });
    const frame = await client.next('delivery');
    expect(frame.payload.intent).toBe('notify');
    client.close();
  });
});

describe('spokenForm (§33.3)', () => {
  const delivery = (intent: 'notify' | 'confirm', payload: Record<string, unknown>) =>
    ({ intent, payload }) as any;

  it('prefers the handler line, falls back to title and body', () => {
    expect(
      spokenForm(delivery('notify', { title: 'A', body: 'B', spoken: 'Just this.' })),
    ).toBe('Just this.');
    expect(spokenForm(delivery('notify', { title: 'A', body: 'B' }))).toBe('A. B.');
    // Already punctuated stays as written — no double full stop.
    expect(spokenForm(delivery('notify', { title: 'A?', body: 'B!' }))).toBe('A? B!');
  });

  it('composes a confirm and strips reserved markers from anything it speaks', () => {
    expect(
      spokenForm(
        delivery('confirm', { title: 'X wants to delete a file', args_summary: 'a.md' }),
      ),
    ).toBe('X wants to delete a file. a.md. Approve or deny on a screen.');
    expect(
      spokenForm(delivery('notify', { title: 'Done', body: '[[used tools: a]] and b' })),
    ).toBe('Done. and b.');
  });
});

/** A throwaway directory holding the stand-in for `notify-send`. */
let scripts: { dir: string; cleanup: () => void } | null = null;
function scriptDir(): string {
  if (!scripts) {
    scripts = tmpDir('turminder-notify-');
    const script = path.join(scripts.dir, 'echo-args.sh');
    fs.writeFileSync(
      script,
      `#!/bin/sh\nprintf '%s\\n' "$@" > "${path.join(scripts.dir, 'args.txt')}"\n`,
      { mode: 0o755 },
    );
  }
  return scripts.dir;
}

describe('GET /api/voice/preview (§33.5, App. E)', () => {
  async function preview(voice: string | null, token = h.token): Promise<VoiceResponse> {
    const q = voice === null ? '' : `?voice=${encodeURIComponent(voice)}`;
    const res = await fetch(`${h.baseUrl}/api/voice/preview${q}`, {
      headers: { authorization: `Bearer ${token}` },
    });
    const body = Buffer.from(await res.arrayBuffer());
    let parsed: any = null;
    if (res.headers.get('content-type')?.includes('json')) {
      parsed = JSON.parse(body.toString('utf8'));
    }
    return { status: res.status, headers: res.headers, body, json: parsed };
  }

  it('speaks the App. A sentence in that voice, and nothing else, ever', async () => {
    clearVoiceCache();
    await bootVoice();
    const res = await preview('nova');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('audio/wav');
    expect(readWavHeader(res.body)).toMatchObject({ sampleRate: 22_050 });
    // The instance's own name (G.3), and the fixed line around it.
    expect(speech.spoken).toEqual([`Hello — I'm Sleeper Service. This is how I sound.`]);
    const sent = speech.requests.at(-1)!;
    // The query is the only input that reaches the endpoint.
    expect(sent.json.voice).toBe('nova');
  });

  it('refuses a voice the endpoint says it does not have, and takes any when it lists none', async () => {
    clearVoiceCache();
    await bootVoice();
    speech.voices = ['alloy', 'nova'];
    const unknown = await preview('vader');
    expect(unknown.status).toBe(400);
    expect(unknown.json.error).toBe('unknown_voice');
    expect(speech.spoken).toEqual([]);
    expect((await preview('nova')).status).toBe(200);

    // openedai-speech and OpenAI itself list nothing; an empty listing must
    // not make every voice unpreviewable.
    clearVoiceCache();
    speech.voices = null;
    expect((await preview('anything-at-all')).status).toBe(200);
  });

  it('needs a voice, a token, and a synthesiser', async () => {
    clearVoiceCache();
    await bootVoice();
    expect((await preview(null)).status).toBe(400);
    expect((await preview('nova', 'not-a-token')).status).toBe(401);

    await h.cleanup();
    h = await bootService({ onboarded: true, watchFiles: false });
    const none = await preview('nova');
    expect(none.status).toBe(503);
    expect(none.json).toMatchObject({ error: 'no_speech_endpoint', kind: 'tts' });
  });

  it('reads voices out of the model listing when there is no /voices route', async () => {
    // The Speaches shape (Christer, 2026-08-31): nothing flat answers, and the
    // voices live inside the `/v1/models` entry. Before this the form fell back
    // to OpenAI's six — which are openedai-speech's piper aliases, so the list
    // looked plausible and was wrong.
    clearVoiceCache();
    await bootVoice();
    speech.voices = null;
    // `fake-piper` is the model the tts entry names, so the endpoint has to
    // serve it for there to be anything to look inside.
    speech.otherModels = ['fake-piper'];
    speech.modelVoices = { 'fake-piper': ['af_heart', 'am_puck'] };
    expect((await preview('af_heart')).status).toBe(200);
    clearVoiceCache();
    const unknown = await preview('alloy');
    expect(unknown.status).toBe(400);
    expect(unknown.json.error).toBe('unknown_voice');
  });

  it('offers the configured model its own voices, not another model on the same box', async () => {
    // One Speaches commonly serves several synthesisers — the reference box has
    // Kokoro with fifty-four voices beside a Norwegian piper with one — and a
    // union offers voices the configured model will refuse.
    clearVoiceCache();
    await bootVoice();
    speech.voices = null;
    speech.otherModels = ['fake-piper', 'kokoro'];
    speech.modelVoices = {
      'fake-piper': ['talesyntese'],
      kokoro: ['af_heart', 'am_puck'],
    };
    // `fake-piper` is what the tts entry names.
    expect((await preview('talesyntese')).status).toBe(200);
    clearVoiceCache();
    expect((await preview('af_heart')).status).toBe(400);
  });

  it('caches a voice listing for a minute rather than asking on every render', async () => {
    clearVoiceCache();
    await bootVoice();
    speech.voices = ['alloy'];
    await preview('alloy');
    await preview('alloy');
    const listings = speech.requests.filter((r) => /voices$/.test(r.path));
    // One round of route-probing, not two.
    expect(listings.length).toBeGreaterThan(0);
    expect(listings.filter((r) => r.path.endsWith('/audio/speech/voices')).length).toBe(1);
  });
});
