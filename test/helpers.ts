import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** A throwaway directory, removed by the returned cleanup. */
export function tmpDir(prefix = 'turminder-test-'): { dir: string; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  return { dir, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

/**
 * Copy a directory tree, entry by entry, modes and symlinks intact.
 *
 * `fs.cpSync` is the one-liner this replaced. Its implementation moved into
 * C++ during Node 22 and CI runs the whole 22–24 range, so a copy that works
 * on one version is not evidence about the others — and it failed in CI, on a
 * scaffolded data dir with no symlinks and nothing exotic in it, reporting
 * ENOENT against a destination path it had not made yet. A fixture is not the
 * place to find out which Node you are on: this walk is boring everywhere.
 */
export function copyTree(from: string, to: string): void {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const src = path.join(from, entry.name);
    const dest = path.join(to, entry.name);
    if (entry.isSymbolicLink()) fs.symlinkSync(fs.readlinkSync(src), dest);
    else if (entry.isDirectory()) copyTree(src, dest);
    else fs.copyFileSync(src, dest);
  }
  // Set after the walk: a 0700 directory would otherwise be one we could not
  // write the rest of the tree into. `secrets/` is exactly that (§27).
  fs.chmodSync(to, fs.statSync(from).mode & 0o777);
}

export function write(file: string, contents: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, contents, 'utf8');
}

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * Run the CLI as a child process. Async on purpose: tests that also run a fake
 * endpoint in-process would deadlock against spawnSync, which blocks the event
 * loop the server needs to answer.
 */
export function runCli(args: string[], env: Record<string, string> = {}): Promise<CliResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts', ...args], {
      cwd: repoRoot,
      env: { ...process.env, TURMINDER_LOG_JSON: '1', TURMINDER_LOG_LEVEL: 'warn', ...env },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += String(d)));
    child.stderr.on('data', (d) => (stderr += String(d)));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code: code ?? -1, stdout, stderr }));
  });
}
