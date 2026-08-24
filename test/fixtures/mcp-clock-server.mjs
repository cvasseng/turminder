#!/usr/bin/env node
/**
 * A real external MCP server, as a separate process over stdio. Used to prove
 * that external servers and bundled integrations are indistinguishable to the
 * agent layer (§11.1).
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const server = new McpServer(
  { name: 'clock', version: '1.0.0' },
  { capabilities: { tools: {} } },
);

server.registerTool(
  'clock.now',
  {
    description: 'Return a fixed timestamp, for tests.',
    inputSchema: { timezone: z.string().optional() },
    annotations: { readOnlyHint: true },
  },
  async (args) => ({
    content: [
      {
        type: 'text',
        text: JSON.stringify({
          now: '2026-08-20T21:00:00.000Z',
          timezone: args.timezone ?? 'UTC',
          pid_is_separate: process.pid !== Number(process.env.PARENT_PID ?? -1),
        }),
      },
    ],
  }),
);

server.registerTool(
  'clock.set_alarm',
  {
    description: 'Pretend to set an alarm. Side-effecting.',
    inputSchema: { at: z.string() },
  },
  async (args) => ({ content: [{ type: 'text', text: JSON.stringify({ set: args.at }) }] }),
);

await server.connect(new StdioServerTransport());
