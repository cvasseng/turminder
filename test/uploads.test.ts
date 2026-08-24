import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { afterEach, describe, expect, it } from 'vitest';
import { imageMarker } from '../src/core/markers.js';
import { probeEndpoint, GREEN_PNG as PROBE_PNG_B64 } from '../src/model/probe.js';
import { UploadReaper } from '../src/uploads/reaper.js';
import { bootService, TestClient, type ServiceHarness } from './service-harness.js';
import { FakeLlama } from './fake-llama.js';

let h: ServiceHarness;
afterEach(async () => {
  await h?.cleanup();
});

const drain = (harness: ServiceHarness) => harness.service.queue.drain();

/** The probe's own 2x2 green PNG — small enough to inline, real enough to store. */
const GREEN_PNG = Buffer.from(PROBE_PNG_B64, 'base64');

async function upload(
  harness: ServiceHarness,
  body: Buffer,
  mime = 'image/png',
  name = 'shot.png',
): Promise<{ status: number; body: any }> {
  const res = await fetch(`${harness.baseUrl}/api/uploads`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${harness.token}`,
      'content-type': mime,
      'x-upload-name': name,
    },
    body: new Uint8Array(body),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

describe('the upload store (§26.1, App. E)', () => {
  it('stores an image, content-addressed, and serves it back', async () => {
    h = await bootService({ onboarded: true, watchFiles: false });
    const first = await upload(h, GREEN_PNG);
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ mime: 'image/png', bytes: GREEN_PNG.length });
    expect(first.body.sha256).toMatch(/^[0-9a-f]{64}$/);

    // Content addressing: the same bytes twice are one file and two rows.
    const second = await upload(h, GREEN_PNG, 'image/png', 'again.png');
    expect(second.body.upload_id).not.toBe(first.body.upload_id);
    expect(second.body.sha256).toBe(first.body.sha256);
    const files = fs.readdirSync(path.join(h.dataDir, 'uploads'));
    expect(files).toEqual([`${first.body.sha256}.png`]);

    const served = await fetch(`${h.baseUrl}/api/uploads/${first.body.upload_id}`, {
      headers: { authorization: `Bearer ${h.token}` },
    });
    expect(served.status).toBe(200);
    expect(served.headers.get('content-type')).toBe('image/png');
    expect(Buffer.from(await served.arrayBuffer())).toEqual(GREEN_PNG);
  });

  it('refuses a non-image, an oversize image, and an unauthenticated caller', async () => {
    h = await bootService({
      onboarded: true,
      watchFiles: false,
      config: { uploads: { max_mb: 1 } },
    });
    const pdf = await upload(h, Buffer.from('%PDF-1.4'), 'application/pdf', 'a.pdf');
    expect(pdf.status).toBe(415);
    expect(pdf.body.error).toBe('unsupported_media_type');

    const big = await upload(h, Buffer.alloc(2 * 1024 * 1024, 1), 'image/png', 'big.png');
    expect(big.status).toBe(413);

    const anon = await fetch(`${h.baseUrl}/api/uploads`, {
      method: 'POST',
      headers: { 'content-type': 'image/png' },
      body: new Uint8Array(GREEN_PNG),
    });
    expect(anon.status).toBe(401);
    // Nothing refused reached the disk.
    expect(fs.readdirSync(path.join(h.dataDir, 'uploads'))).toEqual([]);
  });

  it('is gitignored, and stays out of the data repo', async () => {
    h = await bootService({ onboarded: true, watchFiles: false });
    await upload(h, GREEN_PNG);
    const ignore = fs.readFileSync(path.join(h.dataDir, '.gitignore'), 'utf8');
    expect(ignore).toContain('uploads/');
  });

  it('reaps past the TTL, row and file together', async () => {
    h = await bootService({ onboarded: true, watchFiles: false });
    const stored = await upload(h, GREEN_PNG);
    const id = stored.body.upload_id as string;

    // 31 days later, with the clock injected.
    const later = new Date(Date.now() + 31 * 24 * 3600 * 1000);
    const reaper = new UploadReaper({
      store: h.service.uploads,
      ttlDays: () => 30,
      now: () => later,
    });
    expect(reaper.sweep().reaped).toEqual([id]);
    expect(h.service.uploads.repo.get(id)).toBeNull();
    expect(fs.readdirSync(path.join(h.dataDir, 'uploads'))).toEqual([]);

    // The transcript outliving its attachment is a placeholder, not an error.
    const gone = await fetch(`${h.baseUrl}/api/uploads/${id}`, {
      headers: { authorization: `Bearer ${h.token}` },
    });
    expect(gone.status).toBe(404);
  });

  it('keeps shared bytes until the last row is gone', async () => {
    h = await bootService({ onboarded: true, watchFiles: false });
    const a = await upload(h, GREEN_PNG);
    const b = await upload(h, GREEN_PNG, 'image/png', 'copy.png');
    const rowA = h.service.uploads.repo.get(a.body.upload_id)!;
    h.service.uploads.destroy(rowA);
    // B still points at the file.
    expect(fs.readdirSync(path.join(h.dataDir, 'uploads'))).toHaveLength(1);
    h.service.uploads.destroy(h.service.uploads.repo.get(b.body.upload_id)!);
    expect(fs.readdirSync(path.join(h.dataDir, 'uploads'))).toEqual([]);
  });
});

describe('the vision capability probe (§10.2, §26.3)', () => {
  it('ships a structurally valid test image', () => {
    // The fixture once shipped with a corrupt IDAT CRC: strict decoders
    // refused it and lenient ones decoded garbage — a live vllm looked at our
    // "green square", saw a blue smear, said "Blue", and the endpoint was
    // branded blind. The fake never decodes, so only a chunk walk catches it.
    expect(GREEN_PNG.subarray(0, 8)).toEqual(
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    );
    let at = 8;
    const tags: string[] = [];
    while (at < GREEN_PNG.length) {
      const length = GREEN_PNG.readUInt32BE(at);
      const tagged = GREEN_PNG.subarray(at + 4, at + 8 + length);
      const crc = GREEN_PNG.readUInt32BE(at + 8 + length);
      const tag = tagged.subarray(0, 4).toString('latin1');
      expect(zlib.crc32(tagged), `CRC of ${tag}`).toBe(crc);
      tags.push(tag);
      at += 12 + length;
    }
    expect(at).toBe(GREEN_PNG.length);
    expect(tags[0]).toBe('IHDR');
    expect(tags.at(-1)).toBe('IEND');
    // 2x2, as the probe's question assumes a picture that is all one colour.
    expect(GREEN_PNG.readUInt32BE(16)).toBe(2);
    expect(GREEN_PNG.readUInt32BE(20)).toBe(2);
  });

  it('says no for a text-only endpoint and yes for one that reads the image', async () => {
    const blind = new FakeLlama();
    const blindUrl = await blind.startV1();
    const blindResult = await probeEndpoint(blindUrl, { timeoutMs: 5000 });
    expect(blindResult.caps).not.toContain('vision');
    expect(blindResult.checks.vision).toBe(false);
    await blind.stop();

    const sighted = new FakeLlama();
    sighted.vision = true;
    const sightedUrl = await sighted.startV1();
    const sightedResult = await probeEndpoint(sightedUrl, { timeoutMs: 5000 });
    expect(sightedResult.caps).toContain('vision');
    await sighted.stop();
  });
});

describe('attachments in chat (§26.2, §26.3)', () => {
  /** A harness whose endpoint can see, per models.yaml's manual override. */
  async function sighted(config: Record<string, unknown> = {}): Promise<ServiceHarness> {
    const harness = await bootService({
      onboarded: true,
      watchFiles: false,
      caps: ['json', 'tools', 'vision'],
      config,
    });
    harness.fake.vision = true;
    return harness;
  }

  it('sends image parts to a vision endpoint, and never base64 in text', async () => {
    h = await sighted();
    const stored = await upload(h, GREEN_PNG);
    h.fake.always({ text: 'A green square.' });

    const client = await TestClient.connect(h.baseUrl, h.token);
    await client.hello(['chat']);
    client.send('chat.send', {
      text: 'what is in this image?',
      attachments: [stored.body.upload_id],
    });
    await client.next('chat.accepted');
    await drain(h);

    const body = h.fake.requests.at(-1)!.body;
    const user = body.messages.filter((m: any) => m.role === 'user').at(-1);
    expect(Array.isArray(user.content)).toBe(true);
    const image = user.content.find((part: any) => part.type === 'image_url');
    expect(image).toBeTruthy();
    // The bytes rode as a part, and no text part carries them (§26).
    const text = user.content
      .filter((part: any) => part.type === 'text')
      .map((part: any) => part.text)
      .join('');
    expect(text).toContain('what is in this image?');
    expect(text).not.toContain(GREEN_PNG.toString('base64').slice(0, 24));

    // The persisted turn carries metadata only.
    const turns = h.service.repos.conversations.history(h.service.chat.list()[0]!.id);
    expect(turns[0]!.attachments).toEqual([
      {
        upload_id: stored.body.upload_id,
        name: 'shot.png',
        mime: 'image/png',
        bytes: GREEN_PNG.length,
      },
    ]);
    const rows = h.app.db.prepare(`SELECT content FROM turns`).all() as { content: string }[];
    for (const row of rows) {
      expect(row.content).not.toContain(GREEN_PNG.toString('base64').slice(0, 24));
    }
    client.close();
  });

  it('refuses an unknown upload id at send time', async () => {
    h = await sighted();
    const client = await TestClient.connect(h.baseUrl, h.token);
    await client.hello(['chat']);
    client.send('chat.send', { text: 'look', attachments: ['01NOPE'] });
    const err = await client.next('error');
    expect(err.payload.code).toBe('not_found');
    // Nothing was sent: no event, no turn.
    expect(h.service.chat.list()).toEqual([]);
    client.close();
  });

  it('elides an image past the window, monotonically, and never flips back', async () => {
    h = await sighted({ uploads: { image_context_turns: 1 } });
    const stored = await upload(h, GREEN_PNG);
    h.fake.always({ text: 'noted' });

    const client = await TestClient.connect(h.baseUrl, h.token);
    await client.hello(['chat']);
    client.send('chat.send', {
      text: 'here is a picture',
      attachments: [stored.body.upload_id],
    });
    const accepted = await client.next('chat.accepted');
    await drain(h);
    const first = h.fake.requests.at(-1)!.body;
    expect(JSON.stringify(first.messages)).toContain('image_url');

    // Two more turns; the image is now outside the one-turn window.
    for (const text of ['and now this', 'and this']) {
      client.send('chat.send', { conversation_id: accepted.payload.conversation_id, text });
      await client.next('chat.accepted');
      await drain(h);
    }
    const later = h.fake.requests.at(-1)!.body;
    expect(JSON.stringify(later.messages)).not.toContain('image_url');
    expect(JSON.stringify(later.messages)).toContain(imageMarker('shot.png', 'elided'));
    client.close();
  });

  it('tells a blind model that it cannot see, instead of letting it guess', async () => {
    h = await bootService({ onboarded: true, watchFiles: false, caps: ['json', 'tools'] });
    const stored = await upload(h, GREEN_PNG);
    h.fake.always({ text: 'I cannot see images.' });

    const client = await TestClient.connect(h.baseUrl, h.token);
    await client.hello(['chat']);
    client.send('chat.send', { text: 'what is this?', attachments: [stored.body.upload_id] });
    await client.next('chat.accepted');
    await drain(h);

    const body = h.fake.requests.at(-1)!.body;
    expect(JSON.stringify(body.messages)).not.toContain('image_url');
    expect(JSON.stringify(body.messages)).toContain('no vision-capable endpoint');
    // The upload still exists and still serves — only the model's eye is missing.
    const served = await fetch(`${h.baseUrl}/api/uploads/${stored.body.upload_id}`, {
      headers: { authorization: `Bearer ${h.token}` },
    });
    expect(served.status).toBe(200);
    client.close();
  });

  it('re-renders attachment metadata in chat.history', async () => {
    h = await sighted();
    const stored = await upload(h, GREEN_PNG);
    h.fake.always({ text: 'ok' });
    const client = await TestClient.connect(h.baseUrl, h.token);
    await client.hello(['chat']);
    client.send('chat.send', { text: 'look at this', attachments: [stored.body.upload_id] });
    const accepted = await client.next('chat.accepted');
    await drain(h);

    client.send('chat.history', { conversation_id: accepted.payload.conversation_id });
    const history = await client.next('chat.history.result');
    const userTurn = history.payload.turns.find((t: any) => t.role === 'user');
    expect(userTurn.attachments).toEqual([
      { upload_id: stored.body.upload_id, name: 'shot.png', mime: 'image/png' },
    ]);
    // No bytes on the wire: the panel fetches them from the GET route.
    expect(JSON.stringify(history.payload)).not.toContain('sha256');
    client.close();
  });

  it('deletes a conversation with attachments, uploads and all', async () => {
    h = await sighted();
    const stored = await upload(h, GREEN_PNG);
    h.fake.always({ text: 'ok' });
    const client = await TestClient.connect(h.baseUrl, h.token);
    await client.hello(['chat']);
    client.send('chat.send', { text: 'mine', attachments: [stored.body.upload_id] });
    const accepted = await client.next('chat.accepted');
    await drain(h);
    const row = h.service.uploads.repo.get(stored.body.upload_id)!;

    // The claimed upload holds a foreign key into the conversation, so a delete
    // that ignores it is refused outright — the transcript stays undeletable.
    client.send('conversation.delete', {
      conversation_id: accepted.payload.conversation_id,
    });
    const deleted = await client.next('conversation.deleted');
    expect(deleted.payload.conversation_id).toBe(accepted.payload.conversation_id);

    // Attachments are conversation ephemera (§26.1): row and bytes go with it.
    expect(h.service.uploads.repo.get(stored.body.upload_id)).toBeNull();
    expect(h.service.uploads.exists(row)).toBe(false);
    client.close();
  });

  it('claims an upload for the conversation that referenced it', async () => {
    h = await sighted();
    const stored = await upload(h, GREEN_PNG);
    expect(h.service.uploads.repo.get(stored.body.upload_id)!.conversation_id).toBeNull();
    h.fake.always({ text: 'ok' });
    const client = await TestClient.connect(h.baseUrl, h.token);
    await client.hello(['chat']);
    client.send('chat.send', { text: 'mine', attachments: [stored.body.upload_id] });
    const accepted = await client.next('chat.accepted');
    await drain(h);
    expect(h.service.uploads.repo.get(stored.body.upload_id)!.conversation_id).toBe(
      accepted.payload.conversation_id,
    );
    client.close();
  });
});

describe('uploads are never indexed and never events (§26.1)', () => {
  it('leaves no event, no RAG entry, and no models.yaml surprise', async () => {
    h = await bootService({ onboarded: true, watchFiles: false });
    const before = h.service.repos.events.recent({ limit: 50 }).length;
    await upload(h, GREEN_PNG);
    expect(h.service.repos.events.recent({ limit: 50 }).length).toBe(before);
    await h.service.fileIndex.sync();
    expect(h.service.fileIndex.stats().indexed).toBe(0);
    // The uploads area is not the file store.
    const listed = h.service.files.list().map((f) => f.path);
    expect(listed.some((p) => p.endsWith('.png'))).toBe(false);
  });
});
