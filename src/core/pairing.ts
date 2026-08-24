import { randomBytes } from 'node:crypto';
import { log } from './logger.js';
import { randomToken } from './ids.js';
import { DEVICE_NAME, DEVICE_NAME_MAX, type DeviceTokens } from './tokens.js';

const l = log('pairing');

/**
 * Page-initiated pairing (§24.4). A browser that holds no token cannot ask for
 * one over the socket — it has nothing to authenticate with, which is the whole
 * reason it is at the gate — and it cannot open a camera either: `getUserMedia`
 * is secure-context only, so on the plain-HTTP LAN address a phone reaches this
 * service at, `navigator.mediaDevices` does not exist. So the gate asks, and a
 * device that is already linked approves.
 *
 * The device flow's shape, for the reason it has that shape: a human carries
 * one short string across a gap two machines cannot bridge themselves. What
 * makes it safe is not the code — a code is read aloud in a room — but that
 * the code alone unlocks nothing. The token goes to whoever holds the
 * **ticket**, which never leaves the page that asked.
 *
 * Nothing here is at rest, ever: a pending request and an approved value live
 * in this map and nowhere else, so a restart drops them. A token nobody claimed
 * should not survive one.
 */

/** No `0/1/I/L/O/U`: this is read out loud and typed back by hand. */
const CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTVWXYZ';
const CODE_CHARS = 6;

/** App. A. Not G.1 keys — like the `ui_*` constants, nothing configures these. */
export const PAIR_TTL_S = 600;
export const PAIR_PENDING_MAX = 8;
export const PAIR_POLL_INTERVAL_S = 2;

interface Pending {
  code: string;
  ticket: string;
  expiresAt: number;
  /** Set at approval. The only place the value exists until it is claimed. */
  approved?: { device: string; label?: string; token: string };
  /** A human said no. Kept until claimed so the device can say which it was. */
  declined?: true;
}

/**
 * What kind of thing is asking (§24.4). A closed set on purpose: it decides the
 * name the approval dialog offers, and an unauthenticated caller must not be
 * able to put characters of its own choosing in front of the person answering.
 * The asker picks a category; the server writes every word.
 */
export type PairKind = 'phone' | 'browser' | 'desktop';

export type PairRequest =
  | { code: string; ticket: string; expires_in_s: number }
  | { error: 'too_many_pending' | 'nothing_linked'; message: string };

export type PairClaim =
  | { status: 'pending' }
  | { status: 'approved'; token: string; device: string }
  | { status: 'declined' }
  | { status: 'expired' };

export type PairApproval =
  | { device: string; label: string | null; approved: true; delivered_to_device: true }
  | {
      error: 'no_such_request' | 'already_approved' | 'device_exists' | 'bad_device_name';
      message: string;
    };

/** What a person typed or dictated, reduced to what a code actually is. */
function normalise(code: string): string {
  return code.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

/** `XYZ-ABC` — grouped because a code gets read out in two halves. */
function newCode(): string {
  const bytes = randomBytes(CODE_CHARS);
  let out = '';
  for (let i = 0; i < CODE_CHARS; i++) {
    // Modulo bias over a 30-letter alphabet is ~4% on the first two letters —
    // irrelevant against a code that lives ten minutes behind a pending cap of
    // eight, and the ticket is what actually has to be unguessable.
    out += CODE_ALPHABET[(bytes[i] ?? 0) % CODE_ALPHABET.length];
  }
  return `${out.slice(0, 3)}-${out.slice(3)}`;
}

export class PairingBroker {
  private readonly pending = new Map<string, Pending>();

  constructor(
    private readonly tokens: DeviceTokens,
    private readonly now: () => number = () => Date.now(),
  ) {}

  /**
   * A gate asks to be let in. Nothing is minted here and nothing is written:
   * this hands out a code for a human to read out, and a ticket that makes the
   * asking browser the only thing that can collect the answer.
   */
  request(): PairRequest {
    this.sweep();
    // Nobody to approve it: the same install whose gate points at the CLI
    // (§24.3), and a pending request there would wait out its TTL for nothing.
    if (this.tokens.list().length === 0) {
      return {
        error: 'nothing_linked',
        message:
          'no device is linked yet, so there is nobody to approve this one — create the first token with `turminder token create`',
      };
    }
    if (this.pending.size >= PAIR_PENDING_MAX) {
      return {
        error: 'too_many_pending',
        message: `${PAIR_PENDING_MAX} devices are already waiting to be approved — approve or abandon one, or try again in a few minutes`,
      };
    }
    // A collision would make one code mean two devices, which is the one thing
    // an approval must never be ambiguous about.
    let code = newCode();
    while (this.byCode(code)) code = newCode();
    const ticket = randomToken(32);
    this.pending.set(ticket, { code, ticket, expiresAt: this.now() + PAIR_TTL_S * 1000 });
    l.info({ waiting: this.pending.size }, 'device asked to pair');
    return { code, ticket, expires_in_s: PAIR_TTL_S };
  }

  /**
   * A linked device says yes. The token is minted through the one door
   * (§24.1) and parked against the ticket — it is not returned, because the
   * caller here is the model's tool and the value must never touch it (§24.2).
   */
  approve(code: string, device: string, label?: string): PairApproval {
    this.sweep();
    const found = this.byCode(code);
    if (!found) {
      return {
        error: 'no_such_request',
        message: `no device is waiting with the code ${code} — ask the user to read it again, or to tap "connect this device" if it has expired`,
      };
    }
    if (found.declined) {
      return {
        error: 'no_such_request',
        message: `the device with code ${code} was declined at the prompt — ask the user to tap "connect this device" again if that was a mistake`,
      };
    }
    if (found.approved) {
      return {
        error: 'already_approved',
        message: `the device with code ${code} was already approved as ${found.approved.device} — it should be connected`,
      };
    }
    // The name arrives as free text from a form as well as from a model, so the
    // shape is checked here — at the door — rather than at either caller.
    if (!DEVICE_NAME.test(device) || device.length > DEVICE_NAME_MAX) {
      return {
        error: 'bad_device_name',
        message: `${device || 'that'} is not a usable device name — letters, digits, dot, dash and underscore, starting with a letter or digit`,
      };
    }
    const created = this.tokens.create(device, { ...(label ? { label } : {}) });
    // The request outlives the refusal on purpose: another name still works,
    // and making the user re-tap the button for a naming clash is a punishment
    // for the model's guess.
    if ('error' in created) return created;
    found.approved = created;
    l.info({ device }, 'pairing approved');
    return {
      device: created.device,
      label: created.label ?? null,
      approved: true,
      delivered_to_device: true,
    };
  }

  /**
   * A human said no — the approval dialog was cancelled (§24.4). Kept rather
   * than dropped so the device hears "declined" instead of watching a code go
   * stale: a refusal someone chose to make should look different from a
   * timeout, especially when the refusal means "this is not my device".
   */
  decline(code: string): boolean {
    this.sweep();
    const found = this.byCode(code);
    if (!found || found.approved) return false;
    found.declined = true;
    l.info({ waiting: this.pending.size }, 'pairing declined');
    return true;
  }

  /**
   * The waiting page collects. Exactly once: the entry goes as the value does,
   * so a replayed ticket is indistinguishable from one that never existed.
   */
  claim(ticket: string): PairClaim {
    this.sweep();
    const found = this.pending.get(ticket);
    if (!found) return { status: 'expired' };
    if (found.declined) {
      this.pending.delete(ticket);
      return { status: 'declined' };
    }
    if (!found.approved) return { status: 'pending' };
    this.pending.delete(ticket);
    l.info({ device: found.approved.device }, 'pairing claimed');
    return { status: 'approved', token: found.approved.token, device: found.approved.device };
  }

  /** Pending requests, for the tests that care that nothing lingers. */
  get waiting(): number {
    this.sweep();
    return this.pending.size;
  }

  private byCode(code: string): Pending | undefined {
    const wanted = normalise(code);
    for (const entry of this.pending.values()) {
      if (normalise(entry.code) === wanted) return entry;
    }
    return undefined;
  }

  private sweep(): void {
    const now = this.now();
    for (const [ticket, entry] of this.pending) {
      if (entry.expiresAt <= now) this.pending.delete(ticket);
    }
  }
}
