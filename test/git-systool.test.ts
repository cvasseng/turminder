import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { GitRepo } from '../src/core/git.js';
import { SystoolRegistry, lookupOnPath } from '../src/core/systools.js';
import { openDataHome } from '../src/core/datadir.js';
import { Config } from '../src/core/config.js';
import { FileStore } from '../src/files/store.js';
import { MemoryStore } from '../src/memory/store.js';
import { tmpDir } from './helpers.js';

/**
 * Git as a systool (§12.2, §23.1). The rule under test is the same everywhere:
 * without git the write still happens, the history does not, and everything
 * says `committed: false` rather than throwing or pretending.
 */
describe('git is a systool, not a hard dependency (§12.2)', () => {
  let t: { dir: string; cleanup: () => void };
  afterEach(() => t?.cleanup());

  /** A data home whose git is switched off, as on a clean machine. */
  function gitlessHome(): ReturnType<typeof openDataHome> {
    t = tmpDir('turminder-nogit-');
    const opened = openDataHome(path.join(t.dir, 'home'));
    opened.home.git.useBinary(() => null);
    return opened;
  }

  it('never invokes git to find out whether git exists', () => {
    // The macOS trap (§23.1, §28.5): running the shim opens the Xcode
    // installer. The probe must be a path lookup, so nothing is spawned.
    const spawned: string[] = [];
    const registry = new SystoolRegistry({
      run: (command) => {
        spawned.push(command);
        return 'git version 2.44.0';
      },
      lookupPath: () => null,
    });
    const probe = registry.probe('git');
    expect(probe.ok).toBe(false);
    expect(spawned).toEqual([]);
    expect(probe.hint).toMatch(/xcode-select|apt install git/);
  });

  it('finds git by path when it is there, still without running it', () => {
    const spawned: string[] = [];
    const registry = new SystoolRegistry({
      run: (command) => {
        spawned.push(command);
        return 'git version 2.44.0';
      },
      lookupPath: (command) => `/usr/bin/${command}`,
    });
    expect(registry.probe('git')).toMatchObject({ ok: true, command: '/usr/bin/git' });
    expect(spawned).toEqual([]);
  });

  it('scaffolds a working data dir with no repo, and no throw', () => {
    t = tmpDir('turminder-nogit-');
    const root = path.join(t.dir, 'home');
    // Simulate "no git on this machine" from the very first call by pointing
    // the lookup at nothing: the scaffold must still produce a usable dir.
    const repo = new GitRepo(root);
    repo.useBinary(() => null);
    expect(repo.available).toBe(false);
    repo.init();
    expect(fs.existsSync(path.join(root, '.git'))).toBe(false);
    expect(repo.commit('nothing to commit')).toBe(false);
    expect(repo.head()).toBeNull();
  });

  it('writes files and memories that report committed: false', () => {
    const { home } = gitlessHome();
    const files = new FileStore({
      root: home.filesDir,
      git: { repo: home.git, prefix: 'files' },
    });
    files.ensure();
    const written = files.write('notes/a.md', 'hello\n', 'first note');
    expect(written).toMatchObject({ path: 'notes/a.md', committed: false });
    expect(fs.readFileSync(home.path('files', 'notes/a.md'), 'utf8')).toBe('hello\n');

    const memories = new MemoryStore(home);
    const saved = memories.create({
      description: 'something worth keeping',
      type: 'fact',
      content: 'the sky is blue',
    });
    // The file is on disk; the commit that would normally follow reports false.
    expect(fs.existsSync(home.path(saved.file))).toBe(true);
    expect(memories.commit('memory: a fact', [saved.file])).toBe(false);
  });

  it('initialises the repo on the next start once git appears', () => {
    t = tmpDir('turminder-nogit-');
    const root = path.join(t.dir, 'home');
    const first = new GitRepo(root);
    first.useBinary(() => null);
    fs.mkdirSync(root, { recursive: true });
    first.init();
    expect(first.isRepo()).toBe(false);

    // Same directory, a machine that now has git.
    const later = new GitRepo(root);
    later.useBinary(() => lookupOnPath('git'));
    later.init();
    expect(later.isRepo()).toBe(true);
    fs.writeFileSync(path.join(root, 'note.md'), 'now versioned\n');
    expect(later.commit('first commit after git arrived', ['.'])).toBe(true);
    expect(later.head()).toBeTruthy();
  });

  it('reports the missing tool and what it costs', () => {
    const registry = new SystoolRegistry({ lookupPath: () => null });
    const missing = registry.missing('git');
    expect(missing).toMatchObject({ error: 'systool_missing' });
    expect(missing!.hint).toMatch(/keeps no history/);
    // `doctor` reads the same report.
    expect(registry.report().map((p) => p.name)).toContain('git');
  });

  it('honours the systools.git override rather than PATH', () => {
    t = tmpDir('turminder-nogit-');
    const { home } = openDataHome(path.join(t.dir, 'home'));
    fs.writeFileSync(
      home.path('config', 'turminder.yaml'),
      'systools:\n  git: /nowhere/git\n',
      'utf8',
    );
    const config = new Config(home);
    // A configured path is the user's decision: a typo reports as a typo
    // instead of silently falling through to whatever is on PATH.
    expect(config.systools.command('git')).toBeNull();
  });
});
