import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { log } from '../core/logger.js';
import { errMessage } from '../core/errors.js';
import { randomToken } from '../core/ids.js';
import type { SystoolMissing, SystoolRegistry } from '../core/systools.js';

const l = log('docs');

/** App. A: how long a print may take, and how long the page may keep working. */
export const PRINT_TIMEOUT_MS = 60_000;
export const VIRTUAL_TIME_BUDGET_MS = 10_000;

export interface PrintFailure {
  error: 'print_failed';
  message: string;
}

export type PrintResult = { bytes: number } | PrintFailure | SystoolMissing;

export interface PrinterDeps {
  systools: SystoolRegistry;
  /** Injected in tests: the real one spawns a browser. */
  spawn?: (command: string, args: string[]) => Promise<void>;
}

/**
 * PDF generation is headless-chromium print of a **served URL** (§23.4): the
 * same bytes the user iterated on in chat, with the same theme and the same
 * freshly-executed bindings. There is deliberately no second rendering engine
 * — a preview that does not match its export is worse than no export.
 */
export class ChromiumPrinter {
  private readonly spawn: (command: string, args: string[]) => Promise<void>;

  constructor(private readonly deps: PrinterDeps) {
    this.spawn = deps.spawn ?? runProcess;
  }

  /** Absent chromium is an honest refusal with an install hint, not a crash. */
  available(): SystoolMissing | null {
    return this.deps.systools.missing('chromium');
  }

  async toPdf(url: string, outAbs: string): Promise<PrintResult> {
    const missing = this.available();
    if (missing) return missing;
    const command = this.deps.systools.command('chromium')!;
    fs.mkdirSync(path.dirname(outAbs), { recursive: true });
    // A throwaway profile per print. Not decoration: chromium refuses to start
    // against a profile another instance holds, so without this an export
    // fails whenever the user happens to have their browser open.
    const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'turminder-print-'));
    try {
      await this.spawn(command, [
        '--headless=new',
        `--print-to-pdf=${outAbs}`,
        `--virtual-time-budget=${VIRTUAL_TIME_BUDGET_MS}`,
        // No print stamps (§23.4). Chromium's default header and footer put the
        // date, the source URL and a page counter on every page — none of which
        // is part of the artifact the user previewed, and the URL carries the
        // embed's scoped token. Both spellings are passed: the current flag, and
        // the one older builds inside our supported range understood. Chromium
        // ignores a switch it does not know.
        '--no-pdf-header-footer',
        '--print-to-pdf-no-header',
        // A print reaches one URL — the one it was handed — and chromium's
        // background services are not part of that. Left on, a fresh profile
        // registers with Google Cloud Messaging on startup, and `DEPRECATED_
        // ENDPOINT` puts that request into a retry loop. Which would be merely
        // rude, except that virtual time *pauses while network fetches are
        // pending*: the budget above never expires, the browser never exits,
        // and the print dies on its timeout instead. Fast here, fatal on a CI
        // runner, and the difference was only ever how quickly Google answered.
        '--disable-background-networking',
        `--user-data-dir=${profile}`,
        '--no-first-run',
        '--disable-extensions',
        url,
      ]);
    } catch (e) {
      return { error: 'print_failed', message: withoutTokens(errMessage(e)) };
    } finally {
      fs.rmSync(profile, { recursive: true, force: true });
    }
    if (!fs.existsSync(outAbs)) {
      return { error: 'print_failed', message: 'chromium exited without writing a PDF' };
    }
    return { bytes: fs.statSync(outAbs).size };
  }
}

/**
 * The URL we print carries the embed's scoped token, and a failure message that
 * quotes the command line carries it too. This message becomes a tool result —
 * i.e. model context — so the token comes out of it here, at the boundary,
 * whatever threw and whatever it said (§22.3.2).
 */
function withoutTokens(message: string): string {
  return message.replace(/([?&]t=)[^\s&"']+/g, '$1<redacted>');
}

function runProcess(command: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(command, args, { timeout: PRINT_TIMEOUT_MS }, (error, _stdout, stderr) => {
      if (!error) return resolve();
      // Node puts the whole command line in `error.message`, and that command
      // line carries the embed's scoped token. It stays out of the log and out
      // of the returned message, because the returned message becomes model
      // context and the token is a capability (§22.3.2). The exit signal and
      // chromium's own stderr are what actually diagnose a failed print.
      const why = error.killed ? `timed out after ${PRINT_TIMEOUT_MS}ms` : `exit ${error.code}`;
      l.warn({ why, stderr: String(stderr).slice(0, 500) }, 'chromium print failed');
      reject(new Error(`chromium print failed: ${why}`));
    });
  });
}

interface TransientDoc {
  html: string;
  token: string;
  expiresAt: number;
}

/**
 * Documents that exist only long enough to be printed (§23.4).
 *
 * A markdown file from the store is not an embed and must not become one — a
 * row, a git commit and a reap schedule for something that lives for one
 * chromium navigation. So it is served the way an embed is served, from memory,
 * behind a one-off token, and forgotten.
 */
export class TransientDocs {
  private readonly docs = new Map<string, TransientDoc>();

  constructor(private readonly now: () => number = () => Date.now()) {}

  /** Returns the path segment and token that reach it. */
  put(html: string, ttlMs = PRINT_TIMEOUT_MS): { id: string; token: string } {
    this.sweep();
    const id = randomToken(12);
    const token = randomToken(32);
    this.docs.set(id, { html, token, expiresAt: this.now() + ttlMs });
    return { id, token };
  }

  get(id: string, token: string): string | null {
    this.sweep();
    const doc = this.docs.get(id);
    if (!doc || doc.token.length !== token.length) return null;
    // Wrong token is indistinguishable from unknown id, on purpose.
    return doc.token === token ? doc.html : null;
  }

  forget(id: string): void {
    this.docs.delete(id);
  }

  private sweep(): void {
    const at = this.now();
    for (const [id, doc] of this.docs) if (doc.expiresAt <= at) this.docs.delete(id);
  }
}
