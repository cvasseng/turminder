import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { bootService, type ServiceHarness } from './service-harness.js';
import { MemoryStore, slugify } from '../src/memory/store.js';
import { lexicalSearch } from '../src/rag/index-store.js';

let h: ServiceHarness;
afterEach(async () => {
  await h?.cleanup();
});

const drain = (harness: ServiceHarness) => harness.service.queue.drain();

function gitLog(dir: string): string {
  return execFileSync('git', ['log', '--oneline'], { cwd: dir, encoding: 'utf8' });
}

describe('memory store (§8.1)', () => {
  it('slugifies names into kebab-case filenames', () => {
    expect(slugify('Alex prefers terse answers')).toBe('alex-prefers-terse-answers');
    expect(slugify('  Åpen  bok!! ')).toBe('apen-bok');
    expect(slugify('')).toBe('memory');
  });

  it('writes readable markdown with frontmatter and reads it back', async () => {
    h = await bootService({ onboarded: true });
    const store = new MemoryStore(h.app.home);
    const record = store.create({
      type: 'preference',
      description: 'How Alex likes answers',
      content: 'Terse, dry, no preamble.',
    });
    expect(record.file).toBe('memory/how-alex-likes-answers.md');
    const raw = fs.readFileSync(h.app.home.path(record.file), 'utf8');
    expect(raw).toMatch(/^---\n/);
    expect(raw).toContain('type: preference');
    expect(raw).toContain('Terse, dry, no preamble.');

    const back = store.get(record.name)!;
    expect(back.description).toBe('How Alex likes answers');
    expect(back.content).toBe('Terse, dry, no preamble.');
    expect(store.list()).toHaveLength(1);
  });

  it('avoids filename collisions and survives a broken file', async () => {
    h = await bootService({ onboarded: true });
    const store = new MemoryStore(h.app.home);
    const first = store.create({ type: 'fact', description: 'Cat', content: 'a' });
    const second = store.create({ type: 'fact', description: 'Cat', content: 'b' });
    expect(second.file).not.toBe(first.file);

    fs.writeFileSync(h.app.home.path('memory', 'broken.md'), '---\nname: x\n---\nno type\n');
    expect(store.list()).toHaveLength(2);
  });
});

describe('memory agent (§8.2)', () => {
  it('saves, commits with a meaningful message, and retrieves', async () => {
    h = await bootService({ onboarded: true });
    const saved = await h.service.memory.save({
      type: 'preference',
      description: 'Alex prefers espresso',
      content: 'Espresso only, never filter.',
      reason: 'said so in chat',
    });
    expect(saved.action).toBe('created');

    const log = gitLog(h.dataDir);
    expect(log).toContain('memory(created): Alex prefers espresso — said so in chat');

    const found = await h.service.memory.query('what coffee do they drink');
    expect(found.results.map((r) => r.name)).toContain('Alex prefers espresso');
  });

  it('merges into an existing memory instead of duplicating', async () => {
    h = await bootService({ onboarded: true });
    await h.service.memory.save({
      type: 'preference',
      description: 'Coffee habits',
      content: 'Drinks espresso in the morning.',
    });
    // The dedupe check is a model call; answer it as a duplicate.
    h.fake.always({
      text: JSON.stringify({
        duplicate_of: 'Coffee habits',
        merged_content: 'Drinks espresso in the morning. Two cups before noon.',
      }),
    });
    const second = await h.service.memory.save({
      type: 'preference',
      description: 'Coffee habits',
      content: 'Two cups before noon.',
      reason: 'mentioned again',
    });
    expect(second.action).toBe('merged');
    expect(h.service.memoryStore.list()).toHaveLength(1);
    expect(h.service.memoryStore.get('Coffee habits')?.content).toContain(
      'Two cups before noon',
    );
    expect(gitLog(h.dataDir)).toContain('memory(merged): Coffee habits — mentioned again');
  });

  it('keeps a genuinely new fact separate', async () => {
    h = await bootService({ onboarded: true });
    await h.service.memory.save({
      type: 'fact',
      description: 'Cat name',
      content: 'The cat is called Fen.',
    });
    h.fake.always({ text: JSON.stringify({ duplicate_of: '', merged_content: '' }) });
    const second = await h.service.memory.save({
      type: 'fact',
      description: 'Car',
      content: 'Drives a blue Golf.',
    });
    expect(second.action).toBe('created');
    expect(h.service.memoryStore.list()).toHaveLength(2);
  });

  it('forgets a memory and records why', async () => {
    h = await bootService({ onboarded: true });
    const saved = await h.service.memory.save({
      type: 'fact',
      description: 'Old address',
      content: 'Lives in Bergen.',
    });
    const gone = await h.service.memory.forget(saved.name, 'moved to Oslo');
    expect(gone.deleted).toBe(true);
    expect(h.service.memoryStore.list()).toHaveLength(0);
    expect(gitLog(h.dataDir)).toContain('memory(forgot): Old address — moved to Oslo');
    expect(await h.service.memory.forget('ghost', 'x')).toEqual({
      name: 'ghost',
      deleted: false,
    });
  });

  it('updates an existing memory', async () => {
    h = await bootService({ onboarded: true });
    const saved = await h.service.memory.save({
      type: 'fact',
      description: 'Bike',
      content: 'Rides a red bike.',
    });
    const updated = await h.service.memory.update(saved.name, {
      content: 'Rides a green bike.',
    });
    expect(updated?.name).toBe(saved.name);
    expect(h.service.memoryStore.get(saved.name)?.content).toBe('Rides a green bike.');
    expect(await h.service.memory.update('ghost', { content: 'x' })).toBeNull();
  });
});

describe('rag index (§8.3)', () => {
  it('indexes with embeddings when the endpoint supports them', async () => {
    h = await bootService({ onboarded: true });
    await h.service.memory.save({
      type: 'fact',
      description: 'Cat',
      content: 'The cat is Fen.',
    });
    const stats = h.service.rag.stats();
    expect(stats.indexed).toBe(1);
    expect(stats.vectors).toBe(1);
    expect(stats.dimension).toBe(8);

    const result = await h.service.rag.retrieve('cat');
    expect(result.mode).toBe('vector');
    expect(result.hits).toHaveLength(1);
  });

  it('falls back to lexical retrieval when embeddings are unavailable', async () => {
    const noEmbeddings = (async (url: any, init: any) => {
      const target = String(url);
      if (target.includes('embed')) return new Response('nope', { status: 501 });
      return globalThis.fetch(url, init);
    }) as unknown as typeof globalThis.fetch;

    h = await bootService({ onboarded: true, fetch: noEmbeddings });
    await h.service.memory.save({
      type: 'preference',
      description: 'Coffee preference',
      content: 'Oat milk, never dairy.',
    });
    const stats = h.service.rag.stats();
    expect(stats.vectors).toBe(0);
    const result = await h.service.rag.retrieve('what about coffee');
    expect(result.mode).toBe('lexical');
    expect(result.hits[0]?.name).toBe('Coffee preference');
  });

  it('scores lexically on name, description and body', () => {
    const rows = [
      {
        name: 'Coffee preference',
        description: 'How he takes coffee',
        type: 'preference',
        content: 'Oat milk.',
      },
      {
        name: 'Car',
        description: 'The car',
        type: 'fact',
        content: 'Blue Golf, coffee stains.',
      },
    ];
    const hits = lexicalSearch('coffee', rows, 5);
    expect(hits[0]?.name).toBe('Coffee preference');
    expect(hits).toHaveLength(2);
    expect(lexicalSearch('unrelated', rows, 5)).toHaveLength(0);
  });

  it('rebuilds from the files after the cache is deleted', async () => {
    h = await bootService({ onboarded: true });
    await h.service.memory.save({
      type: 'fact',
      description: 'Cat',
      content: 'The cat is Fen.',
    });
    await h.service.memory.save({ type: 'fact', description: 'Dog', content: 'No dog.' });

    h.service.rag.close();
    fs.rmSync(path.join(h.dataDir, 'cache'), { recursive: true, force: true });
    expect(fs.existsSync(path.join(h.dataDir, 'cache'))).toBe(false);

    const rebuilt = await h.service.rag.rebuild();
    expect(rebuilt.indexed).toBe(2);
    expect(rebuilt.vectors).toBe(2);
    const result = await h.service.rag.retrieve('cat');
    expect(result.hits.length).toBeGreaterThan(0);
  });

  it('drops memories from the index when their files disappear', async () => {
    h = await bootService({ onboarded: true });
    const saved = await h.service.memory.save({
      type: 'fact',
      description: 'Temp',
      content: 'x',
    });
    expect(h.service.rag.stats().indexed).toBe(1);
    fs.rmSync(path.join(h.dataDir, saved.file));
    await h.service.rag.sync();
    expect(h.service.rag.stats().indexed).toBe(0);
  });

  it('picks up a hand-edited memory file', async () => {
    h = await bootService({ onboarded: true });
    fs.writeFileSync(
      path.join(h.dataDir, 'memory', 'hand-written.md'),
      `---\nname: Hand written\ndescription: Written by the user in an editor\ntype: note\ncreated: 2026-08-01T00:00:00.000Z\nupdated: 2026-08-01T00:00:00.000Z\n---\n\nThe boat is called Nemesis.\n`,
    );
    await h.service.rag.sync();
    const result = await h.service.rag.retrieve('boat');
    expect(result.hits[0]?.name).toBe('Hand written');
  });
});

describe('memory in chat (§5.4, §8.2)', () => {
  it('injects retrieved memories at the tail, not the system prompt (§20.5)', async () => {
    h = await bootService({ onboarded: true });
    await h.service.memory.save({
      type: 'preference',
      description: 'Coffee preference',
      content: 'Espresso only, never filter.',
    });
    h.fake.always({ text: 'Oat milk it is.' });
    h.service.chat.send({ text: 'what do I take in my coffee?' });
    await drain(h);

    const messages = h.fake.requests.at(-1)!.body.messages as {
      role: string;
      content: string;
    }[];
    // Not in the system prompt: memories change every turn, and placing them
    // there ends the byte-stable prefix before the whole conversation history.
    expect(messages[0]!.content).not.toContain('Oat milk in coffee');
    // The system prompt does explain the fence, so the block does not read as
    // something the user just said.
    expect(messages[0]!.content).toContain('<memory-recall>');

    const recall = messages.at(-2)!;
    expect(recall.role).toBe('user');
    expect(recall.content).toContain('<memory-recall>');
    expect(recall.content).toContain('Espresso only, never filter');
    // Immediately before the latest user message, which stays last.
    expect(messages.at(-1)).toMatchObject({
      role: 'user',
      content: 'what do I take in my coffee?',
    });
  });

  it('grants chat the memory tools', async () => {
    h = await bootService({ onboarded: true });
    h.fake.always({ text: 'noted' });
    h.service.chat.send({ text: 'remember that I dislike crowded rooms' });
    await drain(h);
    const tools = (h.fake.requests.at(-1)!.body.tools ?? []).map((t: any) => t.function.name);
    expect(tools).toContain('memory.save');
    expect(tools).toContain('memory.query');
  });

  it('writes immediately when asked to remember something', async () => {
    h = await bootService({ onboarded: true });
    h.fake.script(
      {
        toolCalls: [
          {
            name: 'memory.save',
            args: {
              type: 'preference',
              description: 'Dislikes crowded rooms',
              content: 'Alex dislikes crowded rooms. Suggest quiet venues.',
            },
          },
        ],
      },
      { text: 'Noted.' },
    );
    h.service.chat.send({ text: 'remember that I dislike crowded rooms' });
    await drain(h);

    const memories = h.service.memoryStore.list();
    expect(memories).toHaveLength(1);
    expect(memories[0]?.content).toContain('dislikes crowded rooms');
    expect(gitLog(h.dataDir)).toContain('memory(created): Dislikes crowded rooms');
  });

  it('distils on close, then a new conversation knows the preference', async () => {
    h = await bootService({ onboarded: true });
    h.fake.always({ text: 'Understood.' });
    const first = h.service.chat.send({ text: 'I only drink espresso' });
    await drain(h);

    // The distillation pass answers with the App. H.4 shape.
    h.fake.always({
      text: JSON.stringify({
        title: 'Coffee preferences',
        memories: [
          {
            type: 'preference',
            name: 'coffee-preference',
            description: 'Coffee preference',
            content: 'Alex drinks only espresso.',
            project: null,
          },
        ],
      }),
    });
    h.service.chat.close(first.conversationId);
    await drain(h);

    const stored = h.service.memoryStore.list();
    expect(stored).toHaveLength(1);
    expect(stored[0]?.content).toContain('espresso');
    // The model's `name` is the filename, slug and all (H.4) — not the
    // description flattened into a sixty-char sentence fragment.
    expect(stored[0]?.name).toBe('coffee-preference');
    expect(h.service.repos.conversations.get(first.conversationId)?.title).toBe(
      'Coffee preferences',
    );
    const runs = h.service.repos.runs
      .forEvent(
        h.service.repos.events
          .recent({ limit: 10 })
          .find((e) => e.type === 'system.conversation_closed')!.id,
      )
      .map((r) => r.kind);
    expect(runs).toContain('distill');

    // A brand new conversation gets the memory pushed into its prompt — at the
    // tail, as a <memory-recall> message rather than in the system prompt (§20.5).
    h.fake.always({ text: 'Oat milk.' });
    h.service.chat.send({ text: 'what do I take in coffee?' });
    await drain(h);
    const messages = h.fake.requests.at(-1)!.body.messages as { content: string }[];
    expect(messages.map((m) => m.content).join('\n')).toContain('espresso');
    expect(messages.at(-2)!.content).toContain('<memory-recall>');
  });

  it('distils an idle conversation without archiving or renaming it', async () => {
    h = await bootService({ onboarded: true });
    h.fake.always({ text: 'Understood.' });
    const conv = h.service.chat.send({ text: 'I only drink espresso' });
    await drain(h);
    h.service.repos.conversations.setTitle(conv.conversationId, 'Coffee');

    h.fake.always({
      text: JSON.stringify({
        title: 'Coffee preferences',
        memories: [
          {
            type: 'preference',
            name: 'coffee-preference',
            description: 'Coffee preference',
            content: 'Alex drinks only espresso.',
            project: null,
          },
        ],
      }),
    });
    h.app.db
      .prepare(`UPDATE conversations SET last_activity_at = '2020-01-01T00:00:00.000Z'`)
      .run();
    expect(h.service.chat.distillIdle()).toBe(1);
    await drain(h);

    const stored = h.service.memoryStore.list();
    expect(stored).toHaveLength(1);
    expect(stored[0]?.content).toContain('espresso');

    // Going quiet is not the user saying they are done with it: it stays open,
    // and it keeps the name they have been looking at in the list.
    const row = h.service.repos.conversations.get(conv.conversationId)!;
    expect(row.status).toBe('open');
    expect(row.title).toBe('Coffee');

    const runs = h.service.repos.runs
      .forEvent(
        h.service.repos.events
          .recent({ limit: 10 })
          .find((e) => e.type === 'system.conversation_idle')!.id,
      )
      .map((r) => r.kind);
    expect(runs).toContain('distill');
  });

  it('re-distils only the turns the last pass never saw, with the store in view', async () => {
    h = await bootService({ onboarded: true });
    h.fake.always({ text: 'Noted.' });
    const conv = h.service.chat.send({ text: 'I only drink espresso' });
    await drain(h);

    // First pass over a backdated transcript: distilled_at lands at the
    // conversation's last_activity_at, which becomes the next pass's `since`.
    h.app.db.prepare(`UPDATE turns SET created_at = '2019-12-31T00:00:00.000Z'`).run();
    h.app.db
      .prepare(`UPDATE conversations SET last_activity_at = '2020-01-01T00:00:00.000Z'`)
      .run();
    h.fake.always({
      text: JSON.stringify({
        title: 'Coffee',
        memories: [
          {
            type: 'preference',
            name: 'coffee-preference',
            description: 'Coffee preference',
            content: 'Alex drinks only espresso.',
            project: null,
          },
        ],
      }),
    });
    expect(h.service.chat.distillIdle()).toBe(1);
    await drain(h);
    expect(h.service.memoryStore.list()).toHaveLength(1);

    // New turns arrive (created "now"), the conversation goes quiet again.
    h.fake.always({ text: 'Noted.' });
    h.service.chat.send({
      conversationId: conv.conversationId,
      text: 'my dog is called Rex',
    });
    await drain(h);
    h.app.db
      .prepare(`UPDATE conversations SET last_activity_at = '2020-01-02T00:00:00.000Z'`)
      .run();
    h.fake.always({
      text: JSON.stringify({
        title: 'Coffee',
        memories: [
          {
            type: 'fact',
            name: 'dog-name',
            description: 'Dog name',
            content: "Alex's dog is called Rex.",
            project: null,
          },
        ],
      }),
    });
    expect(h.service.chat.distillIdle()).toBe(1);
    await drain(h);

    const distillRequests = h.fake.requests.filter((r) =>
      ((r.body.messages ?? []) as { content: string }[]).some((m) =>
        m.content.includes('come to a rest'),
      ),
    );
    expect(distillRequests).toHaveLength(2);
    const second = (distillRequests.at(-1)!.body.messages as { content: string }[])
      .map((m) => m.content)
      .join('\n');
    // Delta-only (§8.2): the second pass sees the new turns and not the ones
    // the first pass already read — what it never re-sees it cannot re-file.
    expect(second).toContain('Rex');
    expect(second).not.toContain('espresso');
    // …and it is told what the store already holds, by name and description.
    expect(second).toContain('coffee-preference: Coffee preference');

    const names = h.service.memoryStore.list().map((m) => m.name);
    expect(names.sort()).toEqual(['coffee-preference', 'dog-name']);
  });

  it('runs distillation at background priority', async () => {
    h = await bootService({ onboarded: true });
    h.fake.always({ text: 'ok' });
    const conv = h.service.chat.send({ text: 'hello' });
    await drain(h);
    h.fake.always({ text: JSON.stringify({ title: 'Nothing', memories: [] }) });
    h.service.chat.close(conv.conversationId);
    await drain(h);

    const closeEvent = h.service.repos.events
      .recent({ limit: 10 })
      .find((e) => e.type === 'system.conversation_closed')!;
    const llm = h.service.repos.trace
      .forEvent(closeEvent.id)
      .find((t) => t.kind === 'llm_call')!.data as any;
    expect(llm.priority).toBe('background');
    expect(h.service.memoryStore.list()).toHaveLength(0);
  });
});
