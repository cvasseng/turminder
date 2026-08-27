import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SystoolRegistry, SYSTOOL_CONTRACTS } from '../src/core/systools.js';
import { MAX_READ_PAGES, parseRange, pdfOutline, pdfPages } from '../src/docs/pdf.js';
import { MAX_READ_ITEMS, docxOutline, docxRange, parseItemRange } from '../src/docs/docx.js';
import { ChromiumPrinter, TransientDocs } from '../src/docs/print.js';
import { renderMarkdownDocument } from '../src/docs/render.js';
import { EMBED_VENDOR_FILES, readVendorFile } from '../src/embeds/vendor.js';
import { docsTools } from '../src/tools/integrations/docs.js';
import { bootService, installMcpServer, type ServiceHarness } from './service-harness.js';
import { buildPdf } from './pdf-fixture.js';
import {
  buildDocx,
  buildZip,
  deleted,
  heading,
  inserted,
  para,
  run,
  table,
} from './docx-fixture.js';
import { tmpDir } from './helpers.js';

let h: ServiceHarness;
afterEach(async () => {
  await h?.cleanup();
});

const drain = (harness: ServiceHarness) => harness.service.queue.drain();

/**
 * A chromium this machine may or may not have; the gated tests say which.
 *
 * `TURMINDER_NO_CHROMIUM_TESTS` is a second gate, and it is deliberately not
 * spelled as absence: on GitHub's runners chromium is present and answers
 * `--version`, it just never finishes a headless command. It navigates the
 * page — the browser log names the URL it is scanning — and then neither
 * writes its output nor exits: `--dump-dom` of a three-line local file
 * returns nothing after 300s on twenty cores. The binary is the variable,
 * not the runner: a distro-built chromium does the same job in a third of a
 * second in the same container where Google's prebuilt 148 and 151 both
 * deadlock, and the runner's `chromium` is a Google snapshot build under
 * `/usr/local/share/chromium/`. Nothing on the command line reaches it —
 * print flags, virtual time, `--no-sandbox`, `--disable-gpu`, a session bus,
 * an X display and dummy Google API keys were each tried and each hung — so
 * the honest thing is to skip these three there and say why, rather than
 * keep the suite red or claim a fix that is not one (§23.4).
 */
const realChromium = new SystoolRegistry();
const hasChromium =
  !process.env.TURMINDER_NO_CHROMIUM_TESTS && realChromium.probe('chromium').ok;

/* ── §23.1 the systool registry ───────────────────────────────────────────── */

describe('the systool registry (§23.1)', () => {
  it('takes the first candidate that answers, and remembers the answer', () => {
    const asked: string[] = [];
    const registry = new SystoolRegistry({
      run: (command) => {
        asked.push(command);
        if (command === 'chromium') throw Object.assign(new Error('nope'), { code: 'ENOENT' });
        return 'Chromium 128.0.6613.119\n';
      },
    });
    const probe = registry.probe('chromium');
    expect(probe).toMatchObject({ ok: true, command: 'chromium-browser', version: '128.0' });
    expect(asked).toEqual(['chromium', 'chromium-browser']);
    // Cached: a binary does not appear halfway through a process.
    registry.probe('chromium');
    expect(asked).toEqual(['chromium', 'chromium-browser']);
  });

  it('refuses a build older than the flags we pin', () => {
    const registry = new SystoolRegistry({ run: () => 'Chromium 96.0.4664.110\n' });
    const probe = registry.probe('chromium');
    expect(probe.ok).toBe(false);
    expect(probe.reason).toContain('older than 112');
  });

  it('tries only the configured path, so a typo reports as a typo', () => {
    const asked: string[] = [];
    const registry = new SystoolRegistry({
      configured: () => '/opt/wrong/chromium',
      run: (command) => {
        asked.push(command);
        throw Object.assign(new Error('nope'), { code: 'ENOENT' });
      },
    });
    expect(registry.probe('chromium').ok).toBe(false);
    expect(asked).toEqual(['/opt/wrong/chromium']);
  });

  it('degrades honestly: the missing name and the install hint, as a value', () => {
    const registry = new SystoolRegistry({
      run: () => {
        throw Object.assign(new Error('nope'), { code: 'ENOENT' });
      },
    });
    const missing = registry.missing('chromium')!;
    expect(missing.error).toBe('systool_missing');
    expect(missing.message).toContain('chromium');
    expect(missing.hint).toBe(SYSTOOL_CONTRACTS.chromium.hint);
    expect(registry.command('chromium')).toBeNull();
  });

  it('covers notify-send too, so doctor reports both', () => {
    const registry = new SystoolRegistry({ run: () => 'notify-send 0.8.3\n' });
    expect(
      registry
        .report()
        .map((p) => p.name)
        .sort(),
    ).toEqual(['chromium', 'git', 'gpg', 'notify-send']);
  });
});

/* ── §23.5 reading ────────────────────────────────────────────────────────── */

describe('docs.outline / docs.read (§23.5, App. F.14)', () => {
  const withPdf = <T>(
    pages: readonly string[],
    use: (file: string) => Promise<T>,
  ): Promise<T> => {
    const t = tmpDir('turminder-pdf-');
    const file = path.join(t.dir, 'doc.pdf');
    fs.writeFileSync(file, buildPdf(pages));
    return use(file).finally(() => t.cleanup());
  };

  it('returns structure, not content', async () =>
    withPdf(['Quarterly report', 'Revenue detail', 'Appendix'], async (file) => {
      const outline = await pdfOutline(file);
      expect(outline).toEqual({
        kind: 'pdf',
        pages: 3,
        preview: [
          { page: 1, first_line: 'Quarterly report' },
          { page: 2, first_line: 'Revenue detail' },
          { page: 3, first_line: 'Appendix' },
        ],
      });
    }));

  it('reads a range, and refuses more than 20 pages in one call', async () =>
    withPdf(
      Array.from({ length: 30 }, (_, i) => `Page ${i + 1} body text`),
      async (file) => {
        const read = await pdfPages(file, '10-12');
        expect(read).toMatchObject({ pages: '10-12', truncated: false });
        expect((read as { text: string }).text).toContain('Page 11 body text');
        expect((read as { text: string }).text).not.toContain('Page 13');
        expect(parseRange('1-21')).toMatchObject({
          error: expect.stringContaining('20 pages'),
        });
        expect(await pdfPages(file, '1-40')).toMatchObject({ error: 'read_failed' });
      },
    ));

  it('says a scanned page has no text layer instead of returning nothing', async () =>
    withPdf(['Cover page', ''], async (file) => {
      expect(await pdfPages(file, '2')).toMatchObject({ error: 'no_text_layer' });
    }));

  it('refuses a file that is not a PDF, as a value', async () => {
    const t = tmpDir('turminder-pdf-');
    const file = path.join(t.dir, 'notes.md');
    fs.writeFileSync(file, '# not a pdf\n');
    expect(await pdfOutline(file)).toMatchObject({ error: 'not_a_pdf' });
    t.cleanup();
  });

  /**
   * The §20.3 exit criterion: a 200-page document is readable without any one
   * call blowing the transcript budget. The outline is one call; the text is
   * `ceil(200 / 20)` of them, by construction.
   */
  it('handles a 200-page PDF within the per-tool cap', async () =>
    withPdf(
      Array.from({ length: 200 }, (_, i) => `Section ${i + 1}: some heading text here`),
      async (file) => {
        h = await bootService({ onboarded: true, watchFiles: false });
        const store = h.service.files;
        store.ensure();
        fs.copyFileSync(file, store.resolve('big.pdf'));

        const handles = h.service.tools.handles();
        const outline = handles.find((t) => t.name === 'docs.outline')!;
        const read = handles.find((t) => t.name === 'docs.read')!;
        const cap = outline.maxResultChars!;

        const outlined = await outline.call(
          { path: 'big.pdf' },
          { runId: null, eventId: null },
        );
        expect((outlined.output as { pages: number }).pages).toBe(200);
        // The hub caps at the tool's own budget; the point is that it did not
        // have to (§20.3) — an outline that arrives truncated is not an outline.
        expect(JSON.stringify(outlined.output).length).toBeLessThan(cap);
        expect(JSON.stringify(outlined.output)).not.toContain('_truncated');

        const page = await read.call(
          { path: 'big.pdf', pages: `181-200` },
          { runId: null, eventId: null },
        );
        expect(JSON.stringify(page.output)).not.toContain('_truncated');
        expect((page.output as { text: string }).text).toContain('Section 200');
        expect(MAX_READ_PAGES).toBe(20);
      },
    ));
});

/* ── §23.5 docx reading ───────────────────────────────────────────────────── */

describe('docx reading (§23.5, App. F.14)', () => {
  /** Headings, prose, a tracked change, a table, and a comment. */
  const REPORT = {
    body: [
      heading(1, 'Quarterly report'),
      para(run('Revenue grew across every region.')),
      heading(2, 'Details'),
      para(run('Margins were'), inserted('better'), deleted('worse'), run('than forecast.')),
      table([
        ['Region', 'Q3'],
        ['North', '1200'],
        ['South', '900'],
      ]),
    ],
    comments: ['Check this number'],
  };

  const withDocx = async <T>(
    fixture: Parameters<typeof buildDocx>[0],
    use: (file: string) => Promise<T>,
  ): Promise<T> => {
    const t = tmpDir('turminder-docx-');
    const file = path.join(t.dir, 'doc.docx');
    fs.writeFileSync(file, buildDocx(fixture));
    return use(file).finally(() => t.cleanup());
  };

  it('outlines structure and counts, never content', async () =>
    withDocx(REPORT, async (file) => {
      expect(await docxOutline(file)).toEqual({
        kind: 'docx',
        // Indices are 1-based like `pages`, and read straight into `range`.
        headings: [
          { title: 'Quarterly report', level: 1, index: 1 },
          { title: 'Details', level: 2, index: 3 },
        ],
        paragraphs: 4,
        tables: 1,
        has_tracked_changes: true,
        comments: 1,
      });
    }));

  it('reads a range as final text: insertions applied, deletions dropped', async () =>
    withDocx(REPORT, async (file) => {
      const read = await docxRange(file, '4');
      expect(read).toMatchObject({ range: '4-4', truncated: false });
      const text = (read as { text: string }).text;
      expect(text).toContain('better');
      expect(text).not.toContain('worse');
      // Nothing outside the range came along.
      expect(text).not.toContain('Quarterly report');
    }));

  it('serializes a table as rows rather than a run-on paragraph', async () =>
    withDocx(REPORT, async (file) => {
      const read = await docxRange(file, '5');
      const lines = (read as { text: string }).text.split('\n');
      expect(lines).toEqual([
        '--- table (item 5) ---',
        'Region | Q3',
        'North | 1200',
        'South | 900',
      ]);
    }));

  it('says so when a document carries no tracked changes or comments', async () =>
    withDocx({ body: [para(run('Just prose.'))] }, async (file) => {
      expect(await docxOutline(file)).toMatchObject({
        headings: [],
        paragraphs: 1,
        tables: 0,
        has_tracked_changes: false,
        comments: 0,
      });
    }));

  it('refuses a range past the end, a backwards range, and more than the cap', async () =>
    withDocx(REPORT, async (file) => {
      expect(await docxRange(file, '99')).toMatchObject({
        error: 'read_failed',
        message: expect.stringContaining('5 content items'),
      });
      expect(parseItemRange('9-2')).toMatchObject({
        error: expect.stringContaining('backwards'),
      });
      expect(parseItemRange(`1-${MAX_READ_ITEMS + 1}`)).toMatchObject({
        error: expect.stringContaining('500 items'),
      });
      expect(MAX_READ_ITEMS).toBe(500);
    }));

  it('is honest about a renamed zip and a file that is not one', async () => {
    const t = tmpDir('turminder-docx-');
    const notZip = path.join(t.dir, 'a.docx');
    fs.writeFileSync(notZip, '# just markdown\n');
    expect(await docxOutline(notZip)).toMatchObject({ error: 'not_a_docx' });

    // A real zip with no word/document.xml — a .zip someone renamed.
    const renamed = path.join(t.dir, 'b.docx');
    fs.writeFileSync(
      renamed,
      buildZip([{ name: 'notes.txt', body: Buffer.from('not a document', 'utf8') }]),
    );
    expect(await docxOutline(renamed)).toMatchObject({
      error: 'not_a_docx',
      message: expect.stringContaining('word/document.xml'),
    });
    t.cleanup();
  });

  it('routes by format, and names the right selector when asked wrongly', async () =>
    withDocx(REPORT, async (file) => {
      h = await bootService({ onboarded: true, watchFiles: false });
      const store = h.service.files;
      store.ensure();
      fs.copyFileSync(file, store.resolve('report.docx'));
      fs.writeFileSync(store.resolve('slides.pdf'), buildPdf(['Cover']));
      fs.writeFileSync(store.resolve('notes.md'), '# notes\n');

      const handles = h.service.tools.handles();
      const outline = handles.find((t) => t.name === 'docs.outline')!;
      const read = handles.find((t) => t.name === 'docs.read')!;
      const ctx = { runId: null, eventId: null };

      expect((await outline.call({ path: 'report.docx' }, ctx)).output).toMatchObject({
        path: 'report.docx',
        kind: 'docx',
      });
      expect((await outline.call({ path: 'slides.pdf' }, ctx)).output).toMatchObject({
        kind: 'pdf',
      });
      expect((await outline.call({ path: 'notes.md' }, ctx)).output).toMatchObject({
        error: 'unsupported_format',
      });

      // The wrong selector teaches (§23.5): the message names the right one.
      const wrong = await read.call({ path: 'report.docx', pages: '1-2' }, ctx);
      expect(wrong.output).toMatchObject({
        error: 'bad_args',
        message: expect.stringContaining('range'),
      });
      const alsoWrong = await read.call({ path: 'slides.pdf', range: '1-2' }, ctx);
      expect(alsoWrong.output).toMatchObject({
        error: 'bad_args',
        message: expect.stringContaining('pages'),
      });
      // Neither selector at all is the same class of mistake.
      expect((await read.call({ path: 'report.docx' }, ctx)).output).toMatchObject({
        error: 'bad_args',
      });

      const ranged = await read.call({ path: 'report.docx', range: '1-5' }, ctx);
      expect(JSON.stringify(ranged.output)).not.toContain('_truncated');
      expect((ranged.output as { text: string }).text).toContain('Quarterly report');
    }));

  /**
   * The §20.3 exit criterion for docx, mirroring the 200-page PDF above: a long
   * document is answerable without any single call blowing the budget.
   */
  it('handles a 600-item document within the per-tool cap', async () =>
    withDocx(
      {
        body: Array.from({ length: 600 }, (_, i) =>
          i % 100 === 0
            ? heading(1, `Chapter ${i / 100 + 1}`)
            : para(run(`Item ${i + 1} body`)),
        ),
      },
      async (file) => {
        h = await bootService({ onboarded: true, watchFiles: false });
        const store = h.service.files;
        store.ensure();
        fs.copyFileSync(file, store.resolve('long.docx'));

        const handles = h.service.tools.handles();
        const outline = handles.find((t) => t.name === 'docs.outline')!;
        const read = handles.find((t) => t.name === 'docs.read')!;
        const ctx = { runId: null, eventId: null };

        const outlined = await outline.call({ path: 'long.docx' }, ctx);
        expect(outlined.output).toMatchObject({ paragraphs: 600, tables: 0 });
        expect((outlined.output as { headings: unknown[] }).headings).toHaveLength(6);
        expect(JSON.stringify(outlined.output).length).toBeLessThan(outline.maxResultChars!);
        expect(JSON.stringify(outlined.output)).not.toContain('_truncated');

        // The last chapter, read by the index the outline just handed over.
        const tail = await read.call({ path: 'long.docx', range: '501-600' }, ctx);
        expect((tail.output as { text: string }).text).toContain('Item 600 body');
        expect(JSON.stringify(tail.output)).not.toContain('_truncated');
      },
    ));

  it('never loads a parser it does not need', () => {
    // §23.5: both parsers are lazy-imported, so a CLI that reads no documents
    // pays for neither. A static import anywhere in src/ would break that.
    const files = fs
      .readdirSync('src/docs')
      .map((f) => fs.readFileSync(path.join('src/docs', f), 'utf8'))
      .concat(fs.readFileSync('src/tools/integrations/docs.ts', 'utf8'));
    for (const source of files) {
      expect(source).not.toMatch(/^import .*['"](docx2js|pdfjs-dist)/m);
    }
  });
});

/* ── §23.3 the vendored client libs ───────────────────────────────────────── */

describe('/embed-vendor/ (§23.3)', () => {
  it('serves exactly what the allowlist names', () => {
    for (const name of Object.keys(EMBED_VENDOR_FILES)) {
      expect(readVendorFile(name)).not.toBeNull();
    }
    expect(readVendorFile('reveal.js/reveal.css')!.contentType).toContain('text/css');
  });

  it('is an allowlist, not a directory: nothing else under node_modules is nameable', () => {
    expect(readVendorFile('reveal.js/dist/reveal.js')).toBeNull();
    expect(readVendorFile('reveal.js/theme/black.css')).toBeNull();
    expect(readVendorFile('../package.json')).toBeNull();
    expect(readVendorFile('reveal.js/../../package.json')).toBeNull();
    expect(readVendorFile('better-sqlite3/package.json')).toBeNull();
  });

  it('vendors no reveal theme, because the shipped theme owns colour', () => {
    expect(Object.keys(EMBED_VENDOR_FILES).some((k) => k.includes('theme'))).toBe(false);
  });

  it('serves over HTTP without a token, and 404s anything unlisted', async () => {
    h = await bootService({ onboarded: true, watchFiles: false });
    const hit = await fetch(`${h.baseUrl}/embed-vendor/reveal.js/reveal.js`);
    expect(hit.status).toBe(200);
    expect(hit.headers.get('content-type')).toContain('javascript');
    expect(await hit.text()).toContain('Reveal');
    expect(
      (await fetch(`${h.baseUrl}/embed-vendor/reveal.js/plugin/notes/notes.js`)).status,
    ).toBe(404);
    expect((await fetch(`${h.baseUrl}/embed-vendor/../package.json`)).status).toBe(404);
  });

  it('a deck may reference the vendor route, and nothing else', async () => {
    h = await bootService({ onboarded: true, watchFiles: false });
    const deck = h.service.embeds.create({
      title: 'Deck',
      html:
        '<link rel="stylesheet" href="/embed-vendor/reveal.js/reveal.css">' +
        '<div class="reveal"><div class="slides"><section>Hi</section></div></div>' +
        '<script src="/embed-vendor/reveal.js/reveal.js"></script>',
    });
    expect(deck).not.toHaveProperty('error');
    // The same tag pointed anywhere else is refused at authoring time.
    expect(
      h.service.embeds.create({
        title: 'Nope',
        html: '<link rel="stylesheet" href="https://cdn.example.com/x.css">',
      }),
    ).toMatchObject({ error: 'external_reference' });
  });
});

/* ── §23.4 printing ──────────────────────────────────────────────────────── */

describe('transient print documents (§23.4)', () => {
  it('needs the token, and is gone once forgotten', () => {
    const docs = new TransientDocs();
    const { id, token } = docs.put('<p>hello</p>');
    expect(docs.get(id, token)).toBe('<p>hello</p>');
    expect(docs.get(id, 'wrong')).toBeNull();
    docs.forget(id);
    expect(docs.get(id, token)).toBeNull();
  });

  it('expires on its own, so a failed print leaves nothing behind', () => {
    let now = 0;
    const docs = new TransientDocs(() => now);
    const { id, token } = docs.put('<p>hello</p>', 1000);
    now = 1001;
    expect(docs.get(id, token)).toBeNull();
  });

  it('serves with the print CSP, no runtime shim and nothing to connect to', async () => {
    h = await bootService({ onboarded: true, watchFiles: false });
    const { id, token } = h.service.transient.put(renderMarkdownDocument('# Title\n\nBody.'));
    const res = await fetch(`${h.baseUrl}/embed-print/${id}?t=${token}`);
    expect(res.status).toBe(200);
    const csp = res.headers.get('content-security-policy')!;
    expect(csp).toContain("connect-src 'none'");
    expect(csp).toContain('/embed-vendor/');
    expect(csp).not.toContain('allow-same-origin');
    const body = await res.text();
    expect(body).toContain('<h1>Title</h1>');
    // No shim: a print document has no state, no events, and no token to leak.
    expect(body).not.toContain('window.turminder');
    // It still gets the house theme, so an export looks like everything else.
    expect(body).toContain('--t-accent');

    expect((await fetch(`${h.baseUrl}/embed-print/${id}?t=nope`)).status).toBe(404);
  });
});

describe('docs.to_pdf (§23.4, App. F.14)', () => {
  it('pins the CLI contract §23.1 promises', async () => {
    const calls: { command: string; args: string[] }[] = [];
    const printer = new ChromiumPrinter({
      systools: new SystoolRegistry({ run: () => 'Chromium 128.0.6613.119\n' }),
      spawn: async (command, args) => {
        calls.push({ command, args });
        // A print that writes nothing is a failed print, so make one byte.
        const out = args.find((a) => a.startsWith('--print-to-pdf='))!.slice(15);
        fs.writeFileSync(out, '%PDF-1.4\n');
      },
    });
    const out = path.join(os.tmpdir(), `turminder-test-${Date.now()}.pdf`);
    const result = await printer.toPdf('http://127.0.0.1:7787/embed/01ABC?t=deadbeef', out);
    expect(result).not.toHaveProperty('error');
    expect(result).toMatchObject({ bytes: 9 });
    const args = calls[0]!.args;
    expect(args[0]).toBe('--headless=new');
    expect(args).toContain(`--print-to-pdf=${out}`);
    expect(args).toContain('--virtual-time-budget=10000');
    expect(args.some((a) => a.startsWith('--user-data-dir='))).toBe(true);
    // No date, source URL or page counter stamped onto the artifact (§23.4).
    expect(args).toContain('--no-pdf-header-footer');
    // Load-bearing, not hygiene: GCM registration retrying in the background
    // keeps virtual time paused, so the budget above never expires (§23.4).
    expect(args).toContain('--disable-background-networking');
    expect(args.at(-1)).toBe('http://127.0.0.1:7787/embed/01ABC?t=deadbeef');
    fs.rmSync(out, { force: true });
  });

  /**
   * The scoped token rides in the argv, which is where node also puts it when
   * it builds a failure message. It must not come back out into a tool result:
   * that result is model context, and the token is a capability (§22.3.2).
   */
  it('keeps the scoped token out of a print failure', async () => {
    const printer = new ChromiumPrinter({
      systools: new SystoolRegistry({ run: () => 'Chromium 128.0.6613.119\n' }),
      spawn: async () => {
        throw new Error(
          'Command failed: chromium --headless=new http://x/embed/01ABC?t=SECRETTOKEN',
        );
      },
    });
    const failed = await printer.toPdf(
      'http://127.0.0.1:7787/embed/01ABC?t=SECRETTOKEN',
      path.join(os.tmpdir(), 'turminder-never-written.pdf'),
    );
    expect(failed).toMatchObject({ error: 'print_failed' });
    expect(JSON.stringify(failed)).not.toContain('SECRETTOKEN');
  });

  it('declines with the install hint when chromium is absent, and nothing else breaks', async () => {
    h = await bootService({ onboarded: true, watchFiles: false });
    // The tool the hub built probes the real machine, so drive the printer
    // directly with a registry that has nothing: this is the shape the model
    // sees, and it must be a value with a hint (§23.1).
    const printer = new ChromiumPrinter({
      systools: new SystoolRegistry({
        run: () => {
          throw Object.assign(new Error('nope'), { code: 'ENOENT' });
        },
      }),
    });
    const missing = printer.available()!;
    expect(missing).toMatchObject({ error: 'systool_missing' });
    expect(missing.hint).toContain('chromium');
    // Reading still works with no browser anywhere.
    const handles = h.service.tools.handles().map((t) => t.name);
    expect(handles).toContain('docs.outline');
    expect(handles).toContain('docs.read');
  });

  it('refuses an out_path that is not a PDF, and an unprintable source', async () => {
    h = await bootService({ onboarded: true, watchFiles: false });
    const toPdf = h.service.tools.handles().find((t) => t.name === 'docs.to_pdf')!;
    const ctx = { runId: null, eventId: null };
    expect(
      (await toPdf.call({ source: 'notes/a.md', out_path: 'notes/a.txt' }, ctx)).output,
    ).toMatchObject({ error: 'bad_out_path' });
    if (!hasChromium) return;
    expect(
      (await toPdf.call({ source: 'notes/a.docx', out_path: 'out.pdf' }, ctx)).output,
    ).toMatchObject({ error: 'unknown_source' });
  });

  /**
   * The other half of the anti-telephone test: the sentinel that never rode the
   * token stream has to survive into the exported bytes. Needs a real browser,
   * so it is skipped where there is none — the flag assertions above are what
   * always runs (the phase-17 precedent for browser-shaped facts).
   */
  it.skipIf(!hasChromium)(
    'prints an embed with its bindings freshly executed, and commits it',
    async () => {
      h = await bootService({ onboarded: true, watchFiles: false });
      const store = h.service.files;
      store.ensure();
      const sentinel = 424242;
      // A real external tool, so the value genuinely arrives from outside: the
      // number exists in that process and in the page, and in no prompt.
      await installMcpServer(h, {
        name: 'revenue',
        fixture: path.resolve('test/fixtures/mcp-revenue-server.mjs'),
        env: { TURMINDER_TEST_SENTINEL: String(sentinel) },
      });
      const created = h.service.embeds.create({
        title: 'Revenue',
        html: '<h1>Revenue</h1><p>{{data:r.total}}</p>',
      });
      if ('error' in created) throw new Error(created.message);
      await h.service.binder.bind(created.embed_id, [{ name: 'r', tool: 'revenue.total' }], {
        granted: () => ['revenue.total'],
        grantedHandles: () => [],
      });
      const firstFetch = h.service.binder.manifest(created.embed_id)[0]!.fetched_at!;

      const toPdf = h.service.tools.handles().find((t) => t.name === 'docs.to_pdf')!;
      const printed = await toPdf.call(
        { source: created.embed_id, out_path: 'reports/revenue.pdf' },
        { runId: null, eventId: null },
      );
      expect(printed.output).toMatchObject({
        out_path: 'reports/revenue.pdf',
        committed: true,
      });
      // "Print the artifact you previewed" means the bindings ran again first.
      expect(h.service.binder.manifest(created.embed_id)[0]!.fetched_at).not.toBe(firstFetch);

      const pdf = store.resolve('reports/revenue.pdf');
      expect(fs.existsSync(pdf)).toBe(true);
      const read = await pdfPages(pdf, '1');
      const text = (read as { text: string }).text;
      expect(text).toContain(String(sentinel));
      // The page holds the artifact and nothing else: no chromium header or
      // footer, so no date stamp, no page counter, and — the one that matters —
      // no source URL carrying the embed's scoped token (§23.4).
      expect(text).not.toContain('/embed/');
      expect(text).not.toMatch(/\bt=[0-9a-f]{8}/);
      expect(text).not.toMatch(/\b1\/1\b/);
      // And it is in the data repo, like any assistant write (§18.2).
      expect(h.app.home.git.head()).toBeTruthy();
    },
    120_000,
  );

  it.skipIf(!hasChromium)(
    'prints a markdown file from the store through the transient route',
    async () => {
      h = await bootService({ onboarded: true, watchFiles: false });
      h.service.files.ensure();
      h.service.files.write('notes/report.md', '# Findings\n\nThe number is 31337.\n', 'test');
      const toPdf = h.service.tools.handles().find((t) => t.name === 'docs.to_pdf')!;
      const printed = await toPdf.call(
        { source: 'notes/report.md', out_path: 'notes/report.pdf' },
        { runId: null, eventId: null },
      );
      expect(printed.output).toMatchObject({ out_path: 'notes/report.pdf' });
      const read = await pdfPages(h.service.files.resolve('notes/report.pdf'), '1');
      expect((read as { text: string }).text).toContain('31337');
      expect((read as { text: string }).text).toContain('Findings');
    },
    120_000,
  );

  /**
   * The deck mechanism, asserted without a browser: a deck is recognised by its
   * vendored reveal.js reference and printed with reveal's own `print-pdf` mode
   * appended, and an ordinary embed is not (§23.3–23.4).
   */
  it('prints a deck in reveal print mode, and an ordinary embed as it is', async () => {
    h = await bootService({ onboarded: true, watchFiles: false });
    h.service.files.ensure();
    const printed: string[] = [];
    const docs = docsTools({
      files: h.service.files,
      embeds: h.service.embeds,
      binder: h.service.binder,
      printer: new ChromiumPrinter({
        systools: new SystoolRegistry({ run: () => 'Chromium 128.0.6613.119\n' }),
        spawn: async (_command, args) => {
          printed.push(args.at(-1)!);
          fs.writeFileSync(
            args.find((a) => a.startsWith('--print-to-pdf='))!.slice(15),
            '%PDF-\n',
          );
        },
      }),
      transient: h.service.transient,
      origin: () => 'http://127.0.0.1:7787',
    });
    const toPdf = docs.find((d) => d.name === 'docs.to_pdf')!;

    const deck = h.service.embeds.create({
      title: 'Deck',
      html:
        '<link rel="stylesheet" href="/embed-vendor/reveal.js/reveal.css">' +
        '<div class="reveal"><div class="slides"><section><h1>One</h1></section></div></div>' +
        '<script src="/embed-vendor/reveal.js/reveal.js"></script>',
    });
    const plain = h.service.embeds.create({ title: 'Chart', html: '<p>hello</p>' });
    if ('error' in deck || 'error' in plain) throw new Error('setup failed');

    await toPdf.execute(
      { source: deck.embed_id, out_path: 'deck.pdf' },
      { runId: null, eventId: null },
    );
    await toPdf.execute(
      { source: plain.embed_id, out_path: 'chart.pdf' },
      { runId: null, eventId: null },
    );
    expect(printed[0]).toContain('&print-pdf');
    expect(printed[1]).not.toContain('print-pdf');
    // The scoped token rides along either way — chromium gets exactly what a
    // browser tab would get, and nothing more (§23.4).
    expect(printed[0]).toMatch(/\?t=[0-9a-f]{64}&print-pdf$/);
  });

  /**
   * The real thing, where there is a browser. The page count is deliberately
   * not asserted: reveal lays the deck out on `load`, and under a loaded test
   * machine that can finish after the virtual-time budget, so slide-per-page
   * pagination is a browser-timing fact rather than a CI-stable one (the same
   * call phase 17 made about opaque-origin probing). Verified by hand against
   * a three-slide deck: three pages.
   */
  it.skipIf(!hasChromium)(
    'prints a reveal deck end to end',
    async () => {
      h = await bootService({ onboarded: true, watchFiles: false });
      h.service.files.ensure();
      const deck = h.service.embeds.create({
        title: 'Deck',
        html:
          '<link rel="stylesheet" href="/embed-vendor/reveal.js/reveal.css">' +
          '<div class="reveal"><div class="slides">' +
          '<section><h1>Slide one</h1></section><section><h1>Slide two</h1></section>' +
          '</div></div><script src="/embed-vendor/reveal.js/reveal.js"></script>' +
          '<script>Reveal.initialize();</script>',
      });
      if ('error' in deck) throw new Error(deck.message);
      const toPdf = h.service.tools.handles().find((t) => t.name === 'docs.to_pdf')!;
      const printed = await toPdf.call(
        { source: deck.embed_id, out_path: 'deck.pdf' },
        { runId: null, eventId: null },
      );
      expect(printed.output).toMatchObject({ out_path: 'deck.pdf' });
      const outline = await pdfOutline(h.service.files.resolve('deck.pdf'));
      expect((outline as { pages: number }).pages).toBeGreaterThanOrEqual(1);
    },
    120_000,
  );
});

/* ── the tool surface itself ──────────────────────────────────────────────── */

describe('the docs integration (App. F.14)', () => {
  it('offers exactly the three tools, at the tiers the spec names', async () => {
    h = await bootService({ onboarded: true, watchFiles: false });
    const docs = h.service.tools
      .handles()
      .filter((t) => t.source === 'docs')
      .map((t) => ({ name: t.name, tier: t.tier }));
    expect(docs).toEqual([
      { name: 'docs.outline', tier: 'ro' },
      { name: 'docs.read', tier: 'ro' },
      { name: 'docs.to_pdf', tier: 'se' },
    ]);
  });

  it('is granted to chat by default, and paged rather than resident (App. A, F.7)', async () => {
    h = await bootService({ onboarded: true, watchFiles: false });
    h.fake.always({ text: 'ok' });
    h.service.chat.send({ text: 'hello' });
    await drain(h);
    const system = h.fake.requests.at(-1)!.body.messages[0].content as string;
    const rendered = (
      (h.fake.requests.at(-1)!.body.tools ?? []) as { function: { name: string } }[]
    ).map((t) => t.function.name);
    expect(system).toContain('- docs:');
    expect(rendered.some((n) => n.startsWith('docs.'))).toBe(false);
  });
});
