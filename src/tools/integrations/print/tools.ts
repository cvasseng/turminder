import fs from 'node:fs';
import { z } from 'zod';
import { log } from '../../../core/logger.js';
import { errMessage } from '../../../core/errors.js';
import type { SystoolRegistry } from '../../../core/systools.js';
import { mimeForPath, type FileStore } from '../../../files/store.js';
import { PathRejected } from '../../paths.js';
import type { ConfirmLines, ToolDefinition } from '../../types.js';
import type { MetaRepo } from '../../../db/repos/meta.js';
import { STATUS_CACHE_MS } from './constants.js';
import { CertificateChanged, deviceFetch } from './transport.js';
import { IppError } from './printer.js';
import { EsclError, type ScanColor, type ScanFormat, type ScanSource } from './escl.js';
import { prepare, parsePages, type PageRange } from './convert.js';
import {
  printerFor,
  resolveDevice,
  scannerFor,
  type Device,
  type DeviceResolution,
  type PrintScanSettings,
} from './devices.js';
import { discover } from './discover.js';

const l = log('tool:print');

export interface PrintToolsDeps {
  /** Read at call time: `setup.printers` can add a device mid-conversation. */
  settings: () => PrintScanSettings;
  files: FileStore;
  meta: MetaRepo;
  systools: SystoolRegistry;
  /** A device's IPP password, by key — never the whole store (§27). */
  secret?: (key: string) => string | undefined;
  /** Substituted whole in tests; the default pins each device's certificate. */
  fetch?: typeof globalThis.fetch;
  now?: () => Date;
}

interface Failure {
  error: string;
  message: string;
  [k: string]: unknown;
}

/**
 * Device errors as return values (rule 2). Everything below the tools throws —
 * the clients are shared with discovery, which wants exceptions — and this is
 * the one place that turns a throw into something a model can read and act on.
 */
function asFailure(e: unknown): Failure {
  if (e instanceof CertificateChanged) {
    return {
      error: 'certificate_changed',
      message:
        'the device presented a different certificate than the one recorded when it was added; nothing was sent',
      expected: e.expected,
      seen: e.seen,
      hint: 'if the printer was reset or replaced, add it again in setup — that records the new certificate',
    };
  }
  if (e instanceof IppError) return { error: e.code, message: e.message };
  if (e instanceof EsclError) {
    return { error: e.code === 'busy' ? 'scanner_busy' : e.code, message: e.message };
  }
  if (e instanceof PathRejected) return { error: 'path_rejected', message: e.reason };
  return { error: 'unreachable', message: errMessage(e) };
}

/** Everything a tool needs about the device it was pointed at, or the refusal. */
function pick(deps: PrintToolsDeps, name?: string): DeviceResolution {
  return resolveDevice(deps.settings().devices, name);
}

function summarise(device: Device): Record<string, unknown> {
  return {
    name: device.name,
    label: device.label || device.name,
    host: device.host,
    enabled: device.enabled,
    can_print: device.print !== null,
    can_scan: device.scan !== null,
    print: device.print
      ? {
          formats: device.print.formats,
          color: device.print.color,
          sides: device.print.sides,
          media: device.print.media,
          media_default: device.print.media_default,
          resolution_dpi: device.print.resolution_dpi,
        }
      : null,
    scan: device.scan
      ? {
          sources: device.scan.sources,
          formats: device.scan.formats,
          resolutions_dpi: device.scan.resolutions_dpi,
          color_modes: device.scan.color_modes,
        }
      : null,
    probed_at: device.probed_at ?? null,
  };
}

/**
 * Is the other half of this machine already working (§34.4)?
 *
 * A printer/scanner is one mechanism, and the firmware does not defend itself:
 * starting a scan while a page is printing **aborts the print**, mid-sheet,
 * with no complaint from the device. So the caller has to ask first — and ask
 * the right half, because on a shared engine eSCL's `State` reads
 * `Processing` whenever the *printer* is busy. Only the scan job list
 * distinguishes "someone is scanning" from "someone is printing", and only IPP
 * is authoritative about printing.
 *
 * A probe that fails is not a refusal: being unable to ask is a worse reason
 * to refuse work than the small risk it was trying to avoid.
 */
async function busyWith(
  device: Device,
  deps: PrintToolsDeps,
  clientDeps: () => {
    fetch?: typeof globalThis.fetch;
    secret?: (k: string) => string | undefined;
  },
  side: 'printing' | 'scanning',
): Promise<Failure | null> {
  try {
    if (side === 'printing') {
      const printer = printerFor(device, clientDeps());
      if (!printer) return null;
      const state = await printer.state();
      if (state.state === 'processing' || state.queued_jobs > 0) {
        return {
          error: 'device_busy',
          message: `${device.name} is printing right now, and starting a scan would abort the page mid-sheet — try again when it has finished`,
          busy_with: 'printing',
          queued_jobs: state.queued_jobs,
        };
      }
      return null;
    }
    const scanner = scannerFor(device, clientDeps());
    if (!scanner) return null;
    const status = await scanner.status();
    if (status.scanning) {
      return {
        error: 'device_busy',
        message: `${device.name} is scanning right now — printing would interrupt it`,
        busy_with: 'scanning',
      };
    }
    return null;
  } catch (e) {
    l.debug({ device: device.name, side, err: errMessage(e) }, 'busy check failed; continuing');
    return null;
  }
}

/** A scan's default resting place: dated, so a year of them still sorts. */
function scanPath(settings: PrintScanSettings, format: ScanFormat, at: Date): string {
  const stamp = at.toISOString().replace(/[:.]/g, '-').slice(0, 19);
  return `${settings.scan_dir.replace(/\/+$/, '')}/${stamp}-scan.${format === 'pdf' ? 'pdf' : 'jpg'}`;
}

export function printTools(deps: PrintToolsDeps): ToolDefinition[] {
  const now = deps.now ?? (() => new Date());
  const clientDeps = () => ({
    ...(deps.fetch ? { fetch: deps.fetch } : {}),
    ...(deps.secret ? { secret: deps.secret } : {}),
  });

  return [
    {
      name: 'print.devices',
      description:
        'List the printers and scanners this assistant is set up to use, and what each one can do — formats, paper sizes, scan resolutions. Use it before printing or scanning when more than one machine might be meant. This is the recorded answer from when each device was added, not a live check; print.status asks the machine itself.',
      tier: 'ro',
      isEmpty: (result) => ((result as { devices?: unknown[] }).devices ?? []).length === 0,
      args: z.object({}),
      async execute() {
        const devices = deps.settings().devices;
        return {
          devices: devices.map(summarise),
          ...(devices.length
            ? {}
            : { note: 'nothing is set up yet — setup.printers finds and adds a device' }),
        };
      },
    },
    {
      name: 'print.status',
      description:
        'Ask a printer or scanner how it is right now: whether it answers, whether it is idle or busy, whether it is accepting jobs, and how much ink or toner is left. Use it when a print did not appear, or when the user asks whether the printer is out of ink.',
      tier: 'ro',
      args: z.object({
        device: z.string().optional().describe('device name; omit when only one is configured'),
      }),
      async execute(args: { device?: string }) {
        const picked = pick(deps, args.device);
        if ('error' in picked) return picked;
        const device = picked.device;

        const cacheKey = `print:status:${device.name}`;
        const cached = deps.meta.json<{ at: number; value: Record<string, unknown> } | null>(
          cacheKey,
          null,
        );
        if (cached && now().getTime() - cached.at < STATUS_CACHE_MS) return cached.value;

        const printer = printerFor(device, clientDeps());
        const scanner = scannerFor(device, clientDeps());
        try {
          const state = printer ? await printer.state() : null;
          const scannerState = scanner ? (await scanner.status()).state : null;
          const value = {
            device: device.name,
            reachable: true,
            ...(state
              ? {
                  state: state.state,
                  state_reasons: state.state_reasons,
                  accepting_jobs: state.accepting_jobs,
                  queued_jobs: state.queued_jobs,
                  supplies: state.supplies,
                }
              : {}),
            ...(scannerState ? { scanner_state: scannerState } : {}),
          };
          deps.meta.setJson(cacheKey, { at: now().getTime(), value });
          return value;
        } catch (e) {
          return { device: device.name, reachable: false, ...asFailure(e) };
        }
      },
    },
    {
      name: 'print.document',
      description:
        'Print a file from the shared workspace on a network printer. Print a PDF or an image, never a source file: render notes, markdown and anything else you wrote as text with docs.to_pdf first, or the printer produces a page of raw characters. PDFs are converted automatically for printers that cannot read PDF. Say which device when more than one is set up.',
      tier: 'se',
      args: z.object({
        path: z
          .string()
          .min(1)
          .describe('workspace path of the file to print, e.g. notes/lease.pdf'),
        device: z.string().optional().describe('device name; omit when only one is configured'),
        copies: z.number().int().min(1).max(99).optional(),
        sides: z
          .enum(['one-sided', 'two-sided-long-edge', 'two-sided-short-edge'])
          .optional()
          .describe('only values the device listed in print.devices'),
        media: z
          .string()
          .optional()
          .describe('a paper size the device listed, e.g. iso_a4_210x297mm'),
        color: z.enum(['color', 'monochrome']).optional(),
        pages: z.string().optional().describe('PDF only: one page ("3") or a range ("2-7")'),
        title: z.string().optional().describe("the job name shown on the printer's panel"),
      }),
      confirmSummary(args: {
        path: string;
        device?: string;
        copies?: number;
        pages?: string;
      }): ConfirmLines {
        return {
          action: `print ${args.path}`,
          lines: [
            { label: 'File', value: args.path },
            { label: 'Printer', value: args.device ?? 'the configured printer' },
            { label: 'Copies', value: String(args.copies ?? 1) },
            ...(args.pages ? [{ label: 'Pages', value: args.pages }] : []),
          ],
        };
      },
      async execute(args: {
        path: string;
        device?: string;
        copies?: number;
        sides?: string;
        media?: string;
        color?: string;
        pages?: string;
        title?: string;
      }) {
        const picked = pick(deps, args.device);
        if ('error' in picked) return picked;
        const device = picked.device;
        if (!device.print) {
          return { error: 'no_printer', message: `${device.name} cannot print` };
        }

        const range = parsePages(args.pages);
        if (range && 'error' in range) return { error: 'bad_args', message: range.error };

        let document: Buffer;
        try {
          const abs = deps.files.resolve(args.path);
          if (fs.statSync(abs).isDirectory()) {
            return { error: 'is_directory', message: `${args.path} is a directory` };
          }
          document = fs.readFileSync(abs);
        } catch (e) {
          if (e instanceof PathRejected) return { error: 'path_rejected', message: e.reason };
          return { error: 'not_found', message: `${args.path} is not in the workspace` };
        }

        const payload = await prepare(
          document,
          mimeForPath(args.path),
          device.print.formats,
          device.print.resolution_dpi,
          { systools: deps.systools },
          (range as PageRange | null) ?? undefined,
        );
        if ('error' in payload) return payload;

        const busy = await busyWith(device, deps, clientDeps, 'scanning');
        if (busy) return busy;

        const printer = printerFor(device, clientDeps())!;
        const jobs: { job_id: number; state: string }[] = [];
        try {
          for (const [index, doc] of payload.documents.entries()) {
            const title =
              payload.documents.length > 1
                ? `${args.title ?? args.path} (${index + 1}/${payload.documents.length})`
                : (args.title ?? args.path);
            jobs.push(
              await printer.print(doc, payload.format, {
                ...(args.copies ? { copies: args.copies } : {}),
                ...(args.sides ? { sides: args.sides } : {}),
                ...(args.media ? { media: args.media } : {}),
                ...(args.color ? { color: args.color } : {}),
                title,
              }),
            );
          }
        } catch (e) {
          // Partial success is the truth when page three of five is refused:
          // the first two are already coming out of the machine.
          const failure = asFailure(e);
          return jobs.length
            ? { ...failure, device: device.name, jobs, partial: true }
            : failure;
        }

        return {
          device: device.name,
          jobs,
          pages: payload.pages,
          format: payload.format,
          converted: payload.converted,
          ...(jobs.length > 1
            ? { note: `${jobs.length} jobs — this printer takes one page per job` }
            : {}),
        };
      },
    },
    {
      name: 'print.job',
      description:
        'How a print job is doing. Printers forget finished jobs quickly, so "no such job" usually means it finished, not that it failed.',
      tier: 'ro',
      args: z.object({
        job_id: z.number().int().positive(),
        device: z.string().optional(),
      }),
      async execute(args: { job_id: number; device?: string }) {
        const picked = pick(deps, args.device);
        if ('error' in picked) return picked;
        const printer = printerFor(picked.device, clientDeps());
        if (!printer)
          return { error: 'no_printer', message: `${picked.device.name} cannot print` };
        try {
          return { device: picked.device.name, ...(await printer.job(args.job_id)) };
        } catch (e) {
          return asFailure(e);
        }
      },
    },
    {
      name: 'print.cancel_job',
      description:
        'Stop a print job that has not finished. Use it when the wrong thing, or too much of it, is being printed.',
      tier: 'se',
      args: z.object({
        job_id: z.number().int().positive(),
        device: z.string().optional(),
      }),
      async execute(args: { job_id: number; device?: string }) {
        const picked = pick(deps, args.device);
        if ('error' in picked) return picked;
        const printer = printerFor(picked.device, clientDeps());
        if (!printer)
          return { error: 'no_printer', message: `${picked.device.name} cannot print` };
        try {
          await printer.cancel(args.job_id);
          return { device: picked.device.name, job_id: args.job_id, cancelled: true };
        } catch (e) {
          const failure = asFailure(e);
          // A job the printer has already finished is not cancellable, and it
          // reports that the same way as a job that never existed.
          if (failure.error === 'rejected') {
            return { error: 'not_cancellable', message: failure.message, job_id: args.job_id };
          }
          return failure;
        }
      },
    },
    {
      name: 'print.scan',
      description:
        'Scan whatever is on the scanner right now and save it into the shared workspace. The user has to have put the page on the glass or in the feeder first — say so if you are not sure they have. The result is a file path; there is no text extraction, so a scan cannot be read back yet. Ask for PDF only if the user wants one document out of a stack of pages — some devices advertise PDF and then never produce it.',
      tier: 'se',
      args: z.object({
        device: z.string().optional(),
        source: z
          .enum(['platen', 'adf'])
          .optional()
          .describe('platen = the glass; adf = the feeder'),
        resolution_dpi: z.number().int().min(75).max(1200).optional(),
        color: z.enum(['color', 'gray', 'bw']).optional(),
        format: z
          .enum(['pdf', 'jpeg'])
          .optional()
          .describe('jpeg is the default because more devices actually deliver it'),
        path: z
          .string()
          .optional()
          .describe('where to save it; omit for a dated name in the scans folder'),
        message: z.string().optional().describe('git commit message'),
      }),
      confirmSummary(args: { device?: string; source?: string }): ConfirmLines {
        return {
          action: 'scan the page on the scanner',
          lines: [
            { label: 'Scanner', value: args.device ?? 'the configured scanner' },
            { label: 'From', value: args.source === 'adf' ? 'the feeder' : 'the glass' },
          ],
        };
      },
      async execute(args: {
        device?: string;
        source?: ScanSource;
        resolution_dpi?: number;
        color?: ScanColor;
        format?: ScanFormat;
        path?: string;
        message?: string;
      }) {
        const picked = pick(deps, args.device);
        if ('error' in picked) return picked;
        const device = picked.device;
        if (!device.scan) return { error: 'no_scanner', message: `${device.name} cannot scan` };

        const settings = deps.settings();
        const source =
          args.source ?? (device.scan.sources.includes('platen') ? 'platen' : 'adf');
        const format = args.format ?? 'jpeg';
        const resolution = args.resolution_dpi ?? 300;
        const supported = {
          sources: device.scan.sources,
          formats: device.scan.formats,
          resolutions_dpi: device.scan.resolutions_dpi,
        };
        if (device.scan.sources.length && !device.scan.sources.includes(source)) {
          return {
            error: 'unsupported_setting',
            message: `${device.name} has no ${source === 'adf' ? 'document feeder' : 'flatbed'}`,
            supported,
          };
        }
        const wanted = format === 'pdf' ? 'application/pdf' : 'image/jpeg';
        if (device.scan.formats.length && !device.scan.formats.includes(wanted)) {
          return {
            error: 'unsupported_setting',
            message: `${device.name} does not scan to ${format.toUpperCase()}`,
            supported,
          };
        }
        if (
          device.scan.resolutions_dpi.length &&
          !device.scan.resolutions_dpi.includes(resolution)
        ) {
          return {
            error: 'unsupported_setting',
            message: `${device.name} scans at ${device.scan.resolutions_dpi.join(', ')} dpi`,
            supported,
          };
        }

        const busy = await busyWith(device, deps, clientDeps, 'printing');
        if (busy) return busy;

        const scanner = scannerFor(device, clientDeps())!;
        let result;
        try {
          result = await scanner.scan({
            source,
            resolution_dpi: resolution,
            color: args.color ?? 'color',
            format,
          });
        } catch (e) {
          return asFailure(e);
        }

        // Several JPEGs out of a feeder are several files; a PDF is one however
        // many sheets went through it.
        const base = args.path ?? scanPath(settings, format, now());
        const written: { path: string; bytes: number }[] = [];
        try {
          for (const [index, page] of result.pages.entries()) {
            const target =
              result.pages.length > 1
                ? base.replace(/(\.[^./]+)$/, `-${String(index + 1).padStart(2, '0')}$1`)
                : base;
            const saved = deps.files.writeBinary(
              target,
              page,
              args.message ?? `scan: ${target} from ${device.name}`,
            );
            written.push({ path: saved.path, bytes: saved.bytes });
          }
        } catch (e) {
          return asFailure(e);
        }
        l.info({ device: device.name, pages: written.length }, 'scan saved to the workspace');
        return {
          device: device.name,
          path: written[0]!.path,
          ...(written.length > 1 ? { paths: written.map((w) => w.path) } : {}),
          mime: result.mime,
          bytes: written.reduce((sum, w) => sum + w.bytes, 0),
          pages: result.pages.length,
          committed: true,
          note: 'saved as an image — its text is not readable yet',
        };
      },
    },
    {
      name: 'print.discover',
      description:
        'Look for printers and scanners on the local network. Use it when the user asks what is out there, or when a device they expect is missing. It only looks; setup.printers is what adds one. On a network without mDNS this falls back to scanning the local subnet and can take up to half a minute.',
      tier: 'ro',
      isEmpty: (result) => ((result as { found?: unknown[] }).found ?? []).length === 0,
      args: z.object({}),
      async execute() {
        const configured = deps.settings().devices;
        try {
          const result = await discover({
            fetchFor: () => deps.fetch ?? deviceFetch({}),
          });
          return {
            method: result.method,
            found: result.found.map((d) => ({
              label: d.label,
              host: d.host,
              uris: [d.print?.uri, d.scan?.uri].filter(Boolean),
              can_print: d.print !== null,
              can_scan: d.scan !== null,
              ...(() => {
                const known = configured.find((c) => c.host === d.host);
                return known ? { configured_as: known.name } : {};
              })(),
            })),
            note: 'setup.printers adds one of these — it shows the user a form first',
          };
        } catch (e) {
          return { error: 'discovery_failed', message: errMessage(e) };
        }
      },
    },
  ];
}
