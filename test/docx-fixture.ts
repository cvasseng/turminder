/**
 * A minimal .docx writer, for tests only.
 *
 * Same reasoning as `pdf-fixture.ts`: hermetic (no Word, no zip library — a
 * docx is a store-only ZIP of a few XML parts, which is ~60 lines to emit) and
 * exact, so a test can put a known heading, a known table and a known tracked
 * change in a known place and assert on them. `docx2js` is the thing under
 * test, not this.
 */

/** CRC-32, the one thing a ZIP entry cannot be written without. */
function crc32(data: Buffer): number {
  let crc = ~0;
  for (const byte of data) {
    crc ^= byte;
    for (let i = 0; i < 8; i += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return ~crc >>> 0;
}

export interface Entry {
  name: string;
  body: Buffer;
}

/**
 * Store-only ZIP (no compression): local headers, central directory, EOCD.
 * Exported so a test can build a zip that is *not* a docx — a renamed archive
 * is the mistake the reader has to answer honestly.
 */
export function buildZip(entries: readonly Entry[]): Buffer {
  const locals: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const crc = crc32(entry.body);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0, 6); // flags
    local.writeUInt16LE(0, 8); // stored
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(entry.body.length, 18);
    local.writeUInt32LE(entry.body.length, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, entry.body);

    const dir = Buffer.alloc(46);
    dir.writeUInt32LE(0x02014b50, 0);
    dir.writeUInt16LE(20, 4); // version made by
    dir.writeUInt16LE(20, 6); // version needed
    dir.writeUInt16LE(0, 10); // stored
    dir.writeUInt32LE(crc, 16);
    dir.writeUInt32LE(entry.body.length, 20);
    dir.writeUInt32LE(entry.body.length, 24);
    dir.writeUInt16LE(name.length, 28);
    dir.writeUInt32LE(offset, 42);
    central.push(dir, name);
    offset += local.length + name.length + entry.body.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

const CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
<Override PartName="/word/comments.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.comments+xml"/>
</Types>`;

const RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`;

const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';

function esc(text: string): string {
  return text.replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' })[c]!);
}

/** A run of ordinary text. */
export function run(text: string): string {
  return `<w:r><w:t xml:space="preserve">${esc(text)}</w:t></w:r>`;
}

/** A tracked insertion — final text keeps it. */
export function inserted(text: string): string {
  return `<w:ins w:id="90" w:author="Reviewer" w:date="2026-08-01T00:00:00Z">${run(text)}</w:ins>`;
}

/** A tracked deletion — final text drops it. */
export function deleted(text: string): string {
  return `<w:del w:id="91" w:author="Reviewer" w:date="2026-08-01T00:00:00Z"><w:r><w:delText xml:space="preserve">${esc(text)}</w:delText></w:r></w:del>`;
}

export function para(...runs: string[]): string {
  return `<w:p>${runs.join('')}</w:p>`;
}

export function heading(level: number, text: string): string {
  return `<w:p><w:pPr><w:pStyle w:val="Heading${level}"/></w:pPr>${run(text)}</w:p>`;
}

export function table(rows: readonly (readonly string[])[]): string {
  const cells = rows
    .map(
      (row) => `<w:tr>${row.map((cell) => `<w:tc>${para(run(cell))}</w:tc>`).join('')}</w:tr>`,
    )
    .join('');
  return `<w:tbl>${cells}</w:tbl>`;
}

export interface DocxFixture {
  /** Body parts, in document order — use the builders above. */
  body: readonly string[];
  /** Comment texts; each becomes one `w:comment` in word/comments.xml. */
  comments?: readonly string[];
}

export function buildDocx(fixture: DocxFixture): Buffer {
  const document = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document ${W}><w:body>${fixture.body.join('')}</w:body></w:document>`;
  const comments = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:comments ${W}>${(fixture.comments ?? [])
    .map(
      (text, i) =>
        `<w:comment w:id="${i}" w:author="Reviewer" w:date="2026-08-01T00:00:00Z">${para(run(text))}</w:comment>`,
    )
    .join('')}</w:comments>`;
  return buildZip([
    { name: '[Content_Types].xml', body: Buffer.from(CONTENT_TYPES, 'utf8') },
    { name: '_rels/.rels', body: Buffer.from(RELS, 'utf8') },
    { name: 'word/document.xml', body: Buffer.from(document, 'utf8') },
    { name: 'word/comments.xml', body: Buffer.from(comments, 'utf8') },
  ]);
}
