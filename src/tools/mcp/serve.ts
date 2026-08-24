import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { errMessage } from '../../core/errors.js';
import { META_KEY, type ToolContext, type ToolDefinition } from '../types.js';

function contextFromMeta(meta: unknown): ToolContext {
  const raw = (meta as Record<string, unknown> | undefined)?.[META_KEY] as
    Record<string, unknown> | undefined;
  return {
    runId: typeof raw?.run_id === 'string' ? raw.run_id : null,
    eventId: typeof raw?.event_id === 'string' ? raw.event_id : null,
    conversationId: typeof raw?.conversation_id === 'string' ? raw.conversation_id : null,
    handlerName: typeof raw?.handler_name === 'string' ? raw.handler_name : null,
  };
}

/**
 * Wraps a set of bundled tools as a real MCP server (§11.1). The point is not
 * ceremony: an integration built this way can be lifted out into a standalone
 * server process without the agent layer noticing.
 */
export function buildIntegrationServer(name: string, defs: ToolDefinition[]): McpServer {
  const server = new McpServer(
    { name: `turminder-${name}`, version: '0.1.0' },
    { capabilities: { tools: {} } },
  );

  for (const def of defs) {
    const shape =
      def.args instanceof z.ZodObject
        ? (def.args.shape as Record<string, z.ZodTypeAny>)
        : undefined;
    server.registerTool(
      def.name,
      {
        description: def.description,
        ...(shape ? { inputSchema: shape } : {}),
        annotations: { readOnlyHint: def.tier === 'ro', destructiveHint: def.tier === 'se' },
      },
      async (args: unknown, extra: { _meta?: unknown }) => {
        const ctx = contextFromMeta(extra?._meta);
        try {
          const parsed = def.args.safeParse(args ?? {});
          if (!parsed.success) {
            return {
              isError: true,
              content: [
                {
                  type: 'text' as const,
                  text: JSON.stringify({
                    error: 'invalid_arguments',
                    detail: parsed.error.issues
                      .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
                      .join('; '),
                  }),
                },
              ],
            };
          }
          const result = await def.execute(parsed.data, ctx);
          return {
            content: [{ type: 'text' as const, text: JSON.stringify(result ?? { ok: true }) }],
          };
        } catch (e) {
          return {
            isError: true,
            content: [
              {
                type: 'text' as const,
                text: JSON.stringify({ error: 'tool_failed', message: errMessage(e) }),
              },
            ],
          };
        }
      },
    );
  }

  return server;
}
