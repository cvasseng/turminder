/**
 * A minimal PDF writer, for tests only.
 *
 * Built by hand rather than printed with chromium so the PDF-reading tests are
 * hermetic — they must pass on a machine with no browser installed — and so a
 * test can put an exact sentinel on an exact page and assert on it.
 *
 * Uncompressed content streams, one Type1 base font, real xref offsets. Nothing
 * clever: pdf.js is the thing under test, not this.
 */

/** Escapes a literal string for a PDF content stream. */
function pdfString(text: string): string {
  return text.replace(/[\\()]/g, (c) => `\\${c}`);
}

/**
 * One page per entry. An empty string produces a page with no text at all —
 * which is what a scanned document looks like to a text extractor.
 */
export function buildPdf(pages: readonly string[]): Buffer {
  const objects: string[] = [];
  // 1 = catalog, 2 = page tree, 3 = font; pages and contents follow in pairs.
  const firstPage = 4;
  const pageIds = pages.map((_, i) => firstPage + i * 2);
  const contentIds = pages.map((_, i) => firstPage + i * 2 + 1);

  objects[1] = `<< /Type /Catalog /Pages 2 0 R >>`;
  objects[2] =
    `<< /Type /Pages /Count ${pages.length} ` +
    `/Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] >>`;
  objects[3] = `<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>`;

  pages.forEach((text, i) => {
    objects[pageIds[i]!] =
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] ` +
      `/Resources << /Font << /F1 3 0 R >> >> /Contents ${contentIds[i]} 0 R >>`;
    const body = text
      ? `BT /F1 14 Tf 72 720 Td (${pdfString(text)}) Tj ET\n`
      : // A page that draws a rectangle and no text: structurally a page,
        // with nothing for a text layer to hold.
        `0.9 0.9 0.9 rg 72 600 200 100 re f\n`;
    objects[contentIds[i]!] = `<< /Length ${body.length} >>\nstream\n${body}endstream`;
  });

  const header = '%PDF-1.4\n';
  let out = header;
  const offsets: number[] = [];
  for (let id = 1; id < objects.length; id += 1) {
    offsets[id] = out.length;
    out += `${id} 0 obj\n${objects[id]}\nendobj\n`;
  }
  const xrefAt = out.length;
  const count = objects.length; // objects 1..n plus the free object 0
  out += `xref\n0 ${count}\n0000000000 65535 f \n`;
  for (let id = 1; id < objects.length; id += 1) {
    out += `${String(offsets[id]).padStart(10, '0')} 00000 n \n`;
  }
  out += `trailer\n<< /Size ${count} /Root 1 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}
