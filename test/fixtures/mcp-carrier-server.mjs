#!/usr/bin/env node
/**
 * A parcel carrier, for the watcher tests (§30). One read-only tracking tool
 * whose status the test drives through a file, and one side-effecting tool that
 * exists only so `watch.create` has something to refuse.
 *
 * `TURMINDER_TEST_STATUS_FILE` names a file holding the current status; writing
 * it is how a test moves the parcel. Absent or unreadable means "the carrier is
 * down", which is the failure path §30.2 cares about.
 */
import fs from 'node:fs';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const server = new McpServer(
  { name: 'carrier', version: '1.0.0' },
  { capabilities: { tools: {} } },
);

server.registerTool(
  'carrier.track',
  {
    description: 'Track a parcel by code. Read-only.',
    inputSchema: { code: z.string() },
    annotations: { readOnlyHint: true },
  },
  async (args) => {
    const file = process.env.TURMINDER_TEST_STATUS_FILE ?? '';
    let status;
    try {
      status = fs.readFileSync(file, 'utf8').trim();
    } catch {
      return { isError: true, content: [{ type: 'text', text: 'the carrier API is down' }] };
    }
    if (status === 'DOWN') {
      return { isError: true, content: [{ type: 'text', text: 'the carrier API is down' }] };
    }
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({ shipment: { code: args.code, status }, checked_at: 'now' }),
        },
      ],
    };
  },
);

server.registerTool(
  'carrier.book',
  {
    description: 'Book a courier pickup. Has side effects.',
    inputSchema: {},
    annotations: { readOnlyHint: false },
  },
  async () => ({ content: [{ type: 'text', text: JSON.stringify({ booked: true }) }] }),
);

await server.connect(new StdioServerTransport());
