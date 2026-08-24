// Packages the extension for each browser (§29.6). The source layout keeps
// one code base with two manifests, but Firefox only ever reads a file
// literally named `manifest.json` — about:debugging lets you *pick* any file
// and then ignores your choice — so "load the directory" can never install
// the Firefox variant. This script assembles what the browsers actually
// accept: one directory per browser with the right manifest under the right
// name, plus a zip of each for anything that wants a single file.
//
// Dev tooling in the packaging tier: node builtins only (App. J), no service
// imports, and deleting extension/ takes this script with it.
import fs from 'node:fs';
import path from 'node:path';
import { deflateRawSync } from 'node:zlib';

const SRC = path.dirname(new URL(import.meta.url).pathname);
const OUT = path.join(SRC, '..', 'dist', 'extension');

// What ships is what the browser loads — not the docs, not this script, and
// not the Firefox manifest under its source name.
const EXCLUDE = new Set(['manifest.firefox.json', 'build.mjs', 'README.md']);

function shippedFiles() {
  const files = [];
  (function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (EXCLUDE.has(entry.name)) continue;
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(abs);
      else files.push(path.relative(SRC, abs));
    }
  })(SRC);
  // Sorted so the zips are byte-identical run to run.
  return files.sort();
}

/**
 * A minimal zip writer, because App. J has no archiver and both stores accept
 * plain deflate. CRC32 is the one piece node doesn't hand us.
 */
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// A fixed timestamp (the DOS epoch, 1980-01-01) keeps builds reproducible —
// the same source always zips to the same bytes.
const DOS_DATE = (1 << 5) | 1;
const DOS_TIME = 0;

function zip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const { name, data } of entries) {
    const nameBuf = Buffer.from(name, 'utf8');
    const crc = crc32(data);
    const deflated = deflateRawSync(data, { level: 9 });
    // Deflate can lose to tiny inputs; stored (method 0) is always legal.
    const [method, body] = deflated.length < data.length ? [8, deflated] : [0, data];

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    locals.push(local, nameBuf, body);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4); // version made by
    central.writeUInt16LE(20, 6); // version needed
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(DOS_TIME, 12);
    central.writeUInt16LE(DOS_DATE, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBuf);

    offset += 30 + nameBuf.length + body.length;
  }
  const centralStart = offset;
  const centralBuf = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(centralStart, 16);
  return Buffer.concat([...locals, centralBuf, end]);
}

function buildTarget(browser, manifestSource) {
  const dir = path.join(OUT, browser);
  fs.mkdirSync(dir, { recursive: true });
  const entries = [];
  for (const rel of shippedFiles()) {
    // The one divergence lands here: whichever manifest this browser gets is
    // written under the only name either browser will read.
    const source = rel === 'manifest.json' ? manifestSource : rel;
    const data = fs.readFileSync(path.join(SRC, source));
    const dest = path.join(dir, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, data);
    entries.push({ name: rel.split(path.sep).join('/'), data });
  }
  const { version } = JSON.parse(fs.readFileSync(path.join(SRC, manifestSource), 'utf8'));
  const zipPath = path.join(OUT, `turminder-capture-${version}-${browser}.zip`);
  fs.writeFileSync(zipPath, zip(entries));
  return { dir, zipPath };
}

fs.rmSync(OUT, { recursive: true, force: true });
const chrome = buildTarget('chrome', 'manifest.json');
const firefox = buildTarget('firefox', 'manifest.firefox.json');
console.log(`chrome:  ${chrome.dir}  (${path.basename(chrome.zipPath)})`);
console.log(`firefox: ${firefox.dir}  (${path.basename(firefox.zipPath)})`);
