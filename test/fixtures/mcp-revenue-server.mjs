#!/usr/bin/env node
/**
 * An external MCP server with one read-only tool that returns a number, and one
 * side-effecting tool that does not. It exists for the data-trust tests (§23.2):
 * the sentinel it returns must reach a served page and a printed PDF, and must
 * appear in no LLM request anywhere.
 *
 * `TURMINDER_TEST_SENTINEL` lets a test choose the number; `TURMINDER_TEST_DEAD`
 * makes the read-only tool fail, for the stale-but-marked path.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const server = new McpServer(
  { name: 'revenue', version: '1.0.0' },
  { capabilities: { tools: {} } },
);

server.registerTool(
  'revenue.total',
  {
    description: 'Total revenue for a quarter. Read-only.',
    inputSchema: { quarter: z.string().optional() },
    annotations: { readOnlyHint: true },
  },
  async (args) => {
    if (process.env.TURMINDER_TEST_DEAD === '1') {
      return { isError: true, content: [{ type: 'text', text: 'upstream is down' }] };
    }
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            total: Number(process.env.TURMINDER_TEST_SENTINEL ?? 987654321),
            currency: 'NOK',
            quarter: args.quarter ?? 'Q3',
          }),
        },
      ],
    };
  },
);

server.registerTool(
  'revenue.book',
  {
    description: 'Book a revenue entry. Side-effecting, and therefore unbindable.',
    inputSchema: { amount: z.number() },
  },
  async (args) => ({
    content: [{ type: 'text', text: JSON.stringify({ booked: args.amount }) }],
  }),
);

await server.connect(new StdioServerTransport());
