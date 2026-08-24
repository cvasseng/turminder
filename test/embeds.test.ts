import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { Config } from '../src/core/config.js';
import { openDataHome, type DataHome } from '../src/core/datadir.js';
import { openDb } from '../src/db/index.js';
import { createRepos, type Repos } from '../src/db/repos/index.js';
import { EmbedStore, findExternalReference } from '../src/embeds/store.js';
import { EmbedBinder } from '../src/embeds/binder.js';
import { EmbedReaper } from '../src/embeds/reaper.js';
import { TokenBuckets } from '../src/embeds/limits.js';
import { embedCsp, renderEmbed } from '../src/embeds/serve.js';
import { EMBED_SECRET_KEY, scopedToken } from '../src/embeds/tokens.js';
import { handlerBindings } from '../src/embeds/bindings.js';
import { matches } from '../src/exec/handlers.js';
import { embedsTools } from '../src/tools/integrations/embeds.js';
import { RunGrants } from '../src/tools/run-grants.js';
import type { ToolHandle } from '../src/tools/types.js';
import type { EventRecord } from '../src/db/repos/events.js';
import { tmpDir, write } from './helpers.js';

const ctx = { runId: null, eventId: null, conversationId: null };

interface Env {
  home: DataHome;
  config: Config;
  repos: Repos;
  store: EmbedStore;
  /** What the integration is built from; bindings have their own suite. */
  deps: () => { store: EmbedStore; binder: EmbedBinder; runGrants: RunGrants };
  cleanup(): void;
}

function env(): Env {
  const t = tmpDir('turminder-embeds-');
  const { home } = openDataHome(path.join(t.dir, 'home'));
  const db = openDb(home.dbPath);
  const repos = createRepos(db);
  const config = new Config(home);
  const store = new EmbedStore({ home, config, repo: repos.embeds });
  const handles: ToolHandle[] = [];
  const binder = new EmbedBinder({ repo: repos.embeds, tools: () => handles });
  const runGrants = new RunGrants();
  return {
    home,
    config,
    repos,
    store,
    deps: () => ({ store, binder, runGrants }),
    cleanup() {
      db.close();
      t.cleanup();
    },
  };
}

const PAGE = '<div id="chart">hello</div><style>#chart{color:red}</style>';

/* ── store and tools (App. F.13) ──────────────────────────────────────────── */

describe('the embed store (§22.1, App. F.13)', () => {
  it('creates an ephemeral embed under tmp/ and returns its marker', () => {
    const e = env();
    const created = e.store.create({ title: 'Week chart', html: PAGE });
    if ('error' in created) throw new Error(created.message);
    expect(created.marker).toBe(`{{embed:${created.embed_id}}}`);
    expect(created.url).toMatch(new RegExp(`^/embed/${created.embed_id}\\?t=[0-9a-f]{64}$`));
    expect(fs.existsSync(e.home.path('embeds', 'tmp', `${created.embed_id}.html`))).toBe(true);
    // Ephemeral embeds never enter the log (§22.1).
    expect(e.home.git.commit('probe', ['embeds'])).toBe(false);
    e.cleanup();
  });

  it('commits a persistent embed, and its edits', () => {
    const e = env();
    e.home.git.init();
    const created = e.store.create({ title: 'Budget', html: PAGE, kind: 'persistent' });
    if ('error' in created) throw new Error(created.message);
    expect(fs.existsSync(e.home.path('embeds', `${created.embed_id}.html`))).toBe(true);
    const edited = e.store.edit(created.embed_id, 'hello', 'goodbye');
    expect(edited).toEqual({ embed_id: created.embed_id, committed: true });
    expect(e.store.html(e.repos.embeds.get(created.embed_id)!)).toContain('goodbye');
    e.cleanup();
  });

  it('rejects external references at authoring time, not render time', () => {
    const e = env();
    for (const bad of [
      '<script src="https://cdn.example/x.js"></script>',
      '<link href="https://fonts.example/x.css" rel="stylesheet">',
      '<img src="//evil.example/pixel.gif">',
      '<style>@import url(x.css);</style>',
      '<style>body{background:url(https://evil.example/b.png)}</style>',
    ]) {
      const result = e.store.create({ title: 'bad', html: bad });
      expect(result).toMatchObject({ error: 'external_reference' });
    }
    // Prose mentioning a URL is not a reference, and refusing it would be absurd.
    const fine = e.store.create({
      title: 'ok',
      html: '<p>See https://example.com for details</p>',
    });
    expect('error' in fine).toBe(false);
    expect(findExternalReference('<img src="data:image/png;base64,AAA">')).toBeNull();
    e.cleanup();
  });

  it('refuses an edit that would smuggle an external reference in', () => {
    const e = env();
    const created = e.store.create({ title: 'ok', html: PAGE });
    if ('error' in created) throw new Error(created.message);
    expect(
      e.store.edit(created.embed_id, 'hello', '<img src="https://x.example/a.png">'),
    ).toMatchObject({ error: 'external_reference' });
    e.cleanup();
  });

  it('edits exactly once — no match and many matches are both refusals', () => {
    const e = env();
    const created = e.store.create({ title: 'dup', html: '<p>x</p><p>x</p>' });
    if ('error' in created) throw new Error(created.message);
    expect(e.store.edit(created.embed_id, 'nope', 'y')).toMatchObject({ error: 'no_match' });
    expect(e.store.edit(created.embed_id, '<p>x</p>', 'y')).toMatchObject({
      error: 'multiple_matches',
    });
    expect(e.store.edit('01NOPE', 'a', 'b')).toMatchObject({ error: 'not_found' });
    e.cleanup();
  });

  it('reads back with offset and limit', () => {
    const e = env();
    const created = e.store.create({ title: 'lines', html: 'a\nb\nc\nd' });
    if ('error' in created) throw new Error(created.message);
    expect(e.store.read(created.embed_id)).toMatchObject({
      content: 'a\nb\nc\nd',
      truncated: false,
    });
    expect(e.store.read(created.embed_id, { offsetLines: 1, limitLines: 2 })).toMatchObject({
      content: 'b\nc',
      truncated: true,
    });
    e.cleanup();
  });

  it('refuses a colliding title unless the user chose to start fresh', () => {
    // The did-not-ask incident: a second "NO5 energy dashboard" minutes after
    // the first. The gate is deterministic; the prompt rule was skipped.
    const e = env();
    const first = e.store.create({ title: 'NO5 energy dashboard', html: PAGE });
    if ('error' in first) throw new Error(first.message);

    const dup = e.store.create({ title: 'NO5 Energy Dashboard v2', html: PAGE });
    expect(dup).toMatchObject({
      error: 'similar_exists',
      existing: [{ embed_id: first.embed_id, title: 'NO5 energy dashboard' }],
    });

    // A genuinely different subject sails through…
    expect('error' in e.store.create({ title: 'NO5 spot prices', html: PAGE })).toBe(false);
    // …and so does the duplicate once the user said "start fresh".
    expect(
      'error' in
        e.store.create({ title: 'NO5 Energy Dashboard v2', html: PAGE, allowDuplicate: true }),
    ).toBe(false);
    e.cleanup();
  });

  it('finds embeds by title, case-insensitively', () => {
    const e = env();
    e.store.create({ title: 'Budget dashboard', html: PAGE });
    e.store.create({ title: 'Workout log', html: PAGE });
    expect(e.repos.embeds.list({ query: 'BUDGET' }).map((r) => r.title)).toEqual([
      'Budget dashboard',
    ]);
    expect(e.repos.embeds.list({ query: 'nothing' })).toEqual([]);
    e.cleanup();
  });

  it('caps the state pouch and replaces it whole', () => {
    const e = env();
    const created = e.store.create({ title: 'stateful', html: PAGE });
    if ('error' in created) throw new Error(created.message);
    expect(e.store.writeState(created.embed_id, { a: 1 })).toMatchObject({ bytes: 7 });
    expect(e.repos.embeds.state(created.embed_id)).toEqual({ a: 1 });
    // No patch semantics in v1 (§22.4).
    e.store.writeState(created.embed_id, { b: 2 });
    expect(e.repos.embeds.state(created.embed_id)).toEqual({ b: 2 });
    expect(e.store.writeState(created.embed_id, { big: 'x'.repeat(70_000) })).toMatchObject({
      error: 'state_too_large',
    });
    e.cleanup();
  });

  it('the state pouch survives a restart — it is a database row', () => {
    const t = tmpDir('turminder-embeds-restart-');
    const root = path.join(t.dir, 'home');
    const { home } = openDataHome(root);
    const config = new Config(home);
    const first = openDb(home.dbPath);
    const store = new EmbedStore({ home, config, repo: createRepos(first).embeds });
    const created = store.create({ title: 'stateful', html: PAGE });
    if ('error' in created) throw new Error(created.message);
    store.writeState(created.embed_id, { tab: 'week' });
    first.close();

    const second = openDb(home.dbPath);
    expect(createRepos(second).embeds.state(created.embed_id)).toEqual({ tab: 'week' });
    second.close();
    t.cleanup();
  });

  it('promotion moves the file out of tmp/ and commits it', () => {
    const e = env();
    e.home.git.init();
    const created = e.store.create({ title: 'Keeper', html: PAGE });
    if ('error' in created) throw new Error(created.message);
    expect(e.store.promote(created.embed_id)).toEqual({
      embed_id: created.embed_id,
      kind: 'persistent',
    });
    expect(fs.existsSync(e.home.path('embeds', 'tmp', `${created.embed_id}.html`))).toBe(false);
    expect(fs.existsSync(e.home.path('embeds', `${created.embed_id}.html`))).toBe(true);
    expect(e.repos.embeds.get(created.embed_id)!.kind).toBe('persistent');
    e.cleanup();
  });

  it('unkeeping walks that back — file, row and history', () => {
    const e = env();
    e.home.git.init();
    const created = e.store.create({ title: 'Keeper', html: PAGE });
    if ('error' in created) throw new Error(created.message);
    e.store.promote(created.embed_id);

    expect(e.store.demote(created.embed_id)).toEqual({
      embed_id: created.embed_id,
      kind: 'ephemeral',
    });
    // The file goes back to the gitignored tmp/, so the kept copy is *removed*
    // from the data repo rather than left behind as a stale duplicate.
    expect(fs.existsSync(e.home.path('embeds', `${created.embed_id}.html`))).toBe(false);
    expect(fs.existsSync(e.home.path('embeds', 'tmp', `${created.embed_id}.html`))).toBe(true);
    expect(e.repos.embeds.get(created.embed_id)!.kind).toBe('ephemeral');
    // And the content survived the round trip: this is not a delete.
    expect(e.store.html(e.repos.embeds.get(created.embed_id)!)).toBe(PAGE);
    e.cleanup();
  });

  it('unkeeping is idempotent, and refuses an id it does not know', () => {
    const e = env();
    const created = e.store.create({ title: 'Never kept', html: PAGE });
    if ('error' in created) throw new Error(created.message);
    // Already ephemeral: a no-op that reports success rather than an error,
    // because the caller asked for a state and that state is what holds.
    expect(e.store.demote(created.embed_id)).toEqual({
      embed_id: created.embed_id,
      kind: 'ephemeral',
    });
    expect(fs.existsSync(e.home.path('embeds', 'tmp', `${created.embed_id}.html`))).toBe(true);
    expect(e.store.demote('01NOSUCHEMBED')).toMatchObject({ error: 'not_found' });
    e.cleanup();
  });

  it('unkeeping restarts the quiet clock, so it is not reaped immediately', () => {
    const e = env();
    const created = e.store.create({ title: 'Old keeper', html: PAGE });
    if ('error' in created) throw new Error(created.message);
    e.store.promote(created.embed_id);
    // A view kept long ago must not be reaped the instant it stops being kept:
    // `updated_at` moves on demote, so the TTL is measured from the decision.
    const before = e.repos.embeds.get(created.embed_id)!.updated_at;
    e.store.demote(created.embed_id);
    const after = e.repos.embeds.get(created.embed_id)!.updated_at;
    expect(after >= before).toBe(true);
    // Reapable in principle now (it is ephemeral again), but not against a
    // cutoff at the moment of the decision.
    expect(e.repos.embeds.reapable(before).map((r) => r.id)).not.toContain(created.embed_id);
    e.cleanup();
  });
});

/* ── handler binding (§22.5) ──────────────────────────────────────────────── */

function event(type: string, source: string): EventRecord {
  return {
    id: '01EV',
    type,
    source,
    occurred_at: null,
    received_at: '2026-08-21T12:00:00.000Z',
    payload: {},
    summary: null,
    idempotency_key: null,
    serialization_key: null,
    caused_by: null,
    depth: 0,
    status: 'received',
    attempts: 0,
    next_attempt_at: null,
    last_error: null,
  } as unknown as EventRecord;
}

describe('handler binding (§22.5)', () => {
  const bound = {
    name: 'logger',
    description: 'd',
    match: undefined,
    model_class: 'fast' as const,
    tools: [],
    confirm: [],
    watch: [],
    enabled: true,
    embed: '01ABC',
  };

  it('an embed binding implies a match on that embed only', () => {
    expect(matches(bound, event('embed.action', 'embed.01ABC'))).toBe(true);
    expect(matches(bound, event('embed.action', 'embed.01OTHER'))).toBe(false);
    expect(matches(bound, event('email.received', 'imap.x'))).toBe(false);
  });

  it('an explicit match wins over the implied one', () => {
    const explicit = { ...bound, match: { types: ['timer.fired'] } };
    expect(matches(explicit, event('timer.fired', 'scheduler'))).toBe(true);
    expect(matches(explicit, event('embed.action', 'embed.01ABC'))).toBe(false);
  });

  it('deleting an embed removes its bound handlers in one commit', () => {
    const e = env();
    e.home.git.init();
    const created = e.store.create({ title: 'App', html: PAGE, kind: 'persistent' });
    if ('error' in created) throw new Error(created.message);
    write(
      e.home.path('handlers', 'app-logger.md'),
      `---\nname: app-logger\ndescription: logs\nembed: ${created.embed_id}\ntools: [files.append]\n---\n\nAppend a line.\n`,
    );
    // A second handler, bound to nothing, must survive.
    write(
      e.home.path('handlers', 'unrelated.md'),
      `---\nname: unrelated\ndescription: other\n---\n\nDo nothing.\n`,
    );
    e.home.git.commit('handlers', ['handlers']);
    expect(handlerBindings(e.home).map((b) => b.name)).toEqual(['app-logger']);

    const deleted = e.store.delete(created.embed_id);
    expect(deleted).toEqual({
      embed_id: created.embed_id,
      deleted: true,
      handlers_removed: ['app-logger'],
    });
    expect(fs.existsSync(e.home.path('handlers', 'app-logger.md'))).toBe(false);
    expect(fs.existsSync(e.home.path('handlers', 'unrelated.md'))).toBe(true);
    expect(e.repos.embeds.get(created.embed_id)).toBeNull();
    e.cleanup();
  });

  it('finds a binding on a handler that would fail to load', () => {
    const e = env();
    write(
      e.home.path('handlers', 'broken.md'),
      `---\nname: mismatched-name\ndescription: broken\nembed: 01ZZZ\nenabled: false\n---\n\nx\n`,
    );
    // The loader skips this file; a lifecycle cascade must not (§22.5).
    expect(handlerBindings(e.home).map((b) => b.embedId)).toEqual(['01ZZZ']);
    e.cleanup();
  });
});

/* ── the reaper (§22.1) ───────────────────────────────────────────────────── */

describe('the reaper (§22.1)', () => {
  function reaperEnv() {
    const e = env();
    e.home.git.init();
    let now = new Date('2026-08-21T12:00:00.000Z');
    const reaper = new EmbedReaper({ store: e.store, ttlDays: () => 30, now: () => now });
    return {
      ...e,
      reaper,
      advance: (days: number) => {
        now = new Date(now.getTime() + days * 24 * 3600 * 1000);
      },
    };
  }

  it('reaps an ephemeral embed whose conversation is closed and quiet past the TTL', () => {
    const e = reaperEnv();
    const conv = e.repos.conversations.create();
    const created = e.store.create({ title: 'Scratch', html: PAGE, conversationId: conv.id });
    if ('error' in created) throw new Error(created.message);
    write(
      e.home.path('handlers', 'scratch-handler.md'),
      `---\nname: scratch-handler\ndescription: d\nembed: ${created.embed_id}\n---\n\nx\n`,
    );

    // Open conversation: nothing reaps, however old.
    e.advance(60);
    expect(e.reaper.sweep().reaped).toEqual([]);

    e.repos.conversations.close(conv.id);
    const result = e.reaper.sweep();
    expect(result.reaped).toEqual([created.embed_id]);
    expect(result.handlersRemoved).toEqual(['scratch-handler']);
    expect(fs.existsSync(e.home.path('embeds', 'tmp', `${created.embed_id}.html`))).toBe(false);
    expect(fs.existsSync(e.home.path('handlers', 'scratch-handler.md'))).toBe(false);
    expect(e.repos.embeds.get(created.embed_id)).toBeNull();
    e.cleanup();
  });

  it('never reaps a persistent embed, however old and quiet', () => {
    const e = reaperEnv();
    const conv = e.repos.conversations.create();
    const kept = e.store.create({
      title: 'Kept',
      html: PAGE,
      kind: 'persistent',
      conversationId: conv.id,
    });
    if ('error' in kept) throw new Error(kept.message);
    e.repos.conversations.close(conv.id);
    e.advance(400);
    expect(e.reaper.sweep().reaped).toEqual([]);
    expect(e.repos.embeds.get(kept.embed_id)).not.toBeNull();
    e.cleanup();
  });

  /**
   * At the query, not through the sweep: what this rule turns on is a
   * `last_served_at` *later* than the cutoff, and the repo stamps that from the
   * wall clock — so the cutoff is what the test controls, not the clock.
   */
  it('a serve after the cutoff protects an embed the cutoff would otherwise take', async () => {
    const e = env();
    const conv = e.repos.conversations.create();
    const used = e.store.create({ title: 'Used', html: PAGE, conversationId: conv.id });
    const cold = e.store.create({ title: 'Cold', html: PAGE, conversationId: conv.id });
    if ('error' in used || 'error' in cold) throw new Error('setup failed');
    e.repos.conversations.close(conv.id);
    await new Promise((r) => setTimeout(r, 5));
    // A serve from any conversation is what keeps it alive (§22.1).
    e.repos.embeds.markServed(used.embed_id);
    const cutoff = e.repos.embeds.get(used.embed_id)!.last_served_at!;
    expect(e.repos.embeds.reapable(cutoff).map((r) => r.id)).toEqual([cold.embed_id]);
    e.cleanup();
  });

  it('commits the handler removal even when the embed file was never tracked', () => {
    const e = reaperEnv();
    const conv = e.repos.conversations.create();
    const created = e.store.create({
      title: 'Scratch app',
      html: PAGE,
      conversationId: conv.id,
    });
    if ('error' in created) throw new Error(created.message);
    write(
      e.home.path('handlers', 'scratch-app.md'),
      `---\nname: scratch-app\ndescription: d\nembed: ${created.embed_id}\n---\n\nx\n`,
    );
    e.home.git.commit('add the bound handler', ['handlers']);
    e.repos.conversations.close(conv.id);
    e.advance(60);
    expect(e.reaper.sweep().handlersRemoved).toEqual(['scratch-app']);
    // The ephemeral file is gitignored, so naming it would make `git add`
    // refuse the whole commit — including the handler deletion.
    expect(e.home.git.commit('probe: handler deletion uncommitted?', ['handlers'])).toBe(false);
    e.cleanup();
  });

  it('repairs a handler binding whose embed is gone', () => {
    const e = reaperEnv();
    write(
      e.home.path('handlers', 'orphan.md'),
      `---\nname: orphan\ndescription: d\nembed: 01GONE\n---\n\nx\n`,
    );
    expect(e.reaper.sweep().orphanedBindings).toEqual(['orphan']);
    expect(fs.existsSync(e.home.path('handlers', 'orphan.md'))).toBe(false);
    e.cleanup();
  });
});

/* ── scoped tokens and the served page (§22.3) ────────────────────────────── */

describe('serving an embed (§22.3)', () => {
  it('the CSP is the one from the spec, path-scoped to this embed', () => {
    const csp = embedCsp('http://127.0.0.1:7787', '01ABC');
    expect(csp).toBe(
      "sandbox allow-scripts; default-src 'none'; " +
        "script-src 'unsafe-inline' http://127.0.0.1:7787/embed-vendor/ https://code.highcharts.com; " +
        "style-src 'unsafe-inline' http://127.0.0.1:7787/embed-vendor/; img-src data:; " +
        'connect-src http://127.0.0.1:7787/embed-api/01ABC/',
    );
    // The one addition that would be a full compromise.
    expect(csp).not.toContain('allow-same-origin');
    // The Highcharts CDN is a script source ONLY — never a connect target.
    expect(csp).not.toMatch(/connect-src[^;]*highcharts/);
  });

  it('prepends the theme and runtime and closes the token over, rather than exposing it', () => {
    const token = 'a'.repeat(64);
    const served = renderEmbed('<p>page</p>', '01ABC', token);
    expect(served.indexOf('window.turminder')).toBeLessThan(served.indexOf('<p>page</p>'));
    expect(served).toContain('/embed-api/01ABC/');
    // The shipped theme (§23.3): tokens before authored content, and the
    // Highcharts setter trap installed before any CDN script tag can run.
    expect(served.indexOf('--t-bg')).toBeLessThan(served.indexOf('<p>page</p>'));
    expect(served.indexOf("defineProperty(window, 'Highcharts'")).toBeLessThan(
      served.indexOf('<p>page</p>'),
    );
    // Present as a closure variable, never hung off the exposed object.
    expect(served).not.toMatch(/turminder\.(token|t)\s*=/);
    expect(() => renderEmbed('<p>x</p>', '../etc', token)).toThrow();
    expect(() => renderEmbed('<p>x</p>', '01ABC', 'not-a-token')).toThrow();
  });

  it('the theme block enforces dark mode, token-derived charts, and deck behavior (§23.3)', () => {
    const served = renderEmbed('<p>page</p>', '01ABC', 'a'.repeat(64));
    // Light/dark is a token swap: dark overrides exist, and the chart palette
    // itself is tokens, so the swap reaches the charts.
    expect(served).toContain('@media (prefers-color-scheme: dark)');
    expect(served).toContain('--t-chart-1');
    expect(served).toContain('color-scheme: light dark');
    // The Highcharts theme is DERIVED from tokens at runtime; a hardcoded hex
    // in the theme script would break one of the two modes.
    const script = served.slice(served.indexOf('<script>'), served.indexOf('page'));
    expect(script).not.toMatch(/#[0-9a-f]{6}/i);
    // Live charts restyle on scheme change.
    expect(served).toContain("matchMedia('(prefers-color-scheme: dark)')");
    // Deck enforcement: viewport coverage in CSS, house defaults around
    // Reveal.initialize, transitions never 'none', slide-entry chart replay.
    expect(served).toContain('html:has(.reveal), body:has(.reveal)');
    expect(served).toContain("defineProperty(window, 'Reveal'");
    expect(served).toContain("transition: 'slide'");
    expect(served).toContain('replayCharts');
    expect(served).toContain('data-no-replay');
  });

  it('sanctions exactly the Highcharts CDN and vendor paths in authored HTML (§23.3)', () => {
    const ok = (h: string) => expect(findExternalReference(h)).toBeNull();
    const bad = (h: string) => expect(findExternalReference(h)).not.toBeNull();
    ok('<script src="https://code.highcharts.com/highcharts.js"></script>');
    ok('<script src="https://code.highcharts.com/modules/stock.js"></script>');
    ok('<script src="/embed-vendor/reveal.js/dist/reveal.js"></script>');
    bad('<script src="https://cdn.jsdelivr.net/npm/chart.js"></script>');
    bad('<script src="https://code.highcharts.com.evil.example/x.js"></script>');
    bad('<script src="https://unpkg.com/d3"></script>');
    bad('<link href="https://code.highcharts.com/css/highcharts.css">');
    bad('<img src="https://example.com/x.png">');
  });

  it('a rotated generation changes the token', () => {
    expect(scopedToken('s', '01ABC', 1)).not.toBe(scopedToken('s', '01ABC', 2));
    expect(scopedToken('s', '01ABC', 1)).not.toBe(scopedToken('s', '01DEF', 1));
    expect(scopedToken('s', '01ABC', 1)).toBe(scopedToken('s', '01ABC', 1));
  });

  it('generates the signing secret on first use, into secrets.yaml only', () => {
    const e = env();
    const created = e.store.create({ title: 'x', html: PAGE });
    if ('error' in created) throw new Error(created.message);
    const secrets = fs.readFileSync(e.home.path('secrets', 'secrets.yaml'), 'utf8');
    expect(secrets).toContain(EMBED_SECRET_KEY);
    e.config.reload();
    const secret = e.config.secrets[EMBED_SECRET_KEY]!;
    expect(secret).toMatch(/^[0-9a-f]{64}$/);
    // The scoped token is derived from it and must not carry it.
    expect(e.store.url(e.repos.embeds.get(created.embed_id)!)).not.toContain(secret);
    // Sentinel: nowhere in the data dir but `secrets/` (§14.4.2).
    for (const file of walk(e.home.root)) {
      if (file.includes(`${path.sep}secrets${path.sep}`)) continue;
      expect(fs.readFileSync(file).includes(secret)).toBe(false);
    }
    e.cleanup();
  });
});

/* ── rate limits (§22.4) ──────────────────────────────────────────────────── */

describe('per-embed rate limits (§22.4)', () => {
  it('allows the burst, then refuses, then recovers at the sustained rate', () => {
    let now = 0;
    const buckets = new TokenBuckets({ ratePerS: 1, burst: 10, now: () => now });
    for (let i = 0; i < 10; i += 1) expect(buckets.take('a')).toBe(true);
    expect(buckets.take('a')).toBe(false);
    // Another embed has its own bucket.
    expect(buckets.take('b')).toBe(true);
    now += 1000;
    expect(buckets.take('a')).toBe(true);
    expect(buckets.take('a')).toBe(false);
  });
});

/* ── the tools, through the hub ───────────────────────────────────────────── */

describe('the embeds integration', () => {
  it('declares its bulk args, tiers and result cap (§20.6, App. F.13)', () => {
    const e = env();
    const defs = embedsTools(e.deps());
    const byName = new Map(defs.map((d) => [d.name, d]));
    expect([...byName.keys()].sort()).toEqual([
      'embeds.bind',
      'embeds.create',
      'embeds.delete',
      'embeds.edit',
      'embeds.list',
      'embeds.promote',
      'embeds.read',
      'embeds.refresh',
      'embeds.write_state',
    ]);
    expect(byName.get('embeds.create')!.bulkArgs).toEqual(['html']);
    expect(byName.get('embeds.edit')!.bulkArgs).toEqual(['replace']);
    expect(byName.get('embeds.read')!.tier).toBe('ro');
    expect(byName.get('embeds.list')!.tier).toBe('ro');
    expect(byName.get('embeds.create')!.tier).toBe('se');
    e.cleanup();
  });

  it('returns errors as values the model can read', async () => {
    const e = env();
    const defs = embedsTools(e.deps());
    const read = defs.find((d) => d.name === 'embeds.read')!;
    expect(await read.execute({ embed_id: '01MISSING' }, ctx)).toMatchObject({
      error: 'not_found',
    });
    e.cleanup();
  });
});

/** Every regular file under a root, for the sentinel sweep. */
function walk(root: string): string[] {
  return fs.readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) return walk(full);
    return entry.isFile() ? [full] : [];
  });
}
