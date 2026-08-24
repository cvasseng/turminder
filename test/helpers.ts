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
