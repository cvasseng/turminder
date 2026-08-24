import fs from 'node:fs';
import { createRequire } from 'node:module';
import { log } from '../logger.js';
import { errMessage } from '../errors.js';
import type { BackendDeps, BackendHealth, SecretBackend, SecretMap } from './backend.js';

const l = log('secrets');

/** One vault entry per key, under this service name (§27.1). */
const SERVICE = 'turminder';
/** Written, read back and deleted by every probe; never a real key. */
const PROBE_ENTRY = '__probe__';
/**
 * The vault has no "list my entries" API worth relying on, so the store keeps
 * its own index — one more entry, holding the key names. Names, never values:
 * if this entry is lost the values are still there, they are just unlisted,
 * and a migration would miss them. That is why `list()` reads the index and
 * `save()` rewrites it in the same pass.
 */
const INDEX_ENTRY = '__keys__';

/** The slice of `@napi-rs/keyring` this backend uses. Injected in tests. */
export interface Keyring {
  get(service: string, account: string): string | null;
  set(service: string, account: string, value: string): void;
  delete(service: string, account: string): void;
}

/**
 * What `/proc/keys` says right now — the kernel keyring's own account of
 * itself, and the only thing that can say *where* a write landed (§27.1).
 * Injected in tests, where a fake vault leaves no trace in a real kernel.
 */
export type KernelKeys = () => KernelKeysReading;

export type KernelKeysReading =
  /** The file's contents: descriptions and sizes, never values. */
  | { keys: string }
  /** No keyutils here (another OS, or a kernel without CONFIG_KEYS). */
  | { absent: true }
  /** There is a keyring subsystem and it will not show itself. */
  | { unreadable: string };

function readKernelKeys(): KernelKeysReading {
  try {
    return { keys: fs.readFileSync('/proc/keys', 'utf8') };
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    return code === 'ENOENT' ? { absent: true } : { unreadable: errMessage(e) };
  }
}

/** What to do about a machine whose `os` backend is not the Secret Service. */
const NO_SECRET_SERVICE_FIX =
  'start a Secret Service (gnome-keyring or kwallet), or move the store with `turminder secrets migrate gpg`';

/**
 * Did the sentinel land in the kernel keyring rather than the Secret Service?
 *
 * A `/proc/keys` line is `serial flags usage timeout perm uid gid type
 * description: summary` — names and sizes, never values — so a line naming
 * both this service and the sentinel is ours. The flags column's `i`, `R` and
 * `D` mark keys the kernel has already thrown away: an invalidated sentinel
 * from an earlier probe must not convict a vault that works today.
 */
function landedInKeyutils(procKeys: string): boolean {
  return procKeys.split('\n').some((line) => {
    if (!line.includes(SERVICE) || !line.includes(PROBE_ENTRY)) return false;
    const flags = line.trim().split(/\s+/)[1] ?? '';
    return !/[iRD]/.test(flags);
  });
}

let loaded: Keyring | null = null;

/**
 * Lazy, and only here: the native module must not load under the other two
 * backends (App. J). An install that chose `plain` should never have a
 * prebuilt binary mapped into its process.
 */
function nativeKeyring(): Keyring {
  if (loaded) return loaded;
  // `createRequire`, not `await import`: the backend interface is synchronous
  // all the way up to the config loader, and a native CJS addon loads fine
  // this way without turning every secret read into a promise.
  const load = createRequire(import.meta.url);
  const mod = load('@napi-rs/keyring') as {
    Entry: new (
      service: string,
      account: string,
    ) => {
      getPassword(): string;
      setPassword(value: string): void;
      deletePassword(): boolean;
    };
  };
  loaded = {
    get(service, account) {
      try {
        return new mod.Entry(service, account).getPassword();
      } catch {
        // "no entry" and "vault locked" both land here; the probe is what
        // tells those apart, and it runs before anything asks for a value.
        return null;
      }
    },
    set(service, account, value) {
      new mod.Entry(service, account).setPassword(value);
    },
    delete(service, account) {
      try {
        new mod.Entry(service, account).deletePassword();
      } catch {
        /* already gone */
      }
    },
  };
  return loaded;
}

/**
 * The native OS vault (§27.1): Secret Service on Linux, Keychain on macOS,
 * Credential Manager on Windows. Secrets leave the data dir entirely, which
 * removes them from every file-shaped exfiltration path — scrapes, backups,
 * git remotes, a copied data dir — and costs the data dir's portability
 * (§12.1), which the setup flow says out loud.
 */
export class OsBackend implements SecretBackend {
  readonly name = 'os' as const;
  private readonly keyring: () => Keyring;
  private readonly kernelKeys: KernelKeys;

  constructor(_deps: BackendDeps, keyring?: Keyring, kernelKeys?: KernelKeys) {
    this.keyring = keyring ? () => keyring : nativeKeyring;
    this.kernelKeys = kernelKeys ?? readKernelKeys;
  }

  probe(): BackendHealth {
    try {
      const ring = this.keyring();
      // A round-trip, not a read: an unlocked-but-empty vault and a vault that
      // refuses writes look identical until something is written.
      ring.set(SERVICE, PROBE_ENTRY, 'ok');
      const read = ring.get(SERVICE, PROBE_ENTRY);
      // Where it landed is a different question from whether it worked, and
      // the keyring library is not the one to ask — asked here while the
      // sentinel is still in place, and answered before the value is trusted.
      const vault = this.identify();
      ring.delete(SERVICE, PROBE_ENTRY);
      if (read !== 'ok') {
        return {
          ok: false,
          reason: 'the vault did not return what was just written',
          fix: 'unlock your keyring, or switch backends with `turminder secrets migrate plain`',
        };
      }
      return vault;
    } catch (e) {
      return {
        ok: false,
        reason: errMessage(e),
        fix: 'start/unlock the OS keyring (Linux: gnome-keyring or kwallet with a Secret Service), or switch backends with `turminder secrets migrate gpg`',
      };
    }
  }

  /**
   * Positive identification (§27.1): on Linux the `os` backend is the Secret
   * Service or it is nothing. The kernel keyring is session-scoped — every
   * secret gone at the next reboot, which reads as mass revocation rather than
   * as a vault — and the keyring library will happily write there, and report
   * success, with no secrets daemon anywhere. "The API answered" is never the
   * question; where the answer came from is.
   */
  private identify(): BackendHealth {
    const reading = this.kernelKeys();
    // No keyutils in this kernel, so the write cannot have gone there: macOS,
    // Windows, and Linux built without CONFIG_KEYS all land here.
    if ('absent' in reading) return { ok: true };
    if ('unreadable' in reading) {
      return {
        ok: false,
        reason: `could not verify which vault answered (/proc/keys: ${reading.unreadable})`,
        fix: NO_SECRET_SERVICE_FIX,
      };
    }
    if (!landedInKeyutils(reading.keys)) return { ok: true };
    return {
      ok: false,
      reason:
        'no Secret Service — the keyring answered from the kernel keyutils cache, which is wiped at every reboot',
      fix: NO_SECRET_SERVICE_FIX,
    };
  }

  load(): SecretMap {
    const ring = this.keyring();
    const out: SecretMap = {};
    for (const key of this.index(ring)) {
      const value = ring.get(SERVICE, key);
      if (value !== null) out[key] = value;
      else l.warn({ key }, 'indexed secret missing from the vault');
    }
    return out;
  }

  save(map: SecretMap): void {
    const ring = this.keyring();
    const wanted = Object.keys(map).sort();
    for (const gone of this.index(ring).filter((k) => !(k in map))) {
      ring.delete(SERVICE, gone);
    }
    for (const [key, value] of Object.entries(map)) ring.set(SERVICE, key, value);
    ring.set(SERVICE, INDEX_ENTRY, JSON.stringify(wanted));
  }

  purge(): void {
    const ring = this.keyring();
    for (const key of this.index(ring)) ring.delete(SERVICE, key);
    ring.delete(SERVICE, INDEX_ENTRY);
  }

  private index(ring: Keyring): string[] {
    const raw = ring.get(SERVICE, INDEX_ENTRY);
    if (!raw) return [];
    try {
      const parsed = JSON.parse(raw) as unknown;
      return Array.isArray(parsed)
        ? parsed.filter((k): k is string => typeof k === 'string')
        : [];
    } catch {
      l.warn('the vault key index is unreadable; treating the store as empty');
      return [];
    }
  }
}
