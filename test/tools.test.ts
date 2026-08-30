import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { globMatch, globMatchAny } from '../src/core/glob.js';
import { Config } from '../src/core/config.js';
import { openDataHome, type DataHome } from '../src/core/datadir.js';
import { FormBroker } from '../src/chat/forms.js';
import { GrantedDispatcher } from '../src/tools/dispatcher.js';
import { McpConnection } from '../src/tools/mcp/connect.js';
import type { ToolDefinition, ToolHandle } from '../src/tools/types.js';
import { configTools } from '../src/tools/integrations/config.js';
import { resolveWritablePath, PathRejected } from '../src/tools/paths.js';
import { tmpDir } from './helpers.js';

/** No handler routing exercised in these tests (personality.md, non-handler
 *  paths) — a real broker with no live model stack is enough. */
const noRoutingDeps = (home: DataHome) => ({
  forms: new FormBroker(home, new Config(home)),
  router: () => null,
});

describe('glob matching', () => {
  it('matches tool grants and envelope patterns', () => {
    expect(globMatch('memory.*', 'memory.query')).toBe(true);
    expect(globMatch('memory.*', 'memoryquery')).toBe(false);
    expect(globMatch('web.search', 'web.search')).toBe(true);
    expect(globMatch('web.search', 'web.searching')).toBe(false);
    expect(globMatch('*', 'anything.at.all')).toBe(true);
    expect(globMatch('email.*', 'email.received')).toBe(true);
    expect(globMatch('email.*', 'chat.message')).toBe(false);
    expect(globMatchAny(['a.*', 'b.*'], 'b.thing')).toBe(true);
    expect(globMatchAny([], 'b.thing')).toBe(false);
  });
});

const echoTool = (name: string, tier: 'ro' | 'se' = 'ro'): ToolDefinition => ({
  name,
  description: `echo for ${name}`,
  tier,
  args: z.object({ word: z.string() }),
  async execute(args: { word: string }) {
    return { echoed: args.word };
  },
});

describe('granted dispatcher (§11.4, App. F.7)', () => {
  const defs: ToolDefinition[] = [
    echoTool('memory.query'),
    echoTool('memory.save', 'se'),
    echoTool('web.search'),
    echoTool('email.send', 'se'),
  ];
  let handles: ToolHandle[];
  let conn: McpConnection;
  const ctx = { runId: 'r1', eventId: 'e1' };

  beforeEach(async () => {
    conn = await McpConnection.inProcess('test', defs);
    handles = await conn.listTools();
  });
  afterEach(async () => {
    await conn.close();
  });

  it('serves bundled integrations over MCP with tier annotations (§11.1)', () => {
    expect(handles.map((h) => h.name).sort()).toEqual([
      'email.send',
      'memory.query',
      'memory.save',
      'web.search',
    ]);
    expect(handles.find((h) => h.name === 'memory.query')?.tier).toBe('ro');
    expect(handles.find((h) => h.name === 'memory.save')?.tier).toBe('se');
    expect(handles.find((h) => h.name === 'web.search')?.source).toBe('test');
    const schema = handles.find((h) => h.name === 'web.search')!.inputSchema as any;
    expect(schema.type).toBe('object');
    expect(schema.properties.word.type).toBe('string');
  });

  it('only exposes granted tools to the model', () => {
    const d = new GrantedDispatcher(handles, { tools: ['memory.*'] }, ctx);
    expect(Object.keys(d.toolSet()).sort()).toEqual(['memory.query', 'memory.save']);
    expect(d.granted()).not.toContain('web.search');
  });

  it('refuses an ungranted call mechanically', async () => {
    const d = new GrantedDispatcher(handles, { tools: ['memory.*'] }, ctx);
    const r = await d.dispatch({ toolCallId: '1', name: 'email.send', args: { word: 'x' } });
    expect(r.ok).toBe(false);
    expect(r.output).toEqual({ error: 'unknown_tool' });
    expect(r.denied).toBe('not_granted');
  });

  it('refuses a tool nobody registered', async () => {
    const d = new GrantedDispatcher(handles, { tools: ['*'] }, ctx);
    const r = await d.dispatch({ toolCallId: '1', name: 'invented.tool', args: {} });
    expect(r.denied).toBe('not_granted');
  });

  it('executes a granted tool and returns its output', async () => {
    const d = new GrantedDispatcher(handles, { tools: ['web.search'] }, ctx);
    const r = await d.dispatch({ toolCallId: '1', name: 'web.search', args: { word: 'hi' } });
    expect(r).toEqual({ ok: true, output: { echoed: 'hi' }, empty: false });
  });

  it('validates arguments at the integration boundary', async () => {
    const d = new GrantedDispatcher(handles, { tools: ['web.search'] }, ctx);
    const r = await d.dispatch({ toolCallId: '1', name: 'web.search', args: { word: 42 } });
    expect(r.ok).toBe(false);
    expect((r.output as any).error).toBeTruthy();
  });

  it('passes run context as MCP metadata, not as tool arguments', async () => {
    const seen: unknown[] = [];
    const contextConn = await McpConnection.inProcess('ctx', [
      {
        name: 'ctx.peek',
        description: 'reports the ambient run context',
        tier: 'ro',
        args: z.object({}),
        async execute(_args, toolCtx) {
          seen.push(toolCtx);
          return { seen: toolCtx };
        },
      },
    ]);
    const d = new GrantedDispatcher(
      await contextConn.listTools(),
      { tools: ['ctx.*'] },
      {
        runId: 'run-1',
        eventId: 'event-1',
        conversationId: 'conv-1',
        handlerName: 'nudge',
      },
    );
    const r = await d.dispatch({ toolCallId: '1', name: 'ctx.peek', args: {} });
    expect(r.ok).toBe(true);
    expect(seen[0]).toEqual({
      runId: 'run-1',
      eventId: 'event-1',
      conversationId: 'conv-1',
      handlerName: 'nudge',
    });
    await contextConn.close();
  });

  it('makes confirm-tier tools visible but denies them until phase 8', async () => {
    const d = new GrantedDispatcher(
      handles,
      { tools: ['memory.*'], confirm: ['email.send'] },
      ctx,
    );
    expect(d.granted()).toContain('email.send');
    expect(d.toolSet()['email.send']?.description).toContain("user's approval");
    const r = await d.dispatch({ toolCallId: '1', name: 'email.send', args: { word: 'x' } });
    expect(r.denied).toBe('confirm_denied');
    expect(r.output).toEqual({ error: 'denied_by_user' });
  });

  it('lets an approving confirm callback through', async () => {
    const d = new GrantedDispatcher(
      handles,
      { confirm: ['email.send'] },
      ctx,
      async () => true,
    );
    const r = await d.dispatch({ toolCallId: '1', name: 'email.send', args: { word: 'x' } });
    expect(r.ok).toBe(true);
  });

  it('turns a throwing tool into a tool result, not a crash', async () => {
    const boomConn = await McpConnection.inProcess('boom', [
      {
        name: 'boom.now',
        description: 'always throws',
        tier: 'ro',
        args: z.object({}),
        async execute() {
          throw new Error('kaboom');
        },
      },
    ]);
    const d = new GrantedDispatcher(await boomConn.listTools(), { tools: ['*'] }, ctx);
    const r = await d.dispatch({ toolCallId: '1', name: 'boom.now', args: {} });
    expect(r.ok).toBe(false);
    expect(JSON.stringify(r.output)).toContain('kaboom');
    await boomConn.close();
  });
});

describe('config integration path safety (App. F.6)', () => {
  let t: { dir: string; cleanup: () => void };
  let home: DataHome;

  beforeEach(() => {
    t = tmpDir('turminder-paths-');
    home = openDataHome(path.join(t.dir, 'home')).home;
  });
  afterEach(() => t.cleanup());

  it('allows config, handlers and skills files', () => {
    for (const p of ['config/personality.md', 'handlers/nudge.md', 'skills/search.md']) {
      expect(resolveWritablePath(home, p)).toBe(home.path(p));
    }
  });

  it('refuses everything else', () => {
    const bad = [
      'memory/fact.md',
      'secrets/secrets.yaml',
      'events.db',
      '../escape.md',
      '/etc/passwd',
      'config',
      'config/../../escape.md',
      '',
    ];
    for (const p of bad) {
      expect(() => resolveWritablePath(home, p)).toThrowError(PathRejected);
    }
  });

  it('refuses a symlinked path component', () => {
    fs.symlinkSync('/etc', home.path('config', 'evil'));
    expect(() => resolveWritablePath(home, 'config/evil/passwd')).toThrowError(/symlink/);
  });

  it('writes, commits, and reads back through the tools', async () => {
    const [read, write] = configTools(home, noRoutingDeps(home));
    const ctx = { runId: null, eventId: null };
    const result = (await write!.execute(
      {
        path: 'config/personality.md',
        // Valid frontmatter: config.write refuses a file the loader would reject.
        content: '---\nformality: relaxed\nverbosity: terse\nhumor: dry\n---\n\nBe brief.\n',
        message: 'test: write personality',
      },
      ctx,
    )) as { path: string; committed: boolean };
    expect(result.committed).toBe(true);
    expect(fs.existsSync(home.path('config', 'personality.md'))).toBe(true);

    const back = (await read!.execute({ path: 'config/personality.md' }, ctx)) as {
      exists: boolean;
      content: string;
    };
    expect(back.exists).toBe(true);
    expect(back.content).toContain('formality: relaxed');

    const missing = (await read!.execute({ path: 'config/nope.md' }, ctx)) as {
      exists: boolean;
    };
    expect(missing.exists).toBe(false);
  });

  it('declares config.write side-effecting and config.read read-only', () => {
    const tools = configTools(home, noRoutingDeps(home));
    expect(tools.find((t) => t.name === 'config.read')?.tier).toBe('ro');
    expect(tools.find((t) => t.name === 'config.write')?.tier).toBe('se');
  });
});
