import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { ConfigError } from '../errors.js';
import type { BackendDeps, BackendHealth, SecretBackend, SecretMap } from './backend.js';

const HEADER = `# Flat KEY: value map, referenced from config as \${secret:KEY} (App. G.6).
# This file is chmod 600 and never enters git.
`;

/**
 * The original store, now the last resort (§27.1): a chmod-600 YAML file in
 * the data dir. It protects against git leaks and other users on the box, and
 * against nothing else — which is why choosing it is a decision the user makes
 * out loud and hears about once per startup.
 */
export class PlainBackend implements SecretBackend {
  readonly name = 'plain' as const;

  constructor(private readonly deps: BackendDeps) {}

  get file(): string {
    return path.join(this.deps.dir, 'secrets.yaml');
  }

  probe(): BackendHealth {
    // A file store works as long as the directory does; if it does not, every
    // other part of the data dir is already broken.
    return { ok: true };
  }

  load(): SecretMap {
    if (!fs.existsSync(this.file)) return {};
    return parseMap(fs.readFileSync(this.file, 'utf8'), 'secrets/secrets.yaml');
  }

  save(map: SecretMap): void {
    fs.mkdirSync(this.deps.dir, { recursive: true });
    fs.writeFileSync(this.file, `${HEADER}${YAML.stringify(map)}`, {
      encoding: 'utf8',
      mode: 0o600,
    });
    // The mode above only applies when the file is created; an existing one
    // keeps whatever it had, so say it again.
    fs.chmodSync(this.file, 0o600);
  }

  purge(): void {
    fs.rmSync(this.file, { force: true });
  }
}

/** Shared by `plain` and `gpg`: the same document, one of them encrypted. */
export function parseMap(text: string, label: string): SecretMap {
  let parsed: unknown;
  try {
    parsed = YAML.parse(text);
  } catch (e) {
    throw new ConfigError(label, 'not valid YAML', (e as Error).message);
  }
  if (parsed === null || parsed === undefined) return {};
  if (typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new ConfigError(label, 'expected a flat KEY: value map');
  }
  const out: SecretMap = {};
  for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
    if (v === null || v === undefined) continue;
    if (typeof v === 'object') throw new ConfigError(label, `key ${k} must be a scalar`);
    out[k] = String(v);
  }
  return out;
}

export { HEADER as PLAIN_HEADER };
