import fs from 'node:fs';
import { createHash, timingSafeEqual } from 'node:crypto';
import YAML from 'yaml';
import { log } from './logger.js';
import { nowIso } from './time.js';
import { randomToken } from './ids.js';
import type { Config } from './config.js';
import type { ChannelsDevice } from './config-schemas.js';
import type { DataHome } from './datadir.js';

const l = log('tokens');

/**
 * Device tokens (§24) — the gateway's whole auth story, and the one door
 * `config/channels.yaml` is written through (G.4: the CLI and
 * `setup.token_create` are its only writers, and both come here).
 *
 * **Values are never at rest.** A row stores `token_sha256`; the value exists
 * only in the moment of creation — printed once by the CLI, or carried once by
 * a `token.reveal` frame (§24.2). Nothing here can re-display a token, which
 * is why a lost one is revoke + recreate rather than a recovery flow. That is
 * deliberately stronger than the secret store (§27): a secret gets replayed
 * outward and must be recoverable, a gateway token only ever gets *verified*.
 */

/**
 * What a device may be called (G.4). Exported because both doors that mint a
 * token have to agree — the model's `setup.pair_approve` validates its args
 * against this, and the pairing form's free-text answer is checked against the
 * same thing rather than a second regex that drifts from it.
 */
export const DEVICE_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;
export const DEVICE_NAME_MAX = 64;

/** The SHA-256 of a token value, hex — what a row actually holds. */
export function tokenSha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/**
 * Constant-time hash comparison. Both sides are fixed-width SHA-256 hex by
 * construction, so an early length exit leaks nothing about the value — a
 * malformed row is simply not a match.
 */
function sameHash(a: string, b: string): boolean {
  if (a.length !== 64 || b.length !== 64) return false;
  const left = Buffer.from(a, 'hex');
  const right = Buffer.from(b, 'hex');
  if (left.length !== 32 || right.length !== 32) return false;
  return timingSafeEqual(left, right);
}

/** What a listing may show: everything about a device except its token (§24.1). */
export interface DeviceListing {
  device: string;
  label?: string;
  created_at?: string;
}

export interface CreateOptions {
  label?: string;
  /** The run that minted it, for `setup.token_create` provenance (G.4). */
  runId?: string;
  /**
   * Replace an existing row instead of refusing. The CLI's `token create` has
   * always rotated in place — a person at a terminal holding the data dir does
   * not need to be told to revoke first. `setup.token_create` does not set it:
   * the model gets `device_exists` and has to ask (§24.2).
   */
  rotate?: boolean;
}

export type CreateResult =
  | { device: string; label?: string; token: string }
  | { error: 'device_exists'; message: string };

export class DeviceTokens {
  private readonly listeners = new Set<() => void>();

  constructor(
    private readonly home: DataHome,
    private readonly config: Config,
  ) {}

  /**
   * Fires whenever the device rows change under this process — revoke, or a
   * rotate that invalidates the value someone is still holding. The gateway
   * subscribes so a revocation reaches a live socket now rather than at its
   * next reconnect (§24.1). A revoke from the CLI is a different process and
   * never gets here; the heartbeat sweep is what catches that one.
   */
  onChanged(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Devices and their metadata. Never a value — there is none to return. */
  list(): DeviceListing[] {
    return this.rows().map((row) => ({
      device: row.device,
      ...(row.label ? { label: row.label } : {}),
      ...(row.created_at ? { created_at: row.created_at } : {}),
    }));
  }

  has(device: string): boolean {
    return this.rows().some((row) => row.device === device);
  }

  /**
   * Whether some device still authenticates with this hash. The gateway holds
   * the hash of the token each live socket presented — never the value — and
   * asks this to decide whether that socket is still allowed to exist.
   */
  hasHash(hash: string): boolean {
    return this.rows().some((row) => {
      const stored = row.token_sha256 ?? (row.token ? tokenSha256(row.token) : '');
      return sameHash(hash, stored);
    });
  }

  /**
   * The device a presented token authenticates as, or null. Every row is
   * compared — no early exit on the first match — so the work does not depend
   * on which device is asking.
   */
  authenticate(presented: string): string | null {
    if (!presented) return null;
    const offered = tokenSha256(presented);
    let device: string | null = null;
    for (const row of this.rows()) {
      const stored = row.token_sha256 ?? (row.token ? tokenSha256(row.token) : '');
      if (sameHash(offered, stored)) device = row.device;
    }
    return device;
  }

  create(device: string, opts: CreateOptions = {}): CreateResult {
    const rows = this.rows();
    if (!opts.rotate && rows.some((r) => r.device === device)) {
      return {
        error: 'device_exists',
        message: `a device named ${device} already has a token — revoke it first, or pick another name`,
      };
    }
    const token = randomToken(32);
    const row: ChannelsDevice = {
      device,
      token_sha256: tokenSha256(token),
      ...(opts.label ? { label: opts.label } : {}),
      created_at: nowIso(),
      ...(opts.runId ? { created_by_run: opts.runId } : {}),
    };
    this.write(
      [...rows.filter((r) => r.device !== device), row],
      `config: token for device ${device}`,
    );
    return { device, ...(opts.label ? { label: opts.label } : {}), token };
  }

  /** Remove a device's row. False when there was nothing to remove. */
  revoke(device: string): boolean {
    const rows = this.rows();
    const kept = rows.filter((r) => r.device !== device);
    if (kept.length === rows.length) return false;
    this.write(kept, `config: revoke device ${device}`);
    return true;
  }

  /**
   * Fold pre-§24 plaintext `token:` rows into hashes, in place (G.4). Called
   * once at boot: an install that predates hash-at-rest starts clean, keeps
   * authenticating the tokens its devices already hold, and never writes the
   * plaintext again. Returns the devices it rewrote.
   */
  healLegacy(): string[] {
    const rows = this.rows();
    const legacy = rows.filter((r) => r.token !== undefined);
    if (!legacy.length) return [];
    const healed = rows.map((row) => {
      if (row.token === undefined) return row;
      const { token, ...rest } = row;
      return { ...rest, token_sha256: row.token_sha256 ?? tokenSha256(token) };
    });
    this.write(healed, 'config: hash device tokens at rest (§24)');
    const devices = legacy.map((r) => r.device);
    l.info({ devices }, 'hashed legacy plaintext device tokens');
    return devices;
  }

  private rows(): ChannelsDevice[] {
    return this.config.channels().devices;
  }

  private write(devices: ChannelsDevice[], message: string): void {
    fs.writeFileSync(
      this.home.path('config', 'channels.yaml'),
      YAML.stringify({ devices }),
      'utf8',
    );
    this.home.git.commit(message, ['config/channels.yaml']);
    for (const listener of this.listeners) listener();
  }
}
