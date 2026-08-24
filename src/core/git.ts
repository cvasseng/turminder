import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { log } from './logger.js';
import { lookupOnPath } from './systools.js';

const l = log('git');

export interface GitResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

/**
 * Git over the source half of the data dir (§12.2). Every config/memory/handler
 * mutation commits, so this is deliberately dumb and synchronous.
 *
 * Git is a **systool, not a hard dependency** (§23.1). When the binary is
 * absent every method here is a no-op that reports `false`: the write already
 * happened, only the history did not. `binary` is a function rather than a
 * string because the answer can change between starts — install git and the
 * next boot initialises the repo and carries on.
 */
export class GitRepo {
  /**
   * Where git is, or null when this machine has none (§12.2). A **path
   * lookup**, never an invocation: macOS ships a `git` shim that opens the
   * Xcode installer when run, and nobody should meet that dialog because an
   * assistant wanted to know whether it could keep history (§23.1, §28.5).
   */
  private binary: () => string | null = () => lookupOnPath('git');

  constructor(readonly root: string) {}

  /**
   * Point at the configured binary once settings are readable (`systools.git`,
   * G.1). Before this the PATH lookup answers, which is what the scaffold uses.
   */
  useBinary(resolve: () => string | null): void {
    this.binary = resolve;
  }

  /** Is versioning possible at all here? */
  get available(): boolean {
    return this.binary() !== null;
  }

  private run(args: string[]): GitResult {
    const command = this.binary();
    if (!command) return { ok: false, stdout: '', stderr: 'git is not installed' };
    // Turminder's commits are the assistant's, not the user's: never sign them
    // with the user's key. A global `commit.gpgsign = true` would otherwise make
    // every memory mutation slow, and hang outright when the key needs a
    // passphrase — a background agent has no terminal to type it into.
    const r = spawnSync(
      command,
      ['-c', 'commit.gpgsign=false', '-c', 'tag.gpgsign=false', ...args],
      {
        cwd: this.root,
        encoding: 'utf8',
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: process.env.GIT_AUTHOR_NAME ?? 'turminder',
          GIT_AUTHOR_EMAIL: process.env.GIT_AUTHOR_EMAIL ?? 'turminder@localhost',
          GIT_COMMITTER_NAME: process.env.GIT_COMMITTER_NAME ?? 'turminder',
          GIT_COMMITTER_EMAIL: process.env.GIT_COMMITTER_EMAIL ?? 'turminder@localhost',
        },
      },
    );
    const res: GitResult = {
      ok: r.status === 0,
      stdout: (r.stdout ?? '').trim(),
      stderr: (r.stderr ?? '').trim(),
    };
    if (!res.ok) l.debug({ args, stderr: res.stderr }, 'git command failed');
    return res;
  }

  isRepo(): boolean {
    return existsSync(path.join(this.root, '.git'));
  }

  init(): void {
    if (this.isRepo()) return;
    if (!this.available) {
      l.warn(
        { root: this.root },
        'git is not installed: the data dir works, but keeps no history of your files',
      );
      return;
    }
    this.run(['init', '--initial-branch=main']);
    this.run(['config', 'user.name', 'turminder']);
    this.run(['config', 'user.email', 'turminder@localhost']);
    l.info({ root: this.root }, 'initialised data repo');
  }

  /**
   * Stage the given data-dir-relative paths (or everything) and commit.
   * Returns false when there was nothing to commit — not an error.
   */
  commit(message: string, paths: string[] = ['.']): boolean {
    // Not an error: the write happened, the history did not (§12.2, F.8).
    if (!this.available || !this.isRepo()) return false;
    const add = this.run(['add', '--', ...paths]);
    if (!add.ok) {
      l.warn({ stderr: add.stderr }, 'git add failed');
      return false;
    }
    const staged = this.run(['diff', '--cached', '--name-only']);
    if (staged.ok && staged.stdout === '') return false;
    const c = this.run(['commit', '--quiet', '--no-gpg-sign', '-m', message]);
    if (!c.ok) {
      l.warn({ stderr: c.stderr, message }, 'git commit failed');
      return false;
    }
    l.info({ message }, 'committed');
    return true;
  }

  head(): string | null {
    const r = this.run(['rev-parse', '--short', 'HEAD']);
    return r.ok ? r.stdout : null;
  }
}
