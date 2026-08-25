import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { globMatchAny } from '../../core/glob.js';
import { errMessage } from '../../core/errors.js';
import { log } from '../../core/logger.js';
import type { McpYaml } from '../../core/config-schemas.js';
import { META_KEY, type ToolContext, type ToolDefinition, type ToolHandle } from '../types.js';
import { TOOL_CALL_TIMEOUT_MS } from '../timeouts.js';
import { buildIntegrationServer } from './serve.js';

const l = log('mcp');

type McpServerConfig = McpYaml['servers'][number];

/** One connected MCP server — bundled in-process or external. */
export class McpConnection {
  private constructor(
    readonly name: string,
    private readonly client: Client,
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
  ) {}

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
    return new McpConnection(name, client, [], 'se', budgets, bulkArgs, emptiness);
  }

  /** An external MCP server from config/mcp.yaml (App. G.5). */
  static async external(cfg: McpServerConfig): Promise<McpConnection> {
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
    // External tools are side-effecting unless the operator says otherwise, or
    // the server declares readOnlyHint itself.
    return new McpConnection(cfg.name, client, cfg.read_only_tools ?? [], 'se');
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
        call: (args: unknown, ctx: ToolContext) => this.call(t.name, args, ctx),
      } satisfies ToolHandle;
    });
  }

  private async call(
    tool: string,
    args: unknown,
    ctx: ToolContext,
  ): Promise<{ ok: boolean; output: unknown }> {
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
    try {
      await this.client.close();
    } catch {
      /* already gone */
    }
  }
}
