import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LAYOUT_VERSION, openDataHome, resolveDataDir } from '../src/core/datadir.js';
import { UserFacingError } from '../src/core/errors.js';
import { tmpDir } from './helpers.js';

describe('resolveDataDir', () => {
  const savedEnv = process.env.TURMINDER_DATA_DIR;
  const savedHome = process.env.HOME;
  afterEach(() => {
    process.env.TURMINDER_DATA_DIR = savedEnv;
    process.env.HOME = savedHome;
  });

  it('prefers the flag over the environment', () => {
    process.env.TURMINDER_DATA_DIR = '/env/dir';
    expect(resolveDataDir('/flag/dir')).toBe('/flag/dir');
  });

  it('falls back to the environment', () => {
    process.env.TURMINDER_DATA_DIR = '/env/dir';
    expect(resolveDataDir()).toBe('/env/dir');
  });

  it('defaults to ~/.turminder', () => {
    delete process.env.TURMINDER_DATA_DIR;
    process.env.HOME = '/home/someone';
    expect(resolveDataDir()).toBe('/home/someone/.turminder');
  });

  it('expands a leading tilde', () => {
    process.env.HOME = '/home/someone';
    expect(resolveDataDir('~/assistant')).toBe('/home/someone/assistant');
  });

  it('returns an absolute path', () => {
    expect(path.isAbsolute(resolveDataDir('relative/dir'))).toBe(true);
  });
});

describe('openDataHome', () => {
  let t: { dir: string; cleanup: () => void };
  beforeEach(() => {
    t = tmpDir();
  });
  afterEach(() => t.cleanup());

  it('creates the full layout, MANIFEST, ignore file and git repo', () => {
    const root = path.join(t.dir, 'home');
    const { home, created, newUiToken } = openDataHome(root);
    expect(created).toBe(true);
    for (const d of ['config', 'memory', 'handlers', 'skills', 'secrets', 'cache']) {
      expect(fs.statSync(home.path(d)).isDirectory()).toBe(true);
    }
    expect(home.readManifest().layout_version).toBe(LAYOUT_VERSION);
    expect(fs.readFileSync(home.path('.gitignore'), 'utf8')).toContain('events.db');
    expect(home.git.isRepo()).toBe(true);
    expect(home.git.head()).toBeTruthy();
    expect(newUiToken).toMatch(/^[0-9a-f]{64}$/);
  });

  it('keeps secrets out of git, and scaffolds no plaintext file (§27)', () => {
    const { home } = openDataHome(path.join(t.dir, 'home'));
    // The directory is created chmod 700; the *file* is the store's to make,
    // and an install that chose the `os` backend must end up with nothing in
    // here at all.
    expect(fs.statSync(home.secretsDir).mode & 0o777).toBe(0o700);
    expect(fs.readdirSync(home.secretsDir)).toEqual([]);
    const ignore = fs.readFileSync(home.path('.gitignore'), 'utf8');
    expect(ignore).toContain('secrets/');
    expect(ignore).toContain('cache/');
    expect(ignore).toContain('uploads/');
  });

  it('is idempotent and preserves the ui token', () => {
    const root = path.join(t.dir, 'home');
    const first = openDataHome(root);
    const createdAt = first.home.readManifest().created_at;
    const token = fs.readFileSync(first.home.path('config', 'channels.yaml'), 'utf8');

    const second = openDataHome(root);
    expect(second.created).toBe(false);
    expect(second.newUiToken).toBeUndefined();
    expect(second.home.readManifest().created_at).toBe(createdAt);
    expect(fs.readFileSync(second.home.path('config', 'channels.yaml'), 'utf8')).toBe(token);
  });

  it('refuses a MANIFEST from the future', () => {
    const root = path.join(t.dir, 'home');
    const { home } = openDataHome(root);
    fs.writeFileSync(
      home.manifestPath,
      `layout_version: ${LAYOUT_VERSION + 1}\ncreated_at: 2026-01-01T00:00:00.000Z\n`,
    );
    expect(() => openDataHome(root)).toThrowError(UserFacingError);
    try {
      openDataHome(root);
    } catch (e) {
      expect((e as UserFacingError).code).toBe('layout_from_the_future');
    }
  });

  it('rejects a corrupt MANIFEST with a useful code', () => {
    const root = path.join(t.dir, 'home');
    const { home } = openDataHome(root);
    fs.writeFileSync(home.manifestPath, 'layout_version: "not a number"\n');
    try {
      openDataHome(root);
      throw new Error('should have thrown');
    } catch (e) {
      expect((e as UserFacingError).code).toBe('manifest_invalid');
    }
  });

  it('works when the parent directory does not exist yet', () => {
    const root = path.join(t.dir, 'a', 'b', 'c');
    expect(openDataHome(root).created).toBe(true);
    expect(fs.existsSync(path.join(root, 'MANIFEST'))).toBe(true);
  });

  it('survives being copied to a new location (§12.1 test)', () => {
    const root = path.join(t.dir, 'home');
    openDataHome(root);
    const copy = path.join(t.dir, 'copy');
    fs.cpSync(root, copy, { recursive: true });
    const { created, home } = openDataHome(copy);
    expect(created).toBe(false);
    expect(home.readManifest().layout_version).toBe(LAYOUT_VERSION);
  });

  it('does not touch the real home directory', () => {
    openDataHome(path.join(t.dir, 'home'));
    expect(fs.existsSync(path.join(os.homedir(), '.turminder-should-not-exist'))).toBe(false);
  });
});
