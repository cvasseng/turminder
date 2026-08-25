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
  /**
   * Which of the endpoint's models to probe. Absent means the first one it
   * lists, which is all an endpoint serving exactly one model can mean — but a
   * hosted provider lists dozens in no particular order, and capability tags
   * describe *a model*, not an address (§10.2). So the choice has to reach
   * this far down: probing one model and committing another would tag the
   * wrong thing.
   */
  model?: string;
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
}

export interface ProbeResult {
  url: string;
  reachable: boolean;
  /** The model these `caps` were actually measured against. */
  model_id?: string;
  /** Every model the endpoint lists, so setup can offer the choice (§28.5). */
  models?: string[];
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

/**
 * The credential, in both of the shapes this ecosystem actually uses.
 *
 * `/v1/models` is the one route hosted providers commonly serve from their
 * **native** API rather than their OpenAI-compatible layer, and the two do not
 * agree on how a key travels. Anthropic is the case that proved it: the same
 * key is `Invalid bearer token` on `Authorization: Bearer` and accepted on
 * `x-api-key`, while its `/v1/chat/completions` — the route the gateway
 * itself uses — takes the bearer form happily. So the probe 401'd on a
 * perfectly good key and reported the endpoint unreachable.
 *
 * Both headers, rather than a table of which provider wants which: a server
 * ignores the header it does not know, and a per-vendor branch here would be
 * a second place to keep a list of vendors correct.
 */
function authHeaders(apiKey: string | undefined): Record<string, string> {
  if (!apiKey) return {};
  return {
    authorization: `Bearer ${apiKey}`,
    'x-api-key': apiKey,
    // Anthropic pins its native API by date and rejects a request without
    // this. It travels alongside rather than conditionally, for the same
    // reason as `x-api-key`: a server ignores a header it does not know, and
    // branching on the hostname would be a vendor list to keep correct.
    // Worth knowing if this ever looks redundant — an auth error is returned
    // *before* the version is looked at, so probing with a bad key cannot
    // tell you whether this line is load-bearing. Only a good one can.
    'anthropic-version': '2023-06-01',
  };
}

/**
 * What the endpoint actually said, not merely its status code.
 *
 * `HTTP 401` is the least useful true statement available here: providers put
 * the reason in the body, and the reason is usually the entire diagnosis —
 * "x-api-key header is required" and "Invalid bearer token" are different
 * bugs wearing the same number. This message becomes a note on the setup
 * page, so the key is redacted out of it on the way (§27): a credential does
 * not travel, not even inside somebody else's error string.
 */
async function describeFailure(res: Response, apiKey: string | undefined): Promise<string> {
  let detail = '';
  try {
    const text = (await res.text()).trim();
    if (text) {
      let parsed: any;
      try {
        parsed = JSON.parse(text);
      } catch {
        /* not JSON; the raw text is the best we have */
      }
      detail = String(parsed?.error?.message ?? parsed?.message ?? text).slice(0, 200);
    }
  } catch {
    /* a body that cannot be read is not worth failing over */
  }
  if (apiKey && detail) detail = detail.split(apiKey).join('<redacted>');
  return detail ? `HTTP ${res.status} — ${detail}` : `HTTP ${res.status}`;
}

async function getJson(
  url: string,
  opts: ProbeOptions,
): Promise<{ ok: boolean; body?: any; error?: string }> {
  const doFetch = opts.fetch ?? globalThis.fetch;
  try {
    const res = await doFetch(url, {
      headers: authHeaders(opts.apiKey),
      signal: AbortSignal.timeout(opts.timeoutMs ?? 10_000),
    });
    if (!res.ok) return { ok: false, error: await describeFailure(res, opts.apiKey) };
    return { ok: true, body: await res.json() };
  } catch (e) {
    return { ok: false, error: errMessage(e) };
  }
}

/** The embedding half of App. E's probe: does this endpoint embed, and how wide? */
export interface EmbeddingProbeResult {
  /** The root the config will hold — `embeddings.ts` appends its own routes. */
  url: string;
  reachable: boolean;
  model_id?: string;
  dimensions?: number;
  error?: string;
}

/**
 * Embed one short string and count what comes back (App. E, §28.5).
 *
 * "Answered at all" is never the question — §27.1's lesson, and the same one
 * the green-square vision probe learned: a server can accept the request and
 * return nothing usable. The vector's **length** is the answer, because that
 * is the number the index is built around.
 *
 * The two routes, in this order, are exactly the ones `rag/embeddings.ts`
 * tries at runtime. That is the whole point: a probe that reaches embeddings
 * by some path the real client does not use would auto-check a box for a
 * capability this install cannot actually reach.
 */
export async function probeEmbeddings(
  rawUrl: string,
  opts: ProbeOptions = {},
): Promise<EmbeddingProbeResult> {
  const { root } = normaliseEndpointUrl(rawUrl);
  const result: EmbeddingProbeResult = { url: root, reachable: false };
  const doFetch = opts.fetch ?? globalThis.fetch;
  const headers = { 'content-type': 'application/json', ...authHeaders(opts.apiKey) };
  const signal = () => AbortSignal.timeout(opts.timeoutMs ?? 30_000);

  const vectorOf = (body: any): number[] | null => {
    const candidate = Array.isArray(body)
      ? body[0]?.embedding
      : (body?.data?.[0]?.embedding ?? body?.embedding);
    // llama.cpp sometimes nests a single embedding one level deep.
    const flat = Array.isArray(candidate?.[0]) ? candidate[0] : candidate;
    return Array.isArray(flat) && flat.length ? flat : null;
  };

  /**
   * Three shapes, most-specific first, because "an OpenAI-compatible
   * embeddings route" is two different contracts wearing one path. vLLM and
   * the hosted providers **require** `model` and answer a request without one
   * with a 422, which is how a perfectly good endpoint was reported as having
   * no embeddings at all; llama.cpp has no model to name and ignores the
   * field. The named attempt goes first so a server that has several models
   * embeds with the one that was asked for rather than a default.
   */
  const probeText = 'turminder embedding probe';
  const attempts: { url: string; body: unknown }[] = [
    ...(opts.model
      ? [{ url: `${root}/v1/embeddings`, body: { input: probeText, model: opts.model } }]
      : []),
    { url: `${root}/v1/embeddings`, body: { input: probeText } },
    { url: `${root}/embedding`, body: { content: probeText } },
  ];

  const failures: string[] = [];
  for (const attempt of attempts) {
    try {
      const res = await doFetch(attempt.url, {
        method: 'POST',
        headers,
        body: JSON.stringify(attempt.body),
        signal: signal(),
      });
      if (!res.ok) {
        failures.push(`POST ${attempt.url}: ${await describeFailure(res, opts.apiKey)}`);
        continue;
      }
      const body: any = await res.json();
      const vector = vectorOf(body);
      if (!vector) {
        failures.push(`POST ${attempt.url}: answered without a vector`);
        continue;
      }
      result.reachable = true;
      result.dimensions = vector.length;
      if (typeof body?.model === 'string') result.model_id = body.model;
      l.info({ url: root, dimensions: vector.length }, 'embedding probe complete');
      return result;
    } catch (e) {
      failures.push(`POST ${attempt.url}: ${errMessage(e)}`);
    }
  }
  result.error = failures.join('; ');
  return result;
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
  // uses (App. F), so the probe must exercise the same path a real call takes
  // — including the §11.5 wire translation that makes it legal at providers
  // which reject a dot. This name is why the probe used to report "no tool
  // support" for Anthropic and OpenAI: it was the one part of the request
  // they refused, and the tag was derived from their refusal.
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
  let modelIds: string[] = [];
  let contextSize: number | undefined;
  if (models.ok) {
    checks.reachable = true;
    const data: any[] = Array.isArray(models.body?.data) ? models.body.data : [];
    modelIds = data.map((m) => m?.id).filter((id): id is string => typeof id === 'string');
    // A caller who named a model gets that model, listed or not: an endpoint's
    // catalogue is not always complete, and refusing a name the user knows
    // works would be this code claiming to know better. Saying so is enough.
    if (opts.model) {
      modelId = opts.model;
      if (modelIds.length && !modelIds.includes(opts.model)) {
        notes.push(`${opts.model} is not in this endpoint's model list — probing it anyway`);
      }
    } else {
      modelId = modelIds[0];
    }
    const entry = data.find((m) => m?.id === modelId) ?? data[0];
    const metaCtx = entry?.meta?.n_ctx;
    if (typeof metaCtx === 'number') contextSize = metaCtx;
  } else {
    notes.push(`GET ${api}/models failed: ${models.error}`);
    if (opts.model) modelId = opts.model;
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
  if (modelIds.length) result.models = modelIds;
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
