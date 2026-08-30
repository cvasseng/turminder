import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import YAML from 'yaml';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  Config,
  DEFAULT_SETTINGS,
  resolveBindOverride,
  resolveSettings,
} from '../src/core/config.js';
import { ConfigError } from '../src/core/errors.js';
import { openDataHome, type DataHome } from '../src/core/datadir.js';
import { tmpDir, write } from './helpers.js';

describe('config loader', () => {
  let t: { dir: string; cleanup: () => void };
  let home: DataHome;
  let config: Config;

  beforeEach(() => {
    t = tmpDir();
    home = openDataHome(path.join(t.dir, 'home')).home;
    config = new Config(home);
  });
  afterEach(() => t.cleanup());

  it('returns Appendix A defaults for the shipped turminder.yaml', () => {
    const s = config.settings;
    expect(s.maxDepth).toBe(5);
    expect(s.retryAttempts).toBe(3);
    expect(s.budgetMaxTokens).toBe(DEFAULT_SETTINGS.budgetMaxTokens);
    expect(s.bind).toEqual({ host: '127.0.0.1', port: 7787 });
    expect(s.searxngUrl).toBe('http://127.0.0.1:8080');
  });

  it('applies overrides from turminder.yaml', () => {
    write(
      home.path('config', 'turminder.yaml'),
      `bind: 0.0.0.0:9000
data_defaults:
  max_depth: 2
  budget_timeout_s: 30
search:
  searxng_url: http://searx.local
retention_days: 7
`,
    );
    config.reload();
    const s = config.settings;
    expect(s.bind).toEqual({ host: '0.0.0.0', port: 9000 });
    expect(s.maxDepth).toBe(2);
    expect(s.budgetTimeoutS).toBe(30);
    expect(s.searxngUrl).toBe('http://searx.local');
    expect(s.retentionDays).toBe(7);
    // untouched keys keep their defaults
    expect(s.retryAttempts).toBe(3);
  });

  it('names the file and the key on a validation error', () => {
    write(home.path('config', 'turminder.yaml'), 'data_defaults:\n  max_dept: 4\n');
    config.reload();
    try {
      void config.settings;
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(ConfigError);
      expect((e as ConfigError).message).toContain('config/turminder.yaml');
      expect((e as ConfigError).detail).toContain('max_dept');
    }
  });

  it('reports malformed YAML as a config error', () => {
    write(home.path('config', 'turminder.yaml'), 'bind: [unclosed\n');
    config.reload();
    expect(() => config.settings).toThrowError(ConfigError);
  });

  it('resolves ${secret:KEY} references in yaml', () => {
    write(home.path('secrets', 'secrets.yaml'), 'MAIN_KEY: s3cret\n');
    write(
      home.path('config', 'models.yaml'),
      `endpoints:
  - name: main
    url: http://localhost:8080/v1
    api_key: \${secret:MAIN_KEY}
    classes: [fast, best]
    caps: [json, tools]
`,
    );
    config.reload();
    const models = config.models();
    expect(models?.endpoints[0]?.api_key).toBe('s3cret');
  });

  it('errors clearly on an unknown secret reference', () => {
    write(
      home.path('config', 'models.yaml'),
      `endpoints:
  - name: main
    url: http://localhost:8080/v1
    api_key: \${secret:NOPE}
    classes: [fast]
`,
    );
    config.reload();
    expect(() => config.models()).toThrowError(/unknown secret/);
  });

  it('treats an absent models.yaml as unconfigured (setup trigger)', () => {
    expect(config.models()).toBeNull();
    expect(config.modelsOrNull().models).toBeNull();
  });

  it('treats an invalid models.yaml as unconfigured, with the reason', () => {
    write(home.path('config', 'models.yaml'), 'endpoints: []\n');
    config.reload();
    const r = config.modelsOrNull();
    expect(r.models).toBeNull();
    expect(r.error).toContain('config/models.yaml');
  });

  it('loads identity and personality markdown with frontmatter and body', () => {
    write(
      home.path('config', 'identity.md'),
      `---
instance_name: Sleeper Service
user_name: Alex
timezone: Europe/Oslo
locale: en
onboarded_at: 2026-08-20T12:00:00.000Z
---

Notes about the instance.
`,
    );
    write(
      home.path('config', 'personality.md'),
      `---
formality: relaxed
verbosity: terse
humor: dry
---

Be brief. Do not gush.
`,
    );
    const id = config.identity();
    expect(id?.frontmatter.instance_name).toBe('Sleeper Service');
    expect(id?.frontmatter.timezone).toBe('Europe/Oslo');
    expect(id?.body).toBe('Notes about the instance.');
    const p = config.personality();
    expect(p?.frontmatter.verbosity).toBe('terse');
    expect(p?.body).toBe('Be brief. Do not gush.');
  });

  it('reads the scaffolded ui device row as a hash, never a value (§24)', () => {
    const devices = config.channels().devices;
    expect(devices.map((d) => d.device)).toContain('ui');
    expect(devices[0]?.token).toBeUndefined();
    expect(devices[0]?.token_sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('defaults mcp servers to an empty list', () => {
    expect(config.mcp().servers).toEqual([]);
  });
});

/**
 * `healModelsYaml` (§8.3, §10.6 v2): a legacy `embedding:` block folds into a
 * `kind: embedding` endpoint plus an explicit `routes.embedding`, in the same
 * pass — and same commit — as the pre-existing plaintext-key heal.
 */
describe('healModelsYaml — folding a legacy embedding: block', () => {
  let t: { dir: string; cleanup: () => void };
  let home: DataHome;
  let config: Config;

  beforeEach(() => {
    t = tmpDir();
    home = openDataHome(path.join(t.dir, 'home')).home;
    config = new Config(home);
  });
  afterEach(() => t.cleanup());

  const modelsText = () => fs.readFileSync(home.path('config', 'models.yaml'), 'utf8');
  const commitCount = () =>
    spawnSync('git', ['log', '--oneline'], { cwd: home.root, encoding: 'utf8' })
      .stdout.trim()
      .split('\n').length;

  it('folds the block, writes an explicit route, keeps the secret reference, and commits once', () => {
    write(
      home.path('config', 'models.yaml'),
      `endpoints:
  - name: main
    url: http://localhost:8080/v1
    classes: [fast, best]
embedding:
  url: http://localhost:8080
  api_key: \${secret:X}
`,
    );
    const before = commitCount();

    const result = config.healModelsYaml();
    expect(result.embeddingFolded).toBe(true);

    const parsed = YAML.parse(modelsText()) as Record<string, unknown>;
    expect(parsed.embedding).toBeUndefined();
    const endpoints = parsed.endpoints as Record<string, unknown>[];
    const folded = endpoints.find((e) => e.name === 'embedding');
    expect(folded).toMatchObject({
      kind: 'embedding',
      url: 'http://localhost:8080',
      api_key: '${secret:X}',
    });
    expect(parsed.routes).toEqual({ embedding: { endpoint: 'embedding' } });
    // The literal reference survived untouched — it names a secret, is not
    // one, and healModelsYaml never resolves `${secret:}` (that would write
    // the value to disk).
    expect(modelsText()).toContain('${secret:X}');
    expect(commitCount()).toBe(before + 1);

    // Idempotent: a second pass changes nothing and commits nothing.
    const stableText = modelsText();
    const second = config.healModelsYaml();
    expect(second.embeddingFolded).toBe(false);
    expect(second.apiKeys).toEqual([]);
    expect(modelsText()).toBe(stableText);
    expect(commitCount()).toBe(before + 1);
  });

  it('suffixes the folded name on a collision with an existing endpoint', () => {
    write(
      home.path('config', 'models.yaml'),
      `endpoints:
  - name: embedding
    url: http://localhost:9999/v1
    classes: [fast]
embedding:
  url: http://localhost:8080
`,
    );
    config.healModelsYaml();
    const parsed = YAML.parse(modelsText()) as Record<string, unknown>;
    const endpoints = parsed.endpoints as Record<string, unknown>[];
    expect(endpoints.map((e) => e.name)).toEqual(['embedding', 'embedding-2']);
    expect((endpoints[1] as Record<string, unknown>).kind).toBe('embedding');
    expect(parsed.routes).toEqual({ embedding: { endpoint: 'embedding-2' } });
  });

  it('does nothing to a file with no embedding: block and no plaintext key', () => {
    write(
      home.path('config', 'models.yaml'),
      `endpoints:
  - name: main
    url: http://localhost:8080/v1
    classes: [fast, best]
`,
    );
    const before = commitCount();
    const result = config.healModelsYaml();
    expect(result).toEqual({ apiKeys: [], embeddingFolded: false });
    expect(commitCount()).toBe(before);
  });
});

/**
 * The bind override (§28.1). The desktop shell picks a free localhost port for
 * its sidecar at spawn time; it cannot write that into `config/turminder.yaml`
 * because config files have owners (App. G), so it hands it to the process the
 * way `--data-dir` is handed in.
 */
describe('bind override', () => {
  let t: { dir: string; cleanup: () => void };
  let home: DataHome;
  const saved = process.env.TURMINDER_BIND;

  beforeEach(() => {
    t = tmpDir();
    home = openDataHome(path.join(t.dir, 'home')).home;
    delete process.env.TURMINDER_BIND;
  });
  afterEach(() => {
    t.cleanup();
    if (saved === undefined) delete process.env.TURMINDER_BIND;
    else process.env.TURMINDER_BIND = saved;
  });

  it('resolves flag before env before nothing', () => {
    expect(resolveBindOverride()).toBeNull();
    process.env.TURMINDER_BIND = '127.0.0.1:5000';
    expect(resolveBindOverride()).toEqual({ value: '127.0.0.1:5000', label: 'TURMINDER_BIND' });
    // The flag wins, and says so — a bad value has to name the thing to fix.
    expect(resolveBindOverride('127.0.0.1:6000')).toEqual({
      value: '127.0.0.1:6000',
      label: '--bind',
    });
  });

  it('outranks turminder.yaml', () => {
    write(home.path('config', 'turminder.yaml'), 'bind: 0.0.0.0:9000\n');
    expect(new Config(home).settings.bind).toEqual({ host: '0.0.0.0', port: 9000 });
    expect(new Config(home, resolveBindOverride('127.0.0.1:41999')).settings.bind).toEqual({
      host: '127.0.0.1',
      port: 41999,
    });
  });

  it('applies with no config file at all — every bundled first run', () => {
    // raw = null is the real first-run shape: the sidecar is spawned into a
    // data dir that does not exist yet, and the port still has to take.
    expect(resolveSettings(null, { value: '127.0.0.1:1234', label: '--bind' }).bind).toEqual({
      host: '127.0.0.1',
      port: 1234,
    });
    expect(resolveSettings(null).bind).toEqual(DEFAULT_SETTINGS.bind);
  });

  it('blames the right source for a malformed value', () => {
    expect(() => resolveSettings(null, { value: 'nonsense', label: '--bind' })).toThrow(
      ConfigError,
    );
    try {
      resolveSettings(null, { value: 'host:99999', label: 'TURMINDER_BIND' });
      expect.unreachable('a port out of range must not resolve');
    } catch (e) {
      expect(String((e as ConfigError).message)).toContain('TURMINDER_BIND');
    }
  });
});
