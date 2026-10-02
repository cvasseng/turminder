import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { bootService, type ServiceHarness } from './service-harness.js';
import { hashBytes } from '../src/files/store.js';
import { conflictStamp } from '../src/files/sync.js';

/* §18.6 desktop sync, server half — the three routes, the manifest, conflicts. */

let h: ServiceHarness;
afterEach(async () => {
  await h?.cleanup();
});

const sha = (s: string | Buffer) => hashBytes(Buffer.from(s));

function tokenFor(harness: ServiceHarness, device: string): string {
  const created = harness.app.tokens.create(device, {});
  if ('error' in created) throw new Error('token refused');
  return created.token;
}

const put = (
  harness: ServiceHarness,
  token: string | null,
  rel: string,
  body: string | Buffer,
  base?: string,
) =>
  fetch(`${harness.baseUrl}/api/files/sync?path=${encodeURIComponent(rel)}`, {
    method: 'PUT',
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(base !== undefined ? { 'x-turminder-base': base } : {}),
    },
    body,
  });

const del = (harness: ServiceHarness, token: string | null, rel: string, base?: string) =>
  fetch(`${harness.baseUrl}/api/files/sync?path=${encodeURIComponent(rel)}`, {
    method: 'DELETE',
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(base !== undefined ? { 'x-turminder-base': base } : {}),
    },
  });

const manifest = (harness: ServiceHarness, token: string | null) =>
  fetch(`${harness.baseUrl}/api/files/manifest`, {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });

const filePath = (harness: ServiceHarness, rel: string) =>
  path.join(harness.dataDir, 'files', rel);

const gitLog = (harness: ServiceHarness): string[] =>
  execFileSync('git', ['log', '--format=%s'], { cwd: harness.dataDir, encoding: 'utf8' })
    .split('\n')
    .filter(Boolean);

const conflictNotices = (harness: ServiceHarness) =>
  harness.service.repos.deliveries
    .recent(100)
    .filter(
      (d) => d.intent === 'notify' && String(d.payload.title).startsWith('Sync conflict'),
    );

const requests = (harness: ServiceHarness) =>
  harness.service.repos.events.recent({ limit: 100 }).filter((e) => e.type === 'file.request');

async function boot(config?: Record<string, unknown>): Promise<ServiceHarness> {
  return bootService({ onboarded: true, watchFiles: false, ...(config ? { config } : {}) });
}

describe('PUT /api/files/sync (§18.6)', () => {
  it('creates, then edits, with the §18.6 commit messages and the device from the token', async () => {
    h = await boot();
    const a = tokenFor(h, 'laptop');
    const created = await put(h, a, 'notes/todo.md', 'one\n', 'none');
    expect(created.status).toBe(200);
    expect(await created.json()).toEqual({
      path: 'notes/todo.md',
      sha256: sha('one\n'),
      action: 'created',
      committed: true,
    });
    const edited = await put(h, a, 'notes/todo.md', 'two\n', sha('one\n'));
    expect(await edited.json()).toMatchObject({ action: 'modified', sha256: sha('two\n') });
    expect(fs.readFileSync(filePath(h, 'notes/todo.md'), 'utf8')).toBe('two\n');
    const log = gitLog(h);
    expect(log).toContain('Added on laptop: notes/todo.md');
    expect(log).toContain('Edited on laptop: notes/todo.md');
  });

  it('syncs binary bytes unharmed', async () => {
    h = await boot();
    const bytes = Buffer.from([0, 1, 2, 255, 254, 0, 9]);
    const res = await put(h, tokenFor(h, 'laptop'), 'img/x.bin', bytes, 'none');
    expect(res.status).toBe(200);
    expect(fs.readFileSync(filePath(h, 'img/x.bin')).equals(bytes)).toBe(true);
  });

  it('a stale base never overwrites: the original keeps its bytes, the copy holds the upload', async () => {
    h = await boot();
    const a = tokenFor(h, 'laptop');
    const b = tokenFor(h, 'desk');
    await put(h, a, 'todo.md', 'v1\n', 'none');
    await put(h, a, 'todo.md', 'v2 from a\n', sha('v1\n'));
    const res = await put(h, b, 'todo.md', 'v2 from b\n', sha('v1\n'));
    expect(res.status).toBe(409);
    const body = (await res.json()) as any;
    expect(body).toMatchObject({
      error: 'conflict',
      path: 'todo.md',
      sha256: sha('v2 from a\n'),
    });
    expect(body.conflict_path).toMatch(
      /^todo \(conflict from desk \d{4}-\d{2}-\d{2} \d{4}\)\.md$/,
    );
    expect(fs.readFileSync(filePath(h, 'todo.md'), 'utf8')).toBe('v2 from a\n');
    expect(fs.readFileSync(filePath(h, body.conflict_path), 'utf8')).toBe('v2 from b\n');
    expect(conflictNotices(h)).toHaveLength(1);
    expect(gitLog(h)).toContain(`Conflict copy from desk: ${body.conflict_path}`);
    const notice = conflictNotices(h)[0]!.payload as any;
    expect(notice.title).toBe('Sync conflict: todo.md');
    expect(notice.body).toBe(
      `desk and Sleeper Service both changed todo.md. Sleeper Service's version stayed; desk's is in ${body.conflict_path}.`,
    );
  });

  it('a conflict copy name collision gets ` 2` inside the parenthesis', async () => {
    h = await boot();
    const a = tokenFor(h, 'laptop');
    await put(h, a, 'n.md', 'server\n', 'none');
    const first = (await (await put(h, a, 'n.md', 'x1\n', 'none')).json()) as any;
    const second = (await (await put(h, a, 'n.md', 'x2\n', 'none')).json()) as any;
    expect(first.conflict_path).not.toBe(second.conflict_path);
    expect(second.conflict_path).toMatch(/ 2\)\.md$/);
    expect(fs.readFileSync(filePath(h, first.conflict_path), 'utf8')).toBe('x1\n');
    expect(fs.readFileSync(filePath(h, second.conflict_path), 'utf8')).toBe('x2\n');
  });

  it('names a conflict copy in local time', () => {
    expect(conflictStamp(new Date(2026, 9, 2, 7, 5))).toBe('2026-10-02 0705');
  });

  it('a conflict copy of invalid UTF-8 (no NUL) keeps the bytes exactly', async () => {
    h = await boot();
    const a = tokenFor(h, 'laptop');
    await put(h, a, 'u.txt', 'server\n', 'none');
    const bytes = Buffer.from([0xff, 0xfe, 0x41]);
    const res = await put(h, a, 'u.txt', bytes, 'none');
    expect(res.status).toBe(409);
    const { conflict_path } = (await res.json()) as any;
    expect(fs.readFileSync(filePath(h, conflict_path)).equals(bytes)).toBe(true);
  });

  it('a binary conflict copy keeps the exact bytes', async () => {
    h = await boot();
    const a = tokenFor(h, 'laptop');
    await put(h, a, 'b.bin', Buffer.from([0, 1]), 'none');
    const bytes = Buffer.from([0, 7, 255]);
    const body = (await (await put(h, a, 'b.bin', bytes, 'none')).json()) as any;
    expect(fs.readFileSync(filePath(h, body.conflict_path)).equals(bytes)).toBe(true);
  });

  it('identical bytes with a stale or `none` base is unchanged: no commit, no copy', async () => {
    h = await boot();
    const a = tokenFor(h, 'laptop');
    await put(h, a, 'same.md', 'same\n', 'none');
    const commits = gitLog(h).length;
    for (const base of ['none', sha('something else')]) {
      const res = await put(h, a, 'same.md', 'same\n', base);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        path: 'same.md',
        sha256: sha('same\n'),
        action: 'unchanged',
        committed: false,
      });
    }
    expect(gitLog(h)).toHaveLength(commits);
    expect(conflictNotices(h)).toHaveLength(0);
    expect(
      fs
        .readdirSync(path.dirname(filePath(h, 'same.md')))
        .filter((f) => f.includes('conflict')),
    ).toEqual([]);
  });

  it('an edit to a file the server has since deleted recreates it at its own path', async () => {
    h = await boot();
    const a = tokenFor(h, 'laptop');
    await put(h, a, 'gone.md', 'v1\n', 'none');
    h.service.files.delete('gone.md', 'assistant deleted it');
    const res = await put(h, a, 'gone.md', 'v2\n', sha('v1\n'));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ action: 'created', sha256: sha('v2\n') });
    expect(fs.readFileSync(filePath(h, 'gone.md'), 'utf8')).toBe('v2\n');
    expect(gitLog(h)[0]).toBe('Added on laptop: gone.md');
    expect(conflictNotices(h)).toHaveLength(0);
  });

  it('a text conflict copy with a NUL after 8 KB is still kept (binary path), not a 500', async () => {
    h = await boot();
    const a = tokenFor(h, 'laptop');
    await put(h, a, 'n.txt', 'server\n', 'none');
    const bytes = Buffer.concat([
      Buffer.alloc(9000, 0x61),
      Buffer.from([0]),
      Buffer.from('tail'),
    ]);
    const res = await put(h, a, 'n.txt', bytes, 'none');
    expect(res.status).toBe(409);
    const { conflict_path } = (await res.json()) as any;
    expect(fs.readFileSync(filePath(h, conflict_path)).equals(bytes)).toBe(true);
    expect(conflictNotices(h)).toHaveLength(1);
  });

  it('a path through a file, or naming a directory, is 403 for PUT and DELETE, never 500', async () => {
    h = await boot();
    const a = tokenFor(h, 'laptop');
    await put(h, a, 'todo.md', 'x\n', 'none');
    await put(h, a, 'dir/f.md', 'x\n', 'none');
    for (const bad of ['todo.md/x.md', 'todo.md/a/b.md', 'dir']) {
      const p = await put(h, a, bad, 'y', 'none');
      expect(p.status).toBe(403);
      expect(await p.json()).toEqual({ error: 'path_rejected' });
      expect((await del(h, a, bad, sha('x\n'))).status).toBe(403);
    }
    expect(fs.readFileSync(filePath(h, 'todo.md'), 'utf8')).toBe('x\n');
  });

  it('a Content-Length over the limit is 413 from the header alone, nothing written', async () => {
    h = await boot({ files: { sync_max_mb: 0.001 } });
    const a = tokenFor(h, 'laptop');
    const status = await new Promise<number>((resolve, reject) => {
      const u = new URL(h.baseUrl);
      const req = http.request(
        {
          host: u.hostname,
          port: u.port,
          method: 'PUT',
          path: '/api/files/sync?path=late.bin',
          headers: {
            authorization: `Bearer ${a}`,
            'x-turminder-base': 'none',
            'content-length': '5000000',
          },
        },
        (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
          req.destroy();
        },
      );
      req.on('error', (e) => ((e as any).code === 'ECONNRESET' ? undefined : reject(e)));
      req.write(Buffer.alloc(10)); // the body never arrives in full
    });
    expect(status).toBe(413);
    expect(fs.existsSync(filePath(h, 'late.bin'))).toBe(false);
  });

  it('a synced marker fires exactly one file.request once the watcher settles; a conflict copy fires none', async () => {
    h = await boot();
    const a = tokenFor(h, 'laptop');
    await put(h, a, 'm.md', '# list\n- [ ] look into llamas @turminder\n', 'none');
    expect(requests(h)).toHaveLength(0); // not at upload time: the watcher decides
    await h.service.settleFile('m.md');
    expect(requests(h)).toHaveLength(1);
    await h.service.settleFile('m.md');
    expect(requests(h)).toHaveLength(1);

    // Same content, stale base -> identical bytes are `unchanged`; a *different*
    // marker line in a conflicting upload still must not fire from its copy.
    const res = await put(h, a, 'm.md', '- [ ] a brand new ask @turminder\n', 'none');
    expect(res.status).toBe(409);
    const { conflict_path } = (await res.json()) as any;
    await h.service.settleFile(conflict_path);
    await h.service.settleFile('m.md');
    expect(requests(h)).toHaveLength(1);
  });

  it('refuses traversal (403), ignored paths (422), oversize bodies (413) — writing nothing', async () => {
    h = await boot({ files: { sync_max_mb: 0.001 } }); // 1048 bytes
    const a = tokenFor(h, 'laptop');
    for (const bad of ['../escape.md', '/etc/passwd', 'a/../../x.md']) {
      const res = await put(h, a, bad, 'x', 'none');
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: 'path_rejected' });
    }
    const ign = await put(h, a, '.obsidian/workspace.json', 'x', 'none');
    expect(ign.status).toBe(422);
    expect(await ign.json()).toEqual({ error: 'ignored' });
    expect((await put(h, a, '.turminderignore', 'x', 'none')).status).toBe(422);
    expect(fs.existsSync(filePath(h, '.obsidian/workspace.json'))).toBe(false);

    const big = await put(h, a, 'big.bin', Buffer.alloc(5000, 1), 'none');
    expect(big.status).toBe(413);
    expect(await big.json()).toEqual({
      error: 'too_large',
      max_bytes: Math.floor(0.001 * 1024 * 1024),
    });
    expect(fs.existsSync(filePath(h, 'big.bin'))).toBe(false);
    expect(gitLog(h).filter((m) => m.includes('big.bin'))).toEqual([]);
  });

  it('a missing path or base header is 400', async () => {
    h = await boot();
    const a = tokenFor(h, 'laptop');
    const noBase = await put(h, a, 'x.md', 'x');
    expect(noBase.status).toBe(400);
    expect(await noBase.json()).toEqual({ error: 'bad_request' });
    expect((await put(h, a, '', 'x', 'none')).status).toBe(400);
  });
});

const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;

describe('unwritable disks (§18.6)', () => {
  const unwritableBody = async (res: Response) => {
    expect(res.status).toBe(422);
    const body = (await res.json()) as any;
    expect(body.error).toBe('unwritable');
    expect(typeof body.message).toBe('string');
  };

  it.skipIf(isRoot)(
    'PUT into a read-only directory is 422 unwritable, nothing committed',
    async () => {
      h = await boot();
      const a = tokenFor(h, 'laptop');
      await put(h, a, 'ro/seed.md', 'x\n', 'none');
      const commits = gitLog(h).length;
      fs.chmodSync(filePath(h, 'ro'), 0o555);
      try {
        await unwritableBody(await put(h, a, 'ro/new.md', 'y\n', 'none'));
      } finally {
        fs.chmodSync(filePath(h, 'ro'), 0o755);
      }
      expect(fs.existsSync(filePath(h, 'ro/new.md'))).toBe(false);
      expect(gitLog(h)).toHaveLength(commits);
      expect(conflictNotices(h)).toHaveLength(0);
    },
  );

  it('a conflict copy whose name exceeds 255 bytes is 422 unwritable, no notify, no commit', async () => {
    h = await boot();
    const a = tokenFor(h, 'laptop');
    const rel = `${'n'.repeat(230)}.md`;
    expect((await put(h, a, rel, 'server\n', 'none')).status).toBe(200);
    const commits = gitLog(h).length;
    await unwritableBody(await put(h, a, rel, 'other\n', 'none'));
    expect(fs.readFileSync(filePath(h, rel), 'utf8')).toBe('server\n');
    expect(gitLog(h)).toHaveLength(commits);
    expect(conflictNotices(h)).toHaveLength(0);
  });

  it.skipIf(isRoot)(
    'DELETE in a read-only directory is 422 unwritable and keeps the file',
    async () => {
      h = await boot();
      const a = tokenFor(h, 'laptop');
      await put(h, a, 'ro/f.md', 'x\n', 'none');
      const commits = gitLog(h).length;
      fs.chmodSync(filePath(h, 'ro'), 0o555);
      try {
        await unwritableBody(await del(h, a, 'ro/f.md', sha('x\n')));
      } finally {
        fs.chmodSync(filePath(h, 'ro'), 0o755);
      }
      expect(fs.existsSync(filePath(h, 'ro/f.md'))).toBe(true);
      expect(gitLog(h)).toHaveLength(commits);
    },
  );
});

describe('DELETE /api/files/sync (§18.6)', () => {
  it('deletes with the right base and commits as the device', async () => {
    h = await boot();
    const a = tokenFor(h, 'laptop');
    await put(h, a, 'd.md', 'bye\n', 'none');
    const res = await del(h, a, 'd.md', sha('bye\n'));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ path: 'd.md', deleted: true, committed: true });
    expect(fs.existsSync(filePath(h, 'd.md'))).toBe(false);
    expect(gitLog(h)).toContain('Deleted on laptop: d.md');
  });

  it('a stale base deletes nothing (an edit beats a delete)', async () => {
    h = await boot();
    const a = tokenFor(h, 'laptop');
    await put(h, a, 'd.md', 'new\n', 'none');
    const res = await del(h, a, 'd.md', sha('old\n'));
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'conflict', path: 'd.md', sha256: sha('new\n') });
    expect(fs.readFileSync(filePath(h, 'd.md'), 'utf8')).toBe('new\n');
  });

  it('an ignored path is 422 even with the correct base, and stays on disk', async () => {
    h = await boot();
    const a = tokenFor(h, 'laptop');
    h.service.files.ensure();
    fs.mkdirSync(filePath(h, '.obsidian'), { recursive: true });
    fs.writeFileSync(filePath(h, '.obsidian/x'), 'cfg');
    const ignoreText = fs.readFileSync(filePath(h, '.turminderignore'));
    const commits = gitLog(h).length;
    for (const [rel, bytes] of [
      ['.turminderignore', ignoreText],
      ['.obsidian/x', Buffer.from('cfg')],
    ] as const) {
      const res = await del(h, a, rel, hashBytes(bytes));
      expect(res.status).toBe(422);
      expect(await res.json()).toEqual({ error: 'ignored' });
      expect(fs.existsSync(filePath(h, rel))).toBe(true);
    }
    expect(gitLog(h)).toHaveLength(commits);
  });

  it('missing base is 400, absent file is 404, traversal is 403', async () => {
    h = await boot();
    const a = tokenFor(h, 'laptop');
    await put(h, a, 'd.md', 'x\n', 'none');
    const noBase = await del(h, a, 'd.md');
    expect(noBase.status).toBe(400);
    expect(fs.existsSync(filePath(h, 'd.md'))).toBe(true);
    const absent = await del(h, a, 'nope.md', sha('x'));
    expect(absent.status).toBe(404);
    expect(await absent.json()).toEqual({ error: 'not_found' });
    expect((await del(h, a, '../x.md', sha('x'))).status).toBe(403);
  });

  it('the watcher, not the route, settles a synced delete', async () => {
    h = await boot();
    const a = tokenFor(h, 'laptop');
    await put(h, a, 'd.md', 'x\n', 'none');
    await h.service.settleFile('d.md');
    await h.service.background.drain();
    expect(h.service.fileIndex.stats().indexed).toBe(1);
    await del(h, a, 'd.md', sha('x\n'));
    await h.service.settleFile('d.md');
    await h.service.background.stop();
    expect(h.service.fileIndex.stats().indexed).toBe(0);
  });
});

describe('GET /api/files/manifest and the raw hash header (§18.6)', () => {
  it('lists binaries and over-limit files, omits ignored paths and .turminderignore', async () => {
    h = await boot({ files: { sync_max_mb: 0.001 } });
    const a = tokenFor(h, 'laptop');
    h.service.files.ensure();
    fs.mkdirSync(filePath(h, '.obsidian'), { recursive: true });
    fs.writeFileSync(filePath(h, '.obsidian/app.json'), '{}');
    fs.writeFileSync(filePath(h, 'pic.bin'), Buffer.from([0, 1, 2]));
    fs.writeFileSync(filePath(h, 'huge.bin'), Buffer.alloc(5000, 7));
    h.service.files.write('sub/note.md', 'hello\n', 'note');
    const res = await manifest(h, a);
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.max_bytes).toBe(Math.floor(0.001 * 1024 * 1024));
    const byPath = new Map<string, any>(body.files.map((f: any) => [f.path, f]));
    expect([...byPath.keys()].sort()).toEqual(['huge.bin', 'pic.bin', 'sub/note.md']);
    expect(byPath.get('pic.bin')).toMatchObject({
      size: 3,
      sha256: sha(Buffer.from([0, 1, 2])),
    });
    expect(byPath.get('huge.bin').size).toBe(5000);
    expect(new Date(byPath.get('sub/note.md').mtime).toString()).not.toBe('Invalid Date');
  });

  it('its hash equals the raw route header for the same file, text and binary', async () => {
    h = await boot();
    const a = tokenFor(h, 'laptop');
    h.service.files.write('t.md', 'héllo\n', 'm');
    fs.writeFileSync(filePath(h, 'b.png'), Buffer.from([0, 255, 3]));
    const body = (await (await manifest(h, a)).json()) as any;
    for (const entry of body.files) {
      const raw = await fetch(
        `${h.baseUrl}/api/files/raw?path=${encodeURIComponent(entry.path)}`,
        { headers: { authorization: `Bearer ${a}` } },
      );
      expect(raw.headers.get('x-turminder-sha256')).toBe(entry.sha256);
    }
  });

  it('memoises by (path, mtimeMs, size), and notices a changed file', async () => {
    h = await boot();
    const a = tokenFor(h, 'laptop');
    h.service.files.write('c.md', 'aaaa\n', 'm');
    const abs = filePath(h, 'c.md');
    fs.utimesSync(abs, 1_700_000_000, 1_700_000_000);
    const first = (await (await manifest(h, a)).json()) as any;
    // Same size, mtime restored: the cache must (by contract) not re-read it.
    fs.writeFileSync(abs, 'bbbb\n');
    fs.utimesSync(abs, 1_700_000_000, 1_700_000_000);
    const cached = (await (await manifest(h, a)).json()) as any;
    expect(cached.files[0].sha256).toBe(first.files[0].sha256);
    // A real change moves mtime or size and is re-hashed.
    fs.writeFileSync(abs, 'cccc dd\n');
    const fresh = (await (await manifest(h, a)).json()) as any;
    expect(fresh.files[0].sha256).toBe(sha('cccc dd\n'));
  });
});

describe('auth', () => {
  it('is 401 on all three new routes without a valid token', async () => {
    h = await boot();
    for (const token of [null, 'not-a-token']) {
      expect((await manifest(h, token)).status).toBe(401);
      expect((await put(h, token, 'x.md', 'x', 'none')).status).toBe(401);
      expect((await del(h, token, 'x.md', 'none')).status).toBe(401);
    }
    expect(fs.existsSync(filePath(h, 'x.md'))).toBe(false);
  });
});

describe('exit scenario: two clients, one base', () => {
  it('both versions survive and the git log reads as a story', async () => {
    h = await boot();
    const a = tokenFor(h, 'a');
    const b = tokenFor(h, 'b');
    expect((await put(h, a, 'todo.md', 'base\n', 'none')).status).toBe(200);
    const base = sha('base\n');
    expect((await put(h, a, 'todo.md', 'edit from a\n', base)).status).toBe(200);
    const second = await put(h, b, 'todo.md', 'edit from b\n', base);
    expect(second.status).toBe(409);
    const { conflict_path } = (await second.json()) as any;
    expect(fs.readFileSync(filePath(h, 'todo.md'), 'utf8')).toBe('edit from a\n');
    expect(fs.readFileSync(filePath(h, conflict_path), 'utf8')).toBe('edit from b\n');
    expect(
      gitLog(h)
        .filter((m) => /on a|from b/.test(m))
        .reverse(),
    ).toEqual([
      'Added on a: todo.md',
      'Edited on a: todo.md',
      `Conflict copy from b: ${conflict_path}`,
    ]);
    expect(conflictNotices(h)).toHaveLength(1);
  });
});
