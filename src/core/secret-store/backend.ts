import type { SystoolRegistry } from '../systools.js';

/** A flat KEY → value map. Values are opaque strings (§27). */
export type SecretMap = Record<string, string>;

export type BackendName = 'plain' | 'gpg' | 'os';

export interface BackendHealth {
  ok: boolean;
  /** Why not, when `ok` is false — shown verbatim by `secrets status`. */
  reason?: string;
  /** What to do about it. A startup failure quotes this (§27.1). */
  fix?: string;
}

/**
 * One place secrets rest. Whole-map reads and writes rather than per-key ones,
 * because two of the three backends are a single encrypted document and the
 * third has to keep an index anyway — and because the config loader wants the
 * whole map at load time regardless (G.6).
 */
export interface SecretBackend {
  readonly name: BackendName;
  /** Can this backend work right now? Never throws; a pinned failure is the
   *  caller's decision to escalate (§27.1). */
  probe(): BackendHealth;
  load(): SecretMap;
  save(map: SecretMap): void;
  /** Remove everything this backend holds — migration's last step (§27.1). */
  purge(): void;
}

export interface BackendDeps {
  /** Absolute path of the data dir's `secrets/` directory. */
  dir: string;
  systools: SystoolRegistry;
  /** Recipient key id for `gpg` (G.1). */
  gpgKey: () => string | null;
}
