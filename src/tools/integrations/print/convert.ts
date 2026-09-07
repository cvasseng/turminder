import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { log } from '../../../core/logger.js';
import type { SystoolMissing, SystoolRegistry } from '../../../core/systools.js';
import { MAX_PAGES } from './constants.js';

const l = log('tool:print');
const run = promisify(execFile);

/**
 * Getting a document into a format the printer will accept (§34.4).
 *
 * This exists because "every printer takes PDF" is false and comfortably so:
 * the reference ET-3700 advertises `image/urf, image/pwg-raster, image/jpeg`
 * and `pdf-versions-supported: none`, which is the ordinary shape for a
 * consumer inkjet — PDF rendering has always happened on the phone.
 */

export interface PrintPayload {
  /** One entry per IPP job. Usually one; one per page after conversion. */
  documents: Buffer[];
  format: string;
  converted: boolean;
  pages: number;
}

export type ConversionFailure =
  | SystoolMissing
  | { error: 'format_unsupported'; message: string; supported: string[] }
  | { error: 'render_first'; message: string; hint: string }
  | { error: 'too_many_pages'; message: string; pages: number; max: number }
  | { error: 'conversion_failed'; message: string };

export interface PrepareDeps {
  systools: SystoolRegistry;
  /** Substituted in tests: rasterising for real needs poppler and a disk. */
  rasterise?: (pdf: Buffer, dpi: number, range?: PageRange) => Promise<Buffer[]>;
  tmpdir?: string;
}

export interface PageRange {
  first: number;
  last: number;
}

/** `"3"` or `"2-7"`. Anything else is the caller's mistake, said plainly. */
export function parsePages(spec: string | undefined): PageRange | null | { error: string } {
  if (!spec) return null;
  const single = /^\s*(\d+)\s*$/.exec(spec);
  if (single) {
    const n = Number(single[1]);
    return n > 0 ? { first: n, last: n } : { error: 'page numbers start at 1' };
  }
  const range = /^\s*(\d+)\s*-\s*(\d+)\s*$/.exec(spec);
  if (range) {
    const first = Number(range[1]);
    const last = Number(range[2]);
    if (first < 1 || last < first) return { error: `"${spec}" is not a page range` };
    return { first, last };
  }
  return { error: `"${spec}" is not a page or page range — try "3" or "2-7"` };
}

/**
 * PDF → JPEG pages with poppler. The CLI contract is pinned here and in the
 * §23.1 registry entry together: `-jpeg -r <dpi>` with an output *prefix*,
 * which poppler turns into `<prefix>-01.jpg` — zero-padded to the width of the
 * page count, which is why the files are found by listing rather than by
 * guessing their names.
 */
async function rasteriseWithPoppler(
  command: string,
  pdf: Buffer,
  dpi: number,
  range: PageRange | undefined,
  tmpdir: string,
): Promise<Buffer[]> {
  const dir = fs.mkdtempSync(path.join(tmpdir, 'turminder-print-'));
  try {
    const input = path.join(dir, 'in.pdf');
    fs.writeFileSync(input, pdf);
    const args = ['-jpeg', '-r', String(dpi)];
    if (range) args.push('-f', String(range.first), '-l', String(range.last));
    args.push(input, path.join(dir, 'page'));
    await run(command, args, { timeout: 120_000, maxBuffer: 1 << 20 });
    return fs
      .readdirSync(dir)
      .filter((f) => f.startsWith('page') && f.endsWith('.jpg'))
      .sort()
      .map((f) => fs.readFileSync(path.join(dir, f)));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Pick a format the printer will accept and produce the bytes for it.
 *
 * The order is the spec's (§34.4): the file's own type when the device takes
 * it, then a rasterised fallback, then an honest refusal naming what the
 * device does read. There is deliberately no best-effort third branch —
 * a printer fed a format it cannot parse produces either nothing or forty
 * pages of line noise, and the second one is worse than an error message.
 */
export async function prepare(
  document: Buffer,
  mime: string,
  printerFormats: string[],
  resolutionDpi: number,
  deps: PrepareDeps,
  pages?: PageRange,
): Promise<PrintPayload | ConversionFailure> {
  /*
   * `application/octet-stream` is struck from the list on purpose. Nearly
   * every printer advertises it, and it does not mean "I can render this" — it
   * means "hand me bytes and I will guess". Treating it as a capability is how
   * a markdown file gets sent verbatim and comes out as a page of asterisks and
   * hash marks: technically printed, obviously not what anyone asked for.
   */
  const accepts = (type: string) =>
    type !== 'application/octet-stream' && printerFormats.includes(type);

  // A printer that reads the file as it stands. One job, best fidelity, done.
  if (accepts(mime) && !pages) {
    return { documents: [document], format: mime, converted: false, pages: 1 };
  }

  // We could not identify the file at all (§18.2 gives unknown extensions
  // octet-stream). Something unidentified is never sent to a printer: render
  // it to a real document first and print that.
  if (mime === 'application/octet-stream') {
    return {
      error: 'render_first',
      message:
        'this file is not a document a printer can read — markdown, notes and plain text have to be rendered first',
      hint: 'docs.to_pdf turns a workspace file or an embed into a PDF; print that instead',
    };
  }

  if (mime !== 'application/pdf') {
    return {
      error: 'format_unsupported',
      message: `the printer does not accept ${mime}`,
      supported: printerFormats,
    };
  }
  // A page range on a PDF the printer *can* read still means rasterising:
  // splitting a PDF is a different job from rendering one, and poppler is
  // already here for the harder case.
  if (!accepts('image/jpeg') && !accepts('application/pdf')) {
    return {
      error: 'format_unsupported',
      message: 'the printer reads neither PDF nor JPEG',
      supported: printerFormats,
    };
  }

  const missing = deps.systools.missing('pdftoppm');
  if (missing) {
    return {
      ...missing,
      message: accepts('application/pdf')
        ? `printing part of a PDF needs ${missing.message.replace(/^this needs /, '')}`
        : missing.message,
    };
  }
  const command = deps.systools.command('pdftoppm')!;

  let rendered: Buffer[];
  try {
    rendered = await (
      deps.rasterise ??
      ((pdf, dpi, range) =>
        rasteriseWithPoppler(command, pdf, dpi, range, deps.tmpdir ?? os.tmpdir()))
    )(document, resolutionDpi, pages);
  } catch (e) {
    return { error: 'conversion_failed', message: (e as Error).message };
  }

  if (!rendered.length) {
    return { error: 'conversion_failed', message: 'the converter produced no pages' };
  }
  if (rendered.length > MAX_PAGES) {
    return {
      error: 'too_many_pages',
      message: `that is ${rendered.length} pages; print at most ${MAX_PAGES} at a time, or narrow it with "pages"`,
      pages: rendered.length,
      max: MAX_PAGES,
    };
  }
  l.info({ pages: rendered.length, dpi: resolutionDpi }, 'pdf rasterised for printing');
  return {
    documents: rendered,
    format: 'image/jpeg',
    converted: true,
    pages: rendered.length,
  };
}
