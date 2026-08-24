import { errMessage } from '../core/errors.js';
import { log } from '../core/logger.js';
import type { InferenceScheduler } from '../model/scheduler.js';
import type { EmbeddingEndpoint } from '../model/router.js';

const l = log('rag');

export interface EmbeddingClientOptions {
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
}

/**
 * Embeddings from a llama.cpp server (§8.3). Runs through the inference
 * scheduler at `background` priority so indexing never delays a chat turn.
 *
 * A server started without `--embeddings` answers 501; that is a normal state
 * here, not an error — the RAG layer falls back to lexical retrieval.
 */
export class EmbeddingClient {
  private availability: boolean | null = null;

  constructor(
    private readonly endpoint: EmbeddingEndpoint,
    private readonly scheduler: InferenceScheduler,
    private readonly opts: EmbeddingClientOptions = {},
  ) {}

  get url(): string {
    return this.endpoint.url;
  }

  async available(): Promise<boolean> {
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
    if (!(await this.available())) return [];
    return this.scheduler.run({
      endpoint: `embedding:${this.endpoint.url}`,
      priority: 'background',
      fn: () => this.embedRaw(texts),
    });
  }

  private async embedRaw(texts: string[]): Promise<number[][]> {
    const doFetch = this.opts.fetch ?? globalThis.fetch;
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (this.endpoint.apiKey) headers.authorization = `Bearer ${this.endpoint.apiKey}`;
    const signal = AbortSignal.timeout(this.opts.timeoutMs ?? 60_000);

    // Prefer the OpenAI-compatible route; fall back to llama.cpp's own.
    const res = await doFetch(`${this.endpoint.url}/v1/embeddings`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ input: texts, model: this.endpoint.model }),
      signal,
    });
    if (res.ok) {
      const body = (await res.json()) as { data?: { embedding: number[] }[] };
      const vectors = (body.data ?? []).map((d) => d.embedding);
      if (vectors.length) return vectors;
    }

    const native = await doFetch(`${this.endpoint.url}/embedding`, {
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
