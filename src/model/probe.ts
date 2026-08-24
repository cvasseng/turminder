import { jsonSchema, tool, type ToolSet } from 'ai';
import { z } from 'zod';
import { log } from '../core/logger.js';
import { errMessage } from '../core/errors.js';
import { ModelsYamlSchema, type ModelCap } from '../core/config-schemas.js';
import { ModelGateway } from './gateway.js';
import { ModelRouter } from './router.js';
import { InferenceScheduler } from './scheduler.js';

const l = log('probe');

export interface ProbeOptions {
  apiKey?: string;
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
}

export interface ProbeResult {
  url: string;
  reachable: boolean;
  model_id?: string;
  context_size?: number;
  caps: ModelCap[];
  /** Per-probe detail, for honest reporting in the setup UI (plan §3b). */
  checks: {
    reachable: boolean;
    completion: boolean;
    json: boolean;
    tools: boolean;
    long_context: boolean;
    vision: boolean;
  };
  smoke?: string;
  notes: string[];
  error?: string;
}

/** Accepts `http://host:8080` or `http://host:8080/v1` and derives both forms. */
export function normaliseEndpointUrl(raw: string): { api: string; root: string } {
  let url = raw.trim();
  if (!/^https?:\/\//i.test(url)) url = `http://${url}`;
  url = url.replace(/\/+$/, '');
  const root = url.replace(/\/v\d+$/i, '');
  const api = /\/v\d+$/i.test(url) ? url : `${root}/v1`;
  return { api, root };
}

const LONG_CONTEXT_THRESHOLD = 32_768;

/**
 * A solid green 2x2 PNG, base64 — the vision probe's whole payload (§26.3).
 * Embedded rather than fetched: a capability probe that needs the network up
 * twice reports the wrong thing on a bad day.
 *
 * Green, and the answer is checked, because "did it answer at all" is not the
 * question. Plenty of text-only servers accept an image part and quietly drop
 * it; a tag derived from that is how a blind model ends up being sent pictures.
 *
 * The bytes themselves are guarded by a CRC-walking test, because the first
 * version of this constant was a PNG with a corrupt IDAT checksum: strict
 * decoders refused it and lenient ones (vllm's) decoded garbage — a live
 * sighted endpoint looked at our "green square", honestly saw a blue smear,
 * said "Blue", and was branded blind for it. A probe fixture that is itself
 * broken false-negatives every endpoint that actually looks.
 */
export const GREEN_PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAD0lEQVR42mNg+M8AQhAKABvyA/3ULwSAAAAAAElFTkSuQmCC';
const GREEN_WORDS = /green|lime/;

async function getJson(
  url: string,
  opts: ProbeOptions,
): Promise<{ ok: boolean; body?: any; error?: string }> {
  const doFetch = opts.fetch ?? globalThis.fetch;
  try {
    const res = await doFetch(url, {
      headers: opts.apiKey ? { authorization: `Bearer ${opts.apiKey}` } : {},
      signal: AbortSignal.timeout(opts.timeoutMs ?? 10_000),
    });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    return { ok: true, body: await res.json() };
  } catch (e) {
    return { ok: false, error: errMessage(e) };
  }
}

function gatewayFor(api: string, opts: ProbeOptions, modelId: string): ModelGateway {
  const router = new ModelRouter(
    ModelsYamlSchema.parse({
      endpoints: [
        {
          name: 'probe',
          url: api,
          model: modelId,
          classes: ['fast', 'best'],
          caps: ['json', 'tools'],
          ...(opts.apiKey ? { api_key: opts.apiKey } : {}),
        },
      ],
    }),
  );
  return new ModelGateway(router, new InferenceScheduler(1), {
    ...(opts.fetch ? { fetch: opts.fetch } : {}),
    cachePrompt: false,
  });
}

const probeToolSet = (): ToolSet => ({
  // A dotted name on purpose: that is the naming scheme the real tool catalog
  // uses (App. F), so the probe must prove this endpoint tolerates it.
  'probe.echo': tool({
    description: 'Echo a word back. Call this when asked to echo something.',
    inputSchema: jsonSchema<{ word: string }>({
      type: 'object',
      properties: { word: { type: 'string' } },
      required: ['word'],
      additionalProperties: false,
    }),
  }),
});

/**
 * Probe, don't ask (plan §3b): capability tags are derived from what an endpoint
 * actually does, not from what anyone claims. Failures are reported, never fatal.
 */
export async function probeEndpoint(
  rawUrl: string,
  opts: ProbeOptions = {},
): Promise<ProbeResult> {
  const { api, root } = normaliseEndpointUrl(rawUrl);
  const notes: string[] = [];
  const checks = {
    reachable: false,
    completion: false,
    json: false,
    tools: false,
    long_context: false,
    vision: false,
  };
  const result: ProbeResult = { url: api, reachable: false, caps: [], checks, notes };

  // 1. Reachability + model identity.
  const models = await getJson(`${api}/models`, opts);
  let modelId: string | undefined;
  let contextSize: number | undefined;
  if (models.ok) {
    checks.reachable = true;
    const entry = models.body?.data?.[0];
    modelId = entry?.id;
    const metaCtx = entry?.meta?.n_ctx;
    if (typeof metaCtx === 'number') contextSize = metaCtx;
  } else {
    notes.push(`GET ${api}/models failed: ${models.error}`);
  }

  const props = await getJson(`${root}/props`, opts);
  if (props.ok) {
    checks.reachable = true;
    const n =
      props.body?.default_generation_settings?.n_ctx ??
      props.body?.default_generation_settings?.params?.n_ctx ??
      props.body?.n_ctx;
    if (typeof n === 'number' && (!contextSize || n < contextSize)) contextSize = n;
    if (!modelId && typeof props.body?.model_path === 'string') {
      modelId = props.body.model_path.split('/').pop();
    }
  } else if (!models.ok) {
    notes.push(`GET ${root}/props failed: ${props.error}`);
  }

  if (!checks.reachable) {
    result.error = `endpoint unreachable: ${models.error ?? props.error ?? 'unknown error'}`;
    return result;
  }
  result.reachable = true;
  if (modelId) result.model_id = modelId;
  if (contextSize) result.context_size = contextSize;

  const gateway = gatewayFor(api, opts, modelId ?? 'default');
  const timeoutMs = opts.timeoutMs ?? 60_000;

  // 2. Plain completion — the smoke test.
  try {
    const r = await gateway.turn({
      selector: {},
      priority: 'interactive',
      system: 'Reply with exactly one word.',
      messages: [{ role: 'user', content: 'Say the word: ready' }],
      maxOutputTokens: 2048,
      abortSignal: AbortSignal.timeout(timeoutMs),
    });
    checks.completion = r.text.trim().length > 0;
    result.smoke = r.text.trim().slice(0, 200);
    if (!checks.completion) notes.push('the endpoint answered, but returned no text');
  } catch (e) {
    notes.push(`completion failed: ${errMessage(e)}`);
  }

  // 3. JSON-constrained output.
  try {
    const r = await gateway.turn({
      selector: {},
      priority: 'interactive',
      system: 'Return only JSON matching the schema.',
      messages: [{ role: 'user', content: 'Set ok to true and note to "hello".' }],
      jsonSchema: {
        name: 'probe',
        schema: {
          type: 'object',
          properties: { ok: { type: 'boolean' }, note: { type: 'string' } },
          required: ['ok', 'note'],
          additionalProperties: false,
        },
      },
      maxOutputTokens: 4096,
      abortSignal: AbortSignal.timeout(timeoutMs),
    });
    const parsed = z
      .object({ ok: z.boolean(), note: z.string() })
      .safeParse(JSON.parse(r.text.trim()));
    checks.json = parsed.success;
    if (!parsed.success) notes.push('JSON-constrained output did not match the schema');
  } catch (e) {
    notes.push(`JSON-constrained output failed: ${errMessage(e)}`);
  }

  // 4. Tool-call round trip.
  try {
    const r = await gateway.turn({
      selector: {},
      priority: 'interactive',
      system: 'You have one tool. Use it when asked. Never answer echo requests yourself.',
      messages: [{ role: 'user', content: 'Echo the word "pineapple" using your tool.' }],
      tools: probeToolSet(),
      maxOutputTokens: 4096,
      abortSignal: AbortSignal.timeout(timeoutMs),
    });
    const call = r.toolCalls.find((c) => c.toolName === 'probe.echo' && !c.invalid);
    checks.tools = Boolean(call);
    if (!call && r.toolCalls.length) {
      notes.push('the model emitted a tool call this system could not parse');
    } else if (!call) {
      notes.push(
        'the model did not call the tool it was told to call — handlers will be limited',
      );
    }
  } catch (e) {
    notes.push(`tool calling failed: ${errMessage(e)}`);
  }

  // 5. Vision: a tiny image, round-tripped (§26.3). Asking "what colour" of a
  // solid green square is the cheapest question with a checkable answer — an
  // endpoint that cannot take image parts errors here rather than guessing.
  try {
    const r = await gateway.turn({
      selector: {},
      priority: 'interactive',
      system: 'Answer with one word.',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'What colour is this image? Answer with one word.' },
            { type: 'image', image: GREEN_PNG, mediaType: 'image/png' },
          ],
        },
      ],
      // Reasoning models spend tokens thinking before the one-word answer —
      // the live Qwen3.8 needed 112 completion tokens to say "Green". A budget
      // that only covers the answer false-negatives every reasoning model.
      maxOutputTokens: 512,
      abortSignal: AbortSignal.timeout(timeoutMs),
    });
    const said = r.text.trim().toLowerCase();
    checks.vision = GREEN_WORDS.test(said);
    if (!checks.vision) {
      notes.push(
        'the endpoint did not read the test image (set caps: [vision] in models.yaml to override)',
      );
    }
  } catch (e) {
    notes.push(`vision round-trip failed: ${errMessage(e)}`);
  }

  checks.long_context = (contextSize ?? 0) >= LONG_CONTEXT_THRESHOLD;

  const caps: ModelCap[] = [];
  if (checks.json) caps.push('json');
  if (checks.tools) caps.push('tools');
  if (checks.long_context) caps.push('long_context');
  if (checks.vision) caps.push('vision');
  result.caps = caps;

  l.info({ url: api, caps, checks }, 'probe complete');
  return result;
}
