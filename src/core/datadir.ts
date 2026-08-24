import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import YAML from 'yaml';
import { z } from 'zod';
import { UserFacingError } from './errors.js';
import { GitRepo } from './git.js';
import { log } from './logger.js';
import { nowIso } from './time.js';
import { randomToken } from './ids.js';
import { tokenSha256 } from './tokens.js';

const l = log('datadir');

/** Data-dir layout version (App. G.10). Bumped only for on-disk layout changes. */
export const LAYOUT_VERSION = 4;

const ManifestSchema = z.object({
  layout_version: z.number().int().positive(),
  created_at: z.string(),
});
export type Manifest = z.infer<typeof ManifestSchema>;

/**
 * Directories that are part of the git-tracked "source half" (§12.2). `files/`
 * is in it because every assistant write to the store is a commit (§18.2) —
 * "what did you change in my todo list" is answered by `git log -p`. `embeds/`
 * is in it for the same reason, minus `embeds/tmp/`: a promoted mini-app gets
 * history and rollback, while scratch dashboards must not spam the log (§22.1).
 */
const SOURCE_DIRS = ['config', 'memory', 'handlers', 'skills', 'files', 'embeds'] as const;
/** Directories excluded from git and from backup. */
const DERIVED_DIRS = ['secrets', 'cache', 'uploads'] as const;

const EMBEDS_TMP_IGNORE = 'embeds/tmp/';
const UPLOADS_IGNORE = 'uploads/';

const DATA_GITIGNORE = `# Machine data and secrets never enter git (spec §12.2).
events.db
events.db-wal
events.db-shm
secrets/
cache/
${EMBEDS_TMP_IGNORE}
${UPLOADS_IGNORE}
`;

const DEFAULT_TURMINDER_YAML = `# Turminder service settings (spec App. G.1).
# Everything here is optional; the values shown are the shipped defaults.
bind: 127.0.0.1:7787
data_defaults:
  max_depth: 5
  retry_attempts: 3
  conversation_idle_min: 30
  futile_streak_threshold: 3   # §20.9
  spa_text_floor_chars: 500    # §20.9, App. F.5
search:
  searxng_url: http://127.0.0.1:8080
scheduler:
  background_concurrency: 1
files:
  # dir: /home/you/vault   # point the store at an Obsidian vault instead (§18.2)
  quiescence_s: 30
  markers: ["@turminder"]
  watch_rate_limit_s: 600
systools:                 # §23.1 — path overrides; default: probe $PATH
  chromium: null          # e.g. /usr/bin/chromium
  gpg: null               # §27.1 gpg secret backend
  git: null               # §12.2 data-repo versioning
secrets:                  # §27.1
  backend: auto           # auto | os | gpg | plain — pinned at onboarding
  gpg_key: null           # recipient key id, gpg backend only
uploads:                  # §26.1
  max_mb: 20
  ttl_days: 30
  image_context_turns: 2  # §26.3
gateway:
  # public_url: https://turminder.example.net   # base URL for QR connect (§24.3)
  public_url: null
retention_days: 90
`;

/** Shipped `.turminderignore` (App. G.11): editor and sync detritus. */
const DEFAULT_TURMINDERIGNORE = `# Paths excluded from watching and indexing (spec §18.2, App. G.11).
# gitignore syntax. Edit freely; it is only created when missing.
.obsidian/
.trash/
*.tmp
*.swp
*~
*.sync-conflict-*
`;

/** Resolution order per §12.1: --data-dir flag -> env -> ~/.turminder. */
export function resolveDataDir(flag?: string): string {
  const raw = flag ?? process.env.TURMINDER_DATA_DIR ?? path.join(os.homedir(), '.turminder');
  const expanded = raw.startsWith('~')
    ? path.join(os.homedir(), raw.slice(1).replace(/^[/\\]/, ''))
    : raw;
  return path.resolve(expanded);
}

export interface OpenDataHomeResult {
  home: DataHome;
  created: boolean;
  /** Set only when a ui device token was generated on this run (App. E). */
  newUiToken?: string;
}

/**
 * The single directory that is the complete state of the assistant (§12.1).
 * Owns nothing but paths, the MANIFEST, and the scaffold.
 */
export class DataHome {
  readonly root: string;
  readonly git: GitRepo;

  constructor(root: string) {
    this.root = root;
    this.git = new GitRepo(root);
  }

  path(...rel: string[]): string {
    return path.join(this.root, ...rel);
  }

  get configDir(): string {
    return this.path('config');
  }
  get memoryDir(): string {
    return this.path('memory');
  }
  get handlersDir(): string {
    return this.path('handlers');
  }
  get skillsDir(): string {
    return this.path('skills');
  }
  /** The default file store root; `files.dir` may point elsewhere (§18.2). */
  get filesDir(): string {
    return this.path('files');
  }
  get secretsDir(): string {
    return this.path('secrets');
  }
  /** Persistent embeds (§22.1); the ephemeral ones live under `tmp/`. */
  get embedsDir(): string {
    return this.path('embeds');
  }
  get embedsTmpDir(): string {
    return this.path('embeds', 'tmp');
  }
  get cacheDir(): string {
    return this.path('cache');
  }
  /** Chat attachments (§26.1): content-addressed, gitignored, TTL-pruned. */
  get uploadsDir(): string {
    return this.path('uploads');
  }
  get dbPath(): string {
    return this.path('events.db');
  }
  get manifestPath(): string {
    return this.path('MANIFEST');
  }

  exists(): boolean {
    return fs.existsSync(this.manifestPath);
  }

  readManifest(): Manifest {
    let text: string;
    try {
      text = fs.readFileSync(this.manifestPath, 'utf8');
    } catch {
      throw new UserFacingError(
        'manifest_missing',
        `no MANIFEST in ${this.root} — is this a Turminder data dir?`,
      );
    }
    const parsed = ManifestSchema.safeParse(YAML.parse(text));
    if (!parsed.success) {
      throw new UserFacingError(
        'manifest_invalid',
        `MANIFEST in ${this.root} is not valid`,
        parsed.error.issues
          .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
          .join('; '),
      );
    }
    return parsed.data;
  }

  writeManifest(m: Manifest): void {
    fs.writeFileSync(this.manifestPath, YAML.stringify(m), 'utf8');
  }
}

function writeIfAbsent(file: string, contents: string, mode?: number): boolean {
  if (fs.existsSync(file)) return false;
  fs.writeFileSync(file, contents, mode === undefined ? 'utf8' : { encoding: 'utf8', mode });
  return true;
}

/**
 * Fold the interim `config/sources.yaml` into activation records (§19.5, G.12)
 * and delete it. Poller enablement is part of an integration's activation, so
 * two files saying whether Asana is on was one too many.
 *
 * Credentials already on disk imply an active integration: upgrading must not
 * silently switch off a setup that was working yesterday.
 */
function foldSourcesIntoIntegrations(home: DataHome): void {
  const sourcesFile = home.path('config', 'sources.yaml');
  const raw = fs.existsSync(sourcesFile)
    ? ((YAML.parse(fs.readFileSync(sourcesFile, 'utf8')) ?? {}) as Record<string, any>)
    : {};
  const secretsFile = home.path('secrets', 'secrets.yaml');
  const secrets = fs.existsSync(secretsFile)
    ? ((YAML.parse(fs.readFileSync(secretsFile, 'utf8')) ?? {}) as Record<string, unknown>)
    : {};
  const hasGoogleToken = fs.existsSync(home.path('secrets', 'google-token.json'));

  const records: Record<string, unknown> = {};
  const asana = raw.asana;
  const asanaCredentialled = Boolean(asana?.pat || secrets.ASANA_PAT);
  if (asanaCredentialled && (asana?.enabled ?? true)) {
    records.asana = {
      active: true,
      activated_at: nowIso(),
      settings: {
        ...(asana?.poll_seconds ? { poll_interval_s: asana.poll_seconds } : {}),
        ...(asana?.workspaces?.length ? { workspaces: asana.workspaces } : {}),
        ...(asana?.inbox_section ? { inbox_section: asana.inbox_section } : {}),
        ...(asana?.daily_section ? { daily_section: asana.daily_section } : {}),
        ...(asana?.include_comments !== undefined
          ? { include_comments: asana.include_comments }
          : {}),
        ...(asana?.max_per_poll ? { max_per_poll: asana.max_per_poll } : {}),
        ...(asana?.watch_daily !== undefined ? { watch_daily: asana.watch_daily } : {}),
      },
    };
  }

  const calendar = raw.google_calendar;
  if (hasGoogleToken && (calendar?.enabled ?? true)) {
    records['google-calendar'] = {
      active: true,
      activated_at: nowIso(),
      settings: {
        ...(calendar?.poll_seconds ? { poll_interval_s: calendar.poll_seconds } : {}),
        ...(calendar?.lead_minutes ? { upcoming_lead_min: calendar.lead_minutes } : {}),
        ...(calendar?.calendars?.length ? { calendars: calendar.calendars } : {}),
        ...(calendar?.watch_changes !== undefined
          ? { watch_changes: calendar.watch_changes }
          : {}),
      },
    };
  }

  const target = home.path('config', 'integrations.yaml');
  if (Object.keys(records).length && !fs.existsSync(target)) {
    fs.writeFileSync(target, YAML.stringify({ integrations: records }), 'utf8');
    l.info(
      { integrations: Object.keys(records) },
      'migrated sources.yaml into integrations.yaml',
    );
  }
  if (fs.existsSync(sourcesFile)) {
    fs.rmSync(sourcesFile);
    l.info('removed config/sources.yaml; activation records replace it');
  }
  home.git.commit('layout 2: fold sources.yaml into integrations.yaml', ['config']);
}

/**
 * Make room for embeds (§22.1). `openDataHome` creates the directories on every
 * start, so all this step has to add is the ignore line — an install scaffolded
 * before embeds existed has a `.gitignore` that would otherwise track every
 * scratch dashboard the assistant ever drew.
 */
function addEmbedsIgnore(home: DataHome): void {
  const file = home.path('.gitignore');
  const current = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  if (current.split(/\r?\n/).some((line) => line.trim() === EMBEDS_TMP_IGNORE)) return;
  fs.writeFileSync(file, `${current.replace(/\n*$/, '\n')}${EMBEDS_TMP_IGNORE}\n`, 'utf8');
  home.git.commit('layout 3: keep ephemeral embeds out of git', ['.gitignore']);
}

/**
 * Make room for attachments (§26.1). Same shape as the embeds step: the
 * directory is created on every start, so the migration only has to stop git
 * from tracking screenshots — bytes that would bloat the data repo permanently
 * and can never be usefully diffed.
 */
function addUploadsIgnore(home: DataHome): void {
  const file = home.path('.gitignore');
  const current = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  if (current.split(/\r?\n/).some((line) => line.trim() === UPLOADS_IGNORE)) return;
  fs.writeFileSync(file, `${current.replace(/\n*$/, '\n')}${UPLOADS_IGNORE}\n`, 'utf8');
  home.git.commit('layout 4: keep chat attachments out of git', ['.gitignore']);
}

/** Layout migrations, keyed by the version they migrate *from*. */
const LAYOUT_MIGRATIONS: Record<number, (home: DataHome) => void> = {
  1: foldSourcesIntoIntegrations,
  2: addEmbedsIgnore,
  3: addUploadsIgnore,
};

function migrateLayout(home: DataHome, from: number): void {
  let v = from;
  while (v < LAYOUT_VERSION) {
    const step = LAYOUT_MIGRATIONS[v];
    if (!step) {
      throw new UserFacingError(
        'layout_migration_missing',
        `no layout migration from version ${v} to ${v + 1}`,
      );
    }
    l.info({ from: v, to: v + 1 }, 'running layout migration');
    step(home);
    v += 1;
  }
  const m = home.readManifest();
  home.writeManifest({ ...m, layout_version: LAYOUT_VERSION });
}

/**
 * Resolve, create-if-absent, and validate the data home. Idempotent: a second
 * call on an existing dir changes nothing. Refuses a MANIFEST from the future.
 */
export function openDataHome(flag?: string): OpenDataHomeResult {
  const root = resolveDataDir(flag);
  const home = new DataHome(root);
  const fresh = !home.exists();

  fs.mkdirSync(root, { recursive: true });
  for (const d of [...SOURCE_DIRS, ...DERIVED_DIRS]) {
    fs.mkdirSync(home.path(d), { recursive: true });
  }
  fs.chmodSync(home.secretsDir, 0o700);
  fs.mkdirSync(home.embedsTmpDir, { recursive: true });

  // Keep otherwise-empty source dirs in git so a fresh clone has the layout.
  let wroteSomething = false;
  for (const d of ['memory', 'handlers', 'skills', 'embeds'] as const) {
    wroteSomething = writeIfAbsent(home.path(d, '.gitkeep'), '') || wroteSomething;
  }
  // The file store keeps the layout instead: the ignore list is its .gitkeep.
  wroteSomething =
    writeIfAbsent(home.path('files', '.turminderignore'), DEFAULT_TURMINDERIGNORE) ||
    wroteSomething;
  wroteSomething = writeIfAbsent(home.path('.gitignore'), DATA_GITIGNORE) || wroteSomething;
  wroteSomething =
    writeIfAbsent(home.path('config', 'turminder.yaml'), DEFAULT_TURMINDER_YAML) ||
    wroteSomething;

  // The `ui` token's one moment (§24): generated here, hashed into the file,
  // and handed back in memory for the single print the first run makes. After
  // this function returns there is no way to recover the value.
  let newUiToken: string | undefined;
  const channelsFile = home.path('config', 'channels.yaml');
  if (!fs.existsSync(channelsFile)) {
    newUiToken = randomToken(32);
    fs.writeFileSync(
      channelsFile,
      YAML.stringify({
        devices: [
          { device: 'ui', token_sha256: tokenSha256(newUiToken), created_at: nowIso() },
        ],
      }),
      'utf8',
    );
  }

  if (fresh) {
    home.writeManifest({ layout_version: LAYOUT_VERSION, created_at: nowIso() });
    l.info({ root }, 'created data home');
  }

  const manifest = home.readManifest();
  if (manifest.layout_version > LAYOUT_VERSION) {
    throw new UserFacingError(
      'layout_from_the_future',
      `data dir ${root} has layout_version ${manifest.layout_version}, but this build knows ${LAYOUT_VERSION}`,
      'upgrade Turminder, or point --data-dir somewhere else.',
    );
  }
  if (manifest.layout_version < LAYOUT_VERSION) migrateLayout(home, manifest.layout_version);

  home.git.init();
  // Only commit when the scaffold actually laid something down: attempting a
  // commit on every start is pure churn.
  if (fresh || wroteSomething || newUiToken) {
    home.git.commit(fresh ? 'initial data home' : 'scaffold update', [
      '.gitignore',
      ...SOURCE_DIRS,
    ]);
  }

  return newUiToken ? { home, created: fresh, newUiToken } : { home, created: fresh };
}
