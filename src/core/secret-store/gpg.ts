import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import YAML from 'yaml';
import { log } from '../logger.js';
import { errMessage } from '../errors.js';
import type { BackendDeps, BackendHealth, SecretBackend, SecretMap } from './backend.js';
import { parseMap, PLAIN_HEADER } from './plain.js';

const l = log('secrets');

/** How the store shells out to gpg. Injected so tests never need a keyring. */
export type GpgExec = (args: readonly string[], input?: string) => string;

function defaultExec(command: string): GpgExec {
  return (args, input) =>
    execFileSync(command, [...args], {
      encoding: 'utf8',
      input,
      timeout: 15_000,
      stdio: ['pipe', 'pipe', 'pipe'],
      maxBuffer: 8 * 1024 * 1024,
    });
}

/**
 * The same flat map as `plain`, encrypted to a gpg recipient (§27.1). Keeps
 * the data dir self-contained — the encrypted file travels with a backup, and
 * only the user's private key opens it — at the cost of a binary that has to
 * be there.
 *
 * Whole-file re-encryption on every write is deliberate: partial updates of an
 * encrypted document mean a merge, and a merge of secrets that goes wrong
 * silently loses a credential.
 */
export class GpgBackend implements SecretBackend {
  readonly name = 'gpg' as const;

  constructor(
    private readonly deps: BackendDeps,
    /** Test seam; the real one is derived from the probed binary. */
    private readonly exec?: GpgExec,
  ) {}

  get file(): string {
    return path.join(this.deps.dir, 'secrets.yaml.gpg');
  }

  probe(): BackendHealth {
    const probe = this.deps.systools.probe('gpg');
    if (!probe.ok) {
      return { ok: false, reason: probe.reason ?? 'gpg is not installed', fix: probe.hint };
    }
    if (!this.deps.gpgKey()) {
      return {
        ok: false,
        reason: 'no recipient key configured',
        fix: 'set secrets.gpg_key in config/turminder.yaml to the key id secrets should be encrypted to',
      };
    }
    return { ok: true };
  }

  load(): SecretMap {
    if (!fs.existsSync(this.file)) return {};
    const text = this.run(['--batch', '--yes', '--quiet', '--decrypt', this.file]);
    return parseMap(text, 'secrets/secrets.yaml.gpg');
  }

  save(map: SecretMap): void {
    const key = this.deps.gpgKey();
    if (!key) throw new Error('secrets.gpg_key is not set');
    fs.mkdirSync(this.deps.dir, { recursive: true });
    const document = `${PLAIN_HEADER}${YAML.stringify(map)}`;
    const armored = this.run(
      [
        '--batch',
        '--yes',
        '--armor',
        '--recipient',
        key,
        '--trust-model',
        'always',
        '--encrypt',
      ],
      document,
    );
    fs.writeFileSync(this.file, armored, { encoding: 'utf8', mode: 0o600 });
    fs.chmodSync(this.file, 0o600);
  }

  purge(): void {
    fs.rmSync(this.file, { force: true });
  }

  private run(args: readonly string[], input?: string): string {
    const exec = this.exec ?? defaultExec(this.deps.systools.probe('gpg').command ?? 'gpg');
    try {
      return exec(args, input);
    } catch (e) {
      // Not a return value: a backend that cannot read its own store is not a
      // degraded mode, it is a stop (§27.1).
      l.error({ err: errMessage(e) }, 'gpg failed');
      throw new Error(`gpg failed: ${errMessage(e)}`, { cause: e });
    }
  }
}
