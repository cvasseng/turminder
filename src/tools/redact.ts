/**
 * Trace redaction (§14.4.2, App. F.9). A `setup.*` call carries field
 * definitions and prefills, and a prefill is the one place a credential could
 * arrive from the model side — so the trace stores field names and shapes, and
 * anything that could be a value gets `***`.
 *
 * Applied by the dispatcher, not by callers: it is the single point every tool
 * call passes through, which is the only place a rule like this holds.
 */

const MASK = '***';

const FIELD_KEYS = new Set([
  'name',
  'label',
  'type',
  'required',
  'options',
  'secret_key',
  'value',
]);

function redactField(field: unknown): unknown {
  if (!field || typeof field !== 'object' || Array.isArray(field)) return MASK;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(field as Record<string, unknown>)) {
    if (!FIELD_KEYS.has(k)) continue;
    out[k] = k === 'value' ? MASK : v;
  }
  return out;
}

/** Replace every value in a prefill map with the mask, keeping the names. */
function redactPrefill(prefill: unknown): unknown {
  if (!prefill || typeof prefill !== 'object' || Array.isArray(prefill)) return MASK;
  return Object.fromEntries(
    Object.keys(prefill as Record<string, unknown>).map((k) => [k, MASK]),
  );
}

/**
 * What goes into the `tool_call` trace row's `args` (App. C.1). Returns the
 * argument object unchanged — identity, so callers can tell — when there was
 * nothing to mask.
 */
export function redactTraceArgs(tool: string, args: unknown): unknown {
  if (!tool.startsWith('setup.')) return args;
  if (!args || typeof args !== 'object' || Array.isArray(args)) return args;
  const out: Record<string, unknown> = { ...(args as Record<string, unknown>) };
  if (Array.isArray(out.fields)) out.fields = out.fields.map(redactField);
  if (out.prefill !== undefined) out.prefill = redactPrefill(out.prefill);
  return out;
}
