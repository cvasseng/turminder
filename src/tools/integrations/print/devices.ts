import { z } from 'zod';
import { DEFAULT_SCAN_DIR, DEFAULT_SCAN_INBOX } from './constants.js';
import { deviceFetch } from './transport.js';
import { PrinterClient } from './printer.js';
import { ScannerClient } from './escl.js';

/**
 * The device registry (§34.1, App. G.12). It lives in the `print-scan`
 * activation record's settings because a printer is exactly what that record
 * is for — and as a *list*, because "we have two printers" is the normal case
 * and a single-device setting would need replacing the day someone bought a
 * label printer.
 */

export const PrintCapabilitiesSchema = z.strictObject({
  uri: z.string().min(1),
  formats: z.array(z.string()).default([]),
  color: z.boolean().default(false),
  sides: z.array(z.string()).default([]),
  media: z.array(z.string()).default([]),
  media_default: z.string().nullable().default(null),
  resolution_dpi: z.coerce.number().int().positive().default(300),
});

export const ScanCapabilitiesSchema = z.strictObject({
  uri: z.string().min(1),
  sources: z.array(z.string()).default([]),
  formats: z.array(z.string()).default([]),
  resolutions_dpi: z.array(z.coerce.number().int().positive()).default([]),
  color_modes: z.array(z.string()).default([]),
});

/** Kebab, short, and unique — the slug every `print.*` tool addresses. */
export const DEVICE_NAME = /^[a-z0-9][a-z0-9-]{0,39}$/;

export const DeviceSchema = z.strictObject({
  name: z.string().regex(DEVICE_NAME),
  label: z.string().default(''),
  host: z.string().min(1),
  enabled: z.boolean().default(true),
  probed_at: z.string().optional(),
  /** The §34.2 TOFU pin. Null for a device reached over plain HTTP. */
  tls_fingerprint_sha256: z.string().nullable().default(null),
  print: PrintCapabilitiesSchema.nullable().default(null),
  scan: ScanCapabilitiesSchema.nullable().default(null),
});

export const PrintScanSettingsSchema = z.strictObject({
  scan_dir: z.string().default(DEFAULT_SCAN_DIR),
  scan_inbox: z.string().default(DEFAULT_SCAN_INBOX),
  devices: z.array(DeviceSchema).default([]),
});

export type Device = z.infer<typeof DeviceSchema>;
export type PrintScanSettings = z.infer<typeof PrintScanSettingsSchema>;

/** The secret-store key holding a device's IPP password, if it has one (§34.1). */
export function passwordKey(name: string): string {
  return `PRINTER_${name.replace(/[^A-Za-z0-9]+/g, '_').toUpperCase()}_PASSWORD`;
}

export interface DeviceRefusal {
  error: 'no_devices' | 'which_device' | 'unknown_device' | 'device_disabled';
  message: string;
  /** The name that was asked for, when it was not one we hold. */
  device?: string;
  /** What could have been meant instead — an error that teaches (§19.4). */
  devices?: string[];
}

export type DeviceResolution = { device: Device } | DeviceRefusal;

/**
 * Which machine did they mean (§34.4)? With one enabled device the answer is
 * obvious; with several and no name it deliberately refuses rather than
 * picking, because guessing wrong here spends someone else's paper.
 */
export function resolveDevice(devices: Device[], name?: string): DeviceResolution {
  if (!devices.length) {
    return {
      error: 'no_devices',
      message: 'no printer or scanner is configured — "set up my printer" in chat adds one',
    };
  }
  if (name) {
    const wanted = name.trim().toLowerCase();
    const match =
      devices.find((d) => d.name === wanted) ??
      devices.find((d) => d.label.toLowerCase() === wanted) ??
      devices.find((d) => d.host === name.trim());
    if (!match) {
      return {
        error: 'unknown_device',
        message: `there is no device called "${name}"`,
        device: name,
        devices: devices.map((d) => d.name),
      };
    }
    if (!match.enabled) {
      return {
        error: 'device_disabled',
        device: match.name,
        message: `${match.name} is switched off in setup; "enable ${match.name}" turns it back on`,
      };
    }
    return { device: match };
  }
  const enabled = devices.filter((d) => d.enabled);
  if (!enabled.length) {
    return {
      error: 'no_devices',
      message: 'every configured device is switched off',
    };
  }
  if (enabled.length > 1) {
    return {
      error: 'which_device',
      message: 'more than one device is set up — say which one',
      devices: enabled.map((d) => d.name),
    };
  }
  return { device: enabled[0]! };
}

export interface ClientDeps {
  /** Substituted whole in tests; the default pins this device's certificate. */
  fetch?: typeof globalThis.fetch;
  /**
   * One key at a time, never the map: a printer password has no business
   * being reachable from a module that only needs this printer's (§27).
   */
  secret?: (key: string) => string | undefined;
}

/** A fetch that will only talk to this device's known certificate (§34.2). */
export function fetchFor(device: Device, deps: ClientDeps = {}): typeof globalThis.fetch {
  return deps.fetch ?? deviceFetch({ fingerprint: device.tls_fingerprint_sha256 });
}

export function printerFor(device: Device, deps: ClientDeps = {}): PrinterClient | null {
  if (!device.print) return null;
  const password = deps.secret?.(passwordKey(device.name));
  return new PrinterClient({
    uri: device.print.uri,
    fetch: fetchFor(device, deps),
    ...(password ? { password } : {}),
  });
}

export function scannerFor(device: Device, deps: ClientDeps = {}): ScannerClient | null {
  if (!device.scan) return null;
  return new ScannerClient({ uri: device.scan.uri, fetch: fetchFor(device, deps) });
}
