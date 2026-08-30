import fs from 'node:fs';
import path from 'node:path';
import { jsonSchema, tool, type ToolSet } from 'ai';
import { z } from 'zod';
import { log } from '../core/logger.js';
import { errMessage } from '../core/errors.js';
import { ModelsYamlSchema, type ModelCap, type ModelEffort } from '../core/config-schemas.js';
import { ModelGateway } from './gateway.js';
import { ModelRouter } from './router.js';
import type { ResolvedEndpoint } from './types.js';
import { InferenceScheduler } from './scheduler.js';
import { readWavHeader } from './wav.js';

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
  /**
   * The `no_think` body fragment to test (§10.6, G.2). Absent means the default
   * `{reasoning_effort: "none"}` — so probing an endpoint whose server wants
   * `chat_template_kwargs` correctly reports that the default knob does nothing
   * there, which is the honest answer to "does this work out of the box".
   */
  noThink?: Record<string, unknown>;
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
  /**
   * Effort levels this probe could *verify* (§10.6) — in practice only `none`,
   * because "did it stop thinking" is checkable and "did it think harder" is
   * not. Reported, never auto-written: a partial `efforts` list would claim by
   * omission that the levels nobody measured are unsupported (§10.2's rule —
   * the probe result is the default, the config is the decision).
   */
  efforts?: ModelEffort[];
  /** Per-probe detail, for honest reporting in the setup UI (plan §3b). */
  checks: {
    reachable: boolean;
    completion: boolean;
    json: boolean;
    tools: boolean;
    long_context: boolean;
    vision: boolean;
    /** The endpoint thinks by default *and* the `no_think` fragment stops it. */
    no_think: boolean;
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
          // Declared so the gateway will actually *send* the fragment when the
          // reasoning-off check asks for `none` — the same gate a real call
          // passes through (§10.6), not a bypass built for the probe.
          efforts: ['none'],
          ...(opts.noThink ? { no_think: opts.noThink } : {}),
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
    no_think: false,
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
      selector: { purpose: 'probe' },
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
      selector: { purpose: 'probe' },
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
      selector: { purpose: 'probe' },
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
      selector: { purpose: 'probe' },
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

  // 6. `none` as an effort (§10.6): does this endpoint's thinking actually stop?
  //
  // Two calls of the same question, because either half alone proves nothing.
  // A model that never reasons would "pass" a one-call check while honouring
  // no knob at all — and tagging it `none` would tell a voice conversation it
  // had turned something off that was never on. So: reason first, then don't.
  try {
    const question = 'A farmer has 17 sheep. All but 9 run away. How many are left?';
    const ask = (effort?: 'none') =>
      gateway.turn({
        selector: { purpose: 'probe', ...(effort ? { effort } : {}) },
        priority: 'interactive',
        system: 'Answer with one number.',
        messages: [{ role: 'user', content: question }],
        maxOutputTokens: 512,
        abortSignal: AbortSignal.timeout(timeoutMs),
      });
    const thinking = await ask();
    if (thinking.reasoningChars > 0) {
      const quiet = await ask('none');
      checks.no_think = quiet.reasoningChars === 0;
      if (!checks.no_think) {
        notes.push('the endpoint kept reasoning with thinking turned off — `none` not offered');
      }
    } else {
      notes.push(
        'the endpoint did not reason at all, so there is nothing for `none` to turn off',
      );
    }
  } catch (e) {
    notes.push(`the reasoning-off check failed: ${errMessage(e)}`);
  }

  checks.long_context = (contextSize ?? 0) >= LONG_CONTEXT_THRESHOLD;

  const caps: ModelCap[] = [];
  if (checks.json) caps.push('json');
  if (checks.tools) caps.push('tools');
  if (checks.long_context) caps.push('long_context');
  if (checks.vision) caps.push('vision');
  result.caps = caps;
  if (checks.no_think) result.efforts = ['none'];

  l.info({ url: api, caps, checks }, 'probe complete');
  return result;
}

/* ── Speech endpoints (§10.9) ────────────────────────────────────────────── */

/**
 * The `stt` probe's stimulus: a 16 kHz mono clip of the sentence in
 * `probe.txt`, rendered once from the reference synthesiser and checked in.
 * A file rather than a base64 constant because a second and a half of speech
 * is 49 KB of bytes, and a source file is for reading — the build copies the
 * directory next to the compiled module the way it copies the prompt library,
 * and `test/voice-fixture.test.ts` walks the header the way the green PNG's
 * guard test walks its chunks.
 *
 * **A probe validates its own stimulus** (§10.2): a fixture that is itself
 * broken false-negatives every transcriber that actually works.
 */
const FIXTURE_DIR = path.join(import.meta.dirname, 'fixtures');
export const STT_FIXTURE_WAV = path.join(FIXTURE_DIR, 'probe.wav');
export const STT_FIXTURE_TXT = path.join(FIXTURE_DIR, 'probe.txt');

/** The fixture is English, whatever the install's locale is — the transcript
 *  it is scored against is English words. */
const STT_FIXTURE_LANGUAGE = 'en';

/**
 * How much of the fixture a transcriber has to get right to pass. Not 100 %:
 * "Turminder" is an invented proper noun and every whisper build heard so far
 * renders it "Reminder" — refusing an endpoint for mishearing a made-up name
 * would fail every endpoint in the world. Six words of seven is the reference
 * result; the threshold sits just under it.
 */
const STT_MATCH_THRESHOLD = 0.8;

/** The shortest speech worth calling speech — under this the endpoint answered
 *  with a click, which is what a silently-broken synthesiser sounds like. */
const TTS_MIN_SECONDS = 0.3;

export interface SttProbeResult {
  url: string;
  reachable: boolean;
  model_id?: string;
  transcript?: string;
  /** Did enough of the known sentence come back (`STT_MATCH_THRESHOLD`)? */
  matched: boolean;
  error?: string;
}

export interface TtsProbeResult {
  url: string;
  reachable: boolean;
  model_id?: string;
  sample_rate?: number;
  seconds?: number;
  /** Did the endpoint answer with real audio? */
  ok: boolean;
  /** The voices it lists, when it lists any (§33.5, V5.1). */
  voices?: string[];
  error?: string;
}

export type SpeechProbeResult = SttProbeResult | TtsProbeResult;

/** Lower-cased, punctuation-stripped words — the shape both sides of the
 *  transcript comparison are reduced to before they are compared. */
function words(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

/** The model id an endpoint serves, and the ids it lists — the same
 *  `/v1/models` read `probeEndpoint` opens with, minus the capability work a
 *  speech endpoint has no answer for. */
async function speechModels(
  api: string,
  opts: ProbeOptions,
): Promise<{ ok: boolean; modelId?: string; error?: string }> {
  const listed = await getJson(`${api}/models`, opts);
  if (!listed.ok) return { ok: false, ...(listed.error ? { error: listed.error } : {}) };
  const data: any[] = Array.isArray(listed.body?.data) ? listed.body.data : [];
  const ids = data.map((m) => m?.id).filter((id): id is string => typeof id === 'string');
  const modelId = opts.model ?? ids[0];
  return { ok: true, ...(modelId ? { modelId } : {}) };
}

/**
 * The voices a `tts` endpoint offers, or `undefined` when it does not say
 * (§33.5) — the form's option list, and the preview route's allowlist.
 *
 * Three routes because the ecosystem has not settled on one: Speaches
 * serves the first, some forks the second, others the bare third; OpenAI and
 * openedai-speech serve none at all, which is not an error — it means the form
 * falls back to the six names OpenAI's dialect defines.
 *
 * Any JSON array is accepted, of strings or of objects wearing an `id`, `name`
 * or `voice_id`: the shape is not standardised either, and refusing a listing
 * for spelling its key differently would buy nothing.
 */
export async function listVoices(
  endpoint: Pick<ResolvedEndpoint, 'url' | 'apiKey' | 'model'>,
  opts: Pick<ProbeOptions, 'fetch' | 'timeoutMs'> = {},
): Promise<string[] | undefined> {
  const { api } = normaliseEndpointUrl(endpoint.url);
  // Keyed by model as well as address: one Speaches serves several
  // synthesisers with different voices, and the answer for one is wrong for
  // the other.
  const key = `${api}|${endpoint.model}`;
  const hit = VOICE_CACHE.get(key);
  if (hit && hit.at > Date.now() - VOICE_CACHE_TTL_MS) return hit.voices;
  const voices = await fetchVoices(api, {
    ...(endpoint.apiKey ? { apiKey: endpoint.apiKey } : {}),
    ...(endpoint.model ? { model: endpoint.model } : {}),
    ...opts,
  });
  VOICE_CACHE.set(key, { at: Date.now(), ...(voices ? { voices } : {}) });
  return voices;
}

/**
 * Cached per process for a minute (the App. F.5 page-cache precedent, same
 * reasoning): a form that opens twice must not re-ask, and a voice added to
 * the endpoint must not take a restart to appear. A miss is cached too — three
 * 404s per form render, on every render, for an endpoint that will never list
 * anything, is the case this is actually for.
 */
const VOICE_CACHE_TTL_MS = 60_000;
const VOICE_CACHE = new Map<string, { at: number; voices?: string[] }>();

/** Drops every cached listing. Tests, and nothing else — a process cache with
 *  a minute's TTL needs no invalidation in production. */
export function clearVoiceCache(): void {
  VOICE_CACHE.clear();
}

async function fetchVoices(api: string, opts: ProbeOptions): Promise<string[] | undefined> {
  const routes = [`${api}/audio/speech/voices`, `${api}/audio/voices`, `${api}/voices`];
  for (const url of routes) {
    const res = await getJson(url, opts);
    if (!res.ok) continue;
    const raw: unknown = Array.isArray(res.body)
      ? res.body
      : (res.body?.voices ?? res.body?.data);
    const names = voiceNames(raw);
    if (names.length) return names;
  }
  // Nothing flat. Ask what the endpoint serves and look inside the model this
  // one is configured for — the Speaches shape, and the only one that can tell
  // two synthesisers on one address apart.
  for (const url of [`${api}/models`, `${api}/registry?task=text-to-speech`]) {
    const res = await getJson(url, opts);
    if (!res.ok) continue;
    const entries: any[] = Array.isArray(res.body?.data) ? res.body.data : [];
    const named = opts.model ? entries.find((m) => m?.id === opts.model) : undefined;
    // A model that was asked for and lists no voices is the answer "none", not
    // a reason to go and read a different model's.
    const entry = named ?? entries.find((m) => voiceNames(m?.voices).length);
    const names = voiceNames(entry?.voices);
    if (names.length) return names;
  }
  return undefined;
}

/** Names out of a voice listing, whatever key this server spells them with. */
function voiceNames(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((v: any) => (typeof v === 'string' ? v : (v?.name ?? v?.id ?? v?.voice_id)))
    .filter((v: unknown): v is string => typeof v === 'string' && v.length > 0);
}

/**
 * Probe a speech endpoint (§10.9). Like every probe: what it actually does,
 * not what it claims, and reported rather than thrown. Writes nothing —
 * `setup.form`'s `speech_endpoint` template decides what to do with the answer.
 */
export async function probeSpeech(
  kind: 'stt' | 'tts',
  rawUrl: string,
  opts: ProbeOptions & { voice?: string } = {},
): Promise<SpeechProbeResult> {
  const { api } = normaliseEndpointUrl(rawUrl);
  const doFetch = opts.fetch ?? globalThis.fetch;
  const timeoutMs = opts.timeoutMs ?? 60_000;
  const listed = await speechModels(api, opts);
  const modelId = listed.modelId;

  if (kind === 'stt') {
    const result: SttProbeResult = { url: api, reachable: false, matched: false };
    if (modelId) result.model_id = modelId;
    let audio: Buffer;
    let expected: string;
    try {
      audio = fs.readFileSync(STT_FIXTURE_WAV);
      expected = fs.readFileSync(STT_FIXTURE_TXT, 'utf8').trim();
    } catch (e) {
      // The stimulus, not the endpoint. Say so — a missing fixture reported as
      // a failing transcriber is exactly the §10.2 lesson happening again.
      result.error = `the probe's own audio fixture is missing: ${errMessage(e)}`;
      return result;
    }
    try {
      const form = new FormData();
      form.set('file', new Blob([new Uint8Array(audio)], { type: 'audio/wav' }), 'probe.wav');
      form.set('model', modelId ?? 'default');
      form.set('language', STT_FIXTURE_LANGUAGE);
      form.set('response_format', 'json');
      const res = await doFetch(`${api}/audio/transcriptions`, {
        method: 'POST',
        headers: authHeaders(opts.apiKey),
        body: form,
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) {
        result.error = `POST ${api}/audio/transcriptions: ${await describeFailure(res, opts.apiKey)}`;
        return result;
      }
      const body: any = await res.json();
      const transcript = typeof body?.text === 'string' ? body.text.trim() : '';
      result.reachable = true;
      result.transcript = transcript;
      const want = words(expected);
      const heard = new Set(words(transcript));
      const hits = want.filter((w) => heard.has(w)).length;
      result.matched = want.length > 0 && hits / want.length >= STT_MATCH_THRESHOLD;
      if (!result.matched) {
        result.error = `transcribed "${transcript}" — expected "${expected}"`;
      }
    } catch (e) {
      result.error = `POST ${api}/audio/transcriptions: ${errMessage(e)}`;
    }
    l.info({ url: api, matched: result.matched }, 'stt probe complete');
    return result;
  }

  const result: TtsProbeResult = { url: api, reachable: false, ok: false };
  if (modelId) result.model_id = modelId;
  try {
    const res = await doFetch(`${api}/audio/speech`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...authHeaders(opts.apiKey) },
      body: JSON.stringify({
        model: modelId ?? 'default',
        input: 'Turminder is ready.',
        ...(opts.voice ? { voice: opts.voice } : {}),
        response_format: 'wav',
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) {
      result.error = `POST ${api}/audio/speech: ${await describeFailure(res, opts.apiKey)}`;
      return result;
    }
    const body = new Uint8Array(await res.arrayBuffer());
    result.reachable = true;
    const wav = readWavHeader(body);
    if (!wav) {
      result.error = 'the endpoint answered, but not with a RIFF/WAVE body';
      return result;
    }
    result.sample_rate = wav.sampleRate;
    result.seconds = wav.seconds;
    if (wav.sampleRate < 8_000 || wav.sampleRate > 48_000) {
      result.error = `sample rate ${wav.sampleRate} Hz is outside 8000–48000`;
      return result;
    }
    if (wav.seconds < TTS_MIN_SECONDS) {
      result.error = `only ${wav.seconds.toFixed(3)}s of audio came back`;
      return result;
    }
    result.ok = true;
  } catch (e) {
    result.error = `POST ${api}/audio/speech: ${errMessage(e)}`;
    return result;
  }
  const voices = await fetchVoices(api, opts);
  if (voices) result.voices = voices;
  l.info({ url: api, ok: result.ok, voices: result.voices?.length ?? 0 }, 'tts probe complete');
  return result;
}
