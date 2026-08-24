import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { IgnoreRules } from '../src/files/ignore.js';
import { FileStore, hashContent } from '../src/files/store.js';
import { SnapshotStore } from '../src/files/snapshots.js';
import { extractMarkers, normaliseMarkerLine } from '../src/files/markers.js';
import { fenceFile } from '../src/prompts/fencing.js';
import { openDataHome } from '../src/core/datadir.js';
import { GitRepo } from '../src/core/git.js';
import { PathRejected } from '../src/tools/paths.js';
import { bootService, TestClient, type ServiceHarness } from './service-harness.js';
import { INLINE_RENDERABLE } from '../src/net/http.js';
import { tmpDir, write } from './helpers.js';

let h: ServiceHarness;
afterEach(async () => {
  await h?.cleanup();
});

const drain = (harness: ServiceHarness) => harness.service.queue.drain();

/** Polls a condition rather than sleeping a fixed guess at how long it takes. */
async function waitFor(ok: () => boolean, timeoutMs: number): Promise<void> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (ok()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('timed out waiting for the watcher');
}

/** A store in its own git repo, which is the external-vault shape (§18.2). */
function storeEnv() {
  const t = tmpDir('turminder-files-');
  const root = path.join(t.dir, 'store');
  fs.mkdirSync(root, { recursive: true });
  const repo = new GitRepo(root);
  repo.init();
  const writes: { path: string; change: string }[] = [];
  const store = new FileStore({
    root,
    git: { repo, prefix: '' },
    onWrite: (p, _c, change) => writes.push({ path: p, change }),
  });
  return { root, repo, store, writes, cleanup: () => t.cleanup() };
}

describe('.turminderignore (App. G.11)', () => {
  it('reads gitignore syntax, including negation and anchoring', () => {
    const rules = IgnoreRules.parse(
      [
        '.obsidian/',
        '*.tmp',
        '!keep.tmp',
        '/build',
        'docs/**/draft.md',
        '# a comment',
        '',
      ].join('\n'),
    );
    expect(rules.ignores('notes/a.md')).toBe(false);
    expect(rules.ignores('.obsidian/workspace.json')).toBe(true);
    expect(rules.ignores('deep/nested/thing.tmp')).toBe(true);
    expect(rules.ignores('keep.tmp')).toBe(false);
    expect(rules.ignores('build/out.js')).toBe(true);
    // Anchored: only at the root.
    expect(rules.ignores('sub/build/out.js')).toBe(false);
    expect(rules.ignores('docs/x/y/draft.md')).toBe(true);
    expect(rules.reasonFor('deep/nested/thing.tmp')).toBe('*.tmp');
  });

  it('is shipped into a fresh data dir with the editor detritus in it', () => {
    const t = tmpDir('turminder-scaffold-');
    const { home } = openDataHome(path.join(t.dir, 'home'));
    const shipped = fs.readFileSync(home.path('files', '.turminderignore'), 'utf8');
    expect(shipped).toContain('.obsidian/');
    expect(shipped).toContain('*.sync-conflict-*');
    t.cleanup();
  });
});

describe('files integration (App. F.8)', () => {
  it('writes, appends and edits, committing each time', () => {
    const e = storeEnv();
    expect(e.store.write('notes/todo.md', '- [ ] one\n', 'add a todo')).toMatchObject({
      path: 'notes/todo.md',
      committed: true,
      action: 'created',
    });
    expect(e.store.append('notes/todo.md', '- [ ] two\n', 'add another')).toMatchObject({
      committed: true,
    });
    expect(e.store.read('notes/todo.md')).toMatchObject({
      content: '- [ ] one\n- [ ] two\n',
      binary: false,
    });

    expect(e.store.edit('notes/todo.md', '- [ ] two', '- [x] two', 'done two')).toMatchObject({
      committed: true,
    });
    expect((e.store.read('notes/todo.md') as any).content).toContain('- [x] two');
    // One commit per write, all of them in the log.
    expect(e.repo.head()).toBeTruthy();
    expect(e.writes.map((w) => w.change)).toEqual(['created', 'modified', 'modified']);
    e.cleanup();
  });

  it('refuses an edit that does not match exactly once (§18.3)', () => {
    const e = storeEnv();
    e.store.write('a.md', 'x\nx\n', 'two of them');
    expect(e.store.edit('a.md', 'x', 'y', 'ambiguous')).toEqual({
      error: 'multiple_matches',
      matches: 2,
      path: 'a.md',
    });
    expect(e.store.edit('a.md', 'z', 'y', 'missing')).toEqual({
      error: 'no_match',
      matches: 0,
      path: 'a.md',
    });
    // Neither attempt touched the file.
    expect((e.store.read('a.md') as any).content).toBe('x\nx\n');
    e.cleanup();
  });

  it('stores and lists a binary file but reads only its metadata (§18.2)', () => {
    const e = storeEnv();
    fs.writeFileSync(path.join(e.root, 'photo.png'), Buffer.from([0x89, 0x50, 0, 1, 2, 3]));
    const listed = e.store.list();
    expect(listed.find((f) => f.path === 'photo.png')?.binary).toBe(true);
    expect(e.store.read('photo.png')).toMatchObject({
      binary: true,
      mime: 'image/png',
      size: 6,
    });
    expect(e.store.readText('photo.png')).toBeNull();
    expect(() => e.store.edit('photo.png', 'a', 'b', 'nope')).toThrow(/binary/);
    e.cleanup();
  });

  it('keeps writes inside the store', () => {
    const e = storeEnv();
    expect(() => e.store.write('../escape.md', 'no', 'try')).toThrow(PathRejected);
    expect(() => e.store.read('/etc/passwd')).toThrow(PathRejected);
    fs.symlinkSync('/etc', path.join(e.root, 'link'));
    expect(() => e.store.read('link/passwd')).toThrow(PathRejected);
    expect(fs.existsSync(path.join(e.root, '..', 'escape.md'))).toBe(false);
    e.cleanup();
  });

  it('hides ignored paths from listing', () => {
    const e = storeEnv();
    write(path.join(e.root, '.turminderignore'), '.obsidian/\n*.tmp\n');
    e.store.write('notes/a.md', 'keep', 'a');
    fs.mkdirSync(path.join(e.root, '.obsidian'), { recursive: true });
    write(path.join(e.root, '.obsidian', 'workspace.json'), '{}');
    write(path.join(e.root, 'scratch.tmp'), 'x');
    expect(e.store.list().map((f) => f.path)).toEqual(['notes/a.md']);
    e.cleanup();
  });
});

describe('marker extraction (§18.4 tier 2)', () => {
  const markers = ['@turminder'];

  it('fires only for lines that are new', () => {
    const before = '- [ ] old thing @turminder\n- unrelated\n';
    const after = `${before}- [ ] find me a GBNF reference @turminder\n`;
    const hits = extractMarkers('notes/todo.md', before, after, markers);
    expect(hits).toHaveLength(1);
    expect(hits[0]!.line).toBe(3);
    expect(hits[0]!.text).toBe('- [ ] find me a GBNF reference @turminder');
    expect(hits[0]!.context).toContain('- unrelated');
  });

  it('does not re-fire on a re-save, a move, or a ticked box', () => {
    const line = '- [ ] find me a GBNF reference @turminder';
    const first = `header\n${line}\n`;
    expect(extractMarkers('n.md', null, first, markers)).toHaveLength(1);
    // Same content again: nothing new.
    expect(extractMarkers('n.md', first, first, markers)).toHaveLength(0);
    // Reorganised: the line moved, the text did not.
    expect(extractMarkers('n.md', first, `${line}\nheader\n`, markers)).toHaveLength(0);
    // Ticked, and re-indented: still the same request.
    expect(
      extractMarkers('n.md', first, `header\n  ${line.replace('[ ]', '[x]')}\n`, markers),
    ).toHaveLength(0);
    // The idempotency key is stable across all of those forms.
    const key = extractMarkers('n.md', null, first, markers)[0]!.key;
    expect(
      extractMarkers('n.md', null, `  ${line.replace('[ ]', '[X]')}`, markers)[0]!.key,
    ).toBe(key);
    // A different file with the same line is a different request.
    expect(extractMarkers('other.md', null, first, markers)[0]!.key).not.toBe(key);
  });

  it('normalises list and checkbox prefixes away', () => {
    expect(normaliseMarkerLine('  - [ ]  do   a thing @turminder ')).toBe(
      'do a thing @turminder',
    );
    expect(normaliseMarkerLine('3. do a thing')).toBe('do a thing');
  });
});

describe('file snapshots', () => {
  it('remembers what was last seen, per path', () => {
    const t = tmpDir('turminder-snap-');
    const snapshots = new SnapshotStore(path.join(t.dir, 'cache', 'files-watch.db'));
    snapshots.record('a.md', 'one', '2026-08-21T00:00:00.000Z');
    expect(snapshots.get('a.md')).toEqual({
      path: 'a.md',
      hash: hashContent('one'),
      content: 'one',
    });
    snapshots.record('a.md', 'two', '2026-08-21T00:00:01.000Z');
    expect(snapshots.get('a.md')?.content).toBe('two');
    expect(snapshots.paths()).toEqual(['a.md']);
    snapshots.forget('a.md');
    expect(snapshots.get('a.md')).toBeNull();
    snapshots.close();
    t.cleanup();
  });
});

describe('the watcher, in a running service (§18.4)', () => {
  const vault = (harness: ServiceHarness, rel: string, body: string) =>
    write(path.join(harness.dataDir, 'files', rel), body);

  it('a raw save produces no ingress event, only a background reindex', async () => {
    h = await bootService({ onboarded: true, watchFiles: false });
    vault(h, 'notes/plain.md', 'just some notes\n');
    await h.service.settleFile('notes/plain.md');
    await h.service.background.stop();

    expect(h.service.repos.events.recent({ limit: 50 }).map((e) => e.type)).not.toContain(
      'file.request',
    );
    expect(h.service.repos.events.recent({ limit: 50 }).map((e) => e.type)).not.toContain(
      'file.changed',
    );
    // Tier 1 did happen: the file is searchable.
    expect(h.service.fileIndex.stats().indexed).toBe(1);
  });

  it('the Obsidian scenario: one request, ~30s after typing stops', async () => {
    h = await bootService({ onboarded: true, watchFiles: false });
    // The note exists and is already known, as it would be after a baseline.
    vault(h, 'notes/todo.md', '# Todo\n\n- [ ] buy milk\n');
    await h.service.settleFile('notes/todo.md');

    // Now the marker is typed, and autosave hammers the file — every save has
    // the same content, and only the settled state is ever looked at.
    vault(
      h,
      'notes/todo.md',
      '# Todo\n\n- [ ] buy milk\n- [ ] find me a llama.cpp GBNF reference @turminder\n',
    );
    for (let i = 0; i < 20; i += 1) await h.service.settleFile('notes/todo.md');

    const requests = h.service.repos.events
      .recent({ limit: 50 })
      .filter((e) => e.type === 'file.request');
    expect(requests).toHaveLength(1);
    expect(requests[0]!.serialization_key).toBe('notes/todo.md');
    expect((requests[0]!.payload as any).line).toBe(4);
    expect((requests[0]!.payload as any).text).toContain('GBNF');

    // Re-saving, reorganising, and ticking the box never re-fire it.
    vault(
      h,
      'notes/todo.md',
      '# Todo\n\n- [x] find me a llama.cpp GBNF reference @turminder\n- [ ] buy milk\n',
    );
    await h.service.settleFile('notes/todo.md');
    expect(
      h.service.repos.events.recent({ limit: 50 }).filter((e) => e.type === 'file.request'),
    ).toHaveLength(1);
  });

  it("the assistant's own write triggers nothing", async () => {
    h = await bootService({ onboarded: true, watchFiles: false });
    vault(h, 'notes/todo.md', '- [ ] research something @turminder\n');
    await h.service.settleFile('notes/todo.md');
    const before = h.service.repos.events.recent({ limit: 50 }).length;

    // files.edit, exactly as the handler would call it.
    h.service.files.edit(
      'notes/todo.md',
      '- [ ] research something @turminder',
      '- [x] research something @turminder — see notes/answer.md',
      'answered the request',
    );
    await h.service.settleFile('notes/todo.md');
    expect(h.service.repos.events.recent({ limit: 50 }).length).toBe(before);
    expect(h.app.home.git.head()).toBeTruthy();
  });

  it('emits file.changed only for subscribed handlers, rate-limited', async () => {
    h = await bootService({
      onboarded: true,
      watchFiles: false,
      dataDefaults: {},
    });
    write(
      path.join(h.dataDir, 'handlers', 'meeting-notes.md'),
      `---\nname: meeting-notes\ndescription: Use for changes to meeting notes.\nwatch: ["meeting-notes/**"]\ntools: [files.read]\n---\n\nRead the note.\n`,
    );
    h.service.handlers.reload();

    vault(h, 'other/thing.md', 'not watched\n');
    await h.service.settleFile('other/thing.md');
    expect(
      h.service.repos.events.recent({ limit: 50 }).filter((e) => e.type === 'file.changed'),
    ).toHaveLength(0);

    vault(h, 'meeting-notes/monday.md', 'first\n');
    await h.service.settleFile('meeting-notes/monday.md');
    const changed = h.service.repos.events
      .recent({ limit: 50 })
      .filter((e) => e.type === 'file.changed');
    expect(changed).toHaveLength(1);
    expect(changed[0]!.payload).toMatchObject({ path: 'meeting-notes/monday.md' });
    expect(changed[0]!.serialization_key).toBe('meeting-notes/monday.md');

    // A second change inside the rate-limit window is coalesced, not queued.
    vault(h, 'meeting-notes/monday.md', 'second\n');
    await h.service.settleFile('meeting-notes/monday.md');
    vault(h, 'meeting-notes/monday.md', 'third\n');
    await h.service.settleFile('meeting-notes/monday.md');
    expect(
      h.service.repos.events.recent({ limit: 50 }).filter((e) => e.type === 'file.changed'),
    ).toHaveLength(1);
  });
});

describe('the watcher for real, over chokidar', () => {
  it('waits out quiescence and then fires exactly one request', async () => {
    // A one-second window, so the test can actually wait for it.
    h = await bootService({ onboarded: true, config: { files: { quiescence_s: 1 } } });
    const file = path.join(h.dataDir, 'files', 'notes', 'live.md');
    write(file, '# Notes\n');
    // Autosave: the same file written repeatedly, well inside the window.
    for (let i = 0; i < 4; i += 1) {
      fs.appendFileSync(file, `line ${i}\n`);
      await new Promise((r) => setTimeout(r, 120));
    }
    fs.appendFileSync(file, '- [ ] look this up @turminder\n');
    expect(
      h.service.repos.events.recent({ limit: 50 }).filter((e) => e.type === 'file.request'),
    ).toHaveLength(0);

    await waitFor(
      () =>
        h.service.repos.events.recent({ limit: 50 }).filter((e) => e.type === 'file.request')
          .length === 1,
      8000,
    );
    const requests = h.service.repos.events
      .recent({ limit: 50 })
      .filter((e) => e.type === 'file.request');
    expect((requests[0]!.payload as any).text).toContain('look this up');
  });

  it('points the store at an external directory when files.dir says so (§18.2)', async () => {
    const t = tmpDir('turminder-vault-');
    const vaultDir = path.join(t.dir, 'vault');
    fs.mkdirSync(vaultDir, { recursive: true });
    write(path.join(vaultDir, 'note.md'), 'lives outside the data dir\n');
    h = await bootService({
      onboarded: true,
      watchFiles: false,
      config: { files: { dir: vaultDir } },
    });
    expect(h.service.files.root).toBe(fs.realpathSync(vaultDir));
    expect(h.service.files.list().map((f) => f.path)).toEqual(['note.md']);
    // Not a git repo, so writes land but are not committed — knowingly (§18.2).
    expect(h.service.files.committing).toBe(false);
    expect(h.service.files.write('new.md', 'x', 'add')).toMatchObject({ committed: false });
    expect(fs.existsSync(path.join(vaultDir, 'new.md'))).toBe(true);
    t.cleanup();
  });
});

describe('memory and files are disjoint (§18.1)', () => {
  // The third corner, history (§25), has its own suite in history.test.ts.
  it('memory.query never returns file content and files.search never returns memories', async () => {
    h = await bootService({ onboarded: true, watchFiles: false });
    write(
      path.join(h.dataDir, 'memory', 'gbnf-note.md'),
      `---\nname: gbnf grammar note\ndescription: A memory about grammars\ntype: note\ncreated: 2026-08-20T10:00:00.000Z\nupdated: 2026-08-20T10:00:00.000Z\n---\n\nThe memory corpus mentions grammars.\n`,
    );
    write(
      path.join(h.dataDir, 'files', 'notes/grammars.md'),
      'The files corpus mentions grammars.\n',
    );
    await h.service.rag.sync();
    await h.service.fileIndex.sync();

    const memories = await h.service.memory.query('grammars', 5);
    expect(memories.results.map((r) => r.name)).toEqual(['gbnf grammar note']);
    expect(JSON.stringify(memories.results)).not.toContain('files corpus');

    const files = await h.service.fileIndex.search('grammars', 5);
    expect(files.results.map((r) => r.path)).toEqual(['notes/grammars.md']);
    expect(JSON.stringify(files.results)).not.toContain('memory corpus');

    // Two databases, so the separation is structural rather than a query detail.
    expect(fs.existsSync(path.join(h.dataDir, 'cache', 'rag.db'))).toBe(true);
    expect(fs.existsSync(path.join(h.dataDir, 'cache', 'files-rag.db'))).toBe(true);
  });

  it('rebuilds both indexes after cache/ is deleted', async () => {
    h = await bootService({ onboarded: true, watchFiles: false });
    write(path.join(h.dataDir, 'files', 'notes/a.md'), 'something searchable\n');
    await h.service.fileIndex.sync();
    expect(h.service.fileIndex.stats().indexed).toBe(1);

    h.service.rag.close();
    h.service.fileIndex.close();
    fs.rmSync(path.join(h.dataDir, 'cache'), { recursive: true, force: true });
    expect((await h.service.rag.rebuild()).indexed).toBe(0);
    expect((await h.service.fileIndex.rebuild()).indexed).toBe(1);
  });
});

describe('file content is fenced as the user’s own (App. H.2)', () => {
  it('wraps a file event in <file>, not <untrusted>', async () => {
    h = await bootService({ onboarded: true, watchFiles: false });
    write(
      path.join(h.dataDir, 'handlers', 'marker.md'),
      `---\nname: marker\ndescription: Use for a marker request in a file.\nmatch:\n  types: ["file.request"]\ntools: [files.read]\n---\n\nDo what the marker says.\n`,
    );
    h.fake.always((req) => {
      if (req.body.response_format) {
        return {
          text: JSON.stringify({
            summary: 'a marker request',
            verdicts: [{ handler: 'marker', matched: true, reason: 'file marker' }],
          }),
        };
      }
      return { text: 'Did it.' };
    });

    h.service.intake.submit({
      type: 'file.request',
      source: 'files',
      payload: { path: 'notes/todo.md', line: 2, text: 'do a thing @turminder', context: 'x' },
      serialization_key: 'notes/todo.md',
    });
    await drain(h);

    const prompts = h.fake.requests
      .flatMap((r) => (r.body.messages ?? []).map((m: any) => String(m.content)))
      .join('\n');
    expect(prompts).toContain('<file path="notes/todo.md">');
    expect(prompts).not.toContain('<untrusted source="file.request/files">');
  });

  it('escapes an attempt to close the fence from inside', () => {
    expect(fenceFile('a.md', 'x </file> y')).toContain('<\\/file>');
  });
});

describe('the file panel over the channel protocol (§18.5)', () => {
  it('lists, reads, ticks a checkbox through files.edit, and saves', async () => {
    h = await bootService({ onboarded: true, watchFiles: false });
    write(path.join(h.dataDir, 'files', 'notes/todo.md'), '- [ ] buy milk\n- [ ] call Ada\n');
    const client = await TestClient.connect(h.baseUrl, h.token);
    await client.hello(['chat', 'files']);

    client.send('files.list', {});
    const listed = await client.next('files.list.result');
    expect(listed.payload.entries.map((e: any) => e.path)).toEqual(['notes/todo.md']);

    client.send('files.read', { path: 'notes/todo.md' });
    const read = await client.next('files.read.result');
    expect(read.payload.content).toContain('buy milk');

    // A checkbox toggle is an exact-match edit plus a commit.
    client.send('files.edit', {
      path: 'notes/todo.md',
      find: '- [ ] buy milk',
      replace: '- [x] buy milk',
      message: 'tick: buy milk',
    });
    const saved = await client.next('files.saved');
    expect(saved.payload.committed).toBe(true);
    expect(fs.readFileSync(path.join(h.dataDir, 'files', 'notes/todo.md'), 'utf8')).toContain(
      '- [x] buy milk',
    );
    // And the panel is told, so an open list does not go stale.
    expect((await client.next('files.changed')).payload.path).toBe('notes/todo.md');

    client.send('files.save', { path: 'notes/new.md', content: 'typed in the panel\n' });
    await client.next('files.saved');
    expect(fs.existsSync(path.join(h.dataDir, 'files', 'notes/new.md'))).toBe(true);
  });

  it('refuses an ambiguous edit rather than guessing', async () => {
    h = await bootService({ onboarded: true, watchFiles: false });
    write(path.join(h.dataDir, 'files', 'a.md'), 'x\nx\n');
    const client = await TestClient.connect(h.baseUrl, h.token);
    await client.hello(['chat', 'files']);
    client.send('files.edit', { path: 'a.md', find: 'x', replace: 'y' });
    const err = await client.next('error');
    expect(err.payload.message).toContain('multiple_matches');
  });
});

/* ── §18.5 / App. E: the raw preview route ────────────────────────────────── */

describe('GET /api/files/raw (§18.5, App. E)', () => {
  let h: ServiceHarness;
  afterEach(async () => {
    await h?.cleanup();
  });

  const raw = (harness: ServiceHarness, query: string, token?: string) =>
    fetch(`${harness.baseUrl}/api/files/raw?${query}`, {
      headers: token ? { authorization: `Bearer ${token}` } : {},
    });

  async function bootWithFiles(): Promise<ServiceHarness> {
    const harness = await bootService({ onboarded: true, watchFiles: false });
    const store = harness.service.files;
    store.ensure();
    // A real 1x1 PNG: the route must serve bytes, not a transcoding of them.
    fs.writeFileSync(
      store.resolve('photo.png'),
      Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
        'base64',
      ),
    );
    fs.writeFileSync(store.resolve('report.pdf'), Buffer.from('%PDF-1.4\n%%EOF\n', 'utf8'));
    fs.writeFileSync(store.resolve('page.html'), '<script>alert(1)</script>');
    fs.writeFileSync(store.resolve('logo.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
    store.write('notes.md', '# notes\n', 'notes');
    return harness;
  }

  it('serves a store file with its type, inline, to an authenticated device', async () => {
    h = await bootWithFiles();
    const res = await raw(h, 'path=photo.png', h.token);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/png');
    expect(res.headers.get('content-disposition')).toBe('inline');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    const bytes = Buffer.from(await res.arrayBuffer());
    expect(bytes.subarray(1, 4).toString()).toBe('PNG');

    const pdf = await raw(h, 'path=report.pdf', h.token);
    expect(pdf.headers.get('content-type')).toBe('application/pdf');
  });

  it('never serves a store file as HTML, and defuses SVG', async () => {
    // A file in the store may have been written by the assistant, and this
    // route answers on the origin that holds the device token (§22.3's
    // reasoning, applied to the preview surface).
    h = await bootWithFiles();
    const html = await raw(h, 'path=page.html', h.token);
    expect(html.headers.get('content-type')).toBe('text/plain; charset=utf-8');
    expect(await html.text()).toContain('<script>');

    const svg = await raw(h, 'path=logo.svg', h.token);
    expect(svg.headers.get('content-type')).toBe('image/svg+xml');
    expect(svg.headers.get('content-security-policy')).toContain("default-src 'none'");

    const md = await raw(h, 'path=notes.md', h.token);
    expect(md.headers.get('content-type')).toBe('text/plain; charset=utf-8');
  });

  it('refuses without a token, and refuses traversal with the F.8 cases', async () => {
    h = await bootWithFiles();
    expect((await raw(h, 'path=photo.png')).status).toBe(401);
    expect((await raw(h, 'path=photo.png', 'not-the-token')).status).toBe(401);

    // The same probes `files.read` refuses, through the same resolver.
    for (const probe of ['../secrets/secrets.yaml', '/etc/passwd', '../../etc/passwd']) {
      const res = await raw(h, `path=${encodeURIComponent(probe)}`, h.token);
      expect(res.status).toBe(403);
      expect(await res.text()).not.toContain('secret');
    }
    fs.symlinkSync('/etc', path.join(h.dataDir, 'files', 'link'));
    expect((await raw(h, 'path=link/passwd', h.token)).status).toBe(403);
  });

  it('404s what is not there and 400s a missing path', async () => {
    h = await bootWithFiles();
    expect((await raw(h, 'path=nope.png', h.token)).status).toBe(404);
    // A directory is not a file to preview.
    fs.mkdirSync(path.join(h.dataDir, 'files', 'folder'), { recursive: true });
    expect((await raw(h, 'path=folder', h.token)).status).toBe(404);
    expect((await raw(h, 'path=', h.token)).status).toBe(400);
  });
});

/**
 * The panel's one testable seam (§18.5): which element renders which type.
 * `ui/` has no build step and no module system, so the function is read from
 * source and evaluated — the same trick `embeds-net.test.ts` uses to assert
 * things about the page.
 */
describe('file preview renderers (§18.5)', () => {
  const source = fs.readFileSync(new URL('../ui/preview.js', import.meta.url), 'utf8');
  const previewKind = new Function(`${source}; return previewKind;`)() as (
    mime: unknown,
  ) => string | null;

  it('picks a renderer per mime, and nothing for the rest', () => {
    expect(previewKind('image/png')).toBe('image');
    expect(previewKind('image/jpeg')).toBe('image');
    expect(previewKind('image/svg+xml')).toBe('image');
    expect(previewKind('application/pdf')).toBe('pdf');
    // Parameters and case are the server's to send, not the panel's to police.
    expect(previewKind('APPLICATION/PDF; charset=binary')).toBe('pdf');
    // Everything else keeps the metadata row it always had.
    expect(previewKind('application/zip')).toBeNull();
    expect(previewKind('text/html')).toBeNull();
    expect(previewKind(undefined)).toBeNull();
  });

  it('agrees with what the raw route will serve inline', () => {
    // A type the server sends as itself but the panel cannot render is a dead
    // preview; a type the panel renders but the server sends as text/plain is
    // a broken image. SVG is the one asymmetry, and it is deliberate: the
    // route serves it under a no-script CSP.
    for (const mime of INLINE_RENDERABLE) expect(previewKind(mime)).not.toBeNull();
    expect(previewKind('image/svg+xml')).toBe('image');
    expect(INLINE_RENDERABLE.has('image/svg+xml')).toBe(false);
  });
});
