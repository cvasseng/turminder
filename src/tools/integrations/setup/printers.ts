import { log } from '../../../core/logger.js';
import { errMessage } from '../../../core/errors.js';
import { nowIso } from '../../../core/time.js';
import type { FieldSpec, FormBroker } from '../../../chat/forms.js';
import type { ToolContext } from '../../types.js';
import { deviceFetch } from '../print/transport.js';
import { probePrinter } from '../print/printer.js';
import { probeScanner } from '../print/escl.js';
import { discover, type Discovered } from '../print/discover.js';
import {
  DEVICE_NAME,
  PrintScanSettingsSchema,
  passwordKey,
  type Device,
} from '../print/devices.js';
import { recordFor, writeRecord, type ActivationContext } from './records.js';

const l = log('tool:setup');

/**
 * Device management (§34.6): one door for adding, editing, disabling and
 * removing printers and scanners.
 *
 * It lives in `setup.*` rather than `print.*` for a reason that is not
 * cosmetic — before the first device exists there is no `print.*` namespace to
 * call, so discovery would be unreachable exactly when it is needed.
 */

export interface PrinterSetupDeps extends ActivationContext {
  forms: FormBroker;
  /**
   * Substituted in tests. The real one listens for multicast and, failing
   * that, sweeps a /24 — twenty seconds a test does not have, on a network a
   * test must not touch.
   */
  discover?: typeof discover;
}

export interface ProbeResult {
  label: string;
  host: string;
  print: Device['print'];
  scan: Device['scan'];
  fingerprint: string | null;
}

/** Bare host from whatever the user typed: an IP, a hostname, or a URL. */
export function hostOf(address: string): string {
  const trimmed = address.trim().replace(/\/+$/, '');
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
  try {
    return new URL(withScheme).hostname;
  } catch {
    return trimmed;
  }
}

/**
 * Ask a machine what it is (§34.1). Both halves are tried, TLS first, and the
 * certificate the device presented is captured on the way past — that is the
 * "trust" half of trust-on-first-use, and this is the only moment it happens.
 */
export async function probeDevice(
  address: string,
  deps: { fetch?: typeof globalThis.fetch } = {},
): Promise<ProbeResult | { error: 'unreachable'; message: string }> {
  const host = hostOf(address);
  let fingerprint: string | null = null;
  const fetchImpl =
    deps.fetch ?? deviceFetch({ onCertificate: (seen) => (fingerprint ??= seen) });

  const print =
    (await probePrinter(`ipps://${host}:631/ipp/print`, fetchImpl)) ??
    (await probePrinter(`ipp://${host}:631/ipp/print`, fetchImpl));
  const scan =
    (await probeScanner(`https://${host}/eSCL`, fetchImpl)) ??
    (await probeScanner(`http://${host}/eSCL`, fetchImpl));

  if (!print && !scan) {
    return {
      error: 'unreachable',
      message: `${host} did not answer as a printer or a scanner — check the address on the device's own display, and that it is on the same network`,
    };
  }
  return {
    label: print?.label ?? scan?.label ?? host,
    host,
    print: print
      ? {
          uri: print.uri,
          formats: print.formats,
          color: print.color,
          sides: print.sides,
          media: print.media,
          media_default: print.media_default,
          resolution_dpi: print.resolution_dpi,
        }
      : null,
    scan: scan
      ? {
          uri: scan.uri,
          sources: scan.sources,
          formats: scan.formats,
          resolutions_dpi: scan.resolutions_dpi,
          color_modes: scan.color_modes,
        }
      : null,
    fingerprint,
  };
}

/** `EPSON ET-3700 Series` → `epson-et-3700-series`, trimmed to something usable. */
export function slug(text: string): string {
  return (
    text
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40)
      .replace(/-+$/, '') || 'printer'
  );
}

export function devicesOf(ctx: ActivationContext): Device[] {
  return PrintScanSettingsSchema.parse(recordFor(ctx.config, 'print-scan')?.settings ?? {})
    .devices;
}

/**
 * Write one device into the registry, leaving the others alone — and activate
 * the integration if this is the first. Everything goes through `writeRecord`,
 * the same one door activation uses (§34.6, G.12).
 */
export function applyDevice(
  ctx: ActivationContext,
  device: Device | null,
  name: string,
  message: string,
): void {
  const record = recordFor(ctx.config, 'print-scan');
  const settings = PrintScanSettingsSchema.parse(record?.settings ?? {});
  const devices = settings.devices.filter((d) => d.name !== name);
  if (device) devices.push(device);
  writeRecord(
    ctx,
    'print-scan',
    {
      active: true,
      activated_at: record?.activated_at ?? nowIso(),
      settings: { ...settings, devices },
    },
    message,
  );
}

function passwordField(key: string): FieldSpec {
  return {
    name: 'password',
    label:
      'Password, if the printer asks for one — almost none do; leave blank to keep the current one',
    type: 'secret',
    required: false,
    secret_key: key,
  };
}

/** The fields of the add form, with whatever discovery turned up on top. */
function addFields(found: Discovered[]): FieldSpec[] {
  const options = found.map((d) => `${d.label} — ${d.host}`);
  const fields: FieldSpec[] = [];
  if (options.length) {
    fields.push({
      name: 'found',
      label: 'Which one — or choose "another address" and type it below',
      type: 'select',
      options: [...options, 'another address'],
      value: options[0]!,
    });
  }
  fields.push(
    {
      name: 'address',
      label: options.length
        ? 'Address, if it is not in the list above'
        : "Its address on the network — the IP or hostname from the device's own display",
      type: 'text',
      required: !options.length,
    },
    {
      name: 'name',
      label: 'Short name to call it by, e.g. office',
      type: 'text',
      value: found[0] ? slug(found[0].label) : '',
    },
    passwordField('PRINTER_{name}_PASSWORD'),
  );
  return fields;
}

export type WizardOutcome = Record<string, unknown>;

/**
 * `setup.printers` (App. F.9). Two forms at most: which device, then what to
 * do with it. Nothing is written until the machine has answered a probe — a
 * record for an address that did not respond is worse than no record, because
 * every later print then fails at the far end with the address already blessed.
 */
export async function runPrinterWizard(
  deps: PrinterSetupDeps,
  ctx: ToolContext,
): Promise<WizardOutcome> {
  if (!ctx.conversationId || !ctx.runId) {
    return {
      error: 'no_conversation',
      message: 'adding a printer needs a form, and forms are rendered in a chat conversation',
    };
  }
  const form = { runId: ctx.runId, conversationId: ctx.conversationId };
  const devices = devicesOf(deps);

  /* Which device? A menu of one choice is furniture, so it is skipped. */
  let target: Device | null = null;
  if (devices.length) {
    const ADD = 'add a new device';
    const chosen = await deps.forms.request({
      ...form,
      title: 'Printers and scanners',
      description: 'Add another machine, or change one that is already set up.',
      template: 'printers:choose',
      fields: [
        {
          name: 'device',
          label: 'Which one',
          type: 'select',
          options: [ADD, ...devices.map((d) => `${d.name}${d.enabled ? '' : ' (off)'}`)],
          value: ADD,
        },
      ],
    });
    if (!chosen.submitted) return { submitted: false, reason: chosen.reason };
    const picked = String(chosen.values.device ?? ADD).replace(/ \(off\)$/, '');
    target = devices.find((d) => d.name === picked) ?? null;
  }

  return target ? await editDevice(deps, form, target) : await addDevice(deps, form, devices);
}

async function addDevice(
  deps: PrinterSetupDeps,
  form: { runId: string; conversationId: string },
  devices: Device[],
): Promise<WizardOutcome> {
  // Discovery before the form, not after: the whole point is that the user
  // picks their printer off a list instead of reading an IP off an LCD.
  let found: Discovered[] = [];
  try {
    const result = await (deps.discover ?? discover)({
      fetchFor: () => deps.fetch ?? deviceFetch({}),
    });
    found = result.found.filter((d) => !devices.some((known) => known.host === d.host));
  } catch (e) {
    l.warn({ err: errMessage(e) }, 'discovery failed; falling back to a typed address');
  }

  const submission = await deps.forms.request({
    ...form,
    title: 'Add a printer or scanner',
    description: found.length
      ? `Found ${found.length} on the network.`
      : 'Nothing answered on the network, so type the address the device shows on its own display.',
    template: 'printers:add',
    fields: addFields(found),
  });
  if (!submission.submitted) return { submitted: false, reason: submission.reason };

  const typed = String(submission.values.address ?? '').trim();
  const chosen = String(submission.values.found ?? '');
  const fromList = found.find((d) => `${d.label} — ${d.host}` === chosen);
  const address = typed || fromList?.host || '';
  if (!address) {
    return {
      submitted: true,
      added: false,
      error: 'no_address',
      message: 'no address was given',
    };
  }

  const name = slug(String(submission.values.name ?? '') || fromList?.label || address);
  if (!DEVICE_NAME.test(name)) {
    return {
      submitted: true,
      added: false,
      error: 'bad_device_name',
      message: `"${name}" is not a usable short name — letters, digits and dashes`,
    };
  }
  if (devices.some((d) => d.name === name)) {
    return {
      submitted: true,
      added: false,
      error: 'device_exists',
      message: `there is already a device called ${name}`,
    };
  }

  const probed = await probeDevice(address, deps.fetch ? { fetch: deps.fetch } : {});
  if ('error' in probed) return { submitted: true, added: false, ...probed };

  applyDevice(
    deps,
    {
      name,
      label: probed.label,
      host: probed.host,
      enabled: true,
      probed_at: nowIso(),
      tls_fingerprint_sha256: probed.fingerprint,
      print: probed.print,
      scan: probed.scan,
    },
    name,
    `setup: add printer ${name}`,
  );
  const tools = await deps.reloadIntegrations();
  l.info({ device: name, host: probed.host }, 'device added');
  return {
    submitted: true,
    action: 'added',
    device: name,
    label: probed.label,
    can_print: probed.print !== null,
    can_scan: probed.scan !== null,
    discovered: found.length,
    activated: true,
    tools: tools.filter((t) => t.startsWith('print.')),
  };
}

async function editDevice(
  deps: PrinterSetupDeps,
  form: { runId: string; conversationId: string },
  device: Device,
): Promise<WizardOutcome> {
  const SAVE = 'save changes';
  const submission = await deps.forms.request({
    ...form,
    title: `${device.label || device.name}`,
    description: `Set up at ${device.host}${device.probed_at ? `, last checked ${device.probed_at.slice(0, 10)}` : ''}.`,
    template: 'printers:edit',
    fields: [
      {
        name: 'action',
        label: 'What to do',
        type: 'select',
        options: [SAVE, device.enabled ? 'switch it off' : 'switch it on', 'remove it'],
        value: SAVE,
      },
      {
        name: 'address',
        label: 'Address — changing it re-checks the device',
        type: 'text',
        value: device.host,
      },
      // The key is computed here rather than templated from a form field: the
      // edit form has no `name` field to resolve `{name}` against, and the
      // device it belongs to is already known.
      passwordField(passwordKey(device.name)),
    ],
  });
  if (!submission.submitted) return { submitted: false, reason: submission.reason };

  const action = String(submission.values.action ?? SAVE);
  if (action === 'remove it') {
    applyDevice(deps, null, device.name, `setup: remove printer ${device.name}`);
    await deps.reloadIntegrations();
    l.info({ device: device.name }, 'device removed');
    return {
      submitted: true,
      action: 'removed',
      device: device.name,
      // Same reasoning as deactivation (§19.6): the credential outlives the
      // record, so putting it back is one form rather than a hunt.
      secret_retained: true,
    };
  }
  if (action === 'switch it off' || action === 'switch it on') {
    const enabled = action === 'switch it on';
    applyDevice(
      deps,
      { ...device, enabled },
      device.name,
      `setup: ${enabled ? 'enable' : 'disable'} printer ${device.name}`,
    );
    await deps.reloadIntegrations();
    return {
      submitted: true,
      action: enabled ? 'enabled' : 'disabled',
      device: device.name,
    };
  }

  const address = String(submission.values.address ?? '').trim() || device.host;
  const probed = await probeDevice(address, deps.fetch ? { fetch: deps.fetch } : {});
  if ('error' in probed) return { submitted: true, updated: false, ...probed };

  applyDevice(
    deps,
    {
      ...device,
      label: probed.label,
      host: probed.host,
      probed_at: nowIso(),
      tls_fingerprint_sha256: probed.fingerprint,
      print: probed.print,
      scan: probed.scan,
    },
    device.name,
    `setup: update printer ${device.name}`,
  );
  await deps.reloadIntegrations();
  l.info({ device: device.name, host: probed.host }, 'device updated');
  return {
    submitted: true,
    action: 'updated',
    device: device.name,
    label: probed.label,
    can_print: probed.print !== null,
    can_scan: probed.scan !== null,
  };
}

/**
 * The `print-scan` activation effect (§19.6). Deliberately the plain, typed
 * address path: the manifest's fields are static, so discovery lives in
 * `setup.printers` where a form can be built around what it found.
 */
export async function activatePrintScan(
  submission: { values: Record<string, string | number>; secrets: Record<string, string> },
  ctx: ActivationContext,
): Promise<Record<string, unknown>> {
  const address = String(submission.values.address ?? '').trim();
  if (!address) {
    return { activated: false, error: 'no_address', message: 'no address was submitted' };
  }
  const name = slug(String(submission.values.name ?? '') || address);
  if (!DEVICE_NAME.test(name)) {
    return {
      activated: false,
      error: 'bad_device_name',
      message: `"${name}" is not a usable short name — letters, digits and dashes`,
    };
  }

  const probed = await probeDevice(address, ctx.fetch ? { fetch: ctx.fetch } : {});
  if ('error' in probed) return { activated: false, ...probed };

  applyDevice(
    ctx,
    {
      name,
      label: probed.label,
      host: probed.host,
      enabled: true,
      probed_at: nowIso(),
      tls_fingerprint_sha256: probed.fingerprint,
      print: probed.print,
      scan: probed.scan,
    },
    name,
    `setup: activate print-scan with ${name}`,
  );
  const tools = await ctx.reloadIntegrations();
  l.info({ device: name, host: probed.host }, 'print-scan activated');
  return {
    activated: true,
    device: name,
    label: probed.label,
    can_print: probed.print !== null,
    can_scan: probed.scan !== null,
    tools: tools.filter((t) => t.startsWith('print.')),
  };
}
