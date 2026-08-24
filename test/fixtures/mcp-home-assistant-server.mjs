#!/usr/bin/env node
/**
 * A stand-in for a large external MCP server, shaped like Home Assistant's:
 * dot-less tool names, ~20 of them, chunky schemas. It exists to make the
 * §21.2 case concrete — a namespace nobody wants to pay for in a conversation
 * about the calendar, and nobody wants to be without in a conversation about
 * the lights.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const server = new McpServer(
  { name: 'home-assistant', version: '1.0.0' },
  { capabilities: { tools: {} } },
);

const target = {
  name: z
    .string()
    .describe('the name of the device, room or area as it appears in Home Assistant'),
  area: z.string().optional().describe('restrict to one area, e.g. "kitchen" or "upstairs"'),
  domain: z
    .string()
    .optional()
    .describe('entity domain to restrict to, e.g. light, switch, media_player, climate'),
};

/** The state the fake keeps, so a call has something to change. */
const state = new Map();

const tools = [
  ['HassTurnOn', 'Turn on a device, or everything in an area.', target],
  ['HassTurnOff', 'Turn off a device, or everything in an area.', target],
  [
    'HassLightSet',
    'Set brightness or colour of a light.',
    {
      ...target,
      brightness: z.number().min(0).max(100).optional().describe('percent'),
      color: z.string().optional().describe('a colour name or hex value'),
    },
  ],
  [
    'HassClimateSetTemperature',
    'Set a thermostat target temperature.',
    {
      ...target,
      temperature: z.number().describe('degrees, in the system unit'),
    },
  ],
  ['HassMediaPause', 'Pause whatever is playing.', target],
  ['HassMediaUnpause', 'Resume whatever was paused.', target],
  ['HassMediaNext', 'Skip to the next track.', target],
  ['HassMediaPrevious', 'Go back to the previous track.', target],
  [
    'HassSetVolume',
    'Set the volume of a media player.',
    {
      ...target,
      volume_level: z.number().min(0).max(100).describe('percent'),
    },
  ],
  ['HassVacuumStart', 'Start a vacuum cleaner.', target],
  ['HassVacuumReturnToBase', 'Send a vacuum cleaner back to its dock.', target],
  [
    'HassShoppingListAddItem',
    'Add an item to the shopping list.',
    {
      item: z.string().describe('what to add'),
    },
  ],
  [
    'HassListAddItem',
    'Add an item to a named to-do list.',
    {
      item: z.string(),
      name: z.string().describe('which list'),
    },
  ],
  ['HassGetState', 'Read the current state of devices.', target],
  ['HassLockLock', 'Lock a lock.', target],
  ['HassLockUnlock', 'Unlock a lock.', target],
  ['HassCoverOpen', 'Open a cover, blind or garage door.', target],
  ['HassCoverClose', 'Close a cover, blind or garage door.', target],
  [
    'HassCoverSetPosition',
    'Set a cover to a specific position.',
    {
      ...target,
      position: z.number().min(0).max(100).describe('percent open'),
    },
  ],
  [
    'HassTimerStart',
    'Start a timer on a device.',
    {
      ...target,
      duration: z.string().describe('e.g. "10 minutes"'),
    },
  ],
  [
    'HassBroadcast',
    'Announce a message on the speakers.',
    {
      message: z.string(),
      area: z.string().optional(),
    },
  ],
  ['GetLiveContext', 'Read the current state of the whole house.', {}],
  [
    'HassRespond',
    'Speak a response through the assistant satellite.',
    {
      message: z.string(),
    },
  ],
];

for (const [name, description, inputSchema] of tools) {
  server.registerTool(
    name,
    {
      description,
      inputSchema,
      annotations: {
        readOnlyHint: name.startsWith('HassGet') || name === 'GetLiveContext',
      },
    },
    async (args) => {
      if (name === 'HassTurnOn' || name === 'HassTurnOff') {
        state.set(args.name, name === 'HassTurnOn' ? 'on' : 'off');
      }
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              tool: name,
              args,
              ...(args?.name ? { state: state.get(args.name) ?? 'unknown' } : {}),
            }),
          },
        ],
      };
    },
  );
}

await server.connect(new StdioServerTransport());
