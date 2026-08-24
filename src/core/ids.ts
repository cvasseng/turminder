import { randomBytes } from 'node:crypto';
import { monotonicFactory } from 'ulid';

/**
 * Every id in the system is a ULID (spec preamble to the appendices), and the
 * ids are **monotonic**: plain ULIDs generated inside the same millisecond sort
 * arbitrarily, and this system orders events, deliveries and turns by id —
 * per-key event ordering (§4.4) and the delivery resume cursor (§7.3) both
 * depend on id order matching arrival order. Single writer process (§12.2)
 * makes a per-process factory sufficient.
 */
const monotonicUlid = monotonicFactory();

export function newId(): string {
  return monotonicUlid();
}

/** Device/channel tokens (App. G.4): random hex, 32 bytes by default. */
export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('hex');
}
