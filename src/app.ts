import { Config, resolveBindOverride } from './core/config.js';
import { openDataHome, type DataHome } from './core/datadir.js';
import { DeviceTokens } from './core/tokens.js';
import { log } from './core/logger.js';
import type { SystoolRegistry } from './core/systools.js';
import { openDb, dbVersion, type Db } from './db/index.js';
import { installShippedAssets } from './prompts/shipped.js';

const l = log('app');

export interface BootOptions {
  dataDir?: string;
  /** `--bind host:port` (§28.1) — the sidecar's free port, handed in. */
  bind?: string;
  /** Skip opening the database (inspection commands that only need paths). */
  withoutDb?: boolean;
}

/**
 * The composition root: data home, config, database. Everything else takes
 * these as constructor arguments — there is no global service locator.
 */
export interface App {
  home: DataHome;
  config: Config;
  db: Db;
  /** Gateway device tokens (§24) — the one door into `config/channels.yaml`. */
  tokens: DeviceTokens;
  /** External binaries this build may shell out to, probed on demand (§23.1). */
  systools: SystoolRegistry;
  created: boolean;
  newUiToken?: string;
  close(): void;
}

export function bootstrap(opts: BootOptions = {}): App {
  const { home, created, newUiToken } = openDataHome(opts.dataDir);
  const config = new Config(home, resolveBindOverride(opts.bind));
  // Touch settings early so a broken turminder.yaml fails at boot, not mid-run.
  const settings = config.settings;
  const db = openDb(home.dbPath);
  installShippedAssets(home);
  // One registry, owned by the config loader: the gpg secret backend needs it
  // before anything else exists, and two registries would probe twice (§23.1).
  const systools = config.systools;
  // Now that settings are readable, git follows `systools.git` (G.1) rather
  // than a bare PATH lookup — and if git appeared since the last start, the
  // repo is initialised now and versioning resumes (§12.2).
  home.git.useBinary(() => systools.command('git'));
  if (home.git.available) home.git.init();
  else l.warn('git is not installed: the data dir works, but keeps no file history');
  // A pinned secret backend that cannot work is a startup failure naming the
  // fix, never a silent downgrade to plaintext (§27.1).
  config.secretStore.assertUsable();
  // Same story one file over: an api_key written into models.yaml in the clear
  // (before §27, or by hand) moves into the store and leaves a reference
  // behind, and a legacy `embedding:` block becomes a `kind: embedding`
  // endpoint (§8.3, §10.6) — one pass, one commit for whichever apply.
  config.healModelsYaml();
  // An install written before §24 still has plaintext tokens on disk; fold them
  // into hashes now, once, so the devices holding them keep working and the
  // file stops carrying values (G.4).
  const tokens = new DeviceTokens(home, config);
  tokens.healLegacy();

  l.info(
    {
      dataDir: home.root,
      dbVersion: dbVersion(db),
      layoutVersion: home.readManifest().layout_version,
      bind: `${settings.bind.host}:${settings.bind.port}`,
      created,
    },
    created ? 'data home created' : 'data home ready',
  );

  const app: App = {
    home,
    config,
    db,
    tokens,
    systools,
    created,
    close() {
      try {
        db.close();
      } catch {
        /* already closed */
      }
    },
  };
  return newUiToken ? { ...app, newUiToken } : app;
}
