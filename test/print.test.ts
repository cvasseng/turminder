import fs from 'node:fs';
import https from 'node:https';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SystoolRegistry } from '../src/core/systools.js';
import { FileStore } from '../src/files/store.js';
import {
  decodeResponse,
  encodeRequest,
  all,
  first,
} from '../src/tools/integrations/print/ipp.js';
import {
  PrinterClient,
  probePrinter,
  IppError,
} from '../src/tools/integrations/print/printer.js';
import { ScannerClient, probeScanner } from '../src/tools/integrations/print/escl.js';
import { CertificateChanged, deviceFetch } from '../src/tools/integrations/print/transport.js';
import { prepare, parsePages } from '../src/tools/integrations/print/convert.js';
import { collect, discover } from '../src/tools/integrations/print/discover.js';
import {
  DeviceSchema,
  PrintScanSettingsSchema,
  passwordKey,
  resolveDevice,
  type Device,
} from '../src/tools/integrations/print/devices.js';
import { printTools } from '../src/tools/integrations/print/tools.js';
import {
  hostOf,
  runPrinterWizard,
  slug,
  type PrinterSetupDeps,
} from '../src/tools/integrations/setup/printers.js';
import { Config } from '../src/core/config.js';
import { openDataHome, type DataHome } from '../src/core/datadir.js';
import { FormBroker } from '../src/chat/forms.js';
import { tmpDir } from './helpers.js';

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'print');
const fixture = (name: string) => fs.readFileSync(path.join(FIXTURES, name));

/**
 * The IPP and eSCL fixtures were captured from a real Epson ET-3700 (§34), not
 * written by hand. That matters: a hand-written IPP response agrees with the
 * parser that wrote it and with nothing else on the market.
 */
const IPP_ATTRIBUTES = fixture('ipp-printer-attributes.bin');
const ESCL_CAPABILITIES = fixture('escl-capabilities.xml').toString('utf8');
const ESCL_STATUS = fixture('escl-status.xml').toString('utf8');

/** What that device actually advertises — the awkward shape §34.4 exists for. */
const ET3700_FORMATS = [
  'application/octet-stream',
  'image/pwg-raster',
  'image/urf',
  'image/jpeg',
];

/* ── The wire formats ─────────────────────────────────────────────────── */

describe('IPP codec (§34.1)', () => {
  it('decodes a real printer’s attributes, multi-values and all', () => {
    const res = decodeResponse(IPP_ATTRIBUTES);
    expect(res.ok).toBe(true);
    expect(res.statusCode).toBe(0);
    // The one that matters: four values under one name, written with a
    // name-length of zero for every value after the first.
    expect(all(res, 'document-format-supported')).toEqual(ET3700_FORMATS);
    expect(all(res, 'sides-supported')).toHaveLength(3);
    expect(first(res, 'printer-make-and-model')).toBe('EPSON ET-3700 Series');
    expect(first(res, 'printer-state')).toBe(3); // enum decodes as a number
    expect(first(res, 'color-supported')).toBe(true); // boolean, not "true"
    expect(first(res, 'printer-resolution-default')).toBe(600); // resolution's x
    expect(all(res, 'media-supported').length).toBeGreaterThan(20);
  });

  it('writes charset and language first, as RFC 8011 requires', () => {
    const body = encodeRequest({
      operation: 0x000b,
      requestId: 7,
      printerUri: 'ipps://printer:631/ipp/print',
      user: 'turminder',
    });
    expect(body.readUInt8(0)).toBe(2); // IPP 2.0
    expect(body.readUInt16BE(2)).toBe(0x000b);
    expect(body.readUInt32BE(4)).toBe(7);
    expect(body.readUInt8(8)).toBe(0x01); // operation-attributes group
    const text = body.toString('utf8');
    expect(text.indexOf('attributes-charset')).toBeLessThan(
      text.indexOf('attributes-natural-language'),
    );
    expect(text).toContain('ipps://printer:631/ipp/print');
    expect(body.readUInt8(body.length - 1)).toBe(0x03); // end-of-attributes
  });

  it('a truncated response is a failed decode, not a throw', () => {
    const half = IPP_ATTRIBUTES.subarray(0, 40);
    expect(() => decodeResponse(half)).not.toThrow();
    expect(decodeResponse(Buffer.alloc(3)).ok).toBe(false);
  });
});

describe('eSCL (§34.5)', () => {
  const client = (impl: typeof globalThis.fetch) =>
    new ScannerClient({ uri: 'https://scanner.local/eSCL', fetch: impl });

  const capabilitiesFetch = (async (url: any) => {
    const u = String(url);
    if (u.endsWith('/ScannerCapabilities'))
      return new Response(ESCL_CAPABILITIES, { status: 200 });
    if (u.endsWith('/ScannerStatus')) return new Response(ESCL_STATUS, { status: 200 });
    throw new Error(`unexpected ${u}`);
  }) as typeof globalThis.fetch;

  it('reads a real scanner’s capabilities', async () => {
    const caps = await client(capabilitiesFetch).capabilities();
    expect(caps.label).toBe('EPSON ET-3700 Series');
    expect(caps.sources).toEqual(['platen']); // no feeder on this one
    expect(caps.formats).toContain('application/pdf');
    expect(caps.resolutions_dpi).toEqual([100, 200, 300, 600, 1200]);
    expect(caps.color_modes).toContain('Grayscale8');
  });

  it('pulls feeder pages until the device says there are no more', async () => {
    let pulls = 0;
    const impl = (async (url: any, init: any) => {
      const u = String(url);
      if (u.endsWith('/ScanJobs')) {
        expect(init.method).toBe('POST');
        expect(String(init.body)).toContain('<pwg:InputSource>Feeder</pwg:InputSource>');
        return new Response('', { status: 201, headers: { location: '/eSCL/ScanJobs/abc' } });
      }
      if (u.endsWith('/NextDocument')) {
        pulls += 1;
        return pulls <= 2
          ? new Response(Buffer.from(`page${pulls}`), { status: 200 })
          : new Response('', { status: 404 });
      }
      throw new Error(`unexpected ${u}`);
    }) as typeof globalThis.fetch;

    const result = await client(impl).scan({
      source: 'adf',
      resolution_dpi: 300,
      color: 'color',
      format: 'jpeg',
    });
    expect(result.pages).toHaveLength(2);
    expect(result.mime).toBe('image/jpeg');
    expect(pulls).toBe(3); // the 404 is how it learns to stop
  });

  it('asks the glass exactly once, because asking twice re-scans it', async () => {
    let pulls = 0;
    const impl = (async (url: any) => {
      const u = String(url);
      if (u.endsWith('/ScanJobs')) {
        return new Response('', { status: 201, headers: { location: '/eSCL/ScanJobs/x' } });
      }
      // Only the pulls; the job release that follows is not a re-scan.
      if (u.endsWith('/NextDocument')) pulls += 1;
      return new Response(Buffer.from('%PDF-1.4'), { status: 200 });
    }) as typeof globalThis.fetch;
    const result = await client(impl).scan({
      source: 'platen',
      resolution_dpi: 300,
      color: 'color',
      format: 'pdf',
    });
    expect(result.pages).toHaveLength(1);
    expect(pulls).toBe(1);
  });

  it('never follows a Location back down to plain HTTP', async () => {
    // The bug that wedged a real scanner: the ET-3700 serves eSCL over HTTPS
    // on 443 and answers a successful POST with an absolute `http://` job URL,
    // where /eSCL is a 404. Trust that and the page never arrives (§34.2).
    const asked: string[] = [];
    const impl = (async (url: any) => {
      const u = String(url);
      asked.push(u);
      if (u.endsWith('/ScanJobs')) {
        return new Response('', {
          status: 201,
          headers: { location: 'http://192.168.0.90/eSCL/ScanJobs/abc' },
        });
      }
      return new Response(Buffer.from('img'), { status: 200 });
    }) as typeof globalThis.fetch;

    const secure = new ScannerClient({ uri: 'https://192.168.0.90/eSCL', fetch: impl });
    await secure.scan({
      source: 'platen',
      resolution_dpi: 300,
      color: 'color',
      format: 'jpeg',
    });
    expect(asked).toContain('https://192.168.0.90/eSCL/ScanJobs/abc/NextDocument');
    expect(asked.some((u) => u.startsWith('http://'))).toBe(false);
  });

  it('keeps its own port when the device names a different one', async () => {
    const asked: string[] = [];
    const impl = (async (url: any) => {
      asked.push(String(url));
      if (String(url).endsWith('/ScanJobs')) {
        return new Response('', {
          status: 201,
          headers: { location: 'https://elsewhere.invalid:9999/eSCL/ScanJobs/z' },
        });
      }
      return new Response(Buffer.from('img'), { status: 200 });
    }) as typeof globalThis.fetch;
    const client = new ScannerClient({ uri: 'https://192.168.0.90:8443/eSCL', fetch: impl });
    await client.scan({
      source: 'platen',
      resolution_dpi: 300,
      color: 'color',
      format: 'jpeg',
    });
    // Only the path is the device's to choose.
    expect(asked).toContain('https://192.168.0.90:8443/eSCL/ScanJobs/z/NextDocument');
    expect(asked.some((u) => u.includes('elsewhere.invalid'))).toBe(false);
  });

  it('reports a busy scanner as busy, not as a crash', async () => {
    const impl = (async () => new Response('', { status: 503 })) as typeof globalThis.fetch;
    await expect(
      client(impl).scan({
        source: 'platen',
        resolution_dpi: 300,
        color: 'color',
        format: 'pdf',
      }),
    ).rejects.toMatchObject({ code: 'busy' });
  });

  it('sends the minimal body — the fuller one is refused by real firmware', async () => {
    // Not a style preference: the reference ET-3700 answers 201 to this and
    // 409 Conflict to the sane-airscan shape with explicit `ScanRegions`.
    let body = '';
    const impl = (async (url: any, init: any) => {
      const u = String(url);
      if (u.endsWith('/ScanJobs')) {
        body = String(init.body);
        return new Response('', { status: 201, headers: { location: '/eSCL/ScanJobs/x' } });
      }
      return new Response(Buffer.from('img'), { status: 200 });
    }) as typeof globalThis.fetch;
    await client(impl).scan({
      source: 'platen',
      resolution_dpi: 300,
      color: 'gray',
      format: 'jpeg',
    });
    expect(body).not.toContain('ScanRegions');
    expect(body).not.toContain('DocumentFormatExt');
    expect(body).toContain('<pwg:InputSource>Platen</pwg:InputSource>');
    expect(body).toContain('<scan:ColorMode>Grayscale8</scan:ColorMode>');
    expect(body).toContain('<pwg:DocumentFormat>image/jpeg</pwg:DocumentFormat>');
    expect(body).toContain('<scan:XResolution>300</scan:XResolution>');
  });

  it('releases the job even when the scan succeeded', async () => {
    // Seen on the reference ET-3700: taking the single platen page does not
    // close the job — the device stays in Processing and 409s the next scan
    // until the job is deleted.
    const seen: string[] = [];
    const impl = (async (url: any, init: any) => {
      const u = String(url);
      seen.push(`${init?.method ?? 'GET'} ${u}`);
      if (u.endsWith('/ScanJobs')) {
        return new Response('', { status: 201, headers: { location: '/eSCL/ScanJobs/done' } });
      }
      return new Response(Buffer.from('page'), { status: 200 });
    }) as typeof globalThis.fetch;

    const result = await client(impl).scan({
      source: 'platen',
      resolution_dpi: 300,
      color: 'color',
      format: 'jpeg',
    });
    expect(result.pages).toHaveLength(1);
    expect(seen).toContain('DELETE https://scanner.local/eSCL/ScanJobs/done');
  });

  it('deletes a job it could not finish, so the next scan is not refused', async () => {
    // The other half of the same failure: an ET-3700 left holding a
    // half-pulled job sits in Processing and refuses every later scan until
    // it is power-cycled.
    const seen: string[] = [];
    const impl = (async (url: any, init: any) => {
      const u = String(url);
      seen.push(`${init?.method ?? 'GET'} ${u}`);
      if (u.endsWith('/ScanJobs')) {
        return new Response('', { status: 201, headers: { location: '/eSCL/ScanJobs/stuck' } });
      }
      if (u.endsWith('/NextDocument')) throw new Error('the network went away');
      return new Response('', { status: 200 });
    }) as typeof globalThis.fetch;

    await expect(
      client(impl).scan({
        source: 'platen',
        resolution_dpi: 300,
        color: 'color',
        format: 'pdf',
      }),
    ).rejects.toThrow(/network went away/);
    expect(seen).toContain('DELETE https://scanner.local/eSCL/ScanJobs/stuck');
  });

  it('probeScanner says no rather than throwing, for most of a subnet', async () => {
    const impl = (async () => new Response('', { status: 404 })) as typeof globalThis.fetch;
    expect(await probeScanner('https://nothing.local/eSCL', impl)).toBeNull();
  });
});

describe('the printer client (§34.4)', () => {
  const answering = (body: Buffer | string, status = 200) =>
    (async () => new Response(body, { status })) as typeof globalThis.fetch;

  it('reads capabilities off a real response', async () => {
    const client = new PrinterClient({
      uri: 'ipps://printer:631/ipp/print',
      fetch: answering(IPP_ATTRIBUTES),
    });
    const caps = await client.capabilities();
    expect(caps.formats).toEqual(ET3700_FORMATS);
    expect(caps.formats).not.toContain('application/pdf'); // the whole problem
    // media-ready (what is in the tray) beats media-default (what the firmware
    // shipped with): the device says letter, the tray holds A4.
    expect(caps.media_default).toBe('iso_a4_210x297mm');
    expect(caps.resolution_dpi).toBe(600);
  });

  it('reads ink levels and whether it is accepting work', async () => {
    const client = new PrinterClient({
      uri: 'ipps://printer:631/ipp/print',
      fetch: answering(IPP_ATTRIBUTES),
    });
    const state = await client.state();
    expect(state.state).toBe('idle');
    expect(state.accepting_jobs).toBe(true);
    expect(state.supplies.map((s) => s.name)).toContain('Black ink');
    expect(state.supplies.every((s) => s.low === false)).toBe(true);
  });

  it('explains a 426 instead of reporting a dead printer', async () => {
    const client = new PrinterClient({
      uri: 'ipp://printer:631/ipp/print',
      fetch: answering('', 426),
    });
    await expect(client.capabilities()).rejects.toThrow(/requires TLS/);
  });

  it('turns an IPP refusal into a sentence', async () => {
    const refusal = Buffer.alloc(9);
    refusal.writeUInt8(2, 0);
    refusal.writeUInt16BE(0x040a, 2); // document-format-not-supported
    refusal.writeUInt32BE(1, 4);
    refusal.writeUInt8(0x03, 8);
    const client = new PrinterClient({
      uri: 'ipps://printer:631/ipp/print',
      fetch: answering(refusal),
    });
    await expect(client.capabilities()).rejects.toBeInstanceOf(IppError);
    await expect(client.capabilities()).rejects.toThrow(/document format is not supported/);
  });

  it('POSTs an ipps:// URI to https, which URL.protocol silently will not do', async () => {
    let seen = '';
    const impl = (async (url: any) => {
      seen = String(url);
      return new Response(IPP_ATTRIBUTES, { status: 200 });
    }) as typeof globalThis.fetch;
    await new PrinterClient({
      uri: 'ipps://printer:631/ipp/print',
      fetch: impl,
    }).capabilities();
    expect(seen).toBe('https://printer:631/ipp/print');
    await new PrinterClient({ uri: 'ipp://printer:631/ipp/print', fetch: impl }).capabilities();
    expect(seen).toBe('http://printer:631/ipp/print');
  });

  it('sends the document format and the job options the caller asked for', async () => {
    let body = Buffer.alloc(0);
    const accepted = Buffer.alloc(9);
    accepted.writeUInt8(2, 0);
    accepted.writeUInt32BE(1, 4);
    accepted.writeUInt8(0x03, 8);
    const impl = (async (_url: any, init: any) => {
      body = Buffer.from(init.body);
      return new Response(accepted, { status: 200 });
    }) as typeof globalThis.fetch;
    const client = new PrinterClient({ uri: 'ipps://p:631/ipp/print', fetch: impl });
    await client.print(Buffer.from('JPEGDATA'), 'image/jpeg', {
      copies: 3,
      sides: 'two-sided-long-edge',
      media: 'iso_a4_210x297mm',
      color: 'monochrome',
      title: 'lease',
    });
    const text = body.toString('utf8');
    expect(text).toContain('document-format');
    expect(text).toContain('image/jpeg');
    expect(text).toContain('two-sided-long-edge');
    expect(text).toContain('lease');
    expect(text.endsWith('JPEGDATA')).toBe(true); // the document rides last
  });

  it('believes the reasons over the enum when they disagree', async () => {
    // Observed on the reference ET-3700, printing a page that came out fine:
    // job-state 9 (aborted) with job-state-reasons completed-successfully.
    const done = Buffer.concat([
      (() => {
        const h = Buffer.alloc(9);
        h.writeUInt8(2, 0);
        h.writeUInt32BE(1, 4);
        h.writeUInt8(0x02, 8);
        return h;
      })(),
      (() => {
        const b = Buffer.alloc(5 + 'job-state'.length + 4);
        let o = 0;
        b.writeUInt8(0x23, o); // enum
        o += 1;
        b.writeUInt16BE(9, o);
        o += 2;
        b.write('job-state', o);
        o += 9;
        b.writeUInt16BE(4, o);
        o += 2;
        b.writeInt32BE(9, o); // aborted
        return b;
      })(),
      (() => {
        const reason = 'completed-successfully';
        const b = Buffer.alloc(5 + 'job-state-reasons'.length + reason.length);
        let o = 0;
        b.writeUInt8(0x44, o); // keyword
        o += 1;
        b.writeUInt16BE(17, o);
        o += 2;
        b.write('job-state-reasons', o);
        o += 17;
        b.writeUInt16BE(reason.length, o);
        o += 2;
        b.write(reason, o);
        return b;
      })(),
      Buffer.from([0x03]),
    ]);
    const client = new PrinterClient({
      uri: 'ipps://printer:631/ipp/print',
      fetch: answering(done),
    });
    const job = await client.job(1);
    expect(job.state).toBe('completed');
    expect(job.state_reasons).toContain('completed-successfully');
  });

  it('probePrinter says no rather than throwing', async () => {
    const impl = (async () => new Response('nope', { status: 404 })) as typeof globalThis.fetch;
    expect(await probePrinter('ipps://nothing:631/ipp/print', impl)).toBeNull();
  });
});

/* ── Trust on first use (§34.2) ───────────────────────────────────────── */

describe('the certificate pin (§34.2)', () => {
  let server: https.Server;
  let port = 0;
  let hits = 0;

  const start = (cert: string, key: string) =>
    new Promise<void>((resolve) => {
      hits = 0;
      server = https.createServer(
        { cert: fixture(cert).toString(), key: fixture(key).toString() },
        (_req, res) => {
          hits += 1;
          res.writeHead(200, { 'content-type': 'text/plain' });
          res.end('hello');
        },
      );
      server.listen(0, '127.0.0.1', () => {
        port = (server.address() as { port: number }).port;
        resolve();
      });
    });

  afterEach(() => new Promise<void>((r) => server.close(() => r())));

  it('records the certificate it saw the first time', async () => {
    await start('device-cert.pem', 'device-key.pem');
    let seen: string | null = null;
    const res = await deviceFetch({ onCertificate: (fp) => (seen = fp) })(
      `https://127.0.0.1:${port}/eSCL/ScannerStatus`,
    );
    expect(res.status).toBe(200);
    expect(seen).toMatch(/^[0-9A-F]{2}(:[0-9A-F]{2}){31}$/);
    expect(hits).toBe(1);
  });

  it('talks to the certificate it recorded', async () => {
    await start('device-cert.pem', 'device-key.pem');
    let pinned: string | null = null;
    await deviceFetch({ onCertificate: (fp) => (pinned = fp) })(`https://127.0.0.1:${port}/`);
    const res = await deviceFetch({ fingerprint: pinned })(`https://127.0.0.1:${port}/`);
    expect(res.status).toBe(200);
    expect(hits).toBe(2);
  });

  it('sends nothing at all to a device whose certificate changed', async () => {
    // The printer was replaced, or somebody is standing in front of it. Either
    // way the request must die before a byte of it goes out.
    await start('other-cert.pem', 'other-key.pem');
    let stranger: string | null = null;
    await deviceFetch({ onCertificate: (fp) => (stranger = fp) })(`https://127.0.0.1:${port}/`);
    expect(hits).toBe(1);

    const wrong = 'AA:BB:CC:DD:EE:FF' + ':00'.repeat(26);
    await expect(
      deviceFetch({ fingerprint: wrong })(`https://127.0.0.1:${port}/eSCL/ScanJobs`, {
        method: 'POST',
        body: 'scan me',
      }),
    ).rejects.toBeInstanceOf(CertificateChanged);
    expect(hits).toBe(1); // the POST never reached the server
    expect(stranger).not.toBe(wrong);
  });
});

/* ── Format negotiation (§34.4) ───────────────────────────────────────── */

describe('getting a document into a format the printer reads (§34.4)', () => {
  const withPoppler = (pages: number) => ({
    systools: new SystoolRegistry({
      run: (_c, _a, stream) => (stream === 'stderr' ? 'pdftoppm version 24.08.0' : ''),
    }),
    rasterise: async () => Array.from({ length: pages }, (_, i) => Buffer.from(`jpeg${i}`)),
  });
  const withoutPoppler = {
    systools: new SystoolRegistry({
      run: () => {
        throw Object.assign(new Error('spawn'), { code: 'ENOENT' });
      },
      lookupPath: () => null,
    }),
  };
  const PDF = Buffer.from('%PDF-1.4 pretend');

  it('sends a PDF untouched to a printer that reads PDF', async () => {
    const out = await prepare(PDF, 'application/pdf', ['application/pdf'], 600, withPoppler(3));
    expect(out).toMatchObject({ converted: false, format: 'application/pdf', pages: 1 });
    expect('documents' in out && out.documents).toHaveLength(1);
  });

  it('rasterises for the printer that cannot — one job per page', async () => {
    const out = await prepare(PDF, 'application/pdf', ET3700_FORMATS, 600, withPoppler(3));
    expect(out).toMatchObject({ converted: true, format: 'image/jpeg', pages: 3 });
    expect('documents' in out && out.documents).toHaveLength(3);
  });

  it('names the missing binary instead of failing obscurely', async () => {
    const out = await prepare(PDF, 'application/pdf', ET3700_FORMATS, 600, withoutPoppler);
    expect(out).toMatchObject({ error: 'systool_missing' });
    expect((out as { hint: string }).hint).toContain('poppler-utils');
  });

  it('will not send a file it cannot identify — markdown is not a document', async () => {
    // What actually happened: .md has no entry in the mime map, so it arrives
    // as octet-stream; the printer advertises octet-stream; the note printed
    // as a page of hashes and asterisks.
    const out = await prepare(
      Buffer.from('# Shopping\n\n- milk\n'),
      'application/octet-stream',
      ET3700_FORMATS,
      600,
      withPoppler(1),
    );
    expect(out).toMatchObject({ error: 'render_first' });
    expect((out as { hint: string }).hint).toContain('docs.to_pdf');
  });

  it('does not treat octet-stream as a capability', async () => {
    // A printer listing octet-stream is offering to guess, not to render.
    const out = await prepare(
      Buffer.from('%PDF-1.4'),
      'application/pdf',
      ['application/octet-stream'],
      600,
      withPoppler(1),
    );
    expect(out).toMatchObject({ error: 'format_unsupported' });
  });

  it('refuses a format the printer cannot read, and says what it can', async () => {
    const out = await prepare(
      Buffer.from('PNG'),
      'image/png',
      ['image/jpeg'],
      300,
      withPoppler(1),
    );
    expect(out).toMatchObject({ error: 'format_unsupported', supported: ['image/jpeg'] });
  });

  it('refuses to turn one call into fifty jobs', async () => {
    const out = await prepare(PDF, 'application/pdf', ET3700_FORMATS, 300, withPoppler(80));
    expect(out).toMatchObject({ error: 'too_many_pages', pages: 80, max: 50 });
  });

  it('rasterises for a page range even when the printer reads PDF', async () => {
    const out = await prepare(
      PDF,
      'application/pdf',
      ['application/pdf'],
      600,
      withPoppler(2),
      { first: 2, last: 3 },
    );
    expect(out).toMatchObject({ converted: true, pages: 2 });
  });

  it('reads a page spec, and says so when it cannot', () => {
    expect(parsePages(undefined)).toBeNull();
    expect(parsePages('3')).toEqual({ first: 3, last: 3 });
    expect(parsePages(' 2 - 7 ')).toEqual({ first: 2, last: 7 });
    expect(parsePages('7-2')).toMatchObject({ error: expect.stringContaining('7-2') });
    expect(parsePages('last')).toMatchObject({ error: expect.stringContaining('page range') });
  });
});

/* ── The device registry (§34.1) ──────────────────────────────────────── */

const DEVICE: Device = DeviceSchema.parse({
  name: 'office',
  label: 'EPSON ET-3700 Series',
  host: '192.168.0.90',
  print: {
    uri: 'ipps://192.168.0.90:631/ipp/print',
    formats: ET3700_FORMATS,
    color: true,
    sides: ['one-sided'],
    media: ['iso_a4_210x297mm'],
    media_default: 'iso_a4_210x297mm',
    resolution_dpi: 600,
  },
  scan: {
    uri: 'https://192.168.0.90/eSCL',
    sources: ['platen'],
    formats: ['application/pdf', 'image/jpeg'],
    resolutions_dpi: [100, 300, 600],
    color_modes: ['RGB24'],
  },
});

describe('which machine did they mean (§34.4)', () => {
  const second: Device = DeviceSchema.parse({ ...DEVICE, name: 'label-printer', scan: null });

  it('picks the only one without being told', () => {
    expect(resolveDevice([DEVICE])).toEqual({ device: DEVICE });
  });

  it('refuses to guess when two are set up', () => {
    const out = resolveDevice([DEVICE, second]);
    expect(out).toMatchObject({ error: 'which_device', devices: ['office', 'label-printer'] });
  });

  it('names what could have been meant instead', () => {
    expect(resolveDevice([DEVICE], 'kitchen')).toMatchObject({
      error: 'unknown_device',
      devices: ['office'],
    });
  });

  it('says a device is switched off rather than saying nothing', () => {
    const off = DeviceSchema.parse({ ...DEVICE, enabled: false });
    expect(resolveDevice([off], 'office')).toMatchObject({ error: 'device_disabled' });
    // And it is not silently picked when nothing was named, either.
    expect(resolveDevice([off])).toMatchObject({ error: 'no_devices' });
  });

  it('keys a device password by name, in the secret store', () => {
    expect(passwordKey('office')).toBe('PRINTER_OFFICE_PASSWORD');
    expect(passwordKey('big-laser')).toBe('PRINTER_BIG_LASER_PASSWORD');
  });

  it('degrades a broken settings block to no devices, not to a crash', () => {
    const parsed = PrintScanSettingsSchema.safeParse({ devices: [{ name: 'NOT A SLUG' }] });
    expect(parsed.success).toBe(false);
    expect(PrintScanSettingsSchema.parse({})).toMatchObject({
      devices: [],
      scan_dir: 'scans',
      scan_inbox: 'scans/inbox',
    });
  });
});

/* ── The tools (App. F.19) ────────────────────────────────────────────── */

describe('print.* tools (App. F.19)', () => {
  let t: ReturnType<typeof tmpDir>;
  let files: FileStore;
  const meta = () => {
    const store = new Map<string, string>();
    return {
      json: <T>(key: string, fallback: T) =>
        store.has(key) ? (JSON.parse(store.get(key)!) as T) : fallback,
      setJson: (key: string, value: unknown) => store.set(key, JSON.stringify(value)),
    };
  };

  beforeEach(() => {
    t = tmpDir('turminder-print-');
    files = new FileStore({ root: path.join(t.dir, 'files'), git: null });
    files.ensure();
  });
  afterEach(() => t.cleanup());

  const tools = (devices: Device[], impl: typeof globalThis.fetch) =>
    printTools({
      settings: () => PrintScanSettingsSchema.parse({ devices }),
      files,
      meta: meta() as any,
      systools: new SystoolRegistry({
        run: (_c, _a, stream) => (stream === 'stderr' ? 'pdftoppm version 24.08.0' : ''),
      }),
      fetch: impl,
    });
  const tool = (list: ReturnType<typeof printTools>, name: string) =>
    list.find((d) => d.name === name)!;
  const ctx = { runId: null, eventId: null };

  const acceptedJob = (id: number) => {
    const buf = Buffer.alloc(9 + 4 + 'job-id'.length + 4 + 4);
    buf.writeUInt8(2, 0);
    buf.writeUInt32BE(1, 4);
    let o = 8;
    buf.writeUInt8(0x02, o); // job-attributes group
    o += 1;
    buf.writeUInt8(0x21, o); // integer
    o += 1;
    buf.writeUInt16BE(6, o);
    o += 2;
    buf.write('job-id', o);
    o += 6;
    buf.writeUInt16BE(4, o);
    o += 2;
    buf.writeInt32BE(id, o);
    o += 4;
    buf.writeUInt8(0x03, o);
    return buf.subarray(0, o + 1);
  };

  it('lists nothing, and says how to fix that', async () => {
    const list = tools([], (async () => new Response('')) as typeof globalThis.fetch);
    const result = (await tool(list, 'print.devices').execute({}, ctx)) as any;
    expect(result.devices).toEqual([]);
    expect(result.note).toContain('setup.printers');
    expect(tool(list, 'print.devices').isEmpty!(result)).toBe(true);
  });

  it('prints a PDF as one job per rasterised page, and says so', async () => {
    let jobs = 0;
    const impl = (async (_url: any, init: any) => {
      const body = Buffer.from(init.body);
      // The first byte after the header is the group tag; a print job carries
      // a document, a query does not.
      if (body.includes(Buffer.from('document-format'))) {
        jobs += 1;
        return new Response(acceptedJob(100 + jobs), { status: 200 });
      }
      return new Response(IPP_ATTRIBUTES, { status: 200 });
    }) as typeof globalThis.fetch;

    // Two pages of "PDF" — the fake poppler in `tools` is not consulted, so a
    // real rasterise would run; point the printer at a format it does read.
    files.writeBinary('reports/q4.jpg', Buffer.from('JPEGBYTES'), 'test');
    const list = tools([DEVICE], impl);
    const result = (await tool(list, 'print.document').execute(
      { path: 'reports/q4.jpg', copies: 2 },
      ctx,
    )) as any;
    expect(result.jobs).toHaveLength(1);
    expect(result.jobs[0].job_id).toBe(101);
    expect(result.converted).toBe(false);
    expect(jobs).toBe(1);
  });

  it('will not start a scan while a page is printing', async () => {
    // The failure this exists for: a scan started mid-print aborted the page,
    // and the firmware allowed it without a word (§34.4).
    const impl = (async (url: any) => {
      if (String(url).includes(':631')) return new Response(IPP_ATTRIBUTES, { status: 200 });
      return new Response(ESCL_STATUS, { status: 200 });
    }) as typeof globalThis.fetch;
    // The fixture says idle; make the printer say it is working instead.
    const printing = (async (url: any, init: any) => {
      if (String(url).includes(':631')) {
        const res = await impl(url, init);
        const buf = Buffer.from(await res.arrayBuffer());
        // printer-state 4 = processing, in place of the fixture's 3 = idle.
        const at = buf.indexOf(Buffer.from('printer-state')) + 'printer-state'.length + 2;
        buf.writeInt32BE(4, at);
        return new Response(buf, { status: 200 });
      }
      return impl(url, init);
    }) as typeof globalThis.fetch;

    const list = tools([DEVICE], printing);
    const result = (await tool(list, 'print.scan').execute({}, ctx)) as any;
    expect(result.error).toBe('device_busy');
    expect(result.busy_with).toBe('printing');
    expect(result.message).toContain('abort');
  });

  it('will not start a print while a scan job is actually running', async () => {
    // On a shared engine eSCL says Processing whenever the *printer* is busy,
    // so the job list is what distinguishes a real scan (§34.4).
    const SCANNING = ESCL_STATUS.replace(
      '<pwg:JobState>Completed</pwg:JobState>',
      '<pwg:JobState>Processing</pwg:JobState>',
    );
    const impl = (async (url: any) => {
      if (String(url).includes(':631')) return new Response(IPP_ATTRIBUTES, { status: 200 });
      return new Response(SCANNING, { status: 200 });
    }) as typeof globalThis.fetch;
    files.writeBinary('a.jpg', Buffer.from('x'), 'test');
    const list = tools([DEVICE], impl);
    const result = (await tool(list, 'print.document').execute({ path: 'a.jpg' }, ctx)) as any;
    expect(result.error).toBe('device_busy');
    expect(result.busy_with).toBe('scanning');
  });

  it('does not refuse work just because the busy check could not be made', async () => {
    // Being unable to ask is a worse reason to refuse than the risk it avoids.
    let jobs = 0;
    const impl = (async (url: any, init: any) => {
      const u = String(url);
      if (u.includes('/eSCL')) throw new Error('scanner half is unplugged');
      const body = Buffer.from(init.body);
      if (body.includes(Buffer.from('document-format'))) {
        jobs += 1;
        return new Response(acceptedJob(7), { status: 200 });
      }
      return new Response(IPP_ATTRIBUTES, { status: 200 });
    }) as typeof globalThis.fetch;
    files.writeBinary('b.jpg', Buffer.from('x'), 'test');
    const list = tools([DEVICE], impl);
    const result = (await tool(list, 'print.document').execute({ path: 'b.jpg' }, ctx)) as any;
    expect(result.jobs).toHaveLength(1);
    expect(jobs).toBe(1);
  });

  it('refuses a file that is not in the workspace', async () => {
    const list = tools([DEVICE], (async () => new Response('')) as typeof globalThis.fetch);
    const result = (await tool(list, 'print.document').execute(
      { path: 'nowhere/at/all.pdf' },
      ctx,
    )) as any;
    expect(result.error).toBe('not_found');
  });

  it('says which device it needs when two are set up', async () => {
    const second = DeviceSchema.parse({ ...DEVICE, name: 'label-printer' });
    files.writeBinary('a.jpg', Buffer.from('x'), 'test');
    const list = tools(
      [DEVICE, second],
      (async () => new Response('')) as typeof globalThis.fetch,
    );
    const result = (await tool(list, 'print.document').execute({ path: 'a.jpg' }, ctx)) as any;
    expect(result.error).toBe('which_device');
    expect(result.devices).toEqual(['office', 'label-printer']);
  });

  it('puts a scan in the workspace and hands back a path, never bytes', async () => {
    const impl = (async (url: any) => {
      const u = String(url);
      if (u.endsWith('/ScanJobs')) {
        return new Response('', { status: 201, headers: { location: '/eSCL/ScanJobs/1' } });
      }
      if (u.endsWith('/NextDocument')) {
        return new Response(Buffer.from('%PDF-1.4 scanned'), { status: 200 });
      }
      throw new Error(`unexpected ${u}`);
    }) as typeof globalThis.fetch;

    const list = tools([DEVICE], impl);
    const result = (await tool(list, 'print.scan').execute({}, ctx)) as any;
    // JPEG by default: the reference device accepts a PDF job and then never
    // produces the document (§34.5).
    expect(result.path).toMatch(/^scans\/.*-scan\.jpg$/);
    expect(result.mime).toBe('image/jpeg');
    expect(result.pages).toBe(1);
    expect(JSON.stringify(result)).not.toContain('scanned'); // no bytes in the result
    expect(fs.readFileSync(files.resolve(result.path)).toString()).toContain('scanned');
  });

  it('will not scan at a resolution the device does not offer', async () => {
    const list = tools([DEVICE], (async () => new Response('')) as typeof globalThis.fetch);
    const result = (await tool(list, 'print.scan').execute(
      { resolution_dpi: 1200 },
      ctx,
    )) as any;
    expect(result.error).toBe('unsupported_setting');
    expect(result.supported.resolutions_dpi).toEqual([100, 300, 600]);
  });

  it('stops on a changed certificate and says so in both fingerprints', async () => {
    const impl = (async () => {
      throw new CertificateChanged('AA:BB', 'CC:DD');
    }) as typeof globalThis.fetch;
    files.writeBinary('a.jpg', Buffer.from('x'), 'test');
    const list = tools([DEVICE], impl);
    const printed = (await tool(list, 'print.document').execute({ path: 'a.jpg' }, ctx)) as any;
    expect(printed).toMatchObject({
      error: 'certificate_changed',
      expected: 'AA:BB',
      seen: 'CC:DD',
    });
    const scanned = (await tool(list, 'print.scan').execute({}, ctx)) as any;
    expect(scanned.error).toBe('certificate_changed');
  });

  it('never lets a device password reach a result, an argument, or a log', async () => {
    // §27: the password rides one Authorization header and appears nowhere a
    // model, a trace, or a reader of `print.devices` can see it.
    const SENTINEL = 'sentinel-printer-password';
    // Every header seen, not the last: `print.status` asks the scanner too,
    // and the scanner call carries no authorization at all.
    const authorizations: (string | null)[] = [];
    const impl = (async (_url: any, init: any) => {
      authorizations.push(init.headers?.authorization ?? null);
      return new Response(IPP_ATTRIBUTES, { status: 200 });
    }) as typeof globalThis.fetch;

    const list = printTools({
      settings: () => PrintScanSettingsSchema.parse({ devices: [DEVICE] }),
      files,
      meta: meta() as any,
      systools: new SystoolRegistry(),
      secret: (key) => (key === passwordKey('office') ? SENTINEL : undefined),
      fetch: impl,
    });
    const status = await tool(list, 'print.status').execute({}, ctx);
    const devices = await tool(list, 'print.devices').execute({}, ctx);
    const basic = Buffer.from(`turminder:${SENTINEL}`).toString('base64');
    expect(authorizations.some((h) => h?.includes(basic))).toBe(true);
    expect(JSON.stringify(status)).not.toContain(SENTINEL);
    expect(JSON.stringify(devices)).not.toContain(SENTINEL);
    // And not through the key name either — the record holds neither.
    expect(JSON.stringify(devices)).not.toContain('PASSWORD');
  });

  it('puts pages and copies in front of whoever approves it', () => {
    const list = tools([DEVICE], (async () => new Response('')) as typeof globalThis.fetch);
    const summary = tool(list, 'print.document').confirmSummary!({
      path: 'notes/lease.pdf',
      copies: 3,
      pages: '2-7',
    });
    expect(summary.action).toContain('notes/lease.pdf');
    expect(summary.lines.map((l) => l.label)).toEqual(['File', 'Printer', 'Copies', 'Pages']);
  });
});

/* ── Discovery (§34.3) ────────────────────────────────────────────────── */

describe('finding devices (§34.3)', () => {
  /** A DNS-SD answer packet, assembled the way a printer would. */
  function mdnsResponse(): Buffer {
    const name = (n: string) =>
      Buffer.concat([
        ...n
          .split('.')
          .filter(Boolean)
          .map((label) => Buffer.concat([Buffer.from([label.length]), Buffer.from(label)])),
        Buffer.from([0]),
      ]);
    const record = (n: string, type: number, data: Buffer) => {
      const head = Buffer.alloc(10);
      head.writeUInt16BE(type, 0);
      head.writeUInt16BE(1, 2); // class IN
      head.writeUInt32BE(120, 4);
      head.writeUInt16BE(data.length, 8);
      return Buffer.concat([name(n), head, data]);
    };
    const instance = 'EPSON ET-3700 Series._ipps._tcp.local';
    const srv = Buffer.concat([Buffer.alloc(6), name('epson.local')]);
    srv.writeUInt16BE(631, 4);
    const txt = Buffer.concat([
      Buffer.from([12]),
      Buffer.from('rp=ipp/print'),
      Buffer.from([9]),
      Buffer.from('ty=EPSON2'),
    ]);
    const answers = [
      record('_ipps._tcp.local', 12, name(instance)),
      record(instance, 33, srv),
      record(instance, 16, txt),
      record('epson.local', 1, Buffer.from([192, 168, 0, 90])),
    ];
    const header = Buffer.alloc(12);
    header.writeUInt16BE(0x8400, 2); // response, authoritative
    header.writeUInt16BE(answers.length, 6);
    return Buffer.concat([header, ...answers]);
  }

  it('assembles PTR, SRV, TXT and A into one candidate', () => {
    const [candidate, ...rest] = collect([mdnsResponse()]);
    expect(rest).toHaveLength(0);
    expect(candidate).toMatchObject({ label: 'EPSON ET-3700 Series', host: '192.168.0.90' });
    expect(candidate!.uris).toEqual(['ipps://192.168.0.90:631/ipp/print']);
  });

  it('ignores a packet it cannot make sense of', () => {
    expect(collect([Buffer.alloc(4)])).toEqual([]);
    expect(collect([mdnsResponse().subarray(0, 30)])).toEqual([]);
  });

  it('confirms every candidate with a real protocol call', async () => {
    const impl = (async (url: any) => {
      const u = String(url);
      if (u.startsWith('https://192.168.0.90:631')) return new Response(IPP_ATTRIBUTES);
      if (u.startsWith('https://192.168.0.90/eSCL')) return new Response(ESCL_CAPABILITIES);
      return new Response('', { status: 404 });
    }) as typeof globalThis.fetch;

    const result = await discover({
      fetchFor: () => impl,
      browse: async () => [
        {
          label: 'ET-3700',
          host: '192.168.0.90',
          uris: ['ipps://192.168.0.90:631/ipp/print', 'https://192.168.0.90/eSCL'],
        },
        // Something on the network that answers a port but is not a printer.
        { label: 'nas', host: '192.168.0.5', uris: ['ipps://192.168.0.5:631/ipp/print'] },
      ],
    });
    expect(result.method).toBe('mdns');
    expect(result.found).toHaveLength(1);
    expect(result.found[0]).toMatchObject({ host: '192.168.0.90' });
    expect(result.found[0]!.print).not.toBeNull();
    expect(result.found[0]!.scan).not.toBeNull();
  });

  it('sweeps only when multicast produced nothing', async () => {
    let swept = 0;
    const impl = (async (url: any) =>
      String(url).includes(':631')
        ? new Response(IPP_ATTRIBUTES)
        : new Response('', { status: 404 })) as typeof globalThis.fetch;

    const quiet = await discover({
      fetchFor: () => impl,
      browse: async () => [],
      sweep: async () => {
        swept += 1;
        return [{ host: '192.168.0.90', ports: [631] }];
      },
    });
    expect(swept).toBe(1);
    expect(quiet.method).toBe('sweep');
    expect(quiet.found).toHaveLength(1);

    await discover({
      fetchFor: () => impl,
      browse: async () => [
        { label: 'x', host: '10.0.0.2', uris: ['ipps://10.0.0.2:631/ipp/print'] },
      ],
      sweep: async () => {
        swept += 1;
        return [];
      },
    });
    expect(swept).toBe(1); // mDNS answered, so the network was left alone
  });
});

/* ── The setup wizard (§34.6) ─────────────────────────────────────────── */

describe('setup.printers (§34.6)', () => {
  let t: ReturnType<typeof tmpDir>;
  let home: DataHome;
  let config: Config;
  let broker: FormBroker;
  /** Answers the wizard's forms in order, the way a person would. */
  let answers: Record<string, string>[];

  beforeEach(() => {
    t = tmpDir('turminder-printers-');
    home = openDataHome(path.join(t.dir, 'home')).home;
    config = new Config(home);
    broker = new FormBroker(home, config);
    answers = [];
    broker.attach({
      send: (type, payload) => {
        if (type !== 'form.request') return;
        const reply = answers.shift() ?? {};
        // Next tick: `request` has not returned its promise yet.
        setTimeout(() => broker.submit(String(payload.form_id), reply), 0);
      },
    });
  });
  afterEach(() => t.cleanup());

  const deps = (impl: typeof globalThis.fetch): PrinterSetupDeps => ({
    home,
    config,
    intake: { submit: () => undefined } as any,
    reloadIntegrations: async () => ['print.devices', 'print.document'],
    forms: broker,
    fetch: impl,
    // The real one listens for multicast and then sweeps a /24; what is under
    // test here is the wizard's own behaviour, not the network's.
    discover: async () => ({ found: [], method: 'mdns' as const }),
  });
  const ctx = { runId: 'run1', eventId: null, conversationId: 'conv1' };

  /** A machine that answers as both halves of an all-in-one. */
  const answering = (async (url: any) => {
    const u = String(url);
    if (u.startsWith('https://192.168.0.90:631')) return new Response(IPP_ATTRIBUTES);
    if (u.startsWith('https://192.168.0.90/eSCL')) return new Response(ESCL_CAPABILITIES);
    return new Response('', { status: 404 });
  }) as typeof globalThis.fetch;
  const silent = (async () => new Response('', { status: 404 })) as typeof globalThis.fetch;

  const devices = () =>
    PrintScanSettingsSchema.parse(
      config.integrations().integrations['print-scan']?.settings ?? {},
    ).devices;

  it('adds the first device, and that activates the integration', async () => {
    answers = [{ address: '192.168.0.90', name: 'office' }];
    const out = (await runPrinterWizard(deps(answering), ctx)) as any;
    expect(out).toMatchObject({
      action: 'added',
      device: 'office',
      can_print: true,
      can_scan: true,
      activated: true,
    });
    config.reload();
    expect(config.integrations().integrations['print-scan']?.active).toBe(true);
    const [device] = devices();
    expect(device).toMatchObject({ name: 'office', host: '192.168.0.90', enabled: true });
    expect(device!.print!.formats).toEqual(ET3700_FORMATS);
    expect(device!.probed_at).toBeTruthy();
  });

  it('writes nothing when the machine did not answer', async () => {
    answers = [{ address: '10.0.0.9', name: 'ghost' }];
    const out = (await runPrinterWizard(deps(silent), ctx)) as any;
    expect(out).toMatchObject({ added: false, error: 'unreachable' });
    expect(out.message).toContain('10.0.0.9');
    config.reload();
    expect(config.integrations().integrations['print-scan']).toBeUndefined();
  });

  it('offers what discovery found, and takes a typed address over the list', async () => {
    answers = [{ address: '192.168.0.90', name: 'office' }];
    await runPrinterWizard(deps(answering), ctx);
    config.reload();

    // Second time round: the first form chooses, the second edits.
    answers = [{ device: 'office' }, { action: 'switch it off', address: '192.168.0.90' }];
    const out = (await runPrinterWizard(deps(answering), ctx)) as any;
    expect(out).toMatchObject({ action: 'disabled', device: 'office' });
    config.reload();
    expect(devices()[0]!.enabled).toBe(false);
    // And a disabled device is offered back with its state visible.
    expect(resolveDevice(devices(), 'office')).toMatchObject({ error: 'device_disabled' });
  });

  it('removes a device without forgetting its password', async () => {
    answers = [{ address: '192.168.0.90', name: 'office' }];
    await runPrinterWizard(deps(answering), ctx);
    config.reload();

    answers = [{ device: 'office' }, { action: 'remove it', address: '192.168.0.90' }];
    const out = (await runPrinterWizard(deps(answering), ctx)) as any;
    expect(out).toMatchObject({ action: 'removed', device: 'office', secret_retained: true });
    config.reload();
    expect(devices()).toEqual([]);
    // The record survives with no devices, so the next add is one form.
    expect(config.integrations().integrations['print-scan']?.active).toBe(true);
  });

  it('re-probes on an address change, so a moved printer stops lying', async () => {
    answers = [{ address: '192.168.0.90', name: 'office' }];
    await runPrinterWizard(deps(answering), ctx);
    config.reload();
    answers = [{ device: 'office' }, { action: 'save changes', address: '10.0.0.9' }];
    const out = (await runPrinterWizard(deps(silent), ctx)) as any;
    expect(out).toMatchObject({ updated: false, error: 'unreachable' });
    config.reload();
    expect(devices()[0]!.host).toBe('192.168.0.90'); // unchanged: nothing was written
  });

  it('a cancelled form writes nothing at all', async () => {
    const cancelling = new FormBroker(home, config);
    cancelling.attach({
      send: (type, payload) => {
        if (type === 'form.request')
          setTimeout(() => cancelling.cancel(String(payload.form_id)), 0);
      },
    });
    const out = (await runPrinterWizard({ ...deps(answering), forms: cancelling }, ctx)) as any;
    expect(out).toMatchObject({ submitted: false, reason: 'cancelled' });
    config.reload();
    expect(config.integrations().integrations['print-scan']).toBeUndefined();
  });

  it('needs a conversation, because a form has to be rendered somewhere', async () => {
    const out = (await runPrinterWizard(deps(answering), {
      runId: null,
      eventId: null,
    })) as any;
    expect(out.error).toBe('no_conversation');
  });

  it('slugs a device name from what the machine calls itself', () => {
    expect(slug('EPSON ET-3700 Series')).toBe('epson-et-3700-series');
    expect(slug('  ')).toBe('printer');
    expect(hostOf('https://192.168.0.90:631/ipp/print')).toBe('192.168.0.90');
    expect(hostOf('192.168.0.90')).toBe('192.168.0.90');
  });
});
