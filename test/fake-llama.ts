import { wireToolName } from '../src/model/tool-names.js';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * A scriptable stand-in for a llama.cpp server's OpenAI-compatible API.
 * Real HTTP, real SSE — so the AI SDK wiring is under test, not mocked out.
 */

export interface ScriptedToolCall {
  name: string;
  /** Object => serialised as JSON. String => sent verbatim (use for malformed args). */
  args: unknown;
}

export interface ScriptedTurn {
  text?: string;
  /**
   * Reported on the reasoning channel — `delta.reasoning_content` when
   * streaming, `message.reasoning_content` when not — the way llama.cpp and
   * vLLM report a thinking model's block. A different path from inline
   * `<think>` tags in `text`, and the only one that produces live reasoning
   * activity (§20.1).
   */
  reasoning?: string;
  toolCalls?: ScriptedToolCall[];
  finishReason?: string;
  /** Server-side delay before responding, for scheduler/timeout tests. */
  delayMs?: number;
  /**
   * Delay between streamed pieces. Without it a "stream" arrives inside one
   * frame, which is fine for protocol tests and useless for anything about what
   * the reader can do *while* a model is talking.
   */
  chunkDelayMs?: number;
  usage?: { prompt: number; completion: number };
  /**
   * llama.cpp's non-standard `timings` object (§21.1). `promptEvaluated` becomes
   * `timings.prompt_n` — the prompt tokens NOT served from the KV cache.
   * Omitted entirely by default, which is what every non-llama.cpp endpoint
   * looks like.
   */
  promptEvaluated?: number;
  /** Respond with this HTTP status and an error body instead. */
  errorStatus?: number;
}

export interface RecordedRequest {
  path: string;
  body: Record<string, any>;
  /** Lower-cased, so a test can assert how a credential was presented. */
  headers: Record<string, string>;
  at: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Does this request carry an image part (OpenAI `image_url` content)? */
export function hasImagePart(body: Record<string, any>): boolean {
  return (body.messages ?? []).some(
    (m: any) =>
      Array.isArray(m.content) &&
      m.content.some((part: any) => part?.type === 'image_url' || part?.type === 'image'),
  );
}

/**
 * Tools cross the wire as `memory__save` (`src/model/tool-names.ts`), so a real
 * endpoint never answers with the catalog's own spelling. Scripts are
 * written in the catalog's vocabulary because that is what a test is about, and
 * translated here — this class *is* the endpoint, so this is where the wire
 * form belongs.
 *
 * The guard keeps its teeth: if the gateway ever stopped translating, its tool
 * set would be keyed by dotted names, the wire name below would match none of
 * them, and every scripted tool call would come back as an unknown tool.
 */
const scriptedToolName = wireToolName;

export class FakeLlama {
  private server: http.Server | null = null;
  private queue: ScriptedTurn[] = [];
  private fallback: ScriptedTurn | ((req: RecordedRequest) => ScriptedTurn) = { text: 'ok' };
  readonly requests: RecordedRequest[] = [];
  props = { default_generation_settings: { n_ctx: 32768 }, model_path: '/models/fake.gguf' };
  modelId = 'fake-model';
  /**
   * Anything this endpoint serves beyond `modelId`. Empty by default, because
   * llama.cpp serves one model and that is the shape most tests want; a hosted
   * provider listing several is what makes choosing one a question at all.
   */
  otherModels: string[] = [];
  /**
   * Whether this endpoint embeds at all. On by default, like llama.cpp; off is
   * a hosted provider that only does chat, which is the case the setup page
   * has to notice rather than assume.
   */
  embeddings = true;
  embeddingDim = 8;
  /**
   * Whether this endpoint can read image parts (§26.3). Off by default, like a
   * text-only llama.cpp: the capability probe must not find an eye that is not
   * there. When on, the probe's green test image is answered correctly.
   */
  vision = false;

  /** Queue turns, consumed in order; after that `fallback` answers. */
  script(...turns: ScriptedTurn[]): this {
    this.queue.push(...turns);
    return this;
  }

  always(turn: ScriptedTurn | ((req: RecordedRequest) => ScriptedTurn)): this {
    this.fallback = turn;
    return this;
  }

  reset(): this {
    this.queue = [];
    this.requests.length = 0;
    this.fallback = { text: 'ok' };
    return this;
  }

  private next(req: RecordedRequest): ScriptedTurn {
    // The vision probe asks one checkable question of a green square. A
    // sighted endpoint answers it before any script does, because the probe
    // runs during setup, long before a test has queued anything.
    if (this.vision && hasImagePart(req.body)) return { text: 'green' };
    const queued = this.queue.shift();
    if (queued) return queued;
    return typeof this.fallback === 'function' ? this.fallback(req) : this.fallback;
  }

  async start(): Promise<string> {
    this.server = http.createServer((req, res) => void this.handle(req, res));
    await new Promise<void>((resolve) => this.server!.listen(0, '127.0.0.1', resolve));
    const { port } = this.server!.address() as AddressInfo;
    return `http://127.0.0.1:${port}`;
  }

  /** OpenAI-compatible base URL, as it would appear in models.yaml. */
  async startV1(): Promise<string> {
    return `${await this.start()}/v1`;
  }

  get baseUrl(): string {
    const addr = this.server?.address() as AddressInfo | undefined;
    if (!addr) throw new Error('not started');
    return `http://127.0.0.1:${addr.port}`;
  }

  async stop(): Promise<void> {
    const s = this.server;
    this.server = null;
    if (!s) return;
    await new Promise<void>((resolve) => s.close(() => resolve()));
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const raw = Buffer.concat(chunks).toString('utf8');
    const url = new URL(req.url ?? '/', 'http://localhost');
    let body: Record<string, any> = {};
    if (raw) {
      try {
        body = JSON.parse(raw);
      } catch {
        body = { _unparsable: raw };
      }
    }
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.headers)) {
      if (typeof v === 'string') headers[k.toLowerCase()] = v;
    }
    const recorded: RecordedRequest = { path: url.pathname, body, headers, at: Date.now() };
    this.requests.push(recorded);

    const json = (status: number, payload: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(payload));
    };

    if (url.pathname === '/props') return json(200, this.props);
    if (url.pathname === '/v1/models' || url.pathname === '/models') {
      return json(200, {
        object: 'list',
        data: [this.modelId, ...this.otherModels].map((id) => ({ id, object: 'model' })),
      });
    }
    if (url.pathname === '/health' || url.pathname === '/healthz') {
      return json(200, { status: 'ok' });
    }
    if (url.pathname === '/embedding' || url.pathname === '/v1/embeddings') {
      if (!this.embeddings) return json(404, { error: 'no embeddings here' });
      const input = body.input ?? body.content ?? '';
      const texts: string[] = Array.isArray(input) ? input : [input];
      const vec = (t: string) =>
        Array.from({ length: this.embeddingDim }, (_, i) => ((t.length + i) % 7) / 7);
      if (url.pathname === '/embedding') {
        return json(
          200,
          texts.map((t) => ({ embedding: vec(t) })),
        );
      }
      return json(200, {
        object: 'list',
        data: texts.map((t, i) => ({ object: 'embedding', index: i, embedding: vec(t) })),
        model: this.modelId,
        usage: { prompt_tokens: 1, total_tokens: 1 },
      });
    }

    if (!url.pathname.endsWith('/chat/completions')) return json(404, { error: 'not found' });

    const turn = this.next(recorded);
    if (turn.delayMs) await sleep(turn.delayMs);
    if (turn.errorStatus) {
      return json(turn.errorStatus, { error: { message: 'scripted failure', type: 'test' } });
    }

    const usage = {
      prompt_tokens: turn.usage?.prompt ?? 10,
      completion_tokens: turn.usage?.completion ?? 5,
      total_tokens: (turn.usage?.prompt ?? 10) + (turn.usage?.completion ?? 5),
    };
    const toolCalls = (turn.toolCalls ?? []).map((tc, i) => ({
      index: i,
      id: `call_${i}_${Math.random().toString(36).slice(2, 8)}`,
      type: 'function' as const,
      function: {
        name: scriptedToolName(tc.name),
        arguments: typeof tc.args === 'string' ? tc.args : JSON.stringify(tc.args ?? {}),
      },
    }));
    const finishReason = turn.finishReason ?? (toolCalls.length ? 'tool_calls' : 'stop');
    // Shaped like llama.cpp's: prompt_n is the load-bearing field, the rest is
    // there so a parser that reads the object rather than the one key still works.
    const timings =
      turn.promptEvaluated === undefined
        ? undefined
        : {
            prompt_n: turn.promptEvaluated,
            prompt_ms: 12.5,
            predicted_n: usage.completion_tokens,
            predicted_ms: 40,
          };

    if (body.stream) {
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      });
      const send = (obj: unknown) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
      const base = {
        id: 'chatcmpl-fake',
        object: 'chat.completion.chunk',
        created: 1,
        model: this.modelId,
      };
      send({
        ...base,
        choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }],
      });
      for (const piece of splitForStream(turn.reasoning ?? '')) {
        send({
          ...base,
          choices: [{ index: 0, delta: { reasoning_content: piece }, finish_reason: null }],
        });
        if (turn.chunkDelayMs) await sleep(turn.chunkDelayMs);
      }
      for (const piece of splitForStream(turn.text ?? '')) {
        send({
          ...base,
          choices: [{ index: 0, delta: { content: piece }, finish_reason: null }],
        });
        if (turn.chunkDelayMs) await sleep(turn.chunkDelayMs);
      }
      if (toolCalls.length) {
        send({
          ...base,
          choices: [{ index: 0, delta: { tool_calls: toolCalls }, finish_reason: null }],
        });
      }
      send({
        ...base,
        choices: [{ index: 0, delta: {}, finish_reason: finishReason }],
        usage,
        // llama.cpp attaches timings to the last chunk carrying usage.
        ...(timings ? { timings } : {}),
      });
      res.write('data: [DONE]\n\n');
      res.end();
      return;
    }

    return json(200, {
      id: 'chatcmpl-fake',
      object: 'chat.completion',
      created: 1,
      model: this.modelId,
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: turn.text ?? '',
            // vLLM and llama.cpp both put the thinking here on a non-streamed
            // answer, the way they put it on `delta.reasoning_content` when
            // streaming — a probe or a one-shot agent call sees this shape.
            ...(turn.reasoning ? { reasoning_content: turn.reasoning } : {}),
            ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
          },
          finish_reason: finishReason,
        },
      ],
      usage,
      ...(timings ? { timings } : {}),
    });
  }
}

function splitForStream(text: string): string[] {
  if (!text) return [];
  const words = text.split(/(\s+)/).filter((s) => s.length > 0);
  return words.length ? words : [text];
}
