import fs from 'node:fs';
import { log } from '../core/logger.js';
import { errMessage } from '../core/errors.js';

const l = log('docs');

/** App. F.14: one `docs.read` never returns more than this many content items. */
export const MAX_READ_ITEMS = 500;
/** Enough to recognise a heading in an outline, short enough that 200 still fit. */
const HEADING_CHARS = 120;

export interface DocxError {
  error: 'not_a_docx' | 'read_failed';
  message: string;
}

export interface DocxHeading {
  title: string;
  level: number;
  /** Content-item index, usable directly as a `range` bound (§23.5). */
  index: number;
}

export interface DocxOutline {
  kind: 'docx';
  headings: DocxHeading[];
  paragraphs: number;
  tables: number;
  has_tracked_changes: boolean;
  comments: number;
}

export interface DocxRange {
  range: string;
  text: string;
  truncated: boolean;
}

/**
 * The shapes this module uses from `docx2js`. Declared structurally rather than
 * imported as types, for the same reason `pdf.ts` declares its own: the import
 * is lazy, and a type-only dependency on a lazily-loaded parser is exactly the
 * coupling the laziness exists to avoid.
 */
interface DocxRun {
  text?: string;
  type?: 'normal' | 'insertion' | 'deletion' | 'comment';
}
interface DocxParagraph {
  type: 'paragraph' | 'paragraph-insertion' | 'paragraph-deletion';
  properties?: { style?: string; outlineLevel?: string };
  runs?: DocxRun[];
}
interface DocxTable {
  type: 'table';
  caption?: string;
  rows?: DocxRun[][][];
}
type DocxItem = DocxParagraph | DocxTable;
interface DocxDocument {
  comments: unknown[];
  contents: DocxItem[];
}

/**
 * Loaded lazily and once, like `pdfjs-dist` (§23.5): a CLI invocation that
 * never reads a document never pays for a parser it will not use.
 */
let parseBuffer: ((data: Buffer) => Promise<DocxDocument | false>) | null = null;

async function docx2js(): Promise<(data: Buffer) => Promise<DocxDocument | false>> {
  if (!parseBuffer) {
    const mod = (await import('docx2js')) as unknown as {
      ParseBuffer: (data: Buffer) => Promise<DocxDocument | false>;
    };
    parseBuffer = mod.ParseBuffer;
  }
  return parseBuffer;
}

async function open(abs: string): Promise<DocxDocument | DocxError> {
  let data: Buffer;
  try {
    data = fs.readFileSync(abs);
  } catch (e) {
    return { error: 'read_failed', message: errMessage(e) };
  }
  // A docx is a zip. A renamed .zip gets past this and fails on the missing
  // document part below, which is the honest place to say so.
  if (!data.subarray(0, 2).equals(Buffer.from('PK'))) {
    return { error: 'not_a_docx', message: 'that file is not a docx (no zip container)' };
  }
  try {
    const parse = await docx2js();
    const doc = await parse(data);
    if (!doc) {
      return {
        error: 'not_a_docx',
        message: 'that zip has no word/document.xml — it is not a Word document',
      };
    }
    return doc;
  } catch (e) {
    l.warn({ err: errMessage(e) }, 'docx parse failed');
    return { error: 'read_failed', message: errMessage(e) };
  }
}

/** `Heading2`, `heading 2`, or an explicit outline level — all mean the same. */
function headingLevel(item: DocxParagraph): number | null {
  const style = item.properties?.style ?? '';
  const styled = /^heading\s*(\d)$/i.exec(style.trim());
  if (styled) return Number(styled[1]);
  if (style.trim().toLowerCase() === 'title') return 1;
  const outline = item.properties?.outlineLevel;
  if (outline !== undefined && outline !== null && `${outline}` !== '') {
    const level = Number(outline);
    if (Number.isFinite(level) && level >= 0 && level <= 8) return level + 1;
  }
  return null;
}

/**
 * Final text for one paragraph (§23.5): tracked insertions applied, deletions
 * dropped.
 *
 * Runs are joined with a space rather than concatenated, because the parser
 * hands back trimmed run text — concatenating would weld "Before" and "after"
 * into one word at every formatting boundary. The cost is a space inside a
 * word that was styled mid-word; the alternative loses the word boundary
 * everywhere, which is worse and far more common.
 */
function paragraphText(item: DocxParagraph): string {
  if (item.type === 'paragraph-deletion') return '';
  return (item.runs ?? [])
    .filter((run) => run.type !== 'deletion')
    .map((run) => (run.text ?? '').trim())
    .filter((text) => text.length > 0)
    .join(' ');
}

function cellText(cell: DocxRun[]): string {
  return cell
    .filter((run) => run.type !== 'deletion')
    .map((run) => (run.text ?? '').trim())
    .filter((text) => text.length > 0)
    .join(' ');
}

/**
 * A table as rows, one per line (F.14: "serialize as rows like `web.query`").
 * `web.query` returns a rows array in a JSON field; `docs.read` returns one
 * text field, so rows stay rows line by line instead of collapsing into a
 * paragraph. The caption is deliberately not printed: `docx2js` derives it
 * from the preceding paragraph, which the read already contains — and derives
 * it from raw runs, so printing it would put deleted text back into text that
 * is supposed to be final.
 */
function tableText(item: DocxTable, index: number): string {
  // Backslashes first, then pipes — the other order is a lie about the cell.
  // Escaping only `|` turns a cell ending in a backslash into `…\` followed by
  // the separator, which reads back as an escaped pipe and silently welds two
  // columns into one; escaping the backslash first means every `\|` in the
  // output came from a real pipe.
  const rows = (item.rows ?? []).map((row) =>
    row.map((cell) => cellText(cell).replace(/\\/g, '\\\\').replace(/\|/g, '\\|')).join(' | '),
  );
  return [`--- table (item ${index}) ---`, ...rows].join('\n');
}

function itemText(item: DocxItem, index: number): string {
  return item.type === 'table' ? tableText(item, index) : paragraphText(item);
}

function hasTrackedChanges(contents: DocxItem[]): boolean {
  const tracked = (runs: DocxRun[] | undefined): boolean =>
    (runs ?? []).some((run) => run.type === 'insertion' || run.type === 'deletion');
  return contents.some((item) => {
    if (item.type === 'table') {
      return (item.rows ?? []).some((row) => row.some((cell) => tracked(cell)));
    }
    return (
      item.type === 'paragraph-insertion' ||
      item.type === 'paragraph-deletion' ||
      tracked(item.runs)
    );
  });
}

/**
 * Structure, never content (§23.5). A docx has no pages, so the unit is the
 * content item — paragraph or table, in document order — and heading indices
 * are those same indices, so an outline reads straight into a `range`.
 */
export async function docxOutline(abs: string): Promise<DocxOutline | DocxError> {
  const doc = await open(abs);
  if ('error' in doc) return doc;
  const headings: DocxHeading[] = [];
  let paragraphs = 0;
  let tables = 0;
  doc.contents.forEach((item, i) => {
    if (item.type === 'table') {
      tables += 1;
      return;
    }
    paragraphs += 1;
    const level = headingLevel(item);
    const title = paragraphText(item);
    // Items are numbered from 1, like `pages` in the same tool: two selectors
    // counting from different places in one surface is a trap.
    if (level !== null && title)
      headings.push({ title: clip(title, HEADING_CHARS), level, index: i + 1 });
  });
  return {
    kind: 'docx',
    headings,
    paragraphs,
    tables,
    has_tracked_changes: hasTrackedChanges(doc.contents),
    comments: doc.comments.length,
  };
}

/** Final text for a range of content items (§23.5), 1-based and inclusive. */
export async function docxRange(abs: string, spec: string): Promise<DocxRange | DocxError> {
  const range = parseItemRange(spec);
  if ('error' in range) return { error: 'read_failed', message: range.error };
  const doc = await open(abs);
  if ('error' in doc) return doc;
  const count = doc.contents.length;
  if (range.from > count) {
    return {
      error: 'read_failed',
      message: `this document has ${count} content items; ${spec} is past the end`,
    };
  }
  const to = Math.min(count, range.to);
  const parts: string[] = [];
  for (let i = range.from; i <= to; i += 1) {
    const text = itemText(doc.contents[i - 1]!, i);
    if (text) parts.push(text);
  }
  return { range: `${range.from}-${to}`, text: parts.join('\n\n'), truncated: to < range.to };
}

/** `"3"` or `"10-20"`, at most `MAX_READ_ITEMS` wide (App. F.14). */
export function parseItemRange(spec: string): { from: number; to: number } | { error: string } {
  const match = /^\s*(\d+)\s*(?:-\s*(\d+)\s*)?$/.exec(spec);
  if (!match) return { error: `range must look like "3" or "10-20" (got "${spec}")` };
  const from = Number(match[1]);
  const to = match[2] === undefined ? from : Number(match[2]);
  if (from < 1 || to < from) {
    return { error: `that range runs backwards, and items are numbered from 1: "${spec}"` };
  }
  if (to - from + 1 > MAX_READ_ITEMS) {
    return { error: `at most ${MAX_READ_ITEMS} items per call (asked for ${to - from + 1})` };
  }
  return { from, to };
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}
