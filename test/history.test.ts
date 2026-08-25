import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { EmbeddingClient } from '../src/rag/embeddings.js';
import { InferenceScheduler } from '../src/model/scheduler.js';
import { TurnsIndex } from '../src/rag/turns-index.js';
import { bootService, offeredTools, type ServiceHarness } from './service-harness.js';
import { write } from './helpers.js';

let h: ServiceHarness;
afterEach(async () => {
  await h?.cleanup();
});

const drain = (harness: ServiceHarness) => harness.service.queue.drain();

/**
 * Conversation history search (§25). The corpus is persisted turns; the tool
 * is the only way in; the querying conversation is never in the answer.
 */
describe('the turns index (§25)', () => {
  /** Two finished conversations, so a search has something to find. */
  async function withHistory(): Promise<ServiceHarness> {
    const harness = await bootService({ onboarded: true, watchFiles: false });
    harness.fake.always({ text: 'We settled on the NO5 dashboard being weekly.' });
    harness.service.chat.send({ text: 'what cadence for the NO5 dashboard?' });
    await drain(harness);
    harness.fake.always({ text: 'Bergen it is, then.' });
    harness.service.chat.send({ text: 'where should we meet in Bergen?' });
    await drain(harness);
    await harness.service.background.drain();
    return harness;
  }

  it('indexes both roles of a finished run, model text for the assistant', async () => {
    h = await withHistory();
    expect(h.service.history.stats().indexed).toBe(4);

    const found = await h.service.history.search('NO5 dashboard');
    expect(found.results.length).toBeGreaterThan(0);
    const roles = found.results.map((r) => r.role);
    expect(roles).toContain('user');
    // Shape per App. F.15.
    const hit = found.results[0]!;
    expect(hit).toMatchObject({
      conversation_id: expect.any(String),
      turn_seq: expect.any(Number),
      created_at: expect.any(String),
      score: expect.any(Number),
    });
    expect(hit.excerpt.length).toBeLessThanOrEqual(500);
  });

  it('excludes the conversation doing the asking', async () => {
    h = await withHistory();
    const conversations = h.service.chat.list();
    const asking = conversations[0]!.id;

    const all = await h.service.history.search('Bergen dashboard cadence NO5');
    expect(all.results.some((r) => r.conversation_id === asking)).toBe(true);

    const scoped = await h.service.history.search('Bergen dashboard cadence NO5', {
      excludeConversation: asking,
    });
    expect(scoped.results.some((r) => r.conversation_id === asking)).toBe(false);
    expect(scoped.results.length).toBeGreaterThan(0);
  });

  it('filters by date, both ends', async () => {
    h = await withHistory();
    const future = await h.service.history.search('dashboard', { after: '2099-01-01' });
    expect(future.results).toEqual([]);
    const past = await h.service.history.search('dashboard', { before: '2000-01-01' });
    expect(past.results).toEqual([]);
    const now = await h.service.history.search('dashboard', { after: '2000-01-01' });
    expect(now.results.length).toBeGreaterThan(0);
  });

  it('forgets a deleted conversation, and reconciles on the next sync', async () => {
    h = await withHistory();
    const [first] = h.service.chat.list();
    h.service.chat.delete(first!.id);
    await h.service.background.drain();

    const found = await h.service.history.search('Bergen dashboard cadence NO5');
    expect(found.results.some((r) => r.conversation_id === first!.id)).toBe(false);

    // Even if the delete hook never ran, a sync notices the turns are gone.
    const [second] = h.service.chat.list();
    h.service.repos.conversations.remove(second!.id);
    await h.service.history.sync();
    expect(h.service.history.stats().indexed).toBe(0);
  });

  it('rebuilds from events.db alone after cache/ is deleted', async () => {
    h = await withHistory();
    const before = await h.service.history.search('NO5 dashboard');
    expect(before.results.length).toBeGreaterThan(0);

    h.service.history.close();
    fs.rmSync(path.join(h.dataDir, 'cache'), { recursive: true, force: true });
    const rebuilt = await h.service.history.rebuild();
    expect(rebuilt.indexed).toBe(4);
    const after = await h.service.history.search('NO5 dashboard');
    expect(after.results.map((r) => r.turn_seq)).toEqual(before.results.map((r) => r.turn_seq));
  });

  it('degrades to lexical when the embedding endpoint is down, never to an error', async () => {
    h = await withHistory();
    // A second index over the same turns, pointed at nothing.
    const dead = new EmbeddingClient(
      { url: 'http://127.0.0.1:9/v1', model: 'none' },
      new InferenceScheduler(1),
    );
    const index = new TurnsIndex(h.app.home, h.service.repos.conversations, dead);
    // Its own database, so the real index's vectors cannot rescue it.
    fs.rmSync(path.join(h.dataDir, 'cache', 'turns-rag.db'), { force: true });
    const synced = await index.sync();
    expect(synced.indexed).toBe(4);
    expect(synced.vectors).toBe(0);

    const found = await index.search('NO5 dashboard');
    expect(found.mode).toBe('lexical');
    expect(found.results.length).toBeGreaterThan(0);
    index.close();
  });
});

describe('history.search through the tool hub (App. F.15)', () => {
  it('answers with excerpts and says which path found them', async () => {
    h = await bootService({ onboarded: true, watchFiles: false });
    h.fake.always({ text: 'The NO5 dashboard refreshes weekly.' });
    const first = h.service.chat.send({ text: 'how often does the NO5 dashboard refresh?' });
    await drain(h);
    await h.service.background.drain();

    const search = h.service.tools.handles().find((t) => t.name === 'history.search')!;
    expect(search.tier).toBe('ro');

    // Asked from a *different* conversation, the earlier one is findable.
    const other = h.service.chat.send({ text: 'unrelated' });
    await drain(h);
    const result = (
      await search.call(
        { query: 'NO5 dashboard' },
        { runId: null, eventId: null, conversationId: other.conversationId },
      )
    ).output as { results: { conversation_id: string; excerpt: string }[]; retrieval: string };
    expect(result.results.length).toBeGreaterThan(0);
    expect(result.results.every((r) => r.conversation_id === first.conversationId)).toBe(true);
    expect(['vector', 'lexical']).toContain(result.retrieval);

    // Asked from inside that conversation, its own turns are absent: they are
    // already in the context asking the question (§25). Other conversations
    // still answer, which is the point of the exclusion being scoped.
    const inside = (
      await search.call(
        { query: 'NO5 dashboard' },
        { runId: null, eventId: null, conversationId: first.conversationId },
      )
    ).output as { results: { conversation_id: string }[] };
    expect(inside.results.length).toBeGreaterThan(0);
    expect(inside.results.every((r) => r.conversation_id !== first.conversationId)).toBe(true);
  });

  it('is closed by default and opens on demand (§21.2)', async () => {
    h = await bootService({ onboarded: true, watchFiles: false });
    h.fake.always({ text: 'ok' });
    h.service.chat.send({ text: 'hello' });
    await drain(h);
    const body = h.fake.requests.at(-1)!.body;
    const names = offeredTools(h, h.fake.requests.at(-1)!);
    // Granted, but not core: it is a catalog line until the model opens it.
    expect(names).not.toContain('history.search');
    expect(String(body.messages[0].content)).toContain('- history:');
  });
});

describe('the three corpora are disjoint (§18.1, §25)', () => {
  it('history.search returns no memories or files, and they return no turns', async () => {
    h = await bootService({ onboarded: true, watchFiles: false });
    write(
      path.join(h.dataDir, 'memory', 'grammar-note.md'),
      `---\nname: gbnf grammar note\ndescription: A memory about grammars\ntype: note\ncreated: 2026-08-20T10:00:00.000Z\nupdated: 2026-08-20T10:00:00.000Z\n---\n\nThe memory corpus mentions grammars.\n`,
    );
    write(
      path.join(h.dataDir, 'files', 'notes/grammars.md'),
      'The files corpus mentions grammars.\n',
    );
    await h.service.rag.sync();
    await h.service.fileIndex.sync();

    h.fake.always({ text: 'The history corpus mentions grammars.' });
    h.service.chat.send({ text: 'tell me about grammars' });
    await drain(h);
    await h.service.background.drain();

    const history = await h.service.history.search('grammars');
    expect(JSON.stringify(history.results)).toContain('history corpus');
    expect(JSON.stringify(history.results)).not.toContain('memory corpus');
    expect(JSON.stringify(history.results)).not.toContain('files corpus');

    const memories = await h.service.memory.query('grammars', 5);
    expect(JSON.stringify(memories.results)).not.toContain('history corpus');
    const files = await h.service.fileIndex.search('grammars', 5);
    expect(JSON.stringify(files.results)).not.toContain('history corpus');

    // Three databases: the separation is structural, not a query detail.
    for (const db of ['rag.db', 'files-rag.db', 'turns-rag.db']) {
      expect(fs.existsSync(path.join(h.dataDir, 'cache', db))).toBe(true);
    }
  });
});
