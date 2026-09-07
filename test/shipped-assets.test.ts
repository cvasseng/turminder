import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  assetHash,
  LAYOUT_VERSION,
  openDataHome,
  rewriteModelClass,
  type DataHome,
} from '../src/core/datadir.js';
import {
  driftedShippedAssets,
  installShippedAssets,
  refreshShippedAssets,
  SHIPPED_ASSETS,
} from '../src/prompts/shipped.js';
import { bootService, type ServiceHarness } from './service-harness.js';
import { tmpDir, write } from './helpers.js';

const SKILL = 'skills/authoring-skills.md';
const HANDLER = 'handlers/watch-changed.md';

const shipped = (p: string): string => SHIPPED_ASSETS.find((a) => a.path === p)!.content;

/**
 * The frontmatter shape Christer's five-week-old install carried — verbatim,
 * because the layout-5 repair is written against this exact file and a
 * paraphrase would prove nothing.
 */
const BROKEN_WATCH_CHANGED = shipped(HANDLER).replace(
  'model_class: fast',
  'model:\n  class: fast',
);

describe('the four branches of the install rule (§12.3)', () => {
  let t: { dir: string; cleanup: () => void };
  let home: DataHome;
  beforeEach(() => {
    t = tmpDir('turminder-shipped-');
    home = openDataHome(path.join(t.dir, 'home'), SHIPPED_ASSETS).home;
    // A fresh dir has nothing installed yet; get to the steady state first so
    // each case can then set up the one branch it is about.
    installShippedAssets(home);
  });
  afterEach(() => t.cleanup());

  const read = (p: string): string => fs.readFileSync(home.path(p), 'utf8');
  const record = (p: string, hash: string): void => home.recordShipped({ [p]: hash });
  const forget = (p: string): void => {
    const m = home.readManifest();
    const { [p]: _gone, ...rest } = m.shipped;
    home.writeManifest({ ...m, shipped: rest });
  };

  it('installs an asset that is absent, and records what it wrote', () => {
    fs.rmSync(home.path(SKILL));
    forget(SKILL);

    const report = installShippedAssets(home);
    expect(report.installed).toContain(SKILL);
    expect(read(SKILL)).toBe(shipped(SKILL));
    expect(home.shippedHashes()[SKILL]).toBe(assetHash(shipped(SKILL)));
  });

  it('refreshes an unedited asset when the library moves under it', () => {
    // What "the library moved" looks like from the data dir: the file on disk
    // is what we wrote last time, and what we ship now is different.
    const stale = `${shipped(SKILL)}\n<!-- the version we shipped in August -->\n`;
    fs.writeFileSync(home.path(SKILL), stale, 'utf8');
    record(SKILL, assetHash(stale));

    const report = installShippedAssets(home);
    expect(report.refreshed).toContain(SKILL);
    expect(read(SKILL)).toBe(shipped(SKILL));
    // Re-recorded, or the next library move would look like an edit.
    expect(home.shippedHashes()[SKILL]).toBe(assetHash(shipped(SKILL)));
  });

  it('never overwrites an edited asset — not once, not ever', () => {
    // The one case in this phase that must never be allowed to fail. The user
    // edited their copy; the hash on record is what *we* wrote before that.
    const ours = `${shipped(SKILL)}\n<!-- the version we shipped in August -->\n`;
    const theirs = `${shipped(SKILL)}\n\n## My own house rules\n\nAlways use metric.\n`;
    fs.writeFileSync(home.path(SKILL), theirs, 'utf8');
    record(SKILL, assetHash(ours));

    for (let start = 0; start < 3; start += 1) {
      const report = installShippedAssets(home);
      expect(report.refreshed).not.toContain(SKILL);
      expect(report.installed).not.toContain(SKILL);
      expect(report.drifted).toContainEqual({ path: SKILL, reason: 'edited' });
      expect(read(SKILL)).toBe(theirs);
    }
    // And the record is untouched too: adopting it would make the *next*
    // start think the edit was ours and rewrite it.
    expect(home.shippedHashes()[SKILL]).toBe(assetHash(ours));
    expect(driftedShippedAssets(home)).toContainEqual({ path: SKILL, reason: 'edited' });
  });

  it('adopts an unrecorded asset only when it matches byte for byte', () => {
    forget(SKILL);
    expect(home.shippedHashes()[SKILL]).toBeUndefined();

    const adopted = installShippedAssets(home);
    expect(adopted.adopted).toContain(SKILL);
    expect(home.shippedHashes()[SKILL]).toBe(assetHash(shipped(SKILL)));
  });

  it('reports an unrecorded asset that differs, and leaves it alone', () => {
    const theirs = `${shipped(SKILL)}\n\n## Predates the hash map\n`;
    fs.writeFileSync(home.path(SKILL), theirs, 'utf8');
    forget(SKILL);

    const report = installShippedAssets(home);
    expect(report.drifted).toContainEqual({ path: SKILL, reason: 'unknown' });
    expect(report.refreshed).not.toContain(SKILL);
    expect(read(SKILL)).toBe(theirs);
    // Reported, not resolved: no hash is invented for content we did not write.
    expect(home.shippedHashes()[SKILL]).toBeUndefined();
  });

  it('takes the shipped version only when a human names it', () => {
    const theirs = `${shipped(SKILL)}\n\n## Predates the hash map\n`;
    fs.writeFileSync(home.path(SKILL), theirs, 'utf8');
    forget(SKILL);

    const { refreshed, unknown } = refreshShippedAssets(home, [SKILL, 'skills/not-ours.md']);
    expect(refreshed).toEqual([SKILL]);
    expect(unknown).toEqual(['skills/not-ours.md']);
    expect(read(SKILL)).toBe(shipped(SKILL));
    expect(home.shippedHashes()[SKILL]).toBe(assetHash(shipped(SKILL)));
    expect(driftedShippedAssets(home)).toEqual([]);
  });

  it('commits every rewrite to the data repo', () => {
    const stale = `${shipped(SKILL)}\n<!-- old -->\n`;
    fs.writeFileSync(home.path(SKILL), stale, 'utf8');
    record(SKILL, assetHash(stale));
    // Land the stale state in history first, or the refresh restores bytes git
    // already had and there is honestly nothing to commit.
    home.git.commit('the version we shipped in August', ['skills', 'MANIFEST']);
    const before = home.git.head();

    installShippedAssets(home);
    expect(home.git.head()).not.toBe(before);
    const subject = execFileSync('git', ['log', '-1', '--format=%s'], {
      cwd: home.root,
      encoding: 'utf8',
    }).trim();
    expect(subject).toBe('shipped assets: refreshed 1 file');
  });
});

describe('layout 5 repairs before it adopts (§12.3, G.10)', () => {
  let t: { dir: string; cleanup: () => void };
  beforeEach(() => {
    t = tmpDir('turminder-layout5-');
  });
  afterEach(() => t.cleanup());

  /** A data dir as it stood at layout 4: assets installed, no `shipped:` map. */
  const atLayout4 = (root: string): DataHome => {
    const { home } = openDataHome(root, SHIPPED_ASSETS);
    installShippedAssets(home);
    const m = home.readManifest();
    fs.writeFileSync(
      home.manifestPath,
      `layout_version: 4\ncreated_at: ${m.created_at}\n`,
      'utf8',
    );
    return home;
  };

  it('repairs the dead frontmatter, then records the repaired bytes', () => {
    const root = path.join(t.dir, 'home');
    const staged = atLayout4(root);
    fs.writeFileSync(staged.path(HANDLER), BROKEN_WATCH_CHANGED, 'utf8');
    // A handler the user wrote, to prove the repair does not reflow files it
    // has no business touching.
    const mine = `---\nname: mine\ndescription: 'Mine: quoted, spaced oddly.'\nmodel_class:   fast\n---\n\nDo my thing.\n`;
    write(staged.path('handlers', 'mine.md'), mine);

    const { home } = openDataHome(root, SHIPPED_ASSETS);
    expect(home.readManifest().layout_version).toBe(LAYOUT_VERSION);
    // Repaired to the shipped spelling...
    expect(fs.readFileSync(home.path(HANDLER), 'utf8')).toBe(shipped(HANDLER));
    // ...and adopted *after* the repair, so the next library change reaches it.
    expect(home.shippedHashes()[HANDLER]).toBe(assetHash(shipped(HANDLER)));
    // Byte-identical: not a general YAML re-emit.
    expect(fs.readFileSync(home.path('handlers', 'mine.md'), 'utf8')).toBe(mine);
  });

  it('makes the repaired handler load again', async () => {
    const root = path.join(t.dir, 'home');
    const staged = atLayout4(root);
    fs.writeFileSync(staged.path(HANDLER), BROKEN_WATCH_CHANGED, 'utf8');

    const { HandlerLoader } = await import('../src/exec/handlers.js');
    const broken = new HandlerLoader(staged);
    expect(broken.errors().map((e) => e.file)).toContain(HANDLER);

    const { home } = openDataHome(root, SHIPPED_ASSETS);
    const repaired = new HandlerLoader(home);
    expect(repaired.errors()).toEqual([]);
    expect(repaired.get('watch-changed')?.frontmatter.model_class).toBe('fast');
  });

  it('leaves a shape it does not understand alone rather than guessing', () => {
    const exotic = shipped(HANDLER).replace(
      'model_class: fast',
      'model:\n  class: fast\n  endpoint: laptop',
    );
    expect(rewriteModelClass(exotic)).toBe(exotic);
    // And a `model:` line in the body is prose, not frontmatter.
    expect(rewriteModelClass('no frontmatter\nmodel:\n  class: fast\n')).toBe(
      'no frontmatter\nmodel:\n  class: fast\n',
    );
  });
});

describe('a broken asset is an event, not a log line (§12.3, App. B)', () => {
  let h: ServiceHarness;
  afterEach(async () => {
    await h?.cleanup();
  });

  const invalid = () =>
    h.service.repos.events
      .recent({ limit: 50 })
      .filter((e) => e.type === 'system.asset_invalid');

  it('emits one system.asset_invalid, and exactly one across reloads', async () => {
    h = await bootService({ onboarded: true, runScheduler: false });
    write(path.join(h.dataDir, 'handlers', 'watch-changed.md'), BROKEN_WATCH_CHANGED);

    h.service.handlers.reload();
    h.service.handlers.all();
    expect(invalid()).toHaveLength(1);
    expect(invalid()[0]!.payload).toEqual({
      category: 'handlers',
      file: HANDLER,
      message: expect.stringContaining('Unrecognized key: "model"'),
      // It is in the `shipped:` map — this is our file, broken.
      shipped: true,
    });

    // A reload storm is one event, not one per reload (App. B idempotency key).
    for (let i = 0; i < 3; i += 1) {
      h.service.handlers.reload();
      h.service.handlers.all();
    }
    expect(invalid()).toHaveLength(1);
  });

  it('reports a skill the same way, and a new breakage as a new event', async () => {
    h = await bootService({ onboarded: true, runScheduler: false });
    write(
      path.join(h.dataDir, 'skills', 'wonky.md'),
      `---\nname: wonky\n---\n\nNo description.\n`,
    );
    h.service.skills.reload();
    h.service.skills.all();
    expect(invalid()).toHaveLength(1);
    expect(invalid()[0]!.payload).toMatchObject({
      category: 'skills',
      file: 'skills/wonky.md',
      // Never installed by us, so not ours.
      shipped: false,
    });

    write(
      path.join(h.dataDir, 'skills', 'wonky.md'),
      `---\nname: wonky\ndescription: 1\n---\n\nx\n`,
    );
    h.service.skills.reload();
    h.service.skills.all();
    expect(invalid()).toHaveLength(2);
  });
});
