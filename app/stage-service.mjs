#!/usr/bin/env node
/**
 * Stage the service into the shape the shell expects (§28.1, §28.4).
 *
 * Node rather than bash, because this has to run on the three platforms the
 * app targets and Windows has no shell in common with the others. Node is also
 * the thing being staged, so the build machine already has one.
 *
 * The app is a packaging tier: it consumes the service's *built artifacts* and
 * never its source (§28.3). So this only reads `dist/`, `ui/`, the lockfile and
 * the manifest — and it installs into its own staging tree rather than the
 * repo's `node_modules`, because a production-only install in the repo root
 * would delete the dev dependencies the service is tested with.
 *
 * The layout below is not invented here, it is what the built service resolves:
 * `dist/src/net/static.js` looks for `ui/` and `node_modules/` two levels up,
 * which lands inside `dist/`. `npm run build` populates neither, so assembling
 * a *runnable* tree is this script's job (LIMITS.md, §28).
 *
 *   src-tauri/service/bin/<node|node.exe>    the pinned runtime (§28.4)
 *   src-tauri/service/package.json           so Node reads `type: module`
 *   src-tauri/service/dist/src/index.js      the entry point
 *   src-tauri/service/dist/ui/               the chat and setup UI
 *   src-tauri/service/dist/node_modules/     production deps, this arch's natives
 *
 * Usage: node stage-service.mjs [--target <platform-arch>]
 * The target defaults to the host. Naming one cross-stages, which is only
 * partly possible: npm can be told which platform's optional native packages
 * to install, but the runtime binary and the smoke test cannot be faked, so a
 * cross-staged tree is unverified by construction and says so.
 */
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '..');
const staging = path.join(here, 'src-tauri', 'service');
const runtimes = JSON.parse(fs.readFileSync(path.join(here, 'node-runtime.json'), 'utf8'));

const say = (msg) => process.stdout.write(`\x1b[36m==\x1b[0m ${msg}\n`);
const die = (msg) => {
  process.stderr.write(`\x1b[31m==\x1b[0m ${msg}\n`);
  process.exit(1);
};

/* ── which platform are we assembling for ─────────────────────────────────── */

const flagIndex = process.argv.indexOf('--target');
const hostTarget = `${process.platform}-${process.arch}`;
const target = flagIndex === -1 ? hostTarget : process.argv[flagIndex + 1];
const cross = target !== hostTarget;
const runtime = runtimes.targets[target];
if (!runtime) {
  die(`no pinned Node runtime for ${target} — known: ${Object.keys(runtimes.targets).join(', ')}`);
}
const [targetOs, targetArch] = target.split('-');

/* ── the built service, which this script never builds ────────────────────── */

if (!fs.existsSync(path.join(repo, 'dist', 'src', 'index.js'))) {
  die(`no build to bundle — run 'npm run build' in ${repo} first`);
}
if (!fs.existsSync(path.join(repo, 'ui', 'index.html'))) {
  die(`no ui/ to bundle — is ${repo} a Turminder checkout?`);
}

say(`staging ${target}${cross ? ' (cross)' : ''} into ${staging}`);
fs.rmSync(staging, { recursive: true, force: true });
fs.mkdirSync(path.join(staging, 'bin'), { recursive: true });

/* ── the pinned runtime ───────────────────────────────────────────────────── */

/**
 * The archive, from nix if it handed us one, else downloaded to a cache.
 *
 * Either way the checksum is checked against `node-runtime.json` rather than
 * against whatever the server says today: a pin that trusts the same host it
 * downloads from is not a pin.
 */
async function nodeArchive() {
  const prefetched = process.env.TURMINDER_APP_NODE_TARBALL;
  if (prefetched && !cross) {
    say(`using the prefetched runtime`);
    return prefetched;
  }
  const cache = path.join(os.tmpdir(), 'turminder-node-runtimes');
  fs.mkdirSync(cache, { recursive: true });
  const file = path.join(cache, runtime.archive);
  if (!fs.existsSync(file)) {
    const url = `https://nodejs.org/dist/v${runtimes.version}/${runtime.archive}`;
    say(`downloading ${runtime.archive}`);
    const res = await fetch(url);
    if (!res.ok) die(`could not download the pinned runtime: HTTP ${res.status} for ${url}`);
    fs.writeFileSync(file, Buffer.from(await res.arrayBuffer()));
  }
  const digest = createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  if (digest !== runtime.sha256) {
    fs.rmSync(file, { force: true });
    die(`${runtime.archive} failed its checksum — expected ${runtime.sha256}, got ${digest}`);
  }
  return file;
}

function run(command, args, opts = {}) {
  const result = spawnSync(command, args, { stdio: 'inherit', shell: false, ...opts });
  if (result.error) die(`${command} could not be run: ${result.error.message}`);
  if (result.status !== 0) die(`${command} ${args.join(' ')} exited ${result.status}`);
}

/** Did this tool run at all, whatever it thought of its arguments? */
function canRun(command, args) {
  const result = spawnSync(command, args, { stdio: 'ignore' });
  return !result.error;
}

/**
 * Unpack the runtime archive, which is a `.tar.xz` everywhere except Windows.
 *
 * There is no one tool for both: GNU tar reads `.tar.xz` and refuses `.zip`
 * ("This does not look like a tar archive"), while the bsdtar that ships with
 * macOS and Windows reads both. So the zip case tries `unzip` first and falls
 * back to `tar`, which covers a Windows runner staging natively *and* a Linux
 * box cross-staging for Windows — as long as it has one of the two.
 */
function extract(archive, into) {
  if (!archive.endsWith('.zip')) {
    run('tar', ['-xf', archive, '-C', into]);
    return;
  }
  if (canRun('unzip', ['-v'])) {
    run('unzip', ['-q', archive, '-d', into]);
    return;
  }
  // bsdtar handles zip; GNU tar does not, and will say so.
  if (canRun('tar', ['--version'])) {
    const result = spawnSync('tar', ['-xf', archive, '-C', into], { stdio: 'pipe' });
    if (result.status === 0) return;
  }
  die(
    `cannot unpack ${path.basename(archive)} here: no unzip, and this tar will not read a zip. ` +
      `Install unzip, or stage on a Windows machine where tar is bsdtar.`,
  );
}

const archive = await nodeArchive();
say(`unpacking node ${runtimes.version}`);
const unpack = fs.mkdtempSync(path.join(os.tmpdir(), 'turminder-node-'));
extract(archive, unpack);
const unpacked = path.join(unpack, runtime.archive.replace(/\.(tar\.xz|zip)$/, ''));
const nodeBinary = targetOs === 'win32' ? 'node.exe' : 'node';
fs.copyFileSync(path.join(unpacked, runtime.binary), path.join(staging, 'bin', nodeBinary));
if (targetOs !== 'win32') fs.chmodSync(path.join(staging, 'bin', nodeBinary), 0o755);
fs.rmSync(unpack, { recursive: true, force: true });

/* ── the service itself ───────────────────────────────────────────────────── */

say('copying dist and ui');
fs.cpSync(path.join(repo, 'dist'), path.join(staging, 'dist'), { recursive: true });
// `test/` is built by the same tsc run and has no business in a shipped bundle.
fs.rmSync(path.join(staging, 'dist', 'test'), { recursive: true, force: true });
fs.cpSync(path.join(repo, 'ui'), path.join(staging, 'dist', 'ui'), { recursive: true });

say('installing production dependencies');
for (const file of ['package.json', 'package-lock.json']) {
  fs.copyFileSync(path.join(repo, file), path.join(staging, file));
}
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
run(
  npm,
  [
    'ci',
    '--omit=dev',
    '--ignore-scripts',
    '--no-audit',
    '--fund=false',
    // Cross-staging: tell npm which platform's optional native packages to
    // resolve, since it would otherwise pick this machine's.
    ...(cross ? [`--os=${targetOs === 'win32' ? 'win32' : targetOs}`, `--cpu=${targetArch}`] : []),
  ],
  { cwd: staging, stdio: 'ignore', shell: process.platform === 'win32' },
);
// Into dist/, where the built service's own path resolution looks for it.
fs.renameSync(path.join(staging, 'node_modules'), path.join(staging, 'dist', 'node_modules'));
// The lockfile travelled only to drive `npm ci`; package.json stays, because
// Node reads `type: module` from it.
fs.rmSync(path.join(staging, 'package-lock.json'), { force: true });

/* ── one platform's natives, not eight ───────────────────────────────────── */

/**
 * Drop the `prebuilds/` binaries that are not this target's.
 *
 * npm filters *packages* by `os`/`cpu`, which is why `@napi-rs/*` arrives
 * already narrowed — but better-sqlite3 ships every platform inside one
 * tarball, so the staged tree carries eight `.node` files of which one can
 * ever load: two Mach-O, two PE, and four ELF (glibc and musl, x64 and
 * arm64). Seven are dead weight in every artifact, and on Linux one of them
 * fails the build outright. `linuxdeploy` walks the AppDir and resolves
 * dependencies for **every ELF it finds**, so it reaches
 * `linuxmusl-x64.node`, asks a glibc runner for `libc.musl-x86_64.so.1`,
 * and stops: `ERROR: Could not find dependency` → `Failed to deploy
 * dependencies for existing files`. Tauri reports that as
 * `failed to run linuxdeploy` with the reason discarded, which is why the
 * AppImage has never once built (§28.4, §32.3).
 *
 * Keyed off the file name because that is what the convention is: prebuildify
 * names these `<platform><libc?>-<arch>.node`. Anything that does not name a
 * platform at all is left alone — this removes what it recognises, never
 * what it merely fails to recognise.
 */
const keepPrebuild = `${targetOs === 'win32' ? 'win32' : targetOs}-${targetArch}.node`;
const PREBUILD_NAME = /^(darwin|linux|linuxmusl|win32|android|freebsd)-(x64|arm64|arm|ia32)\.node$/;
let dropped = 0;
for (const entry of fs.readdirSync(path.join(staging, 'dist', 'node_modules'), {
  recursive: true,
  withFileTypes: true,
})) {
  if (!entry.isFile() || path.basename(entry.parentPath ?? entry.path) !== 'prebuilds') continue;
  if (!PREBUILD_NAME.test(entry.name) || entry.name === keepPrebuild) continue;
  fs.rmSync(path.join(entry.parentPath ?? entry.path, entry.name));
  dropped++;
}
if (dropped) say(`dropped ${dropped} prebuilt native${dropped === 1 ? '' : 's'} for other platforms`);

/* ── §28.4: a bundle that cannot boot is not an artifact ──────────────────── */

const size = () => {
  let bytes = 0;
  for (const entry of fs.readdirSync(staging, { recursive: true, withFileTypes: true })) {
    if (entry.isFile()) bytes += fs.statSync(path.join(entry.parentPath ?? entry.path, entry.name)).size;
  }
  return `${Math.round(bytes / 1e6)}MB`;
};

if (cross) {
  say(`staged ${size()} for ${target} — NOT smoke-tested: a ${target} binary cannot run here`);
  process.exit(0);
}

say('smoke test: does the staged service actually come up?');
const probeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'turminder-smoke-'));
const { createServer } = await import('node:net');
const port = await new Promise((resolve) => {
  const probe = createServer();
  probe.listen(0, '127.0.0.1', () => {
    const { port } = probe.address();
    probe.close(() => resolve(port));
  });
});

const { spawn } = await import('node:child_process');
const child = spawn(
  path.join(staging, 'bin', nodeBinary),
  [path.join(staging, 'dist', 'src', 'index.js'), '--data-dir', probeDir, '--bind', `127.0.0.1:${port}`, 'serve'],
  { stdio: ['ignore', 'pipe', 'pipe'] },
);
let log = '';
child.stdout.on('data', (d) => (log += d));
child.stderr.on('data', (d) => (log += d));

/** Poll one path until it answers 200, or give up. */
async function reaches(pathname) {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) return `the service exited (${child.exitCode})`;
    try {
      const res = await fetch(`http://127.0.0.1:${port}${pathname}`);
      if (res.status === 200) return null;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return 'it never answered';
}

const healthz = await reaches('/healthz');
// The UI is served from inside the bundle too, and it is the half that a
// dist-only copy silently loses.
const ui = healthz ? 'skipped' : await reaches('/');
child.kill('SIGTERM');
await new Promise((r) => setTimeout(r, 1500));
child.kill('SIGKILL');
fs.rmSync(probeDir, { recursive: true, force: true });

if (healthz || ui) {
  process.stderr.write(`${log.split('\n').slice(-20).join('\n')}\n`);
  die(`staged service failed its smoke test — /healthz: ${healthz ?? 'ok'}, /: ${ui ?? 'ok'}`);
}
say(`staged ${size()} — healthz 200, ui 200`);
