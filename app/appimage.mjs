#!/usr/bin/env node
/**
 * Build the AppImage on a nix box (§28.4) — a packaging pre-flight, never a
 * shipped artifact.
 *
 * `bundle.targets` deliberately excludes `appimage` because that list also
 * serves a developer's plain `cargo tauri build`, and the AppImage leg of it
 * assumes an FHS system in ten separate places. This script supplies what
 * each of them is missing and then asks Tauri for the bundle by name, which is
 * the same thing §32.3's x64 Linux runner does on the command line.
 *
 * **What comes out runs here, and only here.** It needs no nix-shell and no
 * `LD_LIBRARY_PATH`: step 10 below puts the libraries AppImage leaves to the
 * host into the bundle, because a nix box is not a host that has them. What it
 * cannot escape is the ELF interpreter — linuxdeploy rewrites rpaths and never
 * that — so the bundle keeps the `/nix/store/…-glibc/ld-linux-x86-64.so.2` the
 * toolchain linked it against and will not start where that path is absent.
 * That is the same trap `shell.nix` records for the bundled Node runtime, and
 * it is why a released AppImage is still built on a runner. This one exists to
 * prove the packaging works before CI does it for real, exactly as a
 * cross-staged sidecar proves its own packaging and reports itself unverified.
 *
 * The ten, in the order the build hits them:
 *
 *   1. Tauri finds the tray library with `pkg-config --libs-only-L`, then
 *      strips two bytes and treats the remainder as one directory. nix emits
 *      one `-L` per dependency libdir, so the remainder is twelve paths.
 *   2. `gio-2.0.pc` names a `schemasdir` nixpkgs does not populate — GSettings
 *      schemas live under `share/gsettings-schemas/<pkg>/` instead.
 *   3. The gtk plugin copies gtk-3.0's and gdk-pixbuf's module directories
 *      into the AppDir and then writes a generated cache file *inside* the
 *      copy. Store directories are read-only, so the copy is too.
 *   4. nixpkgs ships `libgobject-2.0.so.*-gdb.py` beside the library, and the
 *      plugin's `libgobject-*.so*` glob matches it; linuxdeploy's ELF parser
 *      aborts the whole run on the first non-ELF it is handed.
 *   5. linuxdeploy re-resolves every NEEDED entry *after* rewriting rpath to
 *      `$ORIGIN/../lib`, so a library it refuses to bundle must still be
 *      findable. On a normal distro they all sit on the default loader path.
 *   6. `linuxdeploy-plugin-gstreamer.sh` starts `#! /bin/bash`, which NixOS
 *      does not have, and linuxdeploy runs every plugin beside itself — this
 *      build never asks for that one.
 *   7. The downloaded AppImage plugin's `appimagetool` is a `#! /bin/bash`
 *      shim too. linuxdeploy's built-in copy uses `#!/bin/sh`, which NixOS
 *      does have.
 *   8. nix-shell exports `SOURCE_DATE_EPOCH`; appimagetool's mksquashfs
 *      refuses it alongside the timestamp flags it passes itself.
 *   9. A run that dies leaves read-only store copies in the AppDir, and the
 *      next run cannot delete them.
 *  10. AppImage's excludelist leaves out the libraries it treats as the
 *      host's — libasound, libstdc++, libX11, the GL dispatchers and eleven
 *      more — and nix keeps none of them on the loader path, so the artifact
 *      would not start without help. They go in as `bundle > linux > appimage
 *      > files`, which is Tauri's own supported way to put a file in an
 *      AppDir, passed with `--config` so the tracked `tauri.conf.json` is
 *      never written to.
 *
 * None of this patches a downloaded tool or edits a file outside `target/`:
 * the corrections are a `pkg-config` that answers differently, a tools
 * directory this build owns, two environment variables, and a config fragment.
 *
 * Usage: nix-shell, then `node appimage.mjs`. Run `stage-service.mjs` first —
 * the sidecar is what is being packaged.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const target = path.join(here, 'src-tauri', 'target', 'release');
const work = path.join(here, 'src-tauri', 'target', 'appimage-nix');

const say = (msg) => process.stdout.write(`\x1b[36m==\x1b[0m ${msg}\n`);
const die = (msg) => {
  process.stderr.write(`\x1b[31m==\x1b[0m ${msg}\n`);
  process.exit(1);
};

function capture(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8' });
  if (result.error) die(`${command} could not be run: ${result.error.message}`);
  if (result.status !== 0) die(`${command} ${args.join(' ')} exited ${result.status}`);
  return result.stdout.trim();
}

/* ── the toolchain this needs is the one shell.nix declares ───────────────── */

// `buildInputs` is how the closure below is found, and it is also the cheapest
// proof that this is running where gtk, webkit and the tray library exist.
const buildInputs = (process.env.buildInputs ?? '').split(/\s+/).filter(Boolean);
if (!buildInputs.length) {
  die("no buildInputs in the environment — run this inside nix-shell, from app/");
}
if (!fs.existsSync(path.join(here, 'src-tauri', 'service', 'dist', 'src', 'index.js'))) {
  die("no staged sidecar to package — run 'node stage-service.mjs' first (§28.4)");
}

const pkgConfig = capture('sh', ['-c', 'command -v pkg-config']);
const ask = (variable, module) => capture(pkgConfig, [`--variable=${variable}`, module]);

// Everything generated is rebuilt from scratch, because a stale mirror of a
// store path that has since been garbage-collected is a dangling symlink the
// bundler would follow. `cache/` below is deliberately not in this list: it
// holds a 13MB linuxdeploy nobody wants to download twice.
for (const generated of ['lib', 'schemas', 'bin']) {
  fs.rmSync(path.join(work, generated), { recursive: true, force: true });
}
fs.mkdirSync(work, { recursive: true });

/* ── writable stand-ins for the store directories that get written into ───── */

/**
 * Copy a store tree so the result can be written to.
 *
 * Symlinks are dereferenced on the way: what this produces ends up inside the
 * AppImage, and a link back into `/nix/store` would be a link to nothing on
 * any machine but this one — which is exactly the failure the whole artifact
 * is already only one step away from.
 */
function copyWritable(from, to) {
  const stat = fs.lstatSync(from);
  if (stat.isSymbolicLink()) return copyWritable(fs.realpathSync(from), to);
  if (stat.isDirectory()) {
    fs.mkdirSync(to, { recursive: true, mode: 0o755 });
    for (const name of fs.readdirSync(from)) copyWritable(path.join(from, name), path.join(to, name));
    return;
  }
  fs.copyFileSync(from, to);
  fs.chmodSync(to, 0o644);
}

/**
 * A stand-in for one library directory: symlinks to everything in it, except
 * the entries named in `writable`, which become real copies, and the ones
 * `skip` rejects, which are left out entirely.
 *
 * Symlinks everywhere else because these paths are also what the plugin hands
 * linuxdeploy as `--library=`, and deploying the real library is the point —
 * only the two module directories are ever written into (3), and only the gdb
 * scripts are not libraries at all (4).
 */
function mirror(real, name, { writable = [], skip = () => false } = {}) {
  const into = path.join(work, 'lib', name);
  fs.mkdirSync(into, { recursive: true });
  for (const entry of fs.readdirSync(real)) {
    if (skip(entry)) continue;
    const from = path.join(real, entry);
    if (writable.includes(entry)) copyWritable(from, path.join(into, entry));
    else fs.symlinkSync(from, path.join(into, entry));
  }
  return into;
}

const glibLib = mirror(ask('libdir', 'glib-2.0'), 'glib', {
  // (4) `libgobject-2.0.so.0.8800.1-gdb.py` is a Python file whose name the
  // plugin's `libgobject-*.so*` glob happily matches. Ubuntu keeps these under
  // share/gdb/auto-load, where no glob for a library will ever find them.
  skip: (entry) => entry.endsWith('-gdb.py'),
});
const gtkLib = mirror(ask('libdir', 'gtk+-3.0'), 'gtk3', { writable: ['gtk-3.0'] });
const pixbufReal = ask('libdir', 'gdk-pixbuf-2.0');
const pixbufLib = mirror(pixbufReal, 'gdk-pixbuf', { writable: ['gdk-pixbuf-2.0'] });
// The version-numbered paths inside come from pkg-config rather than from a
// constant here: `2.10.0` is gdk-pixbuf's ABI directory and moves on its own.
const inPixbufMirror = (real) => path.join(pixbufLib, path.relative(pixbufReal, real));

/**
 * (2) One directory holding every GSettings schema on the search path.
 *
 * `XDG_DATA_DIRS` is where they actually are, and shell.nix already builds it
 * out of gtk3 and gsettings-desktop-schemas for the app's own sake — so this
 * reads the answer that is already correct rather than naming packages again.
 */
const schemas = path.join(work, 'schemas');
fs.mkdirSync(schemas, { recursive: true });
let schemaCount = 0;
for (const dir of (process.env.XDG_DATA_DIRS ?? '').split(':').filter(Boolean)) {
  const from = path.join(dir, 'glib-2.0', 'schemas');
  if (!fs.existsSync(from)) continue;
  for (const entry of fs.readdirSync(from)) {
    if (!entry.endsWith('.gschema.xml') && !entry.endsWith('.enums.xml')) continue;
    const to = path.join(schemas, entry);
    if (fs.existsSync(to)) continue;
    fs.copyFileSync(path.join(from, entry), to);
    fs.chmodSync(to, 0o644);
    schemaCount++;
  }
}
if (!schemaCount) die('no GSettings schemas on XDG_DATA_DIRS — is this the app/ nix-shell?');
say(`${schemaCount} GSettings schemas collected, glib/gtk3/gdk-pixbuf mirrored`);

/* ── a pkg-config that answers differently ───────────────────────────────── */

/**
 * Everything it is not asked about goes straight through, and the overrides
 * only fire on the exact two-argument form Tauri and the gtk plugin use — so
 * the cargo build underneath, which asks with `--cflags --libs`, never sees a
 * different answer than it would have got.
 */
const answers = {
  // (1) Tauri does `output.stdout[2..]`: it expects `-L/one/path` and gets the
  // twelve that nix's transitive `Requires` produce. The module's own libdir
  // is the one it was reaching for.
  '--libs-only-L ayatana-appindicator3-0.1': `-L${ask('libdir', 'ayatana-appindicator3-0.1')}`,
  '--variable=schemasdir gio-2.0': schemas,
  '--variable=libdir gobject-2.0': glibLib,
  '--variable=libdir gio-2.0': glibLib,
  '--variable=libdir gtk+-3.0': gtkLib,
  '--variable=libdir gdk-pixbuf-2.0': pixbufLib,
  '--variable=gdk_pixbuf_binarydir gdk-pixbuf-2.0': inPixbufMirror(ask('gdk_pixbuf_binarydir', 'gdk-pixbuf-2.0')),
  '--variable=gdk_pixbuf_cache_file gdk-pixbuf-2.0': inPixbufMirror(ask('gdk_pixbuf_cache_file', 'gdk-pixbuf-2.0')),
  '--variable=gdk_pixbuf_moduledir gdk-pixbuf-2.0': inPixbufMirror(ask('gdk_pixbuf_moduledir', 'gdk-pixbuf-2.0')),
};

const shellSafe = (value) => {
  if (/['\n]/.test(value)) die(`a path this build has to quote contains a quote or newline: ${value}`);
  return `'${value}'`;
};
const shim = path.join(work, 'bin');
fs.mkdirSync(shim, { recursive: true });
fs.writeFileSync(
  path.join(shim, 'pkg-config'),
  [
    '#!/bin/sh',
    '# Written by app/appimage.mjs, which explains every line of it: the',
    '# queries a nix box answers in a way an FHS-shaped bundler cannot use.',
    'if [ "$#" -eq 2 ]; then',
    '  case "$1 $2" in',
    ...Object.entries(answers).map(([query, answer]) => `    ${shellSafe(query)}) echo ${shellSafe(answer)}; exit 0 ;;`),
    '  esac',
    'fi',
    `exec ${shellSafe(pkgConfig)} "$@"`,
    '',
  ].join('\n'),
  { mode: 0o755 },
);

/* ── a tools directory this build owns ────────────────────────────────────── */

/**
 * Tauri downloads linuxdeploy and three plugins into the user's cache on first
 * use. Pointing `XDG_CACHE_HOME` at `target/` instead keeps two decisions —
 * (6) and (7) — inside this build rather than in a directory every other Tauri
 * project on the machine shares.
 *
 * Both files are created empty and unexecutable, which is the only way to tell
 * Tauri not to fetch them: it downloads whatever is absent, and linuxdeploy
 * runs whatever is executable beside it. The AppImage plugin is documented as
 * optional and linuxdeploy falls back to its own copy; the gstreamer one this
 * build never asks for at all, because `bundleMediaFramework` is off.
 */
const cache = path.join(work, 'cache');
const tools = path.join(cache, 'tauri');
fs.mkdirSync(tools, { recursive: true });
for (const declined of ['linuxdeploy-plugin-gstreamer.sh', 'linuxdeploy-plugin-appimage.AppImage']) {
  fs.writeFileSync(path.join(tools, declined), '', { mode: 0o644 });
}

/* ── (9) what a failed run left behind ────────────────────────────────────── */

for (const stale of ['appimage', 'appimage_deb']) {
  const dir = path.join(target, 'bundle', stale);
  if (!fs.existsSync(dir)) continue;
  for (const entry of fs.readdirSync(dir, { recursive: true, withFileTypes: true })) {
    const full = path.join(entry.parentPath ?? entry.path, entry.name);
    if (entry.isDirectory()) fs.chmodSync(full, 0o755);
  }
  fs.rmSync(dir, { recursive: true, force: true });
}

/* ── (5) the libraries AppImage expects the host to already have ──────────── */

const closure = capture('nix-store', ['-qR', ...buildInputs])
  .split('\n')
  .map((store) => path.join(store, 'lib'))
  .filter((lib) => fs.existsSync(lib));

/* ── the bundle ───────────────────────────────────────────────────────────── */

const env = { ...process.env };
env.PATH = `${shim}:${env.PATH}`;
env.XDG_CACHE_HOME = cache;
env.LD_LIBRARY_PATH = [...closure, env.LD_LIBRARY_PATH].filter(Boolean).join(':');
// (8) nixpkgs sets this for reproducibility and appimagetool's mksquashfs
// calls it a conflict: "SOURCE_DATE_EPOCH and command line options can't be
// used at the same time to set timestamp(s)".
delete env.SOURCE_DATE_EPOCH;

/* ── (10) the libraries AppImage leaves to the host ──────────────────────── */

const appDir = path.join(target, 'bundle', 'appimage', 'Turminder.AppDir');
const remembered = path.join(work, 'host-libraries.json');
const config = path.join(work, 'host-libraries.config.json');

/** Every ELF in a tree. Read four bytes rather than trust a name. */
function elves(root) {
  const found = [];
  for (const entry of fs.readdirSync(root, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const full = path.join(entry.parentPath ?? entry.path, entry.name);
    // The staged sidecar is 30k files and almost none of them are ELF, so the
    // name narrows it before the open does.
    if (!/\.(so|node)($|\.)/.test(entry.name) && !(fs.statSync(full).mode & 0o111)) continue;
    const head = Buffer.alloc(4);
    const fd = fs.openSync(full, 'r');
    const read = fs.readSync(fd, head, 0, 4, 0);
    fs.closeSync(fd);
    if (read === 4 && head.toString('binary') === '\x7fELF') found.push(full);
  }
  return found;
}

/**
 * What the bundle asks its host for and would not find.
 *
 * `ldd` with nothing but the AppDir on the path is the same question the
 * loader asks when someone runs the artifact, which is the only question worth
 * answering — the excludelist that decided this is linuxdeploy's, embedded in
 * a binary, and a copy of it here would rot the first time it changed.
 */
function unresolved(files) {
  const missing = new Set();
  for (const file of files) {
    const ldd = spawnSync('ldd', [file], {
      encoding: 'utf8',
      env: { ...env, LD_LIBRARY_PATH: path.join(appDir, 'usr', 'lib') },
    });
    for (const line of (ldd.stdout ?? '').split('\n')) {
      const match = /^\s*(\S+)\s*=>\s*not found/.exec(line);
      if (match) missing.add(match[1]);
    }
  }
  return [...missing].sort();
}

/** Where those sonames live, according to the loader rather than to a guess. */
function locate(files, wanted) {
  const found = {};
  for (const file of files) {
    if (Object.keys(found).length === wanted.length) break;
    const ldd = spawnSync('ldd', [file], { encoding: 'utf8', env });
    for (const line of (ldd.stdout ?? '').split('\n')) {
      const match = /^\s*(\S+)\s*=>\s*(\/\S+)/.exec(line);
      if (match && wanted.includes(match[1]) && !found[match[1]]) found[match[1]] = match[2];
    }
  }
  return found;
}

/**
 * The map is remembered between runs so the steady state is one build, and
 * re-checked after every one so a new dependency cannot quietly go missing:
 * whatever the AppDir still cannot resolve is added and the bundle rebuilt.
 */
let host = {};
if (fs.existsSync(remembered)) {
  host = Object.fromEntries(
    Object.entries(JSON.parse(fs.readFileSync(remembered, 'utf8'))).filter(([, from]) =>
      // A store path can be garbage-collected between builds; a forgotten one
      // is rediscovered below rather than failing the copy.
      fs.existsSync(from),
    ),
  );
}

for (let attempt = 1; ; attempt++) {
  // Writable copies, because linuxdeploy sets an rpath on every ELF it finds
  // in the AppDir and a file copied straight out of the store is read-only.
  const staged = path.join(work, 'lib', 'host');
  fs.rmSync(staged, { recursive: true, force: true });
  fs.mkdirSync(staged, { recursive: true });
  const files = {};
  for (const [soname, from] of Object.entries(host)) {
    copyWritable(from, path.join(staged, soname));
    files[`/usr/lib/${soname}`] = path.join(staged, soname);
  }
  fs.writeFileSync(config, JSON.stringify({ bundle: { linux: { appimage: { files } } } }, null, 2));

  const count = Object.keys(host).length;
  say(`bundling with ${closure.length} closure library paths and ${count} host libraries`);
  const built = spawnSync('cargo', ['tauri', 'build', '--bundles', 'appimage', '--config', config], {
    stdio: 'inherit',
    env,
  });
  if (built.error) die(`cargo could not be run: ${built.error.message}`);
  if (built.status !== 0) die(`cargo tauri build exited ${built.status}`);

  const inside = elves(appDir);
  const missing = unresolved(inside);
  if (!missing.length) break;
  if (attempt > 1) {
    die(`still unresolved after bundling them: ${missing.join(', ')}`);
  }
  const located = locate(inside, missing);
  const lost = missing.filter((soname) => !located[soname]);
  if (lost.length) die(`nothing in the closure provides ${lost.join(', ')}`);
  host = { ...host, ...located };
  fs.writeFileSync(remembered, JSON.stringify(host, null, 2));
  say(`${missing.length} libraries AppImage leaves to a host that has them, and nix does not — bundling them`);
}

/* ── §32.3's rule, because this bundler earns it twice over ───────────────── */

/**
 * Tauri prints "Finished 1 bundle at: …" whether or not appimagetool wrote
 * one: the AppImage plugin swallows its own failure and exits zero, so the
 * only honest check is the file. The magic is AppImage type 2's — `AI\x02` at
 * offset 8, the bytes Tauri blanks in *linuxdeploy* so desktop integration
 * leaves the tool alone, and which the artifact itself must still carry.
 */
const out = path.join(target, 'bundle', 'appimage');
const bundles = fs.existsSync(out) ? fs.readdirSync(out).filter((f) => f.endsWith('.AppImage')) : [];
if (bundles.length !== 1) {
  die(`expected one .AppImage in ${out}, found ${bundles.length} — appimagetool fails quietly and Tauri reports success anyway`);
}
const artifact = path.join(out, bundles[0]);
const header = Buffer.alloc(11);
const fd = fs.openSync(artifact, 'r');
fs.readSync(fd, header, 0, 11, 0);
fs.closeSync(fd);
if (header.subarray(8, 11).toString('hex') !== '414902') {
  die(`${bundles[0]} is not an AppImage — no type 2 magic at offset 8`);
}

say(`${bundles[0]} — ${Math.round(fs.statSync(artifact).size / 1e6)}MB, ${Object.keys(host).length} host libraries bundled`);
say('run it directly: no nix-shell, no LD_LIBRARY_PATH. It keeps the nix ELF');
say('interpreter, so it starts here only — a portable one comes from CI (§32.3).');
