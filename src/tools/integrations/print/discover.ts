import dgram from 'node:dgram';
import net from 'node:net';
import os from 'node:os';
import { log } from '../../../core/logger.js';
import {
  DISCOVERY_WINDOW_MS,
  PROBE_TIMEOUT_MS,
  SWEEP_CONCURRENCY,
  SWEEP_TIMEOUT_MS,
} from './constants.js';
import { probePrinter, type PrinterCapabilities } from './printer.js';
import { probeScanner, type ScannerCapabilities } from './escl.js';

const l = log('tool:print');

const MDNS_ADDRESS = '224.0.0.251';
const MDNS_PORT = 5353;

/** The four services that matter: print and scan, plain and TLS (§34.3). */
const SERVICES = [
  '_ipp._tcp.local',
  '_ipps._tcp.local',
  '_uscan._tcp.local',
  '_uscans._tcp.local',
];

export interface Candidate {
  label: string;
  host: string;
  /** Every URI worth probing, printer and scanner alike. */
  uris: string[];
}

export interface Discovered {
  label: string;
  host: string;
  print: PrinterCapabilities | null;
  scan: ScannerCapabilities | null;
}

export interface DiscoveryResult {
  found: Discovered[];
  method: 'mdns' | 'sweep';
}

/* ── DNS wire format ──────────────────────────────────────────────────────
 * Enough of it to ask four questions and read the answers. Names are
 * length-prefixed labels; anything in an answer may be a compression pointer
 * back into the packet, which is why reading a name needs the whole buffer.
 */

function encodeName(name: string): Buffer {
  const parts = name.split('.').filter(Boolean);
  const out: Buffer[] = [];
  for (const part of parts) {
    const label = Buffer.from(part, 'utf8');
    out.push(Buffer.from([label.length]), label);
  }
  out.push(Buffer.from([0]));
  return Buffer.concat(out);
}

function query(unicastResponse: boolean): Buffer {
  const header = Buffer.alloc(12);
  header.writeUInt16BE(0, 0); // transaction id: mDNS ignores it
  header.writeUInt16BE(0, 2); // standard query
  header.writeUInt16BE(SERVICES.length, 4);
  const questions = SERVICES.map((service) =>
    Buffer.concat([
      encodeName(service),
      // PTR, class IN — with the top bit of the class set when we want the
      // answer sent straight back to us rather than to the multicast group.
      Buffer.from([0x00, 0x0c, unicastResponse ? 0x80 : 0x00, 0x01]),
    ]),
  );
  return Buffer.concat([header, ...questions]);
}

function readName(buf: Buffer, offset: number): { name: string; next: number } {
  const parts: string[] = [];
  let o = offset;
  let next = -1;
  let hops = 0;
  while (o < buf.length) {
    const length = buf.readUInt8(o);
    if (length === 0) {
      o += 1;
      break;
    }
    if ((length & 0xc0) === 0xc0) {
      // A pointer. Where the name continues, not where the record does.
      if (o + 1 >= buf.length) break;
      const pointer = ((length & 0x3f) << 8) | buf.readUInt8(o + 1);
      if (next < 0) next = o + 2;
      o = pointer;
      if (++hops > 16) break; // a packet that points at itself
      continue;
    }
    if (o + 1 + length > buf.length) break;
    parts.push(buf.subarray(o + 1, o + 1 + length).toString('utf8'));
    o += 1 + length;
  }
  return { name: parts.join('.'), next: next >= 0 ? next : o };
}

interface Record_ {
  name: string;
  type: number;
  data: Buffer;
  offset: number;
}

function parseRecords(buf: Buffer): Record_[] {
  if (buf.length < 12) return [];
  const counts = [
    buf.readUInt16BE(4),
    buf.readUInt16BE(6),
    buf.readUInt16BE(8),
    buf.readUInt16BE(10),
  ];
  let o = 12;
  // Questions carry no data, but they have to be walked to find the answers.
  for (let i = 0; i < counts[0]!; i++) {
    o = readName(buf, o).next + 4;
  }
  const records: Record_[] = [];
  const total = counts[1]! + counts[2]! + counts[3]!;
  for (let i = 0; i < total && o < buf.length; i++) {
    const { name, next } = readName(buf, o);
    o = next;
    if (o + 10 > buf.length) break;
    const type = buf.readUInt16BE(o);
    const length = buf.readUInt16BE(o + 8);
    o += 10;
    if (o + length > buf.length) break;
    records.push({ name, type, data: buf.subarray(o, o + length), offset: o });
    o += length;
  }
  return records;
}

function parseTxt(data: Buffer): Record<string, string> {
  const out: Record<string, string> = {};
  let o = 0;
  while (o < data.length) {
    const length = data.readUInt8(o);
    o += 1;
    if (o + length > data.length) break;
    const entry = data.subarray(o, o + length).toString('utf8');
    o += length;
    const eq = entry.indexOf('=');
    if (eq > 0) out[entry.slice(0, eq).toLowerCase()] = entry.slice(eq + 1);
  }
  return out;
}

interface Service {
  instance: string;
  service: string;
  target?: string;
  port?: number;
  txt?: Record<string, string>;
}

/**
 * Assemble DNS-SD answers into candidates. Pure, and separate from the socket
 * on purpose: multicast is blocked on plenty of networks — including the one
 * this was written on — so the only way to test the wire format is to hand it
 * packets.
 *
 * Answers arrive in pieces: a PTR now, its SRV and TXT in the same packet, the
 * A record sometimes in a later one. Everything is collected by name and
 * joined at the end.
 */
export function collect(messages: Buffer[]): Candidate[] {
  const services = new Map<string, Service>();
  const addresses = new Map<string, string>();

  for (const msg of messages) {
    for (const record of parseRecords(msg)) {
      const serviceOf = (name: string) => SERVICES.find((s) => name.endsWith(s)) ?? '';
      if (record.type === 12) {
        // PTR: <instance>.<service>
        const { name: instance } = readName(msg, record.offset);
        const service = serviceOf(record.name);
        if (!service || !instance) continue;
        const existing = services.get(instance) ?? { instance, service };
        existing.service = service;
        services.set(instance, existing);
      } else if (record.type === 33 && record.data.length >= 6) {
        // SRV: priority, weight, port, target
        const { name: target } = readName(msg, record.offset + 6);
        const existing = services.get(record.name) ?? {
          instance: record.name,
          service: serviceOf(record.name),
        };
        existing.port = record.data.readUInt16BE(4);
        existing.target = target;
        services.set(record.name, existing);
      } else if (record.type === 16) {
        const existing = services.get(record.name) ?? {
          instance: record.name,
          service: serviceOf(record.name),
        };
        existing.txt = { ...existing.txt, ...parseTxt(record.data) };
        services.set(record.name, existing);
      } else if (record.type === 1 && record.data.length === 4) {
        addresses.set(record.name, Array.from(record.data).join('.'));
      }
    }
  }

  // One candidate per host: the all-in-one answers on all four services and is
  // one machine, not four.
  const byHost = new Map<string, Candidate>();
  for (const service of services.values()) {
    if (!service.target || !service.port || !service.service) continue;
    const host = addresses.get(service.target) ?? service.target;
    if (!host) continue;
    const label = service.instance.split('._')[0]!.replace(/\\032/g, ' ') || host;
    const scan = service.service.startsWith('_uscan');
    const secure =
      service.service === '_ipps._tcp.local' || service.service === '_uscans._tcp.local';
    const path = (
      scan ? (service.txt?.rs ?? 'eSCL') : (service.txt?.rp ?? 'ipp/print')
    ).replace(/^\/+/, '');
    const defaultPort = secure ? 443 : 80;
    const uri = scan
      ? `${secure ? 'https' : 'http'}://${host}${service.port === defaultPort ? '' : `:${service.port}`}/${path}`
      : `${secure ? 'ipps' : 'ipp'}://${host}:${service.port}/${path}`;
    const entry = byHost.get(host) ?? { label, host, uris: [] };
    if (!entry.uris.includes(uri)) entry.uris.push(uri);
    byHost.set(host, entry);
  }
  return [...byHost.values()];
}

/** Ask the network, then hand what came back to `collect`. */
async function browse(windowMs: number): Promise<Candidate[]> {
  const messages: Buffer[] = [];

  const socket = await new Promise<dgram.Socket | null>((resolve) => {
    const s = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    s.once('error', (e) => {
      l.debug({ err: e.message }, 'mdns socket could not bind 5353; falling back to unicast');
      s.close();
      resolve(null);
    });
    s.bind(MDNS_PORT, () => resolve(s));
  });

  // Port 5353 is held by avahi or mDNSResponder on plenty of machines. An
  // ephemeral port with the unicast-response bit set is the fallback: fewer
  // devices honour it, but "fewer" beats "none".
  const unicast = socket === null;
  const sock =
    socket ??
    (await new Promise<dgram.Socket>((resolve) => {
      const s = dgram.createSocket({ type: 'udp4' });
      s.bind(0, () => resolve(s));
    }));

  sock.on('message', (msg) => messages.push(msg));

  const packet = query(unicast);
  // Once per interface, not once per host: on a box with docker0 and a
  // wireguard tunnel alongside the wifi, the default multicast route is
  // whichever the kernel picked, and it is regularly not the one the printer
  // is on. Joining and sending per interface is the difference between
  // "no printers here" and the truth.
  const interfaces = localAddresses();
  for (const address of interfaces.length ? interfaces : [null]) {
    try {
      if (address) {
        sock.addMembership(MDNS_ADDRESS, address);
        sock.setMulticastInterface(address);
      }
    } catch {
      /* an interface with no multicast route; the next one may work */
    }
    sock.send(packet, 0, packet.length, MDNS_PORT, MDNS_ADDRESS);
  }
  await new Promise((r) => setTimeout(r, windowMs));
  sock.close();
  return collect(messages);
}

/* ── The fallback sweep ───────────────────────────────────────────────── */

/** Every non-loopback IPv4 address this host holds. */
function localAddresses(): string[] {
  const found: string[] = [];
  for (const addresses of Object.values(os.networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (address.family === 'IPv4' && !address.internal) found.push(address.address);
    }
  }
  return found;
}

/** This host's own IPv4 /24s. A machine on two networks sweeps both. */
function localSubnets(): string[] {
  const prefixes = new Set<string>();
  for (const addresses of Object.values(os.networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (address.family !== 'IPv4' || address.internal) continue;
      // Only /24 and narrower: sweeping a /16 is 65k connections and an hour.
      const bits = Number(address.cidr?.split('/')[1] ?? 24);
      if (bits < 24) continue;
      prefixes.add(address.address.split('.').slice(0, 3).join('.'));
    }
  }
  return [...prefixes];
}

function tcpOpen(host: string, port: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    const done = (open: boolean) => {
      socket.destroy();
      resolve(open);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
    socket.connect(port, host);
  });
}

export interface SweepHit {
  host: string;
  /** Which of the interesting ports answered — the probe phase reads this. */
  ports: number[];
}

async function sweep(): Promise<SweepHit[]> {
  const hosts: string[] = [];
  for (const prefix of localSubnets()) {
    for (let i = 1; i < 255; i++) hosts.push(`${prefix}.${i}`);
  }
  const alive: SweepHit[] = [];
  let cursor = 0;
  const worker = async () => {
    while (cursor < hosts.length) {
      const host = hosts[cursor++]!;
      // 631 is IPP, 443 is where a TLS-only device keeps eSCL. Port 80 is left
      // out deliberately: every third thing on a home network answers on it,
      // and none of them are printers.
      const probes = await Promise.all(
        [631, 443].map(async (port) =>
          (await tcpOpen(host, port, SWEEP_TIMEOUT_MS)) ? port : 0,
        ),
      );
      const ports = probes.filter(Boolean);
      if (ports.length) alive.push({ host, ports });
    }
  };
  await Promise.all(Array.from({ length: SWEEP_CONCURRENCY }, worker));
  return alive;
}

/**
 * The URIs worth trying on a host the sweep found. Driven by which port
 * answered, because probing all four everywhere is how a discovery that should
 * take five seconds takes twenty: a home network is full of things listening
 * on 443, and none of them speak IPP.
 */
function guessUris(hit: SweepHit): string[] {
  const uris: string[] = [];
  if (hit.ports.includes(631)) {
    uris.push(`ipps://${hit.host}:631/ipp/print`, `ipp://${hit.host}:631/ipp/print`);
  }
  if (hit.ports.includes(443)) uris.push(`https://${hit.host}/eSCL`);
  return uris;
}

export interface DiscoverDeps {
  /** Built per candidate: a first probe has no fingerprint to pin (§34.2). */
  fetchFor: (host: string) => typeof globalThis.fetch;
  timeoutMs?: number;
  windowMs?: number;
  /** Substituted in tests, which have neither a network nor four seconds. */
  browse?: (windowMs: number) => Promise<Candidate[]>;
  sweep?: () => Promise<SweepHit[]>;
}

/**
 * Find printers and scanners (§34.3). mDNS first because it is exact and
 * instant; the sweep only when multicast produced nothing, because a network
 * scan is a rude thing to do speculatively. Either way every candidate is
 * confirmed by a real protocol call before it is offered to anyone — an open
 * port is not a printer.
 */
export async function discover(deps: DiscoverDeps): Promise<DiscoveryResult> {
  const windowMs = deps.windowMs ?? DISCOVERY_WINDOW_MS;
  const timeoutMs = deps.timeoutMs ?? PROBE_TIMEOUT_MS;

  let candidates = await (deps.browse ?? browse)(windowMs);
  let method: DiscoveryResult['method'] = 'mdns';
  if (!candidates.length) {
    l.info('mdns found nothing; sweeping the local subnet');
    const hits = await (deps.sweep ?? sweep)();
    candidates = hits.map((hit) => ({ label: hit.host, host: hit.host, uris: guessUris(hit) }));
    method = 'sweep';
  }

  const found: Discovered[] = [];
  for (const candidate of candidates) {
    const fetchImpl = deps.fetchFor(candidate.host);
    let print: PrinterCapabilities | null = null;
    let scan: ScannerCapabilities | null = null;
    for (const uri of candidate.uris) {
      const isScan = uri.includes('/eSCL');
      if (isScan && !scan) scan = await probeScanner(uri, fetchImpl, timeoutMs);
      else if (!isScan && !print) print = await probePrinter(uri, fetchImpl, timeoutMs);
    }
    if (!print && !scan) continue;
    found.push({
      label: print?.label ?? scan?.label ?? candidate.label,
      host: candidate.host,
      print,
      scan,
    });
  }
  l.info({ method, candidates: candidates.length, found: found.length }, 'device discovery');
  return { found, method };
}
