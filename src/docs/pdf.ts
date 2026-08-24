import fs from 'node:fs';
import { log } from '../core/logger.js';
import { errMessage } from '../core/errors.js';

const l = log('docs');

/** App. F.14: one `docs.read` never returns more than this many pages. */
export const MAX_READ_PAGES = 20;
/** Enough to recognise a page, short enough that 200 of them still fit. */
const PREVIEW_CHARS = 90;

export interface PdfError {
  error: 'no_text_layer' | 'not_a_pdf' | 'read_failed';
  message: string;
}

export interface TocEntry {
  title: string;
  page: number;
  level: number;
}

export interface PdfOutline {
  /** Which reader answered (App. F.14); a docx outline says `docx`. */
  kind: 'pdf';
  pages: number;
  toc?: TocEntry[];
  preview: { page: number; first_line: string }[];
}

export interface PdfPages {
  pages: string;
  text: string;
  truncated: boolean;
}

/**
 * Minimal shapes from `pdfjs-dist`. Declared rather than imported because the
 * library's own types describe a browser-shaped API (canvas, workers) that this
 * module deliberately never touches: text and structure only.
 */
interface PdfTextItem {
  str?: string;
  hasEOL?: boolean;
}
interface PdfPage {
  getTextContent(): Promise<{ items: unknown[] }>;
}
interface PdfOutlineNode {
  title?: string;
  dest?: unknown;
  items?: PdfOutlineNode[];
}
interface PdfDocument {
  numPages: number;
  getPage(n: number): Promise<PdfPage>;
  getOutline(): Promise<PdfOutlineNode[] | null>;
  getDestination(id: string): Promise<unknown[] | null>;
  getPageIndex(ref: unknown): Promise<number>;
}
interface PdfLoadingTask {
  promise: Promise<PdfDocument>;
  destroy(): Promise<void>;
}

/**
 * Loaded lazily and once. `pdfjs-dist` is a megabyte of parser that most runs
 * never touch, and paying for it at import time would make every CLI command
 * slower to please the rare one that reads a PDF.
 */
let getDocument: ((args: Record<string, unknown>) => PdfLoadingTask) | null = null;

async function pdfjs(): Promise<(args: Record<string, unknown>) => PdfLoadingTask> {
  if (!getDocument) {
    const mod = (await import('pdfjs-dist/legacy/build/pdf.mjs')) as unknown as {
      getDocument: (args: Record<string, unknown>) => PdfLoadingTask;
    };
    getDocument = mod.getDocument;
  }
  return getDocument;
}

let fontUrl: string | null | undefined;

function standardFonts(): string | null {
  if (fontUrl === undefined) {
    try {
      fontUrl = import.meta.resolve('pdfjs-dist/standard_fonts/');
    } catch {
      // Reading text works without them; it only costs a pdf.js warning.
      fontUrl = null;
    }
  }
  return fontUrl;
}

async function open<T>(
  abs: string,
  use: (doc: PdfDocument) => Promise<T>,
): Promise<T | PdfError> {
  let data: Buffer;
  try {
    data = fs.readFileSync(abs);
  } catch (e) {
    return { error: 'read_failed', message: errMessage(e) };
  }
  if (!data.subarray(0, 5).equals(Buffer.from('%PDF-'))) {
    return { error: 'not_a_pdf', message: 'that file does not start with a PDF header' };
  }
  const load = await pdfjs();
  // `isEvalSupported: false` — a PDF may carry JavaScript, and nothing in
  // reading one needs to run it. `useSystemFonts: false` keeps extraction off
  // whatever fonts happen to be installed, which text does not need at all;
  // the standard-font metrics that pdf.js does want come from its own package.
  const task = load({
    data: new Uint8Array(data),
    isEvalSupported: false,
    useSystemFonts: false,
    ...(standardFonts() ? { standardFontDataUrl: standardFonts() } : {}),
  });
  try {
    return await use(await task.promise);
  } catch (e) {
    l.warn({ err: errMessage(e) }, 'pdf parse failed');
    return { error: 'read_failed', message: errMessage(e) };
  } finally {
    await task.destroy().catch(() => {
      /* the worker is going away regardless */
    });
  }
}

/**
 * Structure, never content (§23.5): page count, the document's own table of
 * contents when it has one, and one line per page. A 200-page PDF is never one
 * read, and this is what makes the second call a targeted one.
 */
export async function pdfOutline(abs: string): Promise<PdfOutline | PdfError> {
  return open(abs, async (doc) => {
    const preview: { page: number; first_line: string }[] = [];
    for (let n = 1; n <= doc.numPages; n += 1) {
      const lines = await pageLines(doc, n);
      const first = lines.find((line) => line.trim().length > 0) ?? '';
      preview.push({ page: n, first_line: clip(first.trim(), PREVIEW_CHARS) });
    }
    const toc = await tableOfContents(doc);
    return {
      kind: 'pdf' as const,
      pages: doc.numPages,
      ...(toc.length ? { toc } : {}),
      preview,
    };
  });
}

/**
 * Text for a page range (§23.5). Scanned input has no text layer to extract
 * and says so rather than returning a convincing empty string — OCR is out of
 * scope, and silence would read as "this page is blank".
 */
export async function pdfPages(abs: string, spec: string): Promise<PdfPages | PdfError> {
  const range = parseRange(spec);
  if ('error' in range) return { error: 'read_failed', message: range.error };
  return open(abs, async (doc) => {
    const from = Math.max(1, range.from);
    const to = Math.min(doc.numPages, range.to);
    if (from > doc.numPages) {
      return {
        error: 'read_failed' as const,
        message: `this document has ${doc.numPages} pages; ${spec} is past the end`,
      };
    }
    const parts: string[] = [];
    for (let n = from; n <= to; n += 1) {
      const text = (await pageLines(doc, n)).join('\n').trim();
      parts.push(`--- page ${n} ---\n${text}`);
    }
    const joined = parts.join('\n\n');
    if (!joined.replace(/--- page \d+ ---/g, '').trim()) {
      return {
        error: 'no_text_layer' as const,
        message:
          'these pages carry no extractable text — the document is scanned images, and OCR is out of scope',
      };
    }
    return { pages: `${from}-${to}`, text: joined, truncated: to < range.to };
  });
}

/** `"3"` or `"10-20"`, at most `MAX_READ_PAGES` wide (App. F.14). */
export function parseRange(spec: string): { from: number; to: number } | { error: string } {
  const match = /^\s*(\d+)\s*(?:-\s*(\d+)\s*)?$/.exec(spec);
  if (!match) return { error: `pages must look like "3" or "10-20" (got "${spec}")` };
  const from = Number(match[1]);
  const to = match[2] === undefined ? from : Number(match[2]);
  if (from < 1 || to < from) return { error: `that page range runs backwards: "${spec}"` };
  if (to - from + 1 > MAX_READ_PAGES) {
    return { error: `at most ${MAX_READ_PAGES} pages per call (asked for ${to - from + 1})` };
  }
  return { from, to };
}

async function pageLines(doc: PdfDocument, n: number): Promise<string[]> {
  const content = await (await doc.getPage(n)).getTextContent();
  const lines: string[] = [];
  let current = '';
  for (const raw of content.items) {
    const item = raw as PdfTextItem;
    if (typeof item.str !== 'string') continue;
    current += item.str;
    // pdf.js reports line ends per item; without honouring them a page becomes
    // one run-on line, which is unreadable and defeats the first-line preview.
    if (item.hasEOL) {
      lines.push(current);
      current = '';
    }
  }
  if (current) lines.push(current);
  return lines;
}

async function tableOfContents(doc: PdfDocument): Promise<TocEntry[]> {
  const nodes = await doc.getOutline();
  if (!nodes?.length) return [];
  const out: TocEntry[] = [];
  const walk = async (list: PdfOutlineNode[], level: number): Promise<void> => {
    for (const node of list) {
      const page = await destinationPage(doc, node.dest);
      if (node.title && page !== null) out.push({ title: node.title, page, level });
      if (node.items?.length) await walk(node.items, level + 1);
    }
  };
  await walk(nodes, 1);
  return out;
}

/** A TOC entry with no resolvable page is a bookmark we cannot honour. */
async function destinationPage(doc: PdfDocument, dest: unknown): Promise<number | null> {
  try {
    const explicit = typeof dest === 'string' ? await doc.getDestination(dest) : dest;
    const ref = Array.isArray(explicit) ? explicit[0] : null;
    if (!ref) return null;
    return (await doc.getPageIndex(ref)) + 1;
  } catch {
    return null;
  }
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}
