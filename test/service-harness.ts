import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import WebSocket from 'ws';
import { bootstrap, type App } from '../src/app.js';
import { HttpServer } from '../src/net/http.js';
import { Service, type ServiceOptions } from '../src/service.js';
import { internalToolName } from '../src/model/tool-names.js';
import { FakeLlama, type RecordedRequest } from './fake-llama.js';
import { tmpDir, write } from './helpers.js';

export interface BootOptions extends ServiceOptions {
  /** Write a models.yaml pointing at the fake endpoint. */
  configured?: boolean;
  /** Write identity.md + personality.md, i.e. onboarding already done. */
  onboarded?: boolean;
  caps?: string[];
  /** Extra lines merged into config/turminder.yaml under data_defaults. */
  dataDefaults?: Record<string, string | number>;
  /** Extra top-level config/turminder.yaml sections, e.g. `files`. */
  config?: Record<string, unknown>;
  /**
   * Pre-seed config/channels.yaml — how a test gets a data dir that predates
   * a token change (§24 legacy rows). Written before bootstrap, so the
   * scaffold leaves it alone and `token` is then whatever the seed says.
   */
  channels?: Record<string, unknown>;
}

export interface ServiceHarness {
  app: App;
  service: Service;
  http: HttpServer;
  baseUrl: string;
  token: string;
  fake: FakeLlama;
  dataDir: string;
  cleanup(): Promise<void>;
}

export async function bootService(opts: BootOptions = {}): Promise<ServiceHarness> {
  const t = tmpDir('turminder-svc-');
  const dataDir = path.join(t.dir, 'home');
  const fake = new FakeLlama();
  const fakeUrl = await fake.startV1();

  fs.mkdirSync(path.join(dataDir, 'config'), { recursive: true });
  const extraDefaults = Object.entries(opts.dataDefaults ?? {})
    .map(([k, v]) => `  ${k}: ${v}\n`)
    .join('');
  write(
    path.join(dataDir, 'config', 'turminder.yaml'),
    'bind: 127.0.0.1:0\ndata_defaults:\n  retry_backoff_s: [0, 0, 0]\n  conversation_idle_min: 30\n' +
      extraDefaults +
      (opts.config && Object.keys(opts.config).length ? YAML.stringify(opts.config) : ''),
  );
  if (opts.configured !== false) {
    write(
      path.join(dataDir, 'config', 'models.yaml'),
      YAML.stringify({
        endpoints: [
          {
            name: 'main',
            url: fakeUrl,
            classes: ['fast', 'best'],
            caps: opts.caps ?? ['json', 'tools'],
            context_size: 32768,
          },
        ],
        embedding: { url: fake.baseUrl },
      }),
    );
  }
  if (opts.onboarded) {
    write(
      path.join(dataDir, 'config', 'identity.md'),
      `---\ninstance_name: Sleeper Service\nuser_name: Alex\ntimezone: Europe/Oslo\nlocale: en\nonboarded_at: 2026-08-20T12:00:00.000Z\n---\n\nNothing further.\n`,
    );
    write(
      path.join(dataDir, 'config', 'personality.md'),
      `---\nformality: relaxed\nverbosity: terse\nhumor: dry\n---\n\nBe brief.\n`,
    );
  }

  if (opts.channels) {
    write(path.join(dataDir, 'config', 'channels.yaml'), YAML.stringify(opts.channels));
  }

  const app = bootstrap({ dataDir });
  const {
    configured: _c,
    onboarded: _o,
    caps: _caps,
    dataDefaults: _dd,
    config: _cfg,
    channels: _ch,
    ...serviceOpts
  } = opts;
  // The §3c greeting is off unless a test asks for it: it fires during
  // `start()` on any not-yet-onboarded install, and an unannounced model call
  // there would consume the response the test scripted for its own turn.
  const service = new Service(app, {
    pollMs: 20,
    sweepMs: 0,
    greetOnStart: false,
    ...serviceOpts,
  });
  await service.start();
  const http = new HttpServer(service);
  const { host, port } = await http.listen();
  // The scaffold's one-time value (§24): channels.yaml stores only its hash,
  // so this is the only place a test can learn the ui token — same as a real
  // first run.
  const token = app.newUiToken ?? 'missing-token';

  return {
    app,
    service,
    http,
    baseUrl: `http://${host}:${port}`,
    token,
    fake,
    dataDir,
    async cleanup() {
      await http.close();
      await service.stop();
      app.close();
      await fake.stop();
      t.cleanup();
    },
  };
}

/**
 * Installs an external MCP server the way the form flow does, minus the form,
 * and grants its tools. Shared because more than one suite needs a *real*
 * external tool — a bound data source, in particular, has to be one (§23.2).
 */
export async function installMcpServer(
  harness: ServiceHarness,
  server: { name: string; fixture: string; description?: string; env?: Record<string, string> },
): Promise<void> {
  const env = Object.entries(server.env ?? {})
    .map(([k, v]) => `      ${k}: ${JSON.stringify(v)}\n`)
    .join('');
  write(
    path.join(harness.dataDir, 'config', 'mcp.yaml'),
    `servers:\n  - name: ${server.name}\n    transport: stdio\n` +
      (server.description ? `    description: ${JSON.stringify(server.description)}\n` : '') +
      `    command: ["node", "${server.fixture}"]\n` +
      (env ? `    env:\n${env}` : ''),
  );
  harness.app.config.reload();
  await harness.service.tools.connectExternal(server.name);
  // Granting is separate from connecting (§19.4), and every caller here needs
  // the grant: an ungranted namespace is not paged, it is simply absent.
  harness.service.grants.add(
    harness.service.tools
      .toolsFrom(server.name)
      .map((pattern) => ({ pattern, level: 'tools' as const })),
    'test grant',
  );
}

export interface Frame {
  id: string;
  type: string;
  payload: any;
}

/** A test stand-in for the chat UI: sends frames, waits for frames. */
export class TestClient {
  private readonly socket: WebSocket;
  readonly frames: Frame[] = [];
  private readonly waiters: { type: string; resolve: (f: Frame) => void }[] = [];
  closeCode: number | null = null;

  private constructor(socket: WebSocket) {
    this.socket = socket;
    socket.on('message', (raw) => {
      const frame = JSON.parse(raw.toString()) as Frame;
      const i = this.waiters.findIndex((w) => w.type === frame.type);
      if (i >= 0) {
        // Consumed by a waiter: do not also leave it in the backlog, or the
        // next `next()` for this type resolves with a frame already handled.
        this.waiters.splice(i, 1)[0]!.resolve(frame);
        return;
      }
      this.frames.push(frame);
    });
    socket.on('close', (code) => {
      this.closeCode = code;
    });
  }

  static connect(baseUrl: string, token: string): Promise<TestClient> {
    const url = `${baseUrl.replace('http', 'ws')}/ws?token=${encodeURIComponent(token)}`;
    const socket = new WebSocket(url);
    return new Promise((resolve, reject) => {
      socket.once('open', () => resolve(new TestClient(socket)));
      socket.once('error', reject);
      socket.once('unexpected-response', (_req, res) =>
        reject(new Error(`upgrade rejected: HTTP ${res.statusCode}`)),
      );
    });
  }

  send(type: string, payload: Record<string, unknown> = {}): void {
    this.socket.send(JSON.stringify({ id: `t-${Math.random()}`, type, payload }));
  }

  /** Resolves with the next frame of this type (or one already received). */
  async next(type: string, timeoutMs = 8000): Promise<Frame> {
    const seen = this.frames.find((f) => f.type === type);
    if (seen) {
      this.frames.splice(this.frames.indexOf(seen), 1);
      return seen;
    }
    return new Promise<Frame>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`timed out waiting for frame ${type}`)),
        timeoutMs,
      );
      this.waiters.push({
        type,
        resolve: (f) => {
          clearTimeout(timer);
          resolve(f);
        },
      });
    });
  }

  /**
   * The next frame of this type whose payload satisfies `match`. For streams
   * where a frame of the right type may already be in flight for a different
   * subject — event status pushes, where a background run's transitions land
   * between the two you are watching for.
   */
  async until(
    type: string,
    match: (payload: Record<string, unknown>) => boolean,
    timeoutMs = 8000,
  ): Promise<Record<string, unknown>> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error(`timed out waiting for ${type} to match`);
      const frame = await this.next(type, remaining);
      const payload = frame.payload as Record<string, unknown>;
      if (match(payload)) return payload;
    }
  }

  /** Resolves with the close code when the server hangs up (§24.1 revocation). */
  closed(timeoutMs = 8000): Promise<number> {
    if (this.closeCode !== null) return Promise.resolve(this.closeCode);
    return new Promise<number>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('socket was not closed')), timeoutMs);
      this.socket.once('close', (code: number) => {
        clearTimeout(timer);
        resolve(code);
      });
    });
  }

  of(type: string): Frame[] {
    return this.frames.filter((f) => f.type === type);
  }

  deltaText(): string {
    return this.of('chat.delta')
      .map((f) => f.payload.text as string)
      .join('');
  }

  async hello(capabilities = ['chat']): Promise<Frame> {
    this.send('hello', { device: 'ui', capabilities, last_seen: 0 });
    return this.next('welcome');
  }

  close(): void {
    this.socket.close();
  }
}

export async function postJson(
  url: string,
  body: unknown,
  token?: string,
): Promise<{ status: number; body: any }> {
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

/**
 * The tools a request offered, named the way App. F names them.
 *
 * Tools cross the wire with underscores because two of the three big hosted
 * providers reject a dot in a tool name (`src/model/tool-names.ts`), so the
 * endpoint — and therefore the fake — sees `memory_save`. Almost every test
 * that looks at this is asking a *policy* question: which capabilities was
 * this agent offered. That question is asked in the catalog's vocabulary, so
 * the wire names go back through the gateway's own inverse. The wire format
 * itself is pinned in `gateway.test.ts`, where it belongs.
 */
export function offeredTools(
  harness: ServiceHarness,
  req: RecordedRequest = harness.fake.requests.at(-1)!,
): string[] {
  return ((req.body.tools ?? []) as { function: { name: string } }[]).map((t) =>
    internalToolName(t.function.name),
  );
}
