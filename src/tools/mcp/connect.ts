import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { globMatchAny } from '../../core/glob.js';
import { errMessage } from '../../core/errors.js';
import { log } from '../../core/logger.js';
import type { McpYaml } from '../../core/config-schemas.js';
import {
  META_KEY,
  type ConfirmLines,
  type ToolContext,
  type ToolDefinition,
  type ToolHandle,
} from '../types.js';
import { TOOL_CALL_TIMEOUT_MS } from '../timeouts.js';
import { buildIntegrationServer } from './serve.js';

const l = log('mcp');

type McpServerConfig = McpYaml['servers'][number];

/**
 * What a not-alive connection does when a call arrives (§11.6). The hub owns
 * it, because reviving means re-reading `mcp.yaml` for this server's own
 * definition and re-listing the catalog afterwards — both hub concerns. The
 * message it returns on failure names the server and when it will next be
 * retried, because an error that teaches beats an absence that does not.
 */
export type Revive = () => Promise<{ ok: true } | { ok: false; message: string }>;

/** One connected MCP server — bundled in-process or external. */
export class McpConnection {
  /**
   * Observed, never inferred (§11.6). Map membership is not evidence of
   * anything: the connection object outlives the server, which is exactly how
   * `connected: true` kept being reported about a process that had exited.
   */
  private live = true;
  private failure: string | null = null;
  /** Installed by the hub on external connections only. */
  revive: Revive | null = null;

  private constructor(
    readonly name: string,
    private client: Client,
    private readonly readOnlyPatterns: readonly string[],
    private readonly defaultTier: 'ro' | 'se',
    /** Per-tool transcript budgets, from the definitions (§20.3). */
    private readonly budgets: ReadonlyMap<string, number> = new Map(),
    /** Per-tool bulk-content arg fields, from the definitions (§20.6). */
    private readonly bulkArgs: ReadonlyMap<string, readonly string[]> = new Map(),
    /**
     * Per-tool emptiness predicates (§20.9). Bundled integrations only: an
     * external server's results are shaped by somebody else, so the fallback
     * ("an `{error}` counts, nothing else") is all they ever get.
     */
    private readonly emptiness: ReadonlyMap<string, (result: unknown) => boolean> = new Map(),
    /**
     * Per-tool confirmation wording (§7.3). Bundled integrations only, for the
     * same reason as `emptiness`: an external server writes for a model, and
     * text a human authorises from is not text a stranger supplies (§14.2).
     */
    private readonly summaries: ReadonlyMap<
      string,
      (args: unknown) => ConfirmLines
    > = new Map(),
    /**
     * In-process connections are trivially alive and must stay that way: a
     * bundled integration is the same process, and it cannot drop.
     */
    private readonly external = false,
  ) {}

  get alive(): boolean {
    return !this.external || this.live;
  }

  /** The error that took the server down, for every status surface (§11.6). */
  get error(): string | null {
    return this.external && !this.live ? this.failure : null;
  }

  /** Wire the transport's own signals to `live`. External connections only. */
  private watch(client: Client): void {
    client.onclose = () => {
      if (!this.live) return;
      this.live = false;
      this.failure ??= 'the connection closed';
      l.warn({ server: this.name }, 'external mcp server dropped');
    };
    client.onerror = (e: Error) => {
      this.failure = errMessage(e);
      this.live = false;
    };
  }

  /**
   * Reconnect this same object — identity matters, because every tool handle
   * in the catalog closes over it. Replacing the object would leave the
   * catalog pointing at the corpse, which is a subtler version of the bug
   * §11.6 exists to fix. Re-reads nothing itself: the caller hands in the
   * server's own definition, freshly read from `mcp.yaml`.
   */
  async reconnect(cfg: McpServerConfig): Promise<void> {
    try {
      await this.client.close();
    } catch {
      /* already gone */
    }
    this.client = await connectClient(cfg);
    this.failure = null;
    this.live = true;
    this.watch(this.client);
    l.info({ server: cfg.name, transport: cfg.transport }, 'reconnected external mcp server');
  }

  /** A bundled integration over the in-memory transport (§11.1). */
  static async inProcess(name: string, defs: ToolDefinition[]): Promise<McpConnection> {
    const server = buildIntegrationServer(name, defs);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: `turminder-client-${name}`, version: '0.1.0' });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    const budgets = new Map(
      defs
        .filter((d) => d.maxResultChars !== undefined)
        .map((d) => [d.name, d.maxResultChars!] as const),
    );
    const bulkArgs = new Map(
      defs.filter((d) => d.bulkArgs?.length).map((d) => [d.name, d.bulkArgs!] as const),
    );
    const emptiness = new Map(
      defs
        .filter((d) => d.isEmpty)
        .map((d) => [d.name, d.isEmpty!.bind(d) as (r: unknown) => boolean] as const),
    );
    const summaries = new Map(
      defs
        .filter((d) => d.confirmSummary)
        .map(
          (d) =>
            [d.name, d.confirmSummary!.bind(d) as (args: unknown) => ConfirmLines] as const,
        ),
    );
    return new McpConnection(name, client, [], 'se', budgets, bulkArgs, emptiness, summaries);
  }

  /** An external MCP server from config/mcp.yaml (App. G.5). */
  static async external(cfg: McpServerConfig): Promise<McpConnection> {
    const client = await connectClient(cfg);
    // External tools are side-effecting unless the operator says otherwise, or
    // the server declares readOnlyHint itself.
    const conn = new McpConnection(
      cfg.name,
      client,
      cfg.read_only_tools ?? [],
      'se',
      new Map(),
      new Map(),
      new Map(),
      new Map(),
      true,
    );
    conn.watch(client);
    return conn;
  }

  async listTools(): Promise<ToolHandle[]> {
    const { tools } = await this.client.listTools();
    return tools.map((t) => {
      const annotated = (t.annotations as { readOnlyHint?: boolean } | undefined)?.readOnlyHint;
      const tier =
        annotated === true || globMatchAny(this.readOnlyPatterns, t.name)
          ? 'ro'
          : annotated === false
            ? 'se'
            : this.defaultTier;
      return {
        name: t.name,
        description: t.description ?? t.name,
        tier,
        inputSchema: (t.inputSchema ?? { type: 'object', properties: {} }) as Record<
          string,
          unknown
        >,
        source: this.name,
        ...(this.budgets.has(t.name) ? { maxResultChars: this.budgets.get(t.name)! } : {}),
        ...(this.bulkArgs.has(t.name) ? { bulkArgs: this.bulkArgs.get(t.name)! } : {}),
        ...(this.emptiness.has(t.name) ? { isEmpty: this.emptiness.get(t.name)! } : {}),
        ...(this.summaries.has(t.name) ? { confirmSummary: this.summaries.get(t.name)! } : {}),
        call: (args: unknown, ctx: ToolContext) => this.call(t.name, args, ctx),
      } satisfies ToolHandle;
    });
  }

  private async call(
    tool: string,
    args: unknown,
    ctx: ToolContext,
  ): Promise<{ ok: boolean; output: unknown }> {
    // A dead connection reconnects on demand (§11.6): "fix the VPN and ask
    // again" is the path a user actually takes, and the *call* is what
    // triggers it — which is also why the tools stay advertised while the
    // server is down. A failure here is a value naming the server and the
    // next retry, never a throw and never a bare `tool_failed`.
    if (!this.alive) {
      const revived = this.revive
        ? await this.revive()
        : { ok: false as const, message: `${this.name} is not connected` };
      if (!revived.ok) {
        return { ok: false, output: { error: 'server_unavailable', message: revived.message } };
      }
    }
    try {
      const result = await this.client.callTool(
        {
          name: tool,
          arguments: (args ?? {}) as Record<string, unknown>,
          // Run context rides as request metadata, so it can never be confused
          // with model-supplied arguments (App. F.4).
          _meta: {
            [META_KEY]: {
              run_id: ctx.runId,
              event_id: ctx.eventId,
              conversation_id: ctx.conversationId ?? null,
              handler_name: ctx.handlerName ?? null,
            },
          },
        },
        undefined,
        { timeout: TOOL_CALL_TIMEOUT_MS },
      );
      const content = (result.content ?? []) as { type: string; text?: string }[];
      const text = content
        .filter((c) => c.type === 'text' && typeof c.text === 'string')
        .map((c) => c.text as string)
        .join('\n');
      let output: unknown = text;
      try {
        output = JSON.parse(text);
      } catch {
        /* plain text results are fine */
      }
      if (result.structuredContent) output = result.structuredContent;
      const ok = result.isError !== true;
      if (!ok && (typeof output !== 'object' || output === null)) {
        // Server-side failures (including schema validation) come back as text.
        // The model deals better with a shape than with a sentence.
        const message = typeof output === 'string' ? output : String(output);
        output = {
          error: /validation|invalid arguments/i.test(message)
            ? 'invalid_arguments'
            : 'tool_failed',
          message,
        };
      }
      return { ok, output };
    } catch (e) {
      l.warn({ tool, err: errMessage(e) }, 'mcp call failed');
      return { ok: false, output: { error: 'tool_failed', message: errMessage(e) } };
    }
  }

  async close(): Promise<void> {
    // Deliberate, so `onclose` does not report a shutdown as a drop.
    this.client.onclose = undefined;
    this.client.onerror = undefined;
    try {
      await this.client.close();
    } catch {
      /* already gone */
    }
  }
}

/** One transport, one place (App. G.5) — connect and reconnect share it. */
async function connectClient(cfg: McpServerConfig): Promise<Client> {
  const client = new Client({ name: 'turminder', version: '0.1.0' });
  if (cfg.transport === 'stdio') {
    const [command, ...args] = cfg.command ?? [];
    if (!command) throw new Error(`mcp server ${cfg.name}: empty command`);
    await client.connect(
      new StdioClientTransport({
        command,
        args,
        env: { ...(process.env as Record<string, string>), ...(cfg.env ?? {}) },
      }),
    );
  } else {
    if (!cfg.url) throw new Error(`mcp server ${cfg.name}: missing url`);
    await client.connect(
      new StreamableHTTPClientTransport(new URL(cfg.url), {
        ...(cfg.headers ? { requestInit: { headers: cfg.headers } } : {}),
      }),
    );
  }
  return client;
}
