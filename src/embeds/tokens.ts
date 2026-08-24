import crypto from 'node:crypto';
import type { DataHome } from '../core/datadir.js';
import type { Config } from '../core/config.js';
import { randomToken } from '../core/ids.js';
import { log } from '../core/logger.js';

const l = log('embeds');

/** The key in secrets/secrets.yaml the scoped tokens are derived from (§22.3). */
export const EMBED_SECRET_KEY = 'EMBED_SECRET';

/**
 * Per-embed scoped tokens (§22.3.4). The device token owns the whole system, so
 * it never reaches an embed context; this is what an embed URL carries instead,
 * and a leaked one is worth exactly one embed. Bumping `token_generation`
 * changes what every outstanding link hashes against, which is the revocation.
 */
export function scopedToken(secret: string, id: string, generation: number): string {
  return crypto.createHmac('sha256', secret).update(`${id}:${generation}`).digest('hex');
}

/** Constant-time: a token check that leaks timing is a token check that leaks. */
export function tokenMatches(expected: string, given: string): boolean {
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(given, 'utf8');
  // timingSafeEqual throws on a length mismatch, which would itself be an
  // oracle; compare lengths first and let the wrong-length case be cheap.
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/**
 * The signing secret, generated on first use (§22.3.4) — there is no setup step
 * to forget, and an install that has never served an embed carries no key it
 * did not need. Written through `writeSecrets` like every other credential, so
 * it lands in the one file that is chmod 600 and never enters git.
 */
export function embedSecret(home: DataHome, config: Config): string {
  const existing = config.secrets[EMBED_SECRET_KEY];
  if (existing) return existing;
  const generated = randomToken(32);
  config.secretStore.merge({ [EMBED_SECRET_KEY]: generated });
  config.reload();
  l.info('generated an embed signing secret');
  return generated;
}
