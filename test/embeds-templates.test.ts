import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { Config } from '../src/core/config.js';
import { openDataHome } from '../src/core/datadir.js';
import { openDb } from '../src/db/index.js';
import { createRepos } from '../src/db/repos/index.js';
import { EmbedBinder, MAX_BINDINGS } from '../src/embeds/binder.js';
import { renderEmbed, renderPrintDoc } from '../src/embeds/serve.js';
import { EmbedStore } from '../src/embeds/store.js';
import { embedsTools } from '../src/tools/integrations/embeds.js';
import { RunGrants } from '../src/tools/run-grants.js';
import type { ToolHandle } from '../src/tools/types.js';
import { tmpDir } from './helpers.js';

function handle(
  name: string,
  tier: 'ro' | 'se',
  call: (args: unknown) => Promise<{ ok: boolean; output: unknown }>,
): ToolHandle {
  return {
    name,
    description: name,
    tier,
    inputSchema: { type: 'object' },
    source: name.split('.')[0]!,
    call: (args) => call(args),
  };
}

function setup() {
  const t = tmpDir('turminder-embeds-tpl-');
  const { home } = openDataHome(path.join(t.dir, 'home'));
  const db = openDb(home.dbPath);
  const repos = createRepos(db);
  const store = new EmbedStore({ home, config: new Config(home), repo: repos.embeds });
  const RUN = repos.runs.create({ kind: 'chat', model: 'main' });
  const handles: ToolHandle[] = [
    handle('prices.now', 'ro', async () => ({ ok: true, output: { NOK: 1.49 } })),
    handle('prices.bad', 'ro', async () => ({
      ok: false,
      output: { error: 'invalid_arguments', message: 'expected string at area' },
    })),
    handle('mail.send', 'se', async () => ({ ok: true, output: {} })),
  ];
  const prior = new Map<string, Record<string, unknown>>([['prices.now', { area: 'NO5' }]]);
  const binder = new EmbedBinder({
    repo: repos.embeds,
    tools: () => handles,
    priorArgs: (runId, tool) => (runId === RUN ? (prior.get(tool) ?? null) : null),
  });
  const runGrants = new RunGrants();
  runGrants.register(RUN, {
    granted: () => ['prices.now', 'prices.bad', 'mail.send'],
    grantedHandles: () => [],
  });
  const create = embedsTools({ store, binder, runGrants }).find(
    (d) => d.name === 'embeds.create',
  )!;
  const ctx = { runId: RUN, eventId: null, conversationId: null };
  let n = 0;
  const run = (args: Record<string, unknown>) =>
    create.execute(
      { title: `Page ${++n}`, html: '<p>{{data:p}}</p>', ...args },
      ctx,
    ) as Promise<Record<string, any>>;
  return { repos, binder, run, create, cleanup: () => (db.close(), t.cleanup()) };
}

const REJECTED_NOTE =
  'the page was created but its bindings were rejected — fix them with embeds.bind {embed_id, bindings}; do not create the page again';

describe('embeds.create with bindings (App. F.13)', () => {
  it('binds in the same call and reports results', async () => {
    const s = setup();
    const r = await s.run({
      bindings: [{ name: 'p', tool: 'prices.now', args: { area: 'NO5' }, refresh: 'on_serve' }],
    });
    expect(r.bindings).toEqual(['p']);
    expect(r.results).toHaveLength(1);
    expect(r.results[0]).toMatchObject({ name: 'p', ok: true });
    expect(r.note).toBe('bound: p');
    expect(s.binder.values(r.embed_id)).toEqual({ p: { NOK: 1.49 } });
    s.cleanup();
  });

  it('args_from works inside create against a prior call in the run', async () => {
    const s = setup();
    const r = await s.run({ bindings: [{ name: 'p', tool: 'prices.now', args_from: true }] });
    expect(r.bindings).toEqual(['p']);
    expect(s.repos.embeds.bindings(r.embed_id)[0]!.args).toEqual({ area: 'NO5' });
    s.cleanup();
  });

  it('a rejected bind keeps the embed, with no bindings and the verbatim bind error', async () => {
    const s = setup();
    const r = await s.run({
      bindings: [{ name: 'p', tool: 'prices.bad', args: { area: {} } }],
    });
    expect(r.embed_id).toBeTruthy();
    expect(r.bindings).toEqual([]);
    expect(r.bind_error).toMatchObject({
      error: 'invalid_binding_args',
      failures: [{ name: 'p', tool: 'prices.bad', message: 'expected string at area' }],
    });
    expect(r.results).toBeUndefined();
    expect(r.note).toBe(REJECTED_NOTE);
    expect(s.repos.embeds.get(r.embed_id)).toBeTruthy();
    expect(s.repos.embeds.bindings(r.embed_id)).toEqual([]);
    s.cleanup();
  });

  it('a not_ro tool is rejected the same way', async () => {
    const s = setup();
    const r = await s.run({ bindings: [{ name: 'p', tool: 'mail.send', args: {} }] });
    expect(r.bind_error).toMatchObject({ error: 'not_ro' });
    expect(r.bindings).toEqual([]);
    expect(r.note).toBe(REJECTED_NOTE);
    s.cleanup();
  });

  it('too_many_bindings is rejected the same way', async () => {
    const s = setup();
    const many = Array.from({ length: MAX_BINDINGS + 1 }, (_, i) => ({
      name: `b${i}`,
      tool: 'prices.now',
      args: {},
    }));
    const r = await s.run({ bindings: many });
    expect(r.bind_error).toMatchObject({ error: 'too_many_bindings' });
    expect(r.bindings).toEqual([]);
    expect(r.note).toBe(REJECTED_NOTE);
    expect(s.repos.embeds.bindings(r.embed_id)).toEqual([]);
    s.cleanup();
  });

  it('bindings: [] behaves as absent', async () => {
    const s = setup();
    const r = await s.run({ bindings: [] });
    expect(r.bindings).toEqual([]);
    expect(r.bind_error).toBeUndefined();
    expect(r.results).toBeUndefined();
    expect(r.note).toBe('page references bound data — call embeds.bind now to attach it');
    s.cleanup();
  });

  it('the description says bindings may ride the create', () => {
    const s = setup();
    expect(s.create.description).toContain('bindings may ride the same call');
    s.cleanup();
  });
});

describe('print theme (§23.3)', () => {
  const AUTHORED = '<style>@page { margin: 5mm }</style><p>hi</p>';
  const LIGHT = [
    '#ffffff',
    '#1c2330',
    '#5c6675',
    '#dde2ea',
    '#eef1f5',
    '#4f6df5',
    '#e8618c',
    '#12a594',
    '#f5a623',
    '#8f6ff0',
    '#2ea3f2',
    '#5b8c5a',
    '#d0605e',
  ];

  const printBlock = (doc: string): string => {
    const i = doc.indexOf('@media print');
    expect(i).toBeGreaterThan(-1);
    return doc.slice(i, doc.indexOf('@page { margin: 14mm; }', i) + 30);
  };

  for (const [name, doc] of [
    ['renderEmbed', () => renderEmbed(AUTHORED, '01ABC', 'a'.repeat(64), {})],
    ['renderPrintDoc', () => renderPrintDoc(AUTHORED)],
  ] as const) {
    it(`${name} carries the print block before the authored HTML`, () => {
      const out = doc();
      const block = printBlock(out);
      expect(block).toContain('--t-bg: #ffffff');
      expect(block).toContain('--t-surface: #ffffff');
      expect(block).toContain('print-color-adjust: exact');
      expect(block).toContain('-webkit-print-color-adjust: exact');
      expect(block).toContain('body { margin: 0; }');
      expect(out.indexOf('@page { margin: 14mm; }')).toBeLessThan(
        out.indexOf('@page { margin: 5mm }'),
      );
      expect(out.indexOf('@media print')).toBeLessThan(out.indexOf(AUTHORED));
    });
  }

  it('uses no hex that is not a light token value', () => {
    const block = printBlock(renderPrintDoc(AUTHORED));
    const hexes = block.match(/#[0-9a-fA-F]{3,8}\b/g) ?? [];
    expect(hexes.length).toBeGreaterThan(0);
    for (const h of hexes) expect(LIGHT).toContain(h.toLowerCase());
  });

  it('the chart restyle listener also follows matchMedia(print)', () => {
    expect(renderEmbed(AUTHORED, '01ABC', 'a'.repeat(64), {})).toContain("matchMedia('print')");
  });
});
