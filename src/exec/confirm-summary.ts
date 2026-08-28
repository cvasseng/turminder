import path from 'node:path';
import { maskSecretRefs } from '../core/config.js';
import { errMessage } from '../core/errors.js';
import { log } from '../core/logger.js';
import type { ToolHandle } from '../tools/types.js';

const l = log('confirm');

/** One `label: value` line of an approval dialog (App. D.3). */
export interface ConfirmDetail {
  label: string;
  value: string;
}

/** Everything a human is shown when asked to authorise a call (§7.3, §14.2). */
export interface ConfirmDescription {
  title: string;
  details: ConfirmDetail[];
  /** The same content as one plain-text block, for a channel with no DOM. */
  text: string;
}

/** Where a value stops being readable and starts being a wall of text. */
const VALUE_MAX = 160;
/** How many entries of a list earn their place before the count carries it. */
const LIST_SAMPLE = 3;
/** How many keys of a nested object are worth showing on one line. */
const OBJECT_SAMPLE = 4;
/** How much of a description may become the sentence's verb phrase. */
const ACTION_MAX = 100;
/** How deep into a nested argument the rendering follows before giving up. */
const MAX_DEPTH = 2;

interface RenderOpts {
  dataDir: string;
  /** Authored content (§20.6): measured, never shown. */
  bulk: boolean;
  depth: number;
}

/**
 * The verb phrase for the title, taken from the tool's own catalog entry.
 *
 * Tool descriptions are written as imperatives — "Delete a file from the
 * shared workspace" — which is precisely the clause `<who> wants to …` needs.
 * It is the one place in the system where prose written for the model is also
 * the right prose for a person, and it is the reason this needs no second
 * field on every tool.
 */
function actionClause(handle: { name: string; description?: string }): string {
  const raw = (handle.description ?? '').trim();
  // An external MCP server may describe nothing; then the name is all there is,
  // and saying so plainly beats inventing a sentence about it.
  if (!raw || raw === handle.name) return `run ${handle.name}`;
  const clause = openLowercase(firstClause(raw));
  return clause.length > ACTION_MAX ? `${clause.slice(0, ACTION_MAX).trimEnd()}…` : clause;
}

function firstClause(text: string): string {
  const cut = /[.:;](\s|$)|\s—\s/.exec(text);
  let clause = cut ? text.slice(0, cut.index) : text;
  // A break inside a parenthetical is not a break: "(or reopen it with
  // completed: false)" would otherwise end the sentence mid-aside.
  const open = clause.indexOf('(');
  if (open >= 0 && !clause.slice(open).includes(')')) clause = clause.slice(0, open);
  return clause.trim().replace(/[.,:;]+$/, '');
}

/** Lower the opening letter — unless the first word is an acronym (RSVP). */
function openLowercase(text: string): string {
  const first = text.split(/\s/)[0] ?? '';
  if (first.length > 1 && /[A-Z]/.test(first) && first === first.toUpperCase()) return text;
  return text.charAt(0).toLowerCase() + text.slice(1);
}

/** `embed_id` → `Embed id`. The argument's own name is the only name it has. */
function humanLabel(key: string): string {
  const words = key.replace(/[_-]+/g, ' ').trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} byte${bytes === 1 ? '' : 's'}`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function renderString(text: string, dataDir: string): string {
  // Masked before anything measures or cuts it: eliding first could slice a
  // reference in half and put the front of a key name on screen (§27).
  const masked = maskSecretRefs(text);
  const relative =
    dataDir && masked.startsWith(`${dataDir}${path.sep}`)
      ? path.relative(dataDir, masked)
      : masked;
  const flat = relative.replace(/\s+/g, ' ').trim();
  if (!flat) return '(empty)';
  return flat.length > VALUE_MAX ? `${flat.slice(0, VALUE_MAX)}…` : flat;
}

/**
 * Authored content is measured rather than shown (§20.6). A 400-line document
 * in an approval dialog is a wall nobody reads, and reading it is not what the
 * decision turns on — whether this call should happen at all is.
 */
function renderBulk(value: unknown): string {
  if (typeof value !== 'string')
    return renderValue(value, { dataDir: '', bulk: false, depth: 0 });
  const lines = value ? value.split('\n').length : 0;
  return `${lines} line${lines === 1 ? '' : 's'}, ${humanSize(Buffer.byteLength(value, 'utf8'))}`;
}

function renderValue(value: unknown, opts: RenderOpts): string {
  if (opts.bulk) return renderBulk(value);
  if (value === null || value === undefined) return '(not set)';
  if (typeof value === 'boolean') return value ? 'yes' : 'no';
  if (typeof value === 'number' || typeof value === 'bigint') return String(value);
  if (typeof value === 'string') return renderString(value, opts.dataDir);
  const deeper = { ...opts, depth: opts.depth + 1 };
  if (Array.isArray(value)) {
    if (!value.length) return '(none)';
    if (opts.depth >= MAX_DEPTH) return `${value.length} items`;
    const shown = value.slice(0, LIST_SAMPLE).map((v) => renderValue(v, deeper));
    const more = value.length > shown.length ? ', …' : '';
    return `${value.length} item${value.length === 1 ? '' : 's'}: ${shown.join(', ')}${more}`;
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>);
    if (!entries.length) return '(empty)';
    if (opts.depth >= MAX_DEPTH) return `${entries.length} fields`;
    const shown = entries
      .slice(0, OBJECT_SAMPLE)
      .map(([k, v]) => `${humanLabel(k)}: ${renderValue(v, deeper)}`);
    return shown.join('; ') + (entries.length > shown.length ? '; …' : '');
  }
  return String(value);
}

/** The schema's own field order — the order the tool's author wrote them in. */
function schemaOrder(inputSchema: Record<string, unknown> | undefined): string[] {
  const properties = inputSchema?.properties;
  if (!properties || typeof properties !== 'object' || Array.isArray(properties)) return [];
  return Object.keys(properties as Record<string, unknown>);
}

function genericDetails(
  handle: ConfirmSubject,
  args: unknown,
  dataDir: string,
): ConfirmDetail[] {
  if (args === null || args === undefined) return [];
  if (typeof args !== 'object' || Array.isArray(args)) {
    return [
      { label: 'Argument', value: renderValue(args, { dataDir, bulk: false, depth: 0 }) },
    ];
  }
  const record = args as Record<string, unknown>;
  const bulk = new Set(handle.bulkArgs ?? []);
  const declared = schemaOrder(handle.inputSchema);
  // Schema order first, then anything the model sent that the schema does not
  // describe — surfaced rather than hidden, because an unexpected argument is
  // exactly what somebody approving a call would want to see.
  const order = [
    ...declared.filter((k) => k in record),
    ...Object.keys(record).filter((k) => !declared.includes(k)),
  ];
  return order
    .filter((k) => record[k] !== undefined)
    .map((k) => ({
      label: humanLabel(k),
      value: renderValue(record[k], { dataDir, bulk: bulk.has(k), depth: 0 }),
    }));
}

/** What `describeConfirm` needs of a tool — a handle, or anything shaped like one. */
export type ConfirmSubject = Pick<ToolHandle, 'name' | 'description'> &
  Partial<Pick<ToolHandle, 'inputSchema' | 'bulkArgs' | 'confirmSummary'>>;

/**
 * Describe a gated call to the person being asked to allow it (§7.3, §14.2).
 *
 * **The server writes every word of this.** The obvious-looking alternative —
 * let the model pass a sentence along with the call — hands the description of
 * an action to the party asking to perform it, and a model that garbles a path
 * garbles the sentence about it identically. What the server knows is the tool
 * and the arguments, so the server does the writing; the model's only
 * contribution is the values, rendered.
 */
export function describeConfirm(
  handle: ConfirmSubject,
  args: unknown,
  ctx: { actor: string; dataDir: string },
): ConfirmDescription {
  let override: { action: string; lines: ConfirmDetail[] } | undefined;
  try {
    override = handle.confirmSummary?.(args);
  } catch (e) {
    // A broken override must not take the dialog down with it: the generic
    // rendering is always available, and a call nobody can be asked about is a
    // call that silently denies.
    l.warn(
      { tool: handle.name, err: errMessage(e) },
      'confirmSummary failed; describing generically',
    );
  }
  const action = override?.action ?? actionClause(handle);
  const lines = override?.lines ?? genericDetails(handle, args, ctx.dataDir);
  // One door for the §27 rule. Whoever composed these lines — this module or a
  // tool's own override — a reference reaches no reader from here.
  const details = lines.map((d) => ({
    label: maskSecretRefs(String(d.label ?? '')),
    value: maskSecretRefs(String(d.value ?? '')),
  }));
  return {
    title: maskSecretRefs(`${ctx.actor} wants to ${action}`),
    details,
    text: details.length
      ? details.map((d) => `${d.label}: ${d.value}`).join('\n')
      : '(no arguments)',
  };
}
