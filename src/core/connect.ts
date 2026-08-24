import os from 'node:os';

/**
 * QR connect (§24.3). Typing a 64-character hex token into a phone is how
 * second devices never get connected, so every reveal carries a scannable
 * version of itself.
 *
 * The token rides the URL **fragment**, which browsers never send to the
 * server — so the value stays out of access logs, proxy logs and referrers,
 * the same care §24 takes with the disk.
 */

export interface ConnectBase {
  base_url: string;
  /** True when nobody told us the address and we picked an interface (G.1). */
  guessed: boolean;
}

/**
 * The address to put in front of a phone. `gateway.public_url` wins; otherwise
 * the first non-internal IPv4 interface and the bind port, which is right on a
 * simple LAN and wrong often enough elsewhere that the guess is flagged all
 * the way to the UI (§17.10) instead of failing silently.
 */
export function connectBase(
  publicUrl: string | null,
  bind: { host: string; port: number },
): ConnectBase {
  if (publicUrl) return { base_url: publicUrl.replace(/\/+$/, ''), guessed: false };
  const addresses = Object.values(os.networkInterfaces())
    .flatMap((entries) => entries ?? [])
    .filter((e) => e.family === 'IPv4' && !e.internal)
    .map((e) => e.address);
  // Falling back to the bind host keeps a loopback-only box honest: the URL
  // works on this machine and visibly does not claim to work anywhere else.
  const host = addresses[0] ?? bind.host;
  return { base_url: `http://${host}:${bind.port}`, guessed: true };
}

/** `<base_url>/#connect=<token>&device=<device>` (§24.3). */
export function connectUrl(baseUrl: string, token: string, device: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/#connect=${encodeURIComponent(token)}&device=${encodeURIComponent(device)}`;
}

/**
 * Server-side SVG, so the UI needs no QR library of its own (§24.3, App. J).
 * Lazy-imported: a CLI that never reveals a token never loads the encoder.
 */
export async function connectQrSvg(url: string): Promise<string> {
  const { toString } = await import('qrcode');
  return toString(url, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' });
}

/** The same payload as terminal blocks, for `token create --qr`. */
export async function connectQrAnsi(url: string): Promise<string> {
  const { toString } = await import('qrcode');
  return toString(url, { type: 'terminal', small: true, errorCorrectionLevel: 'M' });
}
