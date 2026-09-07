#!/usr/bin/env node
/**
 * An external MCP server that can be taken away and brought back, the way a
 * VPN route can (§11.6). Two knobs, both files rather than signals, because a
 * reconnect spawns a *new* process and the test needs to steer that one too:
 *
 * - `FLAKY_DOWN_FILE` present at startup → exit immediately, so connecting
 *   fails the way an unreachable host fails.
 * - `FLAKY_TOOLSET_FILE` contents pick the tool list, so a reconnect can find
 *   a server that serves something different than it did an hour ago.
 *
 * `flaky.die` exits the process after answering — a live connection dropping
 * under a call that already succeeded.
 */
import fs from 'node:fs';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const downFile = process.env.FLAKY_DOWN_FILE;
if (downFile && fs.existsSync(downFile)) process.exit(1);

const toolsetFile = process.env.FLAKY_TOOLSET_FILE;
const toolset =
  toolsetFile && fs.existsSync(toolsetFile)
    ? fs.readFileSync(toolsetFile, 'utf8').trim()
    : 'default';

const server = new McpServer(
  { name: 'flaky', version: '1.0.0' },
  { capabilities: { tools: {} } },
);

server.registerTool(
  'flaky.ping',
  {
    description: 'Answer with a fixed value, for tests.',
    inputSchema: { echo: z.string().optional() },
    annotations: { readOnlyHint: true },
  },
  async (args) => ({
    content: [{ type: 'text', text: JSON.stringify({ pong: args.echo ?? 'pong', toolset }) }],
  }),
);

if (toolset === 'extended') {
  server.registerTool(
    'flaky.extra',
    {
      description: 'A tool the server only grew later.',
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => ({ content: [{ type: 'text', text: JSON.stringify({ extra: true }) }] }),
  );
}

server.registerTool(
  'flaky.die',
  {
    description: 'Answer, then exit — a server that drops under a live connection.',
    inputSchema: {},
  },
  async () => {
    setTimeout(() => process.exit(0), 20).unref();
    return { content: [{ type: 'text', text: JSON.stringify({ dying: true }) }] };
  },
);

await server.connect(new StdioServerTransport());
