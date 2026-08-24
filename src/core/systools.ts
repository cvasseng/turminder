import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { log } from './logger.js';

const l = log('systools');

/**
 * The system binaries this build is allowed to shell out to (§23.1). The list
 * is the whitelist: reaching for a binary that is not here is a spec change,
 * not an implementation decision — the same rule App. J applies to npm.
 */
export type SystoolName = 'chromium' | 'notify-send' | 'gpg' | 'git';

export interface SystoolContract {
  name: SystoolName;
  /** Tried in order; the first one that answers wins. */
  candidates: readonly string[];
  /**
   * The pinned CLI contract. Recorded here rather than at the call site
   * because "whatever flags happened to work" is how a shell-out rots: when a
   * distro renames a flag, this is the line that has to change.
   */
  versionArgs: readonly string[];
  /** What acceptable version output looks like, with the major in group 1. */
  versionRe: RegExp;
  /** Refuse anything older: the flags we pin did not exist before this. */
  minMajor?: number;
  /** Said to the user, verbatim, when the binary is absent. */
  hint: string;
  /**
   * Probe by looking the binary up on PATH instead of running it.
   *
   * This exists for exactly one reason: macOS ships a `git` shim that opens
   * the Xcode Command Line Tools installer *when invoked* (§23.1, §28.5). A
   * capability probe must never put a dialog in front of someone who only
   * opened the app — so git is found by path, and its version is not checked.
   */
  probeByPath?: boolean;
}

export const SYSTOOL_CONTRACTS: Record<SystoolName, SystoolContract> = {
  chromium: {
    name: 'chromium',
    candidates: ['chromium', 'chromium-browser', 'google-chrome'],
    versionArgs: ['--version'],
    versionRe: /(\d+)\.\d+/,
    // `--headless=new` — the mode the print pipeline pins (§23.4) — landed in
    // 112. Older builds accept the flag and quietly run the old headless,
    // which prints differently from the browser the user previewed in.
    minMajor: 112,
    hint: 'install chromium (Debian/Ubuntu: apt install chromium; Fedora: dnf install chromium; macOS: brew install --cask chromium) or set systools.chromium in config/turminder.yaml',
  },
  gpg: {
    name: 'gpg',
    candidates: ['gpg', 'gpg2'],
    versionArgs: ['--version'],
    versionRe: /gpg \(GnuPG\) (\d+)\.\d+/,
    // The `--batch --yes --encrypt --recipient` contract the store pins is
    // GnuPG 2; the 1.x flag set differs enough to be a different program.
    minMajor: 2,
    hint: 'install gnupg (Debian/Ubuntu: apt install gnupg; Fedora: dnf install gnupg2; macOS: brew install gnupg) or set systools.gpg in config/turminder.yaml',
  },
  git: {
    name: 'git',
    candidates: ['git'],
    // Never executed: see `probeByPath`. Recorded anyway, because the day
    // someone decides to check a minimum version this is where it goes.
    versionArgs: ['--version'],
    versionRe: /git version (\d+)\.\d+/,
    probeByPath: true,
    hint: 'install git (Debian/Ubuntu: apt install git; macOS: xcode-select --install) or set systools.git in config/turminder.yaml — without it the data dir works but keeps no history',
  },
  'notify-send': {
    name: 'notify-send',
    candidates: ['notify-send'],
    versionArgs: ['--version'],
    versionRe: /(\d+)\.\d+/,
    hint: 'install libnotify (Debian/Ubuntu: apt install libnotify-bin; Fedora: dnf install libnotify) or set daemon.notify_command in config/turminder.yaml',
  },
};

export interface SystoolProbe {
  name: SystoolName;
  /** Usable: found, and new enough. */
  ok: boolean;
  /** What we would actually spawn — a configured path, or the candidate name. */
  command?: string;
  version?: string;
  /** Why not, when `ok` is false. Present for logs and `turminder doctor`. */
  reason?: string;
  hint: string;
}

/** The honest-degradation result shape a tool returns (§23.1, App. F.14). */
export interface SystoolMissing {
  error: 'systool_missing';
  message: string;
  hint: string;
}

export interface SystoolDeps {
  /** A user-configured path for this tool, if any (G.1). */
  configured?: (name: SystoolName) => string | null;
  /**
   * Resolves a command to a path without running it — the `probeByPath`
   * mechanism. Injected so a test can say "this machine has no git" without
   * uninstalling git.
   */
  lookupPath?: (command: string) => string | null;
  /**
   * Runs a candidate's version command. Injected so tests never depend on what
   * happens to be installed on the machine running them.
   */
  run?: (command: string, args: readonly string[]) => string;
}

/**
 * PATH lookup with no execution. An absolute path is checked directly; a bare
 * name is walked across PATH looking for something executable. Deliberately
 * not `which`/`command -v`: spawning a shell to find git is one more process
 * than the answer needs, and on macOS the point is to spawn nothing at all.
 */
export function lookupOnPath(command: string): string | null {
  const isPath = command.includes('/') || command.includes('\\');
  const candidates = isPath
    ? [command]
    : (process.env.PATH ?? '')
        .split(path.delimiter)
        .filter(Boolean)
        .map((dir) => path.join(dir, command));
  for (const candidate of candidates) {
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      /* next */
    }
  }
  return null;
}

function defaultRun(command: string, args: readonly string[]): string {
  return execFileSync(command, [...args], {
    encoding: 'utf8',
    timeout: 5000,
    stdio: ['ignore', 'pipe', 'ignore'],
  });
}

/**
 * Probes the §23.1 registry and remembers the answers. Cached per instance
 * because a binary does not appear halfway through a process, and a feature
 * that shells out must not pay a spawn to find out it can.
 */
export class SystoolRegistry {
  private readonly cache = new Map<SystoolName, SystoolProbe>();
  private readonly run: (command: string, args: readonly string[]) => string;
  private readonly lookup: (command: string) => string | null;

  constructor(private readonly deps: SystoolDeps = {}) {
    this.run = deps.run ?? defaultRun;
    this.lookup = deps.lookupPath ?? lookupOnPath;
  }

  probe(name: SystoolName): SystoolProbe {
    const cached = this.cache.get(name);
    if (cached) return cached;
    const probed = this.attempt(name);
    this.cache.set(name, probed);
    if (probed.ok)
      l.debug(
        { tool: name, command: probed.command, version: probed.version },
        'systool found',
      );
    else
      l.info(
        { tool: name, reason: probed.reason },
        'systool unavailable; the features that need it will say so',
      );
    return probed;
  }

  /** Every entry, for `turminder doctor` (§23.1). */
  report(): SystoolProbe[] {
    return (Object.keys(SYSTOOL_CONTRACTS) as SystoolName[]).map((name) => this.probe(name));
  }

  /** The command to spawn, or null when the tool is not usable. */
  command(name: SystoolName): string | null {
    const probed = this.probe(name);
    return probed.ok ? (probed.command ?? null) : null;
  }

  /**
   * The failure a tool returns when its binary is absent (§23.1): the missing
   * name and the install hint, never a bare "failed". Null when it is there,
   * so a caller reads `const missing = systools.missing('chromium'); if
   * (missing) return missing;`.
   */
  missing(name: SystoolName): SystoolMissing | null {
    const probed = this.probe(name);
    if (probed.ok) return null;
    return {
      error: 'systool_missing',
      message: `this needs ${name}, which is not available: ${probed.reason ?? 'not found'}`,
      hint: probed.hint,
    };
  }

  private attempt(name: SystoolName): SystoolProbe {
    const contract = SYSTOOL_CONTRACTS[name];
    const configured = this.deps.configured?.(name) ?? null;
    // A configured path is the user's decision: try it and only it, so a typo
    // reports as a typo instead of silently falling through to a PATH hit.
    const candidates = configured ? [configured] : contract.candidates;
    const failures: string[] = [];
    if (contract.probeByPath) {
      for (const command of candidates) {
        const found = this.lookup(command);
        if (found) return { name, ok: true, command: found, hint: contract.hint };
        failures.push(`${command}: not on PATH`);
      }
      return { name, ok: false, reason: failures.join('; '), hint: contract.hint };
    }
    for (const command of candidates) {
      let output: string;
      try {
        output = this.run(command, contract.versionArgs);
      } catch (e) {
        failures.push(`${command}: ${(e as { code?: string }).code ?? 'failed'}`);
        continue;
      }
      const match = contract.versionRe.exec(output.trim());
      if (!match) {
        failures.push(`${command}: unrecognised --version output`);
        continue;
      }
      const version = match[0];
      const major = Number(match[1]);
      if (contract.minMajor !== undefined && major < contract.minMajor) {
        failures.push(`${command}: version ${version} is older than ${contract.minMajor}`);
        continue;
      }
      return { name, ok: true, command, version, hint: contract.hint };
    }
    return {
      name,
      ok: false,
      reason: failures.join('; ') || 'no candidate binary',
      hint: contract.hint,
    };
  }
}
