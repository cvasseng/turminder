import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Config } from '../src/core/config.js';
import { openDataHome, type DataHome } from '../src/core/datadir.js';
import { FormBroker } from '../src/chat/forms.js';
import { configTools } from '../src/tools/integrations/config.js';
import { validateWrite } from '../src/tools/validate-write.js';
import { SkillLoader } from '../src/tools/skills.js';
import { SHIPPED_ASSETS } from '../src/prompts/shipped.js';
import { tmpDir } from './helpers.js';

const ctx = { runId: null, eventId: null };

describe('validateWrite', () => {
  it('rejects a skill with no frontmatter, and says what it needs', () => {
    const result = validateWrite('skills/firmafakta.md', '# Firmafakta\n\nSome prose.\n');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toMatch(/no YAML frontmatter/);
    // The message carries a template, so the caller can fix it in one go.
    expect(result.detail).toMatch(/name: firmafakta/);
    expect(result.detail).toMatch(/description:/);
  });

  it('names the missing keys when frontmatter is incomplete', () => {
    const result = validateWrite('skills/x.md', '---\nname: x\n---\n\nbody\n');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.detail).toMatch(/description/);
  });

  it('rejects a name that does not match the filename', () => {
    const result = validateWrite(
      'skills/firmafakta.md',
      '---\nname: something-else\ndescription: d\n---\n\nbody\n',
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toMatch(/must match the filename/);
  });

  it('rejects frontmatter with nothing after it', () => {
    const result = validateWrite('skills/x.md', '---\nname: x\ndescription: d\n---\n');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toMatch(/body is empty/);
  });

  it('accepts a well-formed skill', () => {
    expect(
      validateWrite('skills/x.md', '---\nname: x\ndescription: when to use x\n---\n\nHow.\n')
        .ok,
    ).toBe(true);
  });

  it('applies the handler schema to handler files', () => {
    const bad = validateWrite(
      'handlers/nudge.md',
      '---\nname: nudge\ndescription: d\ntoolz: [memory.query]\n---\n\nDo it.\n',
    );
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.detail).toMatch(/toolz/);
    expect(
      validateWrite(
        'handlers/nudge.md',
        '---\nname: nudge\ndescription: d\ntools: [memory.query]\n---\n\nDo it.\n',
      ).ok,
    ).toBe(true);
  });

  it('refuses a handler pinning both an endpoint and a class (§10.6)', () => {
    const result = validateWrite(
      'handlers/nudge.md',
      '---\nname: nudge\ndescription: d\nendpoint: main\nmodel_class: best\n---\n\nDo it.\n',
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.detail).toMatch(/not both/);
    // Either alone is fine.
    expect(
      validateWrite(
        'handlers/nudge.md',
        '---\nname: nudge\ndescription: d\nendpoint: main\n---\n\nDo it.\n',
      ).ok,
    ).toBe(true);
    expect(
      validateWrite(
        'handlers/nudge.md',
        '---\nname: nudge\ndescription: d\nmodel_class: best\n---\n\nDo it.\n',
      ).ok,
    ).toBe(true);
    // And neither is fine too — absent means the handler route decides.
    expect(
      validateWrite('handlers/nudge.md', '---\nname: nudge\ndescription: d\n---\n\nDo it.\n')
        .ok,
    ).toBe(true);
  });

  it('catches a turminder.yaml that would stop the service from starting', () => {
    const result = validateWrite('config/turminder.yaml', 'chat:\n  max_tokenz: 100\n');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.detail).toMatch(/max_tokenz/);
    expect(validateWrite('config/turminder.yaml', 'chat:\n  max_tokens: 100\n').ok).toBe(true);
  });

  it('leaves paths it does not know alone', () => {
    expect(validateWrite('config/notes.md', 'anything at all').ok).toBe(true);
  });

  it('validates every asset this build ships', () => {
    for (const asset of SHIPPED_ASSETS) {
      const result = validateWrite(asset.path, asset.content);
      expect(result.ok, `${asset.path}: ${result.ok ? '' : result.message}`).toBe(true);
    }
  });
});

describe('config.write refuses what the loader would reject', () => {
  let t: { dir: string; cleanup: () => void };
  let home: DataHome;

  beforeEach(() => {
    t = tmpDir('turminder-write-');
    home = openDataHome(path.join(t.dir, 'home')).home;
  });
  afterEach(() => t.cleanup());

  // Built per test: `home` only exists once beforeEach has run. No handler
  // routing exercised below (bad-content refusals, resolved before any form
  // would be raised) — a real broker with no live model stack is enough.
  const writeTool = () =>
    configTools(home, {
      forms: new FormBroker(home, new Config(home)),
      router: () => null,
    }).find((tool) => tool.name === 'config.write')!;

  it('does not commit a skill the loader cannot read', async () => {
    const result = (await writeTool().execute(
      {
        path: 'skills/firmafakta.md',
        content: '# Firmafakta\n\nMCP server for Norwegian company data.\n',
        message: 'skills: firmafakta',
      },
      ctx,
    )) as any;

    expect(result.error).toBe('invalid_content');
    expect(result.message).toMatch(/no YAML frontmatter/);
    expect(result.committed).toBeUndefined();
    // Nothing on disk, so nothing for the loader to skip later.
    expect(new SkillLoader(home).all()).toHaveLength(0);
    expect(new SkillLoader(home).errors()).toHaveLength(0);
  });

  it('writes and commits a well-formed one', async () => {
    const result = (await writeTool().execute(
      {
        path: 'skills/firmafakta.md',
        content:
          '---\nname: firmafakta\ndescription: Norwegian company lookups by name or orgnr.\n---\n\nUse organisasjonsnummer_for_selskap first.\n',
        message: 'skills: firmafakta',
      },
      ctx,
    )) as any;

    expect(result.committed).toBe(true);
    const loader = new SkillLoader(home);
    expect(loader.roster().map((s) => s.name)).toEqual(['firmafakta']);
    expect(loader.errors()).toHaveLength(0);
  });

  /**
   * `config.write` edits handlers but no longer creates them (F.6, F.20), so
   * the parse-and-refuse cases below start from one already on disk — the
   * refusal must leave it exactly as it was.
   */
  const EXISTING =
    '---\nname: HANDLER\ndescription: Existing.\ntools: [time.now]\n---\n\nOld.\n';
  const seed = (name: string) => {
    const content = EXISTING.replace('HANDLER', name);
    fs.writeFileSync(path.join(home.handlersDir, `${name}.md`), content);
    return content;
  };

  it('reports a bad handler without leaving it on disk', async () => {
    const before = seed('watcher');
    const result = (await writeTool().execute(
      {
        path: 'handlers/watcher.md',
        content: 'Just some prose, no frontmatter.\n',
        message: 'handlers: watcher',
      },
      ctx,
    )) as any;
    expect(result.error).toBe('invalid_content');
    expect(result.detail).toMatch(/name: invoice-arrival|frontmatter/);
    expect(fs.readFileSync(path.join(home.handlersDir, 'watcher.md'), 'utf8')).toBe(before);
  });

  it('says the same true thing about malformed YAML however often it is asked', async () => {
    // The bug this pins (2026-09-11, F.6): gray-matter caches by input string
    // and writes the entry *before* parsing, so a throw leaves a hollow one
    // behind — and the second reader of the same document is told it has no
    // frontmatter at all. `config.write` parses twice by design (routing,
    // then validation), so the very first write hit it: the model was told to
    // add a `---` block to a file that opened with one, and spent two retries
    // guessing at what was really an unquoted colon in `description`.
    const before = seed('digest');
    const content =
      '---\nname: digest\ndescription: Runs the digest (event digest.due): weather and calendar.\ntools: [time.now]\n---\n\nBuild the digest.\n';
    for (const attempt of [1, 2, 3]) {
      const result = (await writeTool().execute(
        { path: 'handlers/digest.md', content, message: 'handlers: digest' },
        ctx,
      )) as any;
      expect(result.error, `attempt ${attempt}`).toBe('invalid_content');
      expect(result.message, `attempt ${attempt}`).toMatch(/frontmatter is malformed/);
      // The YAML parser's own complaint, naming where to look.
      expect(result.detail, `attempt ${attempt}`).toMatch(/line 3/);
      // And never the lie that replaced it.
      expect(result.message, `attempt ${attempt}`).not.toMatch(/no YAML frontmatter/);
    }
    expect(fs.readFileSync(path.join(home.handlersDir, 'digest.md'), 'utf8')).toBe(before);
  });

  it('quoting the colon is all it takes — the advice was actionable', async () => {
    seed('digest');
    const result = (await writeTool().execute(
      {
        path: 'handlers/digest.md',
        content:
          '---\nname: digest\ndescription: "Runs the digest (event digest.due): weather and calendar."\ntools: [time.now]\n---\n\nBuild the digest.\n',
        message: 'handlers: digest',
      },
      ctx,
    )) as any;
    expect(result.committed).toBe(true);
  });
});

describe('skill load errors are visible', () => {
  it('reports which file failed and why', () => {
    const t = tmpDir('turminder-skill-err-');
    try {
      const { home } = openDataHome(path.join(t.dir, 'home'));
      // A hand-edited file can still be broken; the loader must say so.
      fs.writeFileSync(home.path('skills', 'broken.md'), '# no frontmatter\n');
      const loader = new SkillLoader(home);
      expect(loader.all().map((s) => s.name)).not.toContain('broken');
      const errors = loader.errors();
      expect(errors).toHaveLength(1);
      expect(errors[0]?.file).toBe('skills/broken.md');
      expect(errors[0]?.message).toMatch(/name|description/);
    } finally {
      t.cleanup();
    }
  });
});
