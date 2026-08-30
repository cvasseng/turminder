import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Config, DEFAULT_SETTINGS } from '../src/core/config.js';
import { isTranscriptPlaceholder } from '../src/core/markers.js';
import { openDataHome, type DataHome } from '../src/core/datadir.js';
import { FormBroker } from '../src/chat/forms.js';
import { openDb } from '../src/db/index.js';
import { createRepos } from '../src/db/repos/index.js';
import { EventIntake } from '../src/ingress/intake.js';
import { elidedMarker, storedMarker } from '../src/model/elide.js';
import { ProjectScope } from '../src/projects/scope.js';
import { GrantedDispatcher } from '../src/tools/dispatcher.js';
import { ToolHub } from '../src/tools/hub.js';
import { SkillLoader } from '../src/tools/skills.js';
import { tmpDir } from './helpers.js';

/**
 * §20.6/§20.8: a bulk-content argument that *is* a transcript placeholder is
 * refused at the hub, and a write that did not happen is never stubbed as if
 * it had. The incident: run `01M18071PR7SRR04VV7B8TZQZP`, 2026-08-30, where two
 * `memory.update` calls stored the `[[stored: …]]` marker itself.
 */
describe('placeholder guard (§20.6)', () => {
  it('recognises the two transcript placeholders and nothing broader', () => {
    expect(isTranscriptPlaceholder(storedMarker(434))).toBe(true);
    expect(isTranscriptPlaceholder(`  ${storedMarker(1)}`)).toBe(true);
    expect(isTranscriptPlaceholder(elidedMarker('web.fetch', { a: 1 }))).toBe(true);
    // History annotations are not stand-ins for the model's own content.
    expect(isTranscriptPlaceholder('[[used tools: files.read]]')).toBe(false);
    expect(isTranscriptPlaceholder('[[image: x.png — no vision-capable endpoint]]')).toBe(
      false,
    );
    // Documentation that *mentions* a marker is content (§20.8's limitation).
    expect(isTranscriptPlaceholder('Turminder stubs args with a [[stored: …]] marker.')).toBe(
      false,
    );
    expect(isTranscriptPlaceholder(42)).toBe(false);
    expect(isTranscriptPlaceholder(undefined)).toBe(false);
  });

  interface Harness {
    home: DataHome;
    hub: ToolHub;
    cleanup(): Promise<void>;
  }
  let h: Harness;
  afterEach(async () => {
    await h?.cleanup();
  });

  async function harness(): Promise<Harness> {
    const t = tmpDir('turminder-placeholder-');
    const { home } = openDataHome(path.join(t.dir, 'home'));
    const db = openDb(home.dbPath);
    const repos = createRepos(db);
    const config = new Config(home);
    const hub = await ToolHub.create({
      home,
      config,
      intake: new EventIntake(repos, DEFAULT_SETTINGS),
      repos,
      skills: new SkillLoader(home),
      projectScope: new ProjectScope(repos.conversations),
      forms: new FormBroker(home, config),
      router: () => null,
    });
    return {
      home,
      hub,
      async cleanup() {
        await hub.close();
        db.close();
        t.cleanup();
      },
    };
  }

  const ctx = { runId: null, eventId: null };

  it('refuses a bulk field that is a placeholder, writes nothing, and stubs nothing', async () => {
    h = await harness();
    const dispatcher = new GrantedDispatcher(h.hub.handles(), { tools: ['config.write'] }, ctx);
    const r = await dispatcher.dispatch({
      toolCallId: '1',
      name: 'config.write',
      args: { path: 'skills/guarded.md', content: storedMarker(120), message: 'add skill' },
    });
    expect(r.ok).toBe(false);
    expect(r.output).toMatchObject({ error: 'placeholder_as_content', field: 'content' });
    expect((r.output as { message: string }).message).toContain('Nothing was written now');
    // The tool never ran: no file, and no `bulkArgs` for the loop to stub with
    // a marker claiming the content was stored.
    expect(fs.existsSync(h.home.path('skills/guarded.md'))).toBe(false);
    expect(r.bulkArgs).toBeUndefined();
  });

  it('lets real content through and reports its bulk fields', async () => {
    h = await harness();
    const dispatcher = new GrantedDispatcher(h.hub.handles(), { tools: ['config.write'] }, ctx);
    const r = await dispatcher.dispatch({
      toolCallId: '2',
      name: 'config.write',
      args: {
        path: 'skills/guarded.md',
        // Mentioning a marker inside content is fine — only a value that *is*
        // one is refused. (Documentation about this system contains its
        // markers, §20.8.)
        content:
          '---\nname: guarded\ndescription: About transcript markers.\n---\n\n' +
          'Turminder shows a bulk argument as a [[stored: …]] marker after the call.\n',
        message: 'add skill',
      },
    });
    expect(r.output).toMatchObject({ path: 'skills/guarded.md' });
    expect(r.ok).toBe(true);
    expect(r.bulkArgs).toEqual(['content']);
    expect(fs.existsSync(h.home.path('skills/guarded.md'))).toBe(true);
  });

  it('does not stub the content of a write the tool itself refused', async () => {
    h = await harness();
    const dispatcher = new GrantedDispatcher(h.hub.handles(), { tools: ['config.write'] }, ctx);
    const r = await dispatcher.dispatch({
      toolCallId: '3',
      name: 'config.write',
      args: { path: 'skills/broken.md', content: 'no frontmatter at all', message: 'add' },
    });
    // An expected failure is a return value (`{error}`), so `ok` stays true —
    // but nothing was stored, so nothing may be stubbed as stored.
    expect(r.output).toMatchObject({ error: 'invalid_content' });
    expect(r.bulkArgs).toBeUndefined();
    expect(fs.existsSync(h.home.path('skills/broken.md'))).toBe(false);
  });
});
