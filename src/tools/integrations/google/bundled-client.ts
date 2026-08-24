import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { log } from '../../../core/logger.js';

const l = log('google');

/**
 * The bundled OAuth client — Turminder's own, not the user's.
 *
 * The Go daemon this is ported from bakes the client into the binary with
 * `-X main.googleClientID=$TIMETRACK_GOOGLE_CLIENT_ID`, so a user never visits
 * the Google console. Node has no ldflags, so the equivalent is a small file
 * written next to the app at build (or install) time from the same environment
 * variables, plus a runtime env fallback for development. Empty is fine: the
 * loader then falls through to the user's own credentials.
 *
 * The file is gitignored. An installed-app client secret is not a
 * confidentiality boundary anyway — Google says as much — but there is no
 * reason to publish it either.
 */
export interface BundledClient {
  clientId: string;
  clientSecret: string;
  source: string;
}

export const BUNDLE_FILENAME = 'google-client.json';

/** Repo root in development, the dist directory after a build. */
export function appRoots(): string[] {
  const here = path.dirname(fileURLToPath(import.meta.url));
  // src/tools/integrations/google -> repo root; dist/... -> dist and its parent.
  const up = (n: number) => path.resolve(here, ...Array.from({ length: n }, () => '..'));
  return [up(4), up(5)];
}

export function bundlePath(): string {
  return path.join(appRoots()[0]!, BUNDLE_FILENAME);
}

export function readBundledClient(): BundledClient | null {
  // For operators who want their own client instead of the shipped one — and
  // for tests, which must not depend on whether a bundle happens to exist.
  if (process.env.TURMINDER_IGNORE_BUNDLED_GOOGLE_CLIENT === '1') return null;

  const envId = process.env.TURMINDER_GOOGLE_CLIENT_ID;
  const envSecret = process.env.TURMINDER_GOOGLE_CLIENT_SECRET;
  if (envId && envSecret) {
    return { clientId: envId, clientSecret: envSecret, source: 'environment (bundled slot)' };
  }

  for (const root of appRoots()) {
    const file = path.join(root, BUNDLE_FILENAME);
    if (!fs.existsSync(file)) continue;
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as {
        client_id?: string;
        client_secret?: string;
        installed?: { client_id?: string; client_secret?: string };
        web?: { client_id?: string; client_secret?: string };
      };
      const wrap = parsed.installed ?? parsed.web ?? parsed;
      if (wrap.client_id && wrap.client_secret) {
        return {
          clientId: wrap.client_id,
          clientSecret: wrap.client_secret,
          source: `bundled (${BUNDLE_FILENAME})`,
        };
      }
      l.warn({ file }, 'bundled google client file has no client_id/client_secret');
    } catch (e) {
      l.warn({ file, err: (e as Error).message }, 'bundled google client file is unreadable');
    }
  }
  return null;
}

/** Writes the bundled slot. Used by the build step and `auth google-client`. */
export function writeBundledClient(clientId: string, clientSecret: string): string {
  const file = bundlePath();
  fs.writeFileSync(
    file,
    `${JSON.stringify({ client_id: clientId, client_secret: clientSecret }, null, 2)}\n`,
    { encoding: 'utf8', mode: 0o600 },
  );
  return file;
}

/** Reads CLIENT_ID/CLIENT_SECRET out of a `.env`-style file. */
export function readEnvFile(file: string): { clientId: string; clientSecret: string } | null {
  if (!fs.existsSync(file)) return null;
  const values: Record<string, string> = {};
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
    if (!match || line.trim().startsWith('#')) continue;
    values[match[1]!] = match[2]!.trim().replace(/^["']|["']$/g, '');
  }
  const idKey = Object.keys(values).find((k) => /GOOGLE_CLIENT_ID$/.test(k));
  const secretKey = Object.keys(values).find((k) => /GOOGLE_CLIENT_SECRET$/.test(k));
  if (!idKey || !secretKey) return null;
  return { clientId: values[idKey]!, clientSecret: values[secretKey]! };
}
