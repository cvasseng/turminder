import { errMessage } from '../core/errors.js';
import { log } from '../core/logger.js';
import type { InferenceScheduler } from '../model/scheduler.js';
import type { EmbeddingEndpoint } from '../model/types.js';

const l = log('rag');

export interface EmbeddingClientOptions {
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
}

/** Strip a trailing `/v1` so both `http://host:8081` and `http://host:8081/v1`
 *  name the same server root (G.2 — the embedding URL convention, unlike a
 *  chat endpoint's, is the server root; llama.cpp's native `/embedding` route
 *  is not under `/v1`). */
function normaliseUrl(url: string): string {
  return url.replace(/\/+$/, '').replace(/\/v1$/, '');
}

/**
 * Embeddings from a llama.cpp (or vLLM) server (§8.3). Runs through the
 * inference scheduler at `background` priority so indexing never delays a
 * chat turn.
 *
 * A server started without `--embeddings` answers 501; that is a normal state
 * here, not an error — the RAG layer falls back to lexical retrieval. So is a
 * `null` endpoint (§10.6: no `kind: embedding` endpoint configured) —
 * `available()` reports false without a network call.
 */
export class EmbeddingClient {
  private availability: boolean | null = null;
  private endpoint: EmbeddingEndpoint | null;

  constructor(
    endpoint: EmbeddingEndpoint | null,
    private readonly scheduler: InferenceScheduler,
    private readonly opts: EmbeddingClientOptions = {},
  ) {
    this.endpoint = endpoint && { ...endpoint, url: normaliseUrl(endpoint.url) };
  }

  get url(): string | null {
    return this.endpoint?.url ?? null;
  }

  /**
   * Swap the endpoint after a config reload (§10.6, `Service.loadModels()`).
   * Resets availability so the next call re-probes rather than trusting a
   * verdict about the old server; a changed URL is worth a warning, because
   * an existing index's vectors came from whatever model used to answer here
   * and do not silently become comparable to a new one's.
   */
  reconfigure(endpoint: EmbeddingEndpoint | null): void {
    const next = endpoint && { ...endpoint, url: normaliseUrl(endpoint.url) };
    const urlChanged = this.endpoint?.url !== next?.url;
    this.endpoint = next;
    this.availability = null;
    if (urlChanged && next) {
      l.warn('embedding endpoint changed; stored vectors are stale until setup.rebuild_index');
    }
  }

  async available(): Promise<boolean> {
    if (!this.endpoint) return false;
    if (this.availability !== null) return this.availability;
    try {
      const probe = await this.embedRaw(['probe']);
      this.availability = probe.length > 0 && probe[0]!.length > 0;
    } catch (e) {
      l.warn({ err: errMessage(e), url: this.endpoint.url }, 'embeddings unavailable');
      this.availability = false;
    }
    return this.availability;
  }

  /** Embeds texts, queued at background priority. Returns [] when unavailable. */
  async embed(texts: string[]): Promise<number[][]> {
    if (!texts.length) return [];
    if (!(await this.available()) || !this.endpoint) return [];
    const url = this.endpoint.url;
    return this.scheduler.run({
      endpoint: `embedding:${url}`,
      priority: 'background',
      fn: () => this.embedRaw(texts),
    });
  }

  private async embedRaw(texts: string[]): Promise<number[][]> {
    const endpoint = this.endpoint;
    if (!endpoint) throw new Error('no embedding endpoint configured');
    const doFetch = this.opts.fetch ?? globalThis.fetch;
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (endpoint.apiKey) headers.authorization = `Bearer ${endpoint.apiKey}`;
    const signal = AbortSignal.timeout(this.opts.timeoutMs ?? 60_000);

    // Prefer the OpenAI-compatible route; fall back to llama.cpp's own.
    const res = await doFetch(`${endpoint.url}/v1/embeddings`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ input: texts, model: endpoint.model }),
      signal,
    });
    if (res.ok) {
      const body = (await res.json()) as { data?: { embedding: number[] }[] };
      const vectors = (body.data ?? []).map((d) => d.embedding);
      if (vectors.length) return vectors;
    }

    const native = await doFetch(`${endpoint.url}/embedding`, {
      method: 'POST',
      headers,
      body: JSON.stringify(texts.length === 1 ? { content: texts[0] } : { content: texts }),
      signal,
    });
    if (!native.ok) throw new Error(`embedding endpoint returned HTTP ${native.status}`);
    const body = (await native.json()) as
      | { embedding?: number[] }
      | { embedding?: number[] }[]
      | { data?: { embedding: number[] }[] };
    if (Array.isArray(body)) {
      return body.map((b) => flatten(b.embedding ?? []));
    }
    if ('data' in body && body.data) return body.data.map((d) => flatten(d.embedding));
    if ('embedding' in body && body.embedding) return [flatten(body.embedding)];
    throw new Error('embedding response had no vectors');
  }
}

/** llama.cpp sometimes nests a single embedding one level deep. */
function flatten(v: unknown): number[] {
  if (Array.isArray(v) && Array.isArray(v[0])) return (v[0] as number[]).map(Number);
  return (v as number[]).map(Number);
}
