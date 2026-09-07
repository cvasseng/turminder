/**
 * IPP, by hand (§34.1). The protocol is a binary envelope over HTTP: a short
 * header, then attribute groups, then — for `Print-Job` — the document itself.
 * There is no library for it in App. J and there does not need to be: the four
 * operations this system uses are a couple of hundred lines, and a printer's
 * answer is a flat list of named values.
 *
 * The encoding rules that matter, because they are the ones that bite:
 *   - every attribute is `tag | name-length | name | value-length | value`;
 *   - a *second* value for the same attribute is written with a name-length of
 *     zero, which is how `document-format-supported` carries four types;
 *   - collections (`media-col`) are ordinary attributes with begCollection /
 *     memberAttrName / endCollection tags, so a flat reader walks them
 *     correctly even when it has nothing to say about them.
 */

/** Delimiters. Anything below 0x10 ends the previous group and starts a new one. */
const GROUP = {
  operation: 0x01,
  job: 0x02,
  end: 0x03,
  printer: 0x04,
} as const;

/** Value tags, named where we write them. */
const TAG = {
  integer: 0x21,
  boolean: 0x22,
  enum: 0x23,
  resolution: 0x32,
  range: 0x33,
  keyword: 0x44,
  uri: 0x45,
  charset: 0x47,
  naturalLanguage: 0x48,
  mimeMediaType: 0x49,
  nameWithoutLanguage: 0x42,
  textWithoutLanguage: 0x41,
} as const;

export const IPP_OPERATION = {
  printJob: 0x0002,
  cancelJob: 0x0008,
  getJobAttributes: 0x0009,
  getPrinterAttributes: 0x000b,
} as const;

export type IppValue = string | number | boolean;

/** One decoded response: a status line and every attribute the printer sent. */
export interface IppResponse {
  statusCode: number;
  /** True for the `successful-ok*` family — including the two that substituted
   *  or ignored an attribute, which is a printer being helpful, not a failure. */
  ok: boolean;
  attributes: Record<string, IppValue[]>;
}

interface Attribute {
  tag: number;
  name: string;
  value: IppValue;
}

function encodeAttribute(tag: number, name: string, value: string | number | boolean): Buffer {
  const nameBuf = Buffer.from(name, 'utf8');
  let valueBuf: Buffer;
  if (typeof value === 'number') {
    valueBuf = Buffer.alloc(4);
    valueBuf.writeInt32BE(value);
  } else if (typeof value === 'boolean') {
    valueBuf = Buffer.from([value ? 1 : 0]);
  } else {
    valueBuf = Buffer.from(value, 'utf8');
  }
  const out = Buffer.alloc(5 + nameBuf.length + valueBuf.length);
  let o = 0;
  out.writeUInt8(tag, o);
  o += 1;
  out.writeUInt16BE(nameBuf.length, o);
  o += 2;
  nameBuf.copy(out, o);
  o += nameBuf.length;
  out.writeUInt16BE(valueBuf.length, o);
  o += 2;
  valueBuf.copy(out, o);
  return out;
}

export interface IppRequestInput {
  operation: number;
  requestId: number;
  printerUri: string;
  /** Who the printer thinks is asking. Some devices reject a job without one. */
  user: string;
  /** Extra operation-group attributes, e.g. `job-id`, `document-format`. */
  operation_attributes?: Attribute[];
  /** Job-group attributes: copies, sides, media, colour. */
  job_attributes?: Attribute[];
  /** The document, appended after the end-of-attributes delimiter. */
  document?: Buffer;
}

export function encodeRequest(input: IppRequestInput): Buffer {
  const header = Buffer.alloc(8);
  header.writeUInt8(2, 0); // IPP 2.0 — every AirPrint device speaks it
  header.writeUInt8(0, 1);
  header.writeUInt16BE(input.operation, 2);
  header.writeUInt32BE(input.requestId, 4);

  const parts: Buffer[] = [
    header,
    Buffer.from([GROUP.operation]),
    // Charset and language first, in that order: RFC 8011 requires it, and
    // devices that check are the ones you find out about in the field.
    encodeAttribute(TAG.charset, 'attributes-charset', 'utf-8'),
    encodeAttribute(TAG.naturalLanguage, 'attributes-natural-language', 'en-us'),
    encodeAttribute(TAG.uri, 'printer-uri', input.printerUri),
    encodeAttribute(TAG.nameWithoutLanguage, 'requesting-user-name', input.user),
  ];
  for (const a of input.operation_attributes ?? []) {
    parts.push(encodeAttribute(a.tag, a.name, a.value));
  }
  if (input.job_attributes?.length) {
    parts.push(Buffer.from([GROUP.job]));
    for (const a of input.job_attributes) parts.push(encodeAttribute(a.tag, a.name, a.value));
  }
  parts.push(Buffer.from([GROUP.end]));
  if (input.document) parts.push(input.document);
  return Buffer.concat(parts);
}

/**
 * Decode a response into a flat `name → values` map. Group boundaries are
 * dropped on purpose: nothing here needs to know whether `job-id` arrived in
 * the job group or the printer group, and the alternative is a shape every
 * caller has to walk.
 */
export function decodeResponse(buf: Buffer): IppResponse {
  if (buf.length < 8) {
    return { statusCode: -1, ok: false, attributes: {} };
  }
  const statusCode = buf.readUInt16BE(2);
  const attributes: Record<string, IppValue[]> = {};
  let last: string | null = null;
  let o = 8;

  while (o < buf.length) {
    const tag = buf.readUInt8(o);
    o += 1;
    if (tag === GROUP.end) break;
    if (tag < 0x10) continue; // a group delimiter; the flat map does not care

    if (o + 2 > buf.length) break;
    const nameLength = buf.readUInt16BE(o);
    o += 2;
    if (o + nameLength + 2 > buf.length) break;
    const name = buf.subarray(o, o + nameLength).toString('utf8');
    o += nameLength;
    const valueLength = buf.readUInt16BE(o);
    o += 2;
    if (o + valueLength > buf.length) break;
    const raw = buf.subarray(o, o + valueLength);
    o += valueLength;

    let value: IppValue;
    if ((tag === TAG.integer || tag === TAG.enum) && valueLength >= 4) {
      value = raw.readInt32BE(0);
    } else if (tag === TAG.boolean && valueLength >= 1) {
      value = raw.readUInt8(0) === 1;
    } else if (tag === TAG.resolution && valueLength >= 9) {
      // Reported in the units the device chose (3 = dpi, 4 = dots/cm); we only
      // ever read the x value, and only to pick a rasterisation resolution.
      value = raw.readInt32BE(0);
    } else if (tag === TAG.range && valueLength >= 8) {
      value = `${raw.readInt32BE(0)}-${raw.readInt32BE(4)}`;
    } else {
      value = raw.toString('utf8');
    }

    // Name-length zero means "another value for the attribute before me".
    const key: string | null = nameLength === 0 ? last : name;
    if (!key) continue;
    (attributes[key] ??= []).push(value);
    last = key;
  }

  return {
    statusCode,
    // 0x0000–0x0002 are the successful-ok family; anything else is a refusal.
    ok: statusCode >= 0 && statusCode <= 0x0002,
    attributes,
  };
}

/** IPP's own name for a status code, for an error a human will read. */
export function ippStatusText(code: number): string {
  if (code === 0x0400) return 'bad request';
  if (code === 0x0401) return 'forbidden';
  if (code === 0x0402) return 'not authenticated';
  if (code === 0x0403) return 'not authorized';
  if (code === 0x0405) return 'not found';
  if (code === 0x040a) return 'the document format is not supported';
  if (code === 0x040b) return 'the attributes or values are not supported';
  if (code === 0x0501) return 'the printer refused the operation';
  if (code === 0x0507) return 'the printer is busy';
  return `IPP status 0x${code.toString(16).padStart(4, '0')}`;
}

export const IPP_TAGS = TAG;

/** First value of an attribute, or null. Most attributes are single-valued. */
export function first(response: IppResponse, name: string): IppValue | null {
  return response.attributes[name]?.[0] ?? null;
}

/** Every value of an attribute as strings — the `*-supported` lists. */
export function all(response: IppResponse, name: string): string[] {
  return (response.attributes[name] ?? []).map((v) => String(v));
}
