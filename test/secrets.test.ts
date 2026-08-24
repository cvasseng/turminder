import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import YAML from 'yaml';
import { bootstrap, type App } from '../src/app.js';
import { Config } from '../src/core/config.js';
import { openDataHome, type DataHome } from '../src/core/datadir.js';
import { SecretStore, type KernelKeys, type Keyring } from '../src/core/secret-store/index.js';
import { SystoolRegistry } from '../src/core/systools.js';
import { tmpDir, write } from './helpers.js';

/**
 * The secret store (§27). Every test here asks one of two questions: does the
 * value survive, and is it anywhere it should not be. Backends are swapped
 * underneath the same interface on purpose — consumers cannot tell them apart,
 * and neither can these tests except where the point is the difference.
 */

interface Env {
  home: DataHome;
  dir: string;
  cleanup(): void;
}

function env(config = ''): Env {
  const t = tmpDir('turminder-secrets-');
  const { home } = openDataHome(path.join(t.dir, 'home'));
  if (config) write(home.path('config', 'turminder.yaml'), config);
  return { home, dir: home.secretsDir, cleanup: () => t.cleanup() };
}

/** An in-memory stand-in for the OS vault — no keyring on a CI box. */
function fakeVault(): Keyring & { entries: Map<string, string> } {
  const entries = new Map<string, string>();
  return {
    entries,
    get: (service, account) => entries.get(`${service}:${account}`) ?? null,
    set: (service, account, value) => void entries.set(`${service}:${account}`, value),
    delete: (service, account) => void entries.delete(`${service}:${account}`),
  };
}

/**
 * `/proc/keys` fixtures. The real format, from a live box: the flags column is
 * what tells a key the kernel still holds from one it has already thrown away.
 */
const KERNEL_KEYS = {
  quiet: () =>
    ({
      keys:
        '10d0a5a3 I--Q---     6 perm 1f3f0000     0 65534 keyring   _uid.0: empty\n' +
        '34193d32 I--Q---   299 perm 3f030000     0     0 keyring   _ses: 3\n',
    }) as const,
  /** The sentinel, alive in the kernel keyring — no Secret Service answered. */
  keyutils: () =>
    ({
      keys:
        '34193d32 I--Q---   299 perm 3f030000     0     0 keyring   _ses: 3\n' +
        '03146ff6 I--Q---     4 perm 3f010000  1000   100 user      keyring:__probe__@turminder: 18\n',
    }) as const,
  /** The same line after the kernel invalidated it: a probe that already ran. */
  stale: () =>
    ({
      keys: '03146ff6 I--Q--i     4 perm 3f010000  1000   100 user      keyring:__probe__@turminder: 18\n',
    }) as const,
  absent: () => ({ absent: true }) as const,
  unreadable: () => ({ unreadable: 'EACCES: permission denied' }) as const,
} satisfies Record<string, KernelKeys>;

/** A stand-in for gpg: "encryption" is a reversible wrapper, and that is fine —
 *  what is under test is the store's use of the binary, not GnuPG. */
function fakeGpg(): (args: readonly string[], input?: string) => string {
  return (args, input) => {
    if (args.includes('--decrypt')) {
      const file = args[args.length - 1]!;
      return fs.readFileSync(file, 'utf8').replace(/^-----FAKE-----\n/, '');
    }
    if (!args.includes('--recipient')) throw new Error('no recipient');
    return `-----FAKE-----\n${input ?? ''}`;
  };
}

function storeFor(
  e: Env,
  opts: {
    backend?: 'auto' | 'plain' | 'gpg' | 'os';
    gpgKey?: string | null;
    keyring?: Keyring;
    kernelKeys?: KernelKeys;
  } = {},
): SecretStore {
  return new SecretStore({
    dir: e.dir,
    systools: new SystoolRegistry({ run: () => 'gpg (GnuPG) 2.4.0' }),
    settings: () => ({ backend: opts.backend ?? 'plain', gpgKey: opts.gpgKey ?? null }),
    ...(opts.keyring ? { keyring: opts.keyring } : {}),
    // Default to a kernel with no keyutils at all: a fake vault leaves no
    // trace in the real one, and no test may depend on the host's keyring.
    kernelKeys: opts.kernelKeys ?? KERNEL_KEYS.absent,
    gpgExec: fakeGpg(),
  });
}

describe('the store interface, identical across backends (§27.1)', () => {
  let e: Env;
  afterEach(() => e.cleanup());

  const backends = ['plain', 'gpg', 'os'] as const;

  for (const backend of backends) {
    it(`round-trips, lists names only, and deletes — ${backend}`, () => {
      e = env();
      const store = storeFor(e, { backend, gpgKey: 'test-key', keyring: fakeVault() });
      expect(store.probe().ok).toBe(true);

      expect(store.set('ASANA_PAT', 'sentinel-pat')).toEqual({ ok: true });
      store.merge({ OTHER: 'two' });
      expect(store.get('ASANA_PAT')).toBe('sentinel-pat');
      // Names only, everywhere, always.
      expect(store.list()).toEqual(['ASANA_PAT', 'OTHER']);
      expect(JSON.stringify(store.list())).not.toContain('sentinel');

      store.delete('OTHER');
      expect(store.list()).toEqual(['ASANA_PAT']);

      // A fresh store over the same storage reads the same thing back.
      const reopened = storeFor(e, { backend, gpgKey: 'test-key', keyring: fakeVault() });
      if (backend !== 'os') expect(reopened.get('ASANA_PAT')).toBe('sentinel-pat');
    });
  }

  it('refuses a value past the size cap, as a value not a throw', () => {
    e = env();
    const store = storeFor(e);
    const huge = 'x'.repeat(65 * 1024);
    expect(store.set('BIG', huge)).toMatchObject({ error: 'too_large' });
    expect(store.list()).toEqual([]);
  });

  it('keeps a JSON blob as an ordinary value (§27)', () => {
    e = env();
    const store = storeFor(e);
    const blob = JSON.stringify({ refresh_token: 'r', scope: 'calendar' });
    store.set('GOOGLE_OAUTH_TOKEN', blob);
    expect(JSON.parse(store.get('GOOGLE_OAUTH_TOKEN')!)).toMatchObject({ refresh_token: 'r' });
  });
});

describe('backend selection and startup (§27.1)', () => {
  let e: Env;
  afterEach(() => e.cleanup());

  it('refuses to start when a *pinned* backend is broken — never a downgrade', () => {
    e = env();
    const broken: Keyring = {
      get: () => {
        throw new Error('vault is locked');
      },
      set: () => {
        throw new Error('vault is locked');
      },
      delete: () => {},
    };
    const store = storeFor(e, { backend: 'os', keyring: broken });
    expect(store.probe().ok).toBe(false);
    expect(() => store.assertUsable()).toThrow(/os secret backend is not working/);
    // And it says what to do about it, rather than quietly writing plaintext.
    try {
      store.assertUsable();
    } catch (err) {
      expect((err as { detail?: string }).detail).toMatch(/keyring|migrate/);
    }
    // And nothing was written on the way past: no quiet plaintext fallback.
    expect(fs.readdirSync(e.dir)).toEqual([]);
  });

  it('treats the pre-onboarding default as unpinned, and warns rather than failing', () => {
    e = env();
    const store = storeFor(e, { backend: 'auto' });
    expect(store.pinned).toBe(false);
    expect(store.name).toBe('plain');
    expect(() => store.assertUsable()).not.toThrow();
  });

  it('needs a recipient key before gpg can be used', () => {
    e = env();
    const store = storeFor(e, { backend: 'gpg', gpgKey: null });
    const health = store.probe();
    expect(health.ok).toBe(false);
    expect(health.fix).toMatch(/secrets\.gpg_key/);
  });
});

describe('identifying the vault rather than believing it (§27.1)', () => {
  let e: Env;
  afterEach(() => e.cleanup());

  /** A vault that answers every call — exactly what keyutils does. */
  const answering = () => fakeVault();

  it('disqualifies `os` when the sentinel lands in the kernel keyring', () => {
    e = env();
    const store = storeFor(e, {
      backend: 'os',
      keyring: answering(),
      kernelKeys: KERNEL_KEYS.keyutils,
    });
    const health = store.probe();
    // The round-trip *worked*; that was never the question.
    expect(health.ok).toBe(false);
    expect(health.reason).toMatch(/no Secret Service/);
    expect(health.fix).toMatch(/gnome-keyring|kwallet/);
    // `secrets status` says so in the same words, and offers the alternatives.
    const available = store.available();
    const os = available.find((a) => a.backend === 'os');
    expect(os?.ok).toBe(false);
    expect(os?.reason).toMatch(/no Secret Service/);
    expect(available.find((a) => a.backend === 'plain')?.ok).toBe(true);
    // And a machine pinned to `os` refuses to start, rather than quietly
    // keeping secrets somewhere a reboot wipes.
    expect(() => store.assertUsable()).toThrow(/os secret backend is not working/);
  });

  it('accepts a vault that leaves nothing in /proc/keys', () => {
    e = env();
    const store = storeFor(e, {
      backend: 'os',
      keyring: answering(),
      kernelKeys: KERNEL_KEYS.quiet,
    });
    expect(store.probe()).toEqual({ ok: true });
    expect(() => store.assertUsable()).not.toThrow();
  });

  it('is not fooled by an invalidated sentinel from an earlier probe', () => {
    e = env();
    const store = storeFor(e, {
      backend: 'os',
      keyring: answering(),
      kernelKeys: KERNEL_KEYS.stale,
    });
    // The kernel has already thrown that key away; convicting on it would
    // disqualify a working Secret Service for a probe that ran minutes ago.
    expect(store.probe().ok).toBe(true);
  });

  it('refuses when it cannot tell where the value went', () => {
    e = env();
    const store = storeFor(e, {
      backend: 'os',
      keyring: answering(),
      kernelKeys: KERNEL_KEYS.unreadable,
    });
    const health = store.probe();
    expect(health.ok).toBe(false);
    expect(health.reason).toMatch(/could not verify which vault answered/);
  });

  it('will not migrate into a kernel keyring', () => {
    e = env();
    const plain = storeFor(e, { backend: 'plain' });
    plain.merge({ ASANA_PAT: 'sentinel-pat' });
    const store = new SecretStore({
      dir: e.dir,
      systools: new SystoolRegistry({ run: () => 'gpg (GnuPG) 2.4.0' }),
      settings: () => ({ backend: 'plain', gpgKey: null }),
      keyring: answering(),
      kernelKeys: KERNEL_KEYS.keyutils,
    });
    expect(store.migrate('os')).toMatchObject({ error: 'target_unavailable' });
    // The source is untouched: a refused move loses nothing.
    expect(fs.readFileSync(path.join(e.dir, 'secrets.yaml'), 'utf8')).toContain('sentinel-pat');
  });
});

describe('migration (§27.1)', () => {
  let e: Env;
  afterEach(() => e.cleanup());

  it('moves every key, verifies the read-back, and leaves no source residue', () => {
    e = env();
    const vault = fakeVault();
    const plain = storeFor(e, { backend: 'plain' });
    plain.merge({ A: 'one', B: 'two' });
    expect(fs.existsSync(path.join(e.dir, 'secrets.yaml'))).toBe(true);

    // The same store object, told the backend changed underneath it.
    let backend: 'plain' | 'os' = 'plain';
    const store = new SecretStore({
      dir: e.dir,
      systools: new SystoolRegistry({ run: () => 'gpg (GnuPG) 2.4.0' }),
      settings: () => ({ backend, gpgKey: null }),
      keyring: vault,
      kernelKeys: KERNEL_KEYS.absent,
    });
    const moved = store.migrate('os');
    expect(moved).toMatchObject({ moved: ['A', 'B'], from: 'plain' });
    // Source gone, values present, and `secrets/` empty — the exit criterion.
    expect(fs.existsSync(path.join(e.dir, 'secrets.yaml'))).toBe(false);
    expect(fs.readdirSync(e.dir)).toEqual([]);

    backend = 'os';
    store.reload();
    expect(store.get('A')).toBe('one');
    expect(store.list()).toEqual(['A', 'B']);
  });

  it('leaves the source alone when the target cannot be verified', () => {
    e = env();
    const plain = storeFor(e, { backend: 'plain' });
    plain.merge({ A: 'one' });
    // A vault that passes its probe and then loses real keys: the failure that
    // would destroy a credential if the source were deleted before verifying.
    const amnesiac: Keyring = {
      get: (_s, account) => (account === '__probe__' ? 'ok' : null),
      set: () => {},
      delete: () => {},
    };
    const store = new SecretStore({
      dir: e.dir,
      systools: new SystoolRegistry({ run: () => 'gpg (GnuPG) 2.4.0' }),
      settings: () => ({ backend: 'plain', gpgKey: null }),
      keyring: amnesiac,
      kernelKeys: KERNEL_KEYS.absent,
    });
    expect(store.migrate('os')).toMatchObject({ error: 'verify_failed' });
    expect(fs.readFileSync(path.join(e.dir, 'secrets.yaml'), 'utf8')).toContain('A: one');
  });
});

describe('legacy plaintext model keys heal on load (§27)', () => {
  let boot: { app: App; dataDir: string; cleanup(): void } | null = null;
  afterEach(() => {
    boot?.cleanup();
    boot = null;
  });

  const MODELS = (key: string, embedKey: string) =>
    YAML.stringify({
      endpoints: [
        { name: 'main', url: 'http://localhost:8080', api_key: key, classes: ['best'] },
      ],
      embedding: { url: 'http://localhost:8080', api_key: embedKey },
    });

  function bootSeeded(models: string, secrets?: string) {
    const t = tmpDir('turminder-modelkeys-');
    const dataDir = path.join(t.dir, 'home');
    write(path.join(dataDir, 'config', 'models.yaml'), models);
    if (secrets) write(path.join(dataDir, 'secrets', 'secrets.yaml'), secrets);
    const app = bootstrap({ dataDir });
    return {
      app,
      dataDir,
      cleanup: () => {
        app.close();
        t.cleanup();
      },
    };
  }

  const modelsText = (dataDir: string) =>
    fs.readFileSync(path.join(dataDir, 'config', 'models.yaml'), 'utf8');

  it('moves the value into the store, leaves a reference, and commits', () => {
    boot = bootSeeded(MODELS('sentinel-hosted-key', 'sentinel-embed-key'));
    const { app, dataDir } = boot;

    const text = modelsText(dataDir);
    expect(text).toContain('${secret:MODEL_API_KEY_MAIN}');
    expect(text).toContain('${secret:MODEL_API_KEY_EMBEDDING}');
    expect(text).not.toContain('sentinel-hosted-key');
    expect(text).not.toContain('sentinel-embed-key');

    // The endpoint still works: the reference resolves back to the value.
    expect(app.config.models()?.endpoints[0]?.api_key).toBe('sentinel-hosted-key');
    expect(app.config.secretStore.get('MODEL_API_KEY_MAIN')).toBe('sentinel-hosted-key');

    // And the value greps out of nothing but the store.
    for (const rel of ['config', 'files', 'memory']) {
      const dir = path.join(dataDir, rel);
      if (!fs.existsSync(dir)) continue;
      for (const file of fs.readdirSync(dir)) {
        const full = path.join(dir, file);
        if (!fs.statSync(full).isFile()) continue;
        expect(fs.readFileSync(full, 'utf8')).not.toContain('sentinel-hosted-key');
      }
    }
    expect(fs.readFileSync(path.join(dataDir, 'secrets', 'secrets.yaml'), 'utf8')).toContain(
      'sentinel-hosted-key',
    );

    // Committed, like every other mutation of the data repo.
    const log = spawnSync('git', ['log', '--oneline'], {
      cwd: dataDir,
      encoding: 'utf8',
    }).stdout;
    expect(log).toContain('move model api keys into the secret store');

    // Once, and then never again: a second start has nothing to heal.
    const before = modelsText(dataDir);
    const second = bootstrap({ dataDir });
    expect(modelsText(dataDir)).toBe(before);
    second.close();
  });

  it('leaves one plaintext alone rather than repointing it at a different value', () => {
    boot = bootSeeded(
      YAML.stringify({
        endpoints: [
          {
            name: 'main',
            url: 'http://localhost:8080',
            api_key: 'sentinel-current',
            classes: ['best'],
          },
          {
            name: 'spare',
            url: 'http://localhost:8081',
            api_key: 'sentinel-spare',
            classes: ['fast'],
          },
        ],
      }),
      YAML.stringify({ MODEL_API_KEY_MAIN: 'sentinel-older' }),
    );
    const { app, dataDir } = boot;

    // Silently swapping the credential is the one outcome worse than a file
    // keeping its plaintext, so `main` is declined — while `spare`, which
    // clashes with nothing, heals in the same pass.
    const text = modelsText(dataDir);
    expect(text).toContain('sentinel-current');
    expect(text).toContain('${secret:MODEL_API_KEY_SPARE}');
    expect(text).not.toContain('sentinel-spare');
    expect(app.config.secretStore.get('MODEL_API_KEY_MAIN')).toBe('sentinel-older');
    expect(app.config.secretStore.get('MODEL_API_KEY_SPARE')).toBe('sentinel-spare');
  });
});

describe('totality: no secret-bearing file survives (§27)', () => {
  let e: Env;
  afterEach(() => e.cleanup());

  it('folds legacy google files into keys and deletes them', () => {
    e = env();
    fs.mkdirSync(e.dir, { recursive: true });
    fs.writeFileSync(path.join(e.dir, 'google-token.json'), '{"refresh_token":"sentinel-rt"}');
    fs.writeFileSync(
      path.join(e.dir, 'credentials.json'),
      '{"installed":{"client_id":"cid","client_secret":"sentinel-cs"}}',
    );
    const store = storeFor(e);

    expect(store.get('GOOGLE_OAUTH_TOKEN')).toContain('sentinel-rt');
    expect(store.get('GOOGLE_CLIENT_CREDENTIALS')).toContain('sentinel-cs');
    expect(fs.existsSync(path.join(e.dir, 'google-token.json'))).toBe(false);
    expect(fs.existsSync(path.join(e.dir, 'credentials.json'))).toBe(false);
  });

  it('under the os backend, secrets/ ends up holding nothing at all', () => {
    e = env();
    fs.mkdirSync(e.dir, { recursive: true });
    fs.writeFileSync(path.join(e.dir, 'google-token.json'), '{"refresh_token":"sentinel-rt"}');
    const vault = fakeVault();
    const store = storeFor(e, { backend: 'os', keyring: vault });
    store.merge({ ASANA_PAT: 'sentinel-pat' });
    store.all();

    expect(fs.readdirSync(e.dir)).toEqual([]);
    // And the values really are in the vault, not lost.
    expect([...vault.entries.values()].join()).toContain('sentinel-pat');
  });

  it('resolves ${secret:KEY} through whichever backend is configured (G.6)', () => {
    e = env('secrets:\n  backend: plain\n');
    const config = new Config(e.home);
    config.secretStore.merge({ SEARX: 'http://searx.example' });
    config.reload();
    write(
      e.home.path('config', 'turminder.yaml'),
      'search:\n  searxng_url: "${secret:SEARX}"\n',
    );
    expect(new Config(e.home).settings.searxngUrl).toBe('http://searx.example');
  });
});
