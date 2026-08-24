import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { newId } from '../../core/ids.js';
import { log } from '../../core/logger.js';
import type { EmbedBinder } from '../../embeds/binder.js';
import type { EmbedStore } from '../../embeds/store.js';
import { pdfOutline, pdfPages } from '../../docs/pdf.js';
import { docxOutline, docxRange } from '../../docs/docx.js';
import type { ChromiumPrinter, TransientDocs } from '../../docs/print.js';
import { renderHtmlDocument, renderMarkdownDocument } from '../../docs/render.js';
import { FileStoreError, type FileStore } from '../../files/store.js';
import { PathRejected } from '../paths.js';
import type { ToolDefinition } from '../types.js';

const l = log('tool:docs');

export interface DocsDeps {
  files: FileStore;
  embeds: EmbedStore;
  /** Bindings are re-executed before a print, so the PDF is the live artifact. */
  binder: EmbedBinder;
  printer: ChromiumPrinter;
  transient: TransientDocs;
  /**
   * The origin chromium can reach, e.g. `http://127.0.0.1:7787` — known only
   * once the HTTP server has bound, hence a function. Null means nothing is
   * serving, which the tool reports rather than guessing a port.
   */
  origin: () => string | null;
}

/** Store errors are outcomes the model reasons about, not exceptions (F.8). */
function asError(e: unknown): { error: string; message: string } {
  if (e instanceof FileStoreError) return { error: e.code, message: e.message };
  if (e instanceof PathRejected) return { error: 'path_rejected', message: e.reason };
  throw e;
}

const pathArg = z.string().min(1).describe('store-relative path, e.g. reports/q3.pdf');

/**
 * Which reader a path gets (§23.5). Extension rather than sniffing: the store
 * is the user's own workspace, the name is what they and the model both see,
 * and a mislabelled file gets an honest parse error from the reader it was
 * routed to rather than a silent guess.
 */
function formatOf(storePath: string): 'pdf' | 'docx' | null {
  if (/\.pdf$/i.test(storePath)) return 'pdf';
  if (/\.docx$/i.test(storePath)) return 'docx';
  return null;
}

const unsupported = (storePath: string) => ({
  error: 'unsupported_format' as const,
  message: `${storePath} is neither a PDF nor a .docx — those are the formats this build reads`,
});

/**
 * The `docs` integration (App. F.14, §23.4–23.5): PDFs in, PDFs out.
 *
 * Reading is shaped by context discipline — structure first, then a narrow
 * range — because a 200-page document read in one call is a context bill, not
 * an answer. Writing is a headless-browser print of a page that was *served*,
 * so an export is the artifact the user already looked at, down to the bytes.
 */
export function docsTools(deps: DocsDeps): ToolDefinition[] {
  const { files, embeds, binder, printer, transient } = deps;
  return [
    {
      name: 'docs.outline',
      description:
        'Map a document before reading it. PDF: page count, table of contents, the first line of every page. Word (.docx): headings with the item numbers to read, plus paragraph and table counts. Always do this first — then read only the part that matters.',
      tier: 'ro',
      /**
       * Structure for a long document is the whole point of the call, and this
       * is what keeps a 200-page outline inside one result instead of arriving
       * truncated at the default 4000 (§20.3, same reasoning as `files.read`).
       */
      maxResultChars: 20_000,
      args: z.object({ path: pathArg }),
      async execute(args: { path: string }) {
        const format = formatOf(args.path);
        if (!format) return unsupported(args.path);
        let abs: string;
        try {
          abs = files.resolve(args.path);
        } catch (e) {
          return asError(e);
        }
        const result = format === 'pdf' ? await pdfOutline(abs) : await docxOutline(abs);
        return 'error' in result ? result : { path: args.path, ...result };
      },
    },
    {
      name: 'docs.read',
      description:
        'Read part of a document. PDF: pages, "3" or "10-20", at most 20 at a time. Word (.docx): range, the item numbers from the outline, at most 500 at a time. Use docs.outline first to know what to ask for.',
      tier: 'ro',
      maxResultChars: 20_000,
      args: z.object({
        path: pathArg,
        pages: z
          .string()
          .min(1)
          .optional()
          .describe('PDF only: a page or a range, "3" or "10-20"'),
        range: z
          .string()
          .min(1)
          .optional()
          .describe('docx only: content items from the outline, "3" or "10-20"'),
      }),
      async execute(args: { path: string; pages?: string; range?: string }) {
        const format = formatOf(args.path);
        if (!format) return unsupported(args.path);
        // The wrong selector for the format is a teachable error, not a guess
        // (§23.5): the message names the one that works here.
        const wanted = format === 'pdf' ? 'pages' : 'range';
        const given = format === 'pdf' ? args.pages : args.range;
        const other = format === 'pdf' ? args.range : args.pages;
        if (!given) {
          return {
            error: 'bad_args',
            message: other
              ? `${args.path} is a ${format === 'pdf' ? 'PDF' : 'docx'}, so it takes \`${wanted}\`, not \`${format === 'pdf' ? 'range' : 'pages'}\``
              : `docs.read needs \`${wanted}\` for a ${format === 'pdf' ? 'PDF' : 'docx'}`,
          };
        }
        let abs: string;
        try {
          abs = files.resolve(args.path);
        } catch (e) {
          return asError(e);
        }
        const result =
          format === 'pdf' ? await pdfPages(abs, given) : await docxRange(abs, given);
        return 'error' in result ? result : { path: args.path, ...result };
      },
    },
    {
      name: 'docs.to_pdf',
      description:
        'Export something as a PDF into the shared workspace: an embed by its id (printed exactly as it looks, with its data refreshed first), or a .md or .html file from the store. Needs chromium installed; it will say so if it is missing.',
      tier: 'se',
      args: z.object({
        source: z.string().min(1).describe('an embed id, or a store path ending .md or .html'),
        out_path: z.string().min(1).describe('where the PDF goes, e.g. reports/q3.pdf'),
      }),
      async execute(args: { source: string; out_path: string }) {
        if (!/\.pdf$/i.test(args.out_path)) {
          return {
            error: 'bad_out_path',
            message: 'out_path must end in .pdf',
          };
        }
        const missing = printer.available();
        if (missing) return missing;
        const origin = deps.origin();
        if (!origin) {
          return {
            error: 'not_serving',
            message:
              'PDF export prints a served page, and this process is not serving HTTP right now',
          };
        }

        const source = await resolveSource(args.source);
        if ('error' in source) return source;

        // A temp file, then the store: chromium writes wherever it is pointed,
        // and the store is the only thing that commits (§18.2). Printing
        // straight into `files/` would leave a half-written PDF there if
        // chromium died mid-page.
        const scratch = path.join(os.tmpdir(), `turminder-print-${newId()}.pdf`);
        try {
          const printed = await printer.toPdf(`${origin}${source.url}`, scratch);
          if ('error' in printed) return printed;
          const written = files.writeBinary(
            args.out_path,
            fs.readFileSync(scratch),
            `docs: exported ${source.label} to ${args.out_path}`,
          );
          l.info({ out: written.path, bytes: written.bytes }, 'pdf exported');
          return { out_path: written.path, bytes: written.bytes, committed: written.committed };
        } catch (e) {
          return asError(e);
        } finally {
          fs.rmSync(scratch, { force: true });
          if (source.transientId) transient.forget(source.transientId);
        }
      },
    },
  ];

  /**
   * An embed id, or a document from the store. Embeds are checked first
   * because an id is unambiguous; a store path has to name a format we can
   * turn into a page.
   */
  async function resolveSource(
    source: string,
  ): Promise<
    { url: string; label: string; transientId?: string } | { error: string; message: string }
  > {
    const row = embeds.repo.get(source);
    if (row) {
      // "Print the artifact you previewed" means the data is current at print
      // time, not whenever the page was last opened (§23.4).
      await binder.refresh(source);
      const html = embeds.html(row);
      if (html === null) {
        return { error: 'content_missing', message: `embed ${source} has no file` };
      }
      embeds.repo.markServed(source);
      // A deck paginates itself, in reveal's own print mode (§23.3). Detected
      // rather than asked for: the model should not have to remember that one
      // kind of embed prints differently, and the HTML already says which it is.
      const deck = /\/embed-vendor\/reveal\.js\//i.test(html);
      return {
        url: `${embeds.url(row)}${deck ? '&print-pdf' : ''}`,
        label: `embed ${row.title} (${source})`,
      };
    }
    if (!/\.(md|html?)$/i.test(source)) {
      return {
        error: 'unknown_source',
        message: 'source must be an embed id, or a store path ending in .md or .html',
      };
    }
    let text: string | null;
    try {
      text = files.readText(source)?.content ?? null;
    } catch (e) {
      return asError(e);
    }
    if (text === null) {
      return { error: 'not_found', message: `no readable text file at ${source}` };
    }
    const html = /\.md$/i.test(source)
      ? renderMarkdownDocument(text)
      : renderHtmlDocument(text);
    const doc = transient.put(html);
    return {
      url: `/embed-print/${doc.id}?t=${doc.token}`,
      label: source,
      transientId: doc.id,
    };
  }
}
