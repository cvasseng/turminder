import { log } from '../../../core/logger.js';
import { errMessage } from '../../../core/errors.js';
import {
  IPP_OPERATION,
  IPP_TAGS,
  all,
  decodeResponse,
  encodeRequest,
  first,
  ippStatusText,
  type IppResponse,
} from './ipp.js';
import { JOB_TIMEOUT_MS, PROBE_TIMEOUT_MS } from './constants.js';

const l = log('tool:print');

/** What one printer told us about itself (§34.1). */
export interface PrinterCapabilities {
  label: string;
  uri: string;
  formats: string[];
  color: boolean;
  sides: string[];
  media: string[];
  media_default: string | null;
  resolution_dpi: number;
}

export interface PrinterState {
  state: 'idle' | 'processing' | 'stopped' | 'unknown';
  state_reasons: string[];
  accepting_jobs: boolean;
  queued_jobs: number;
  supplies: { name: string; level_pct: number; low: boolean }[];
}

export interface JobState {
  job_id: number;
  state: 'pending' | 'processing' | 'completed' | 'canceled' | 'aborted' | 'unknown';
  state_reasons: string[];
  pages_completed: number;
}

export interface PrintOptions {
  copies?: number;
  sides?: string;
  media?: string;
  color?: string;
  title?: string;
}

/** IPP printer-state enum (RFC 8011): 3 idle, 4 processing, 5 stopped. */
function printerState(value: number | null): PrinterState['state'] {
  if (value === 3) return 'idle';
  if (value === 4) return 'processing';
  if (value === 5) return 'stopped';
  return 'unknown';
}

/**
 * IPP job-state enum: 3/4 pending, 5/6 processing, 7 done, 8 canceled, 9 aborted.
 *
 * `reasons` is not decoration. The reference ET-3700 settles a perfectly good
 * print at state 9 — *aborted* — with `job-state-reasons: completed-successfully`,
 * and reporting that as a failure would have the assistant apologise for a page
 * the user is holding. The reasons win when they contradict the enum, because
 * they are the more specific claim.
 */
function jobState(value: number | null, reasons: string[] = []): JobState['state'] {
  if (reasons.some((r) => r.includes('completed-successfully'))) return 'completed';
  if (value === 3 || value === 4) return 'pending';
  if (value === 5 || value === 6) return 'processing';
  if (value === 7) return 'completed';
  if (value === 8) return 'canceled';
  if (value === 9) return 'aborted';
  return 'unknown';
}

export class IppError extends Error {
  constructor(
    readonly code: 'rejected' | 'no_such_job' | 'unreachable',
    message: string,
  ) {
    super(message);
    this.name = 'IppError';
  }
}

export interface PrinterClientOptions {
  /** `ipp://…` or `ipps://…` — the printer's own advertised URI. */
  uri: string;
  fetch: typeof globalThis.fetch;
  timeoutMs?: number;
  /** Stamped on every job so the device's panel says who is printing. */
  user?: string;
  /** IPP basic-auth password from the secret store (§34.1); most need none. */
  password?: string;
}

/**
 * One printer, over IPP (§34.4). Everything here throws `IppError` or a
 * transport error and the tool layer converts — the tools are where
 * `{error, message}` lives, so a client used by discovery and by a tool does
 * not have to guess which shape its caller wants.
 */
export class PrinterClient {
  private requestId = 1;
  private readonly timeoutMs: number;
  private readonly user: string;

  constructor(private readonly opts: PrinterClientOptions) {
    this.timeoutMs = opts.timeoutMs ?? PROBE_TIMEOUT_MS;
    this.user = opts.user ?? 'turminder';
  }

  /**
   * `ipps://host:631/path` is an HTTPS POST to the same place. Built by string
   * surgery rather than by assigning `url.protocol`, which silently does
   * nothing: WHATWG refuses to turn a non-special scheme like `ipp` into a
   * special one like `https`, so the assignment leaves an `ipps:` URL that
   * `fetch` will not touch and the failure looks like an unreachable printer.
   */
  private get endpoint(): string {
    const [scheme, rest] = this.opts.uri.split('://');
    const secure = scheme === 'ipps' || scheme === 'https';
    const [authority = '', ...path] = (rest ?? '').split('/');
    const host = authority.includes(':') ? authority : `${authority}:631`;
    return `${secure ? 'https' : 'http'}://${host}/${path.join('/')}`;
  }

  private async call(
    operation: number,
    extra: {
      operation_attributes?: { tag: number; name: string; value: string | number | boolean }[];
      job_attributes?: { tag: number; name: string; value: string | number | boolean }[];
      document?: Buffer;
      timeoutMs?: number;
    } = {},
  ): Promise<IppResponse> {
    const body = encodeRequest({
      operation,
      requestId: this.requestId++,
      printerUri: this.opts.uri,
      user: this.user,
      ...extra,
    });
    const headers: Record<string, string> = { 'content-type': 'application/ipp' };
    if (this.opts.password) {
      const basic = Buffer.from(`${this.user}:${this.opts.password}`).toString('base64');
      headers.authorization = `Basic ${basic}`;
    }
    const res = await this.opts.fetch(this.endpoint, {
      method: 'POST',
      headers,
      body: new Uint8Array(body),
      signal: AbortSignal.timeout(extra.timeoutMs ?? this.timeoutMs),
    });
    if (!res.ok) {
      // 426 is the one worth naming: the device wants TLS and we came in plain.
      const hint =
        res.status === 426
          ? ' — the printer requires TLS on this port; use an ipps:// address'
          : '';
      throw new IppError('rejected', `the printer answered HTTP ${res.status}${hint}`);
    }
    const decoded = decodeResponse(Buffer.from(await res.arrayBuffer()));
    if (!decoded.ok) {
      if (decoded.statusCode === 0x0405) throw new IppError('no_such_job', 'no such job');
      throw new IppError('rejected', ippStatusText(decoded.statusCode));
    }
    return decoded;
  }

  async capabilities(): Promise<PrinterCapabilities> {
    const res = await this.call(IPP_OPERATION.getPrinterAttributes);
    const resolution = first(res, 'printer-resolution-default');
    return {
      label: String(
        first(res, 'printer-make-and-model') ?? first(res, 'printer-name') ?? 'printer',
      ),
      uri: this.opts.uri,
      formats: all(res, 'document-format-supported'),
      color: first(res, 'color-supported') === true,
      sides: all(res, 'sides-supported'),
      media: all(res, 'media-supported'),
      media_default: first(res, 'media-ready')
        ? String(first(res, 'media-ready'))
        : first(res, 'media-default')
          ? String(first(res, 'media-default'))
          : null,
      // 300 is the safe floor: every printer renders it and it is what the
      // eSCL side calls "document quality" too.
      resolution_dpi: typeof resolution === 'number' && resolution > 0 ? resolution : 300,
    };
  }

  async state(): Promise<PrinterState> {
    const res = await this.call(IPP_OPERATION.getPrinterAttributes);
    const names = all(res, 'marker-names');
    const levels = all(res, 'marker-levels');
    const low = all(res, 'marker-low-levels');
    return {
      state: printerState(first(res, 'printer-state') as number | null),
      state_reasons: all(res, 'printer-state-reasons'),
      accepting_jobs: first(res, 'printer-is-accepting-jobs') === true,
      queued_jobs: Number(first(res, 'queued-job-count') ?? 0),
      supplies: names.map((name, i) => {
        const level = Number(levels[i] ?? -1);
        const threshold = Number(low[i] ?? 10);
        return { name, level_pct: level, low: level >= 0 && level <= threshold };
      }),
    };
  }

  /** Submit one document. The printer answers with the job it created. */
  async print(
    document: Buffer,
    format: string,
    options: PrintOptions = {},
  ): Promise<{ job_id: number; state: JobState['state'] }> {
    const job: { tag: number; name: string; value: string | number | boolean }[] = [];
    if (options.copies && options.copies > 1) {
      job.push({ tag: IPP_TAGS.integer, name: 'copies', value: options.copies });
    }
    if (options.sides) job.push({ tag: IPP_TAGS.keyword, name: 'sides', value: options.sides });
    if (options.media) job.push({ tag: IPP_TAGS.keyword, name: 'media', value: options.media });
    if (options.color) {
      job.push({ tag: IPP_TAGS.keyword, name: 'print-color-mode', value: options.color });
    }

    const res = await this.call(IPP_OPERATION.printJob, {
      operation_attributes: [
        { tag: IPP_TAGS.mimeMediaType, name: 'document-format', value: format },
        {
          tag: IPP_TAGS.nameWithoutLanguage,
          name: 'job-name',
          value: (options.title ?? 'Turminder').slice(0, 120),
        },
      ],
      job_attributes: job,
      document,
      // Sending a document is not a metadata call: a big raster over wifi to a
      // printer that is warming up takes far longer than the probe budget.
      timeoutMs: JOB_TIMEOUT_MS,
    });
    const jobId = Number(first(res, 'job-id') ?? 0);
    l.info({ job: jobId, format, bytes: document.length }, 'print job submitted');
    return {
      job_id: jobId,
      state: jobState(first(res, 'job-state') as number | null, all(res, 'job-state-reasons')),
    };
  }

  async job(jobId: number): Promise<JobState> {
    const res = await this.call(IPP_OPERATION.getJobAttributes, {
      operation_attributes: [{ tag: IPP_TAGS.integer, name: 'job-id', value: jobId }],
    });
    const reasons = all(res, 'job-state-reasons');
    return {
      job_id: jobId,
      state: jobState(first(res, 'job-state') as number | null, reasons),
      state_reasons: reasons,
      pages_completed: Number(first(res, 'job-impressions-completed') ?? 0),
    };
  }

  async cancel(jobId: number): Promise<void> {
    await this.call(IPP_OPERATION.cancelJob, {
      operation_attributes: [{ tag: IPP_TAGS.integer, name: 'job-id', value: jobId }],
    });
    l.info({ job: jobId }, 'print job cancelled');
  }
}

/**
 * Is this address a printer? Discovery's confirmation step (§34.3): an open
 * port proves nothing, an IPP answer proves everything. Returns null rather
 * than throwing, because "no" is the expected answer for most of a subnet.
 */
export async function probePrinter(
  uri: string,
  fetchImpl: typeof globalThis.fetch,
  timeoutMs = PROBE_TIMEOUT_MS,
): Promise<PrinterCapabilities | null> {
  try {
    return await new PrinterClient({ uri, fetch: fetchImpl, timeoutMs }).capabilities();
  } catch (e) {
    l.debug({ uri, err: errMessage(e) }, 'not an ipp printer');
    return null;
  }
}
