import { log } from '../../../core/logger.js';
import { errMessage } from '../../../core/errors.js';
import { PROBE_TIMEOUT_MS, SCAN_TIMEOUT_MS } from './constants.js';

const l = log('tool:print');

/**
 * eSCL (AirScan/Mopria scan), by hand (§34.5). It is a small REST protocol
 * with XML bodies: ask for capabilities, POST a job, then pull documents off
 * it until the device says there are no more.
 *
 * The XML is read with regular expressions rather than `cheerio`, and that is
 * a considered choice, not laziness: the documents are machine-generated, flat,
 * and namespaced (`scan:` / `pwg:`), and what we want out of them is a dozen
 * leaf values. Parsing them as a DOM would buy nothing and would put an HTML
 * parser in the path of a scanner.
 */

export interface ScannerCapabilities {
  label: string;
  uri: string;
  /** `platen` (flatbed) and/or `adf` (document feeder). */
  sources: string[];
  formats: string[];
  resolutions_dpi: number[];
  color_modes: string[];
}

export interface ScannerStatus {
  state: 'idle' | 'processing' | 'testing' | 'stopped' | 'unknown';
  /**
   * A scan job is actually running — which is a different question from
   * `state`. On a device where one mechanism does both jobs, `State` reads
   * `Processing` while the *printer* prints, so only the job list can tell
   * "somebody is scanning" from "somebody is printing" (§34.4).
   */
  scanning: boolean;
}

export type ScanSource = 'platen' | 'adf';
export type ScanColor = 'color' | 'gray' | 'bw';
export type ScanFormat = 'pdf' | 'jpeg';

export interface ScanRequest {
  source: ScanSource;
  resolution_dpi: number;
  color: ScanColor;
  format: ScanFormat;
}

export class EsclError extends Error {
  constructor(
    readonly code: 'busy' | 'rejected' | 'no_documents',
    message: string,
  ) {
    super(message);
    this.name = 'EsclError';
  }
}

/** Every value of a repeated leaf element, namespace prefix ignored. */
function leaves(xml: string, local: string): string[] {
  const re = new RegExp(`<(?:\\w+:)?${local}(?:\\s[^>]*)?>([^<]*)</(?:\\w+:)?${local}>`, 'g');
  return [...xml.matchAll(re)].map((m) => m[1]!.trim()).filter(Boolean);
}

function leaf(xml: string, local: string): string | null {
  return leaves(xml, local)[0] ?? null;
}

/** The `<scan:Adf>` / `<scan:Platen>` blocks say which sources exist. */
function sourcesOf(xml: string): string[] {
  const found: string[] = [];
  if (/<(?:\w+:)?PlatenInputCaps/.test(xml)) found.push('platen');
  if (/<(?:\w+:)?AdfSimplexInputCaps|<(?:\w+:)?AdfDuplexInputCaps/.test(xml)) found.push('adf');
  return found;
}

const COLOR_MODE: Record<ScanColor, string> = {
  color: 'RGB24',
  gray: 'Grayscale8',
  bw: 'BlackAndWhite1',
};

const MIME: Record<ScanFormat, string> = {
  pdf: 'application/pdf',
  jpeg: 'image/jpeg',
};

const INPUT_SOURCE: Record<ScanSource, string> = { platen: 'Platen', adf: 'Feeder' };

export interface ScannerClientOptions {
  /** The eSCL root, e.g. `https://192.168.0.90/eSCL`. */
  uri: string;
  fetch: typeof globalThis.fetch;
  timeoutMs?: number;
}

export class ScannerClient {
  private readonly timeoutMs: number;

  constructor(private readonly opts: ScannerClientOptions) {
    this.timeoutMs = opts.timeoutMs ?? PROBE_TIMEOUT_MS;
  }

  private url(path: string): string {
    return `${this.opts.uri.replace(/\/+$/, '')}${path}`;
  }

  async capabilities(): Promise<ScannerCapabilities> {
    const res = await this.opts.fetch(this.url('/ScannerCapabilities'), {
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!res.ok) throw new EsclError('rejected', `the scanner answered HTTP ${res.status}`);
    const xml = await res.text();
    const resolutions = [...new Set(leaves(xml, 'XResolution').map(Number))]
      .filter((n) => Number.isFinite(n) && n > 0)
      .sort((a, b) => a - b);
    return {
      label: leaf(xml, 'MakeAndModel') ?? 'scanner',
      uri: this.opts.uri,
      sources: sourcesOf(xml),
      formats: [
        ...new Set(leaves(xml, 'DocumentFormat').concat(leaves(xml, 'DocumentFormatExt'))),
      ],
      resolutions_dpi: resolutions,
      color_modes: [...new Set(leaves(xml, 'ColorMode'))],
    };
  }

  async status(): Promise<ScannerStatus> {
    const res = await this.opts.fetch(this.url('/ScannerStatus'), {
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!res.ok) throw new EsclError('rejected', `the scanner answered HTTP ${res.status}`);
    const xml = await res.text();
    const state = (leaf(xml, 'State') ?? '').toLowerCase();
    const scanning = leaves(xml, 'JobState').some((s) => s.toLowerCase() === 'processing');
    if (
      state === 'idle' ||
      state === 'processing' ||
      state === 'testing' ||
      state === 'stopped'
    ) {
      return { state, scanning };
    }
    return { state: 'unknown', scanning };
  }

  /**
   * Run one scan and return the pages the device produced. A PDF job is one
   * document however many sheets went through the feeder; a JPEG job is one
   * per sheet, which is why this returns a list either way.
   */
  async scan(request: ScanRequest): Promise<{ mime: string; pages: Buffer[] }> {
    // Deliberately the *minimal* body, and the shape is not a guess: the
    // reference ET-3700 answers 201 to this one and 409 Conflict to the
    // fuller sane-airscan shape with explicit `ScanRegions`. Whole scan area,
    // no region, no `DocumentFormatExt` — every element here has come back
    // from a real device with a real page attached.
    const settings =
      `<?xml version="1.0" encoding="UTF-8"?>` +
      `<scan:ScanSettings xmlns:scan="http://schemas.hp.com/imaging/escl/2011/05/03" ` +
      `xmlns:pwg="http://www.pwg.org/schemas/2010/12/sm">` +
      `<pwg:Version>2.63</pwg:Version>` +
      `<scan:Intent>Document</scan:Intent>` +
      `<pwg:InputSource>${INPUT_SOURCE[request.source]}</pwg:InputSource>` +
      `<scan:ColorMode>${COLOR_MODE[request.color]}</scan:ColorMode>` +
      `<pwg:DocumentFormat>${MIME[request.format]}</pwg:DocumentFormat>` +
      `<scan:XResolution>${request.resolution_dpi}</scan:XResolution>` +
      `<scan:YResolution>${request.resolution_dpi}</scan:YResolution>` +
      `</scan:ScanSettings>`;

    const created = await this.opts.fetch(this.url('/ScanJobs'), {
      method: 'POST',
      headers: { 'content-type': 'text/xml' },
      body: settings,
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (created.status === 409 || created.status === 503) {
      throw new EsclError('busy', 'the scanner is busy with another job');
    }
    if (created.status !== 201) {
      throw new EsclError('rejected', `the scanner refused the job (HTTP ${created.status})`);
    }
    /*
     * The job lives at the Location header — but only its *path* is the
     * device's to decide. Everything else is ours, and that is not fastidiousness:
     * the reference ET-3700 serves eSCL over HTTPS on 443 and then answers a
     * successful POST with `Location: http://…`, plain, port 80, where `/eSCL`
     * is a 404. A client that trusts that URL pulls the page over a scheme the
     * scanner does not serve, never gets it, and leaves a job the firmware will
     * not release — which is how this device ends up wedged.
     *
     * §34.2 already forbids being walked down from HTTPS to HTTP by something
     * a device said. This is that rule applied to a `Location` rather than to a
     * redirect: take the path, keep our own origin, and a lying header costs
     * nothing.
     */
    const location = created.headers.get('location');
    if (!location)
      throw new EsclError('rejected', 'the scanner created a job with no location');
    let jobPath: string;
    try {
      jobPath = location.startsWith('http') ? new URL(location).pathname : location;
    } catch {
      throw new EsclError('rejected', `the scanner named its job unusably: ${location}`);
    }
    const job = `${new URL(this.opts.uri).origin}${jobPath.replace(/\/+$/, '')}`;

    const pages: Buffer[] = [];
    try {
      // A finished feeder answers 404 to the next pull — that is the protocol's
      // "no more pages", not an error. Bounded so a device that answers 200 with
      // nothing forever cannot hold the run open.
      for (let page = 0; page < 100; page++) {
        const next = await this.opts.fetch(`${job}/NextDocument`, {
          signal: AbortSignal.timeout(SCAN_TIMEOUT_MS),
        });
        if (next.status === 404) break;
        if (!next.ok) {
          throw new EsclError('rejected', `page ${page + 1} failed (HTTP ${next.status})`);
        }
        const bytes = Buffer.from(await next.arrayBuffer());
        if (!bytes.length) break;
        pages.push(bytes);
        // A flatbed has exactly one page and some devices never answer 404 for
        // it; asking twice makes them re-scan, which is worse than stopping.
        if (request.source === 'platen') break;
      }
    } finally {
      // Always, not only on failure. A platen job is *not* closed by taking
      // its one page: the reference ET-3700 keeps it open, stays in
      // `Processing`, and refuses the next scan with a 409 until the job is
      // released — and a job abandoned mid-scan wedges it until the machine
      // is power-cycled. Both were seen; one DELETE settles both. Best
      // effort, and never allowed to replace whatever brought us here.
      try {
        await this.opts.fetch(job, {
          method: 'DELETE',
          signal: AbortSignal.timeout(this.timeoutMs),
        });
      } catch (e) {
        l.warn({ job, err: errMessage(e) }, 'could not release the scan job');
      }
    }
    if (!pages.length) throw new EsclError('no_documents', 'the scanner produced no pages');
    l.info({ pages: pages.length, format: request.format }, 'scan complete');
    return { mime: MIME[request.format], pages };
  }
}

/** Discovery's confirmation step for the scan half (§34.3). */
export async function probeScanner(
  uri: string,
  fetchImpl: typeof globalThis.fetch,
  timeoutMs = PROBE_TIMEOUT_MS,
): Promise<ScannerCapabilities | null> {
  try {
    const caps = await new ScannerClient({ uri, fetch: fetchImpl, timeoutMs }).capabilities();
    return caps.sources.length ? caps : null;
  } catch (e) {
    l.debug({ uri, err: errMessage(e) }, 'not an escl scanner');
    return null;
  }
}
