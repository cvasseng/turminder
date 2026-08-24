import fs from 'node:fs';
import path from 'node:path';
import { log } from '../logger.js';
import { UserFacingError, errMessage } from '../errors.js';
import type { SystoolRegistry } from '../systools.js';
import type {
  BackendDeps,
  BackendHealth,
  BackendName,
  SecretBackend,
  SecretMap,
} from './backend.js';
import { PlainBackend } from './plain.js';
import { GpgBackend } from './gpg.js';
import { OsBackend, type KernelKeys, type Keyring } from './os.js';

const l = log('secrets');

export type { SecretMap, BackendName, BackendHealth } from './backend.js';
export type { KernelKeys, KernelKeysReading, Keyring } from './os.js';
export type { GpgExec } from './gpg.js';

/** App. A: one value may be this big. JSON blobs are ordinary values (§27). */
export const SECRET_VALUE_MAX_KB = 64;

/**
 * Legacy secret-bearing files, folded into store keys on load (§27). Each is
 * read once, stored under its key, and deleted — after which the store is
 * total again and the `os` guarantee is not theatre.
 */
const LEGACY_FILES: { file: string; key: string }[] = [
  { file: 'google-token.json', key: 'GOOGLE_OAUTH_TOKEN' },
  { file: 'credentials.json', key: 'GOOGLE_CLIENT_CREDENTIALS' },
];

export interface SecretStoreDeps {
  /** The data dir's `secrets/` directory. */
  dir: string;
  systools: SystoolRegistry;
  /** Read per call, so an edited config takes effect on reload (G.1). */
  settings: () => { backend: 'auto' | BackendName; gpgKey: string | null };
  /** Test seams; the real backends reach the vault, the gpg binary, and
   *  `/proc/keys` — which is how the vault is identified rather than believed
   *  (§27.1). */
  keyring?: Keyring;
  gpgExec?: import('./gpg.js').GpgExec;
  kernelKeys?: KernelKeys;
}

export type SetResult = { ok: true } | { error: 'too_large'; message: string };

/**
 * The secret store (§27) — the one door to every secret this system holds at
 * rest, and the only thing that may write inside `secrets/`.
 *
 * Above it, nothing changes with the backend: `${secret:KEY}` resolution still
 * happens in the config loader and only there (G.6), and every §14.4.2 rule
 * about where a value may appear is identical for all three. Consumers cannot
 * tell `plain` from `os`; that is the point of the interface.
 *
 * The store is **total**: OAuth blobs, dropped client credentials, and the
 * generated `EMBED_SECRET` are ordinary keys. A secret-bearing file outside it
 * is a bug of the same class as a secret in a trace.
 */
export class SecretStore {
  private cache: SecretMap | null = null;
  private backendCache: SecretBackend | null = null;
  private backendName: BackendName | null = null;

  constructor(private readonly deps: SecretStoreDeps) {}

  /** Which backend this install is actually using right now (§27.1). */
  get name(): BackendName {
    return this.backend().name;
  }

  /** Is the configured backend pinned, or still the pre-onboarding default? */
  get pinned(): boolean {
    return this.deps.settings().backend !== 'auto';
  }

  probe(): BackendHealth {
    return this.backend().probe();
  }

  /**
   * Fail fast when a pinned backend cannot work (§27.1). Falling back from
   * `os` to `plain` because the vault did not answer would be the system
   * working around its own security setting — a hard boundary, so this
   * refuses to start instead, naming the fix.
   */
  assertUsable(): void {
    const health = this.probe();
    if (health.ok) {
      if (this.name === 'plain' && this.pinned) {
        l.warn(
          'secrets are stored in plaintext (secrets/secrets.yaml) — any process running as you can read them',
        );
      }
      return;
    }
    if (!this.pinned) {
      l.warn(
        { reason: health.reason },
        'no secret backend available yet; using the plain file',
      );
      return;
    }
    throw new UserFacingError(
      'secret_backend_unavailable',
      `the ${this.name} secret backend is not working: ${health.reason ?? 'unknown reason'}`,
      health.fix ??
        'fix the backend, or move the store with `turminder secrets migrate <backend>`',
    );
  }

  /** Every key and value. The config loader's one call (G.6). */
  all(): SecretMap {
    if (!this.cache) {
      this.cache = this.backend().load();
      const healed = this.healLegacyFiles(this.cache);
      if (healed) this.cache = this.backend().load();
    }
    return this.cache;
  }

  get(key: string): string | null {
    return this.all()[key] ?? null;
  }

  /** Names only, everywhere, always (§27.1). */
  list(): string[] {
    return Object.keys(this.all()).sort();
  }

  set(key: string, value: string): SetResult {
    const max = SECRET_VALUE_MAX_KB * 1024;
    if (Buffer.byteLength(value, 'utf8') > max) {
      return {
        error: 'too_large',
        message: `a secret value may be at most ${SECRET_VALUE_MAX_KB}KB`,
      };
    }
    return this.merge({ [key]: value });
  }

  /** Merge several at once — what a submitted form does (§19.2). */
  merge(updates: SecretMap): SetResult {
    if (!Object.keys(updates).length) return { ok: true };
    for (const [key, value] of Object.entries(updates)) {
      if (Buffer.byteLength(value, 'utf8') > SECRET_VALUE_MAX_KB * 1024) {
        return {
          error: 'too_large',
          message: `${key} is larger than the ${SECRET_VALUE_MAX_KB}KB limit for a secret value`,
        };
      }
    }
    const merged = { ...this.all(), ...updates };
    this.backend().save(merged);
    this.cache = merged;
    // Names only. The values are the one thing in this system that is never
    // logged (§14.4.2).
    l.info({ keys: Object.keys(updates), backend: this.name }, 'secrets written');
    return { ok: true };
  }

  delete(key: string): void {
    const remaining = { ...this.all() };
    if (!(key in remaining)) return;
    delete remaining[key];
    this.backend().save(remaining);
    this.cache = remaining;
    l.info({ key, backend: this.name }, 'secret deleted');
  }

  /** Drop the in-memory copy; the next read goes back to the backend. */
  reload(): void {
    this.cache = null;
    this.backendCache = null;
    this.backendName = null;
  }

  /**
   * What this machine could actually use (§27.1). The setup flow probes before
   * it offers, so nobody is invited to pin a backend that will refuse to start
   * on the next boot.
   */
  available(): { backend: BackendName; ok: boolean; reason?: string }[] {
    return (['os', 'gpg', 'plain'] as BackendName[]).map((name) => {
      const health = this.make(name).probe();
      return { backend: name, ok: health.ok, ...(health.ok ? {} : { reason: health.reason }) };
    });
  }

  status(): { backend: BackendName; pinned: boolean; keys: string[]; health: BackendHealth } {
    const health = this.probe();
    return {
      backend: this.name,
      pinned: this.pinned,
      keys: health.ok ? this.list() : [],
      health,
    };
  }

  /**
   * Move every key to another backend (§27.1): copy, verify each read-back,
   * then remove the source. Verification before deletion is the whole point —
   * a migration that half-worked and deleted the original is the one failure
   * nobody recovers from.
   */
  migrate(
    to: BackendName,
  ): { moved: string[]; from: BackendName } | { error: string; message: string } {
    const from = this.name;
    if (to === from) return { error: 'same_backend', message: `already using ${to}` };
    const source = this.backend();
    const target = this.make(to);
    const health = target.probe();
    if (!health.ok) {
      return {
        error: 'target_unavailable',
        message: `${to} is not usable: ${health.reason ?? 'unknown reason'}${health.fix ? ` — ${health.fix}` : ''}`,
      };
    }
    const map = source.load();
    target.save(map);
    const readBack = target.load();
    const missing = Object.keys(map).filter((k) => readBack[k] !== map[k]);
    if (missing.length) {
      return {
        error: 'verify_failed',
        message: `${to} did not read back ${missing.length} value(s); the source was left untouched`,
      };
    }
    source.purge();
    this.reload();
    l.info({ from, to, keys: Object.keys(map).length }, 'secret store migrated');
    return { moved: Object.keys(map).sort(), from };
  }

  /**
   * Fold pre-§27 secret-bearing files into keys and delete them. Runs on the
   * first read, once: an install that predates the store keeps working, and
   * stops keeping credentials in files the vault never sees.
   */
  private healLegacyFiles(current: SecretMap): boolean {
    const updates: SecretMap = {};
    const consumed: string[] = [];
    for (const legacy of LEGACY_FILES) {
      const file = path.join(this.deps.dir, legacy.file);
      if (!fs.existsSync(file)) continue;
      try {
        const raw = fs.readFileSync(file, 'utf8').trim();
        if (raw && !current[legacy.key]) updates[legacy.key] = raw;
        consumed.push(file);
      } catch (e) {
        l.warn({ file: legacy.file, err: errMessage(e) }, 'legacy secret file unreadable');
      }
    }
    if (!consumed.length) return false;
    if (Object.keys(updates).length) {
      const merged = { ...current, ...updates };
      this.backend().save(merged);
      this.cache = merged;
    }
    // Delete only after the value is safely stored: a crash between the two
    // leaves a duplicate, never a hole.
    for (const file of consumed) fs.rmSync(file, { force: true });
    l.info(
      { keys: Object.keys(updates), files: consumed.length },
      'legacy secret files folded in',
    );
    return true;
  }

  private backend(): SecretBackend {
    const configured = this.deps.settings().backend;
    // `auto` is the pre-onboarding default and means "the one that needs
    // nothing" — a concrete choice is written when the user makes one (§27.1).
    const wanted: BackendName = configured === 'auto' ? 'plain' : configured;
    if (this.backendCache && this.backendName === wanted) return this.backendCache;
    this.backendCache = this.make(wanted);
    this.backendName = wanted;
    return this.backendCache;
  }

  private make(name: BackendName): SecretBackend {
    const deps: BackendDeps = {
      dir: this.deps.dir,
      systools: this.deps.systools,
      gpgKey: () => this.deps.settings().gpgKey,
    };
    if (name === 'gpg') return new GpgBackend(deps, this.deps.gpgExec);
    if (name === 'os') return new OsBackend(deps, this.deps.keyring, this.deps.kernelKeys);
    return new PlainBackend(deps);
  }
}
