#!/usr/bin/env node
/**
 * Tauri's bundle tree → the names a release actually publishes (§32.3).
 *
 * The bundler names files after the product and the bundler's own idea of an
 * architecture — `Turminder_1.0.0_amd64.deb`, `Turminder_1.0.0_aarch64.dmg`,
 * `Turminder_1.0.0_x64-setup.exe` — three vocabularies for four artifacts that
 * sit in one release list. This renames them into the one vocabulary the repo
 * already uses for a target: the keys of `app/node-runtime.json`, mapped to
 * the words a person downloading recognizes.
 *
 * **An empty collection is a failure.** A bundler that produced nothing still
 * exits zero often enough that "the release had no .deb in it" is a real way
 * to ship nothing at all; this is the step that notices.
 *
 * CI tooling tier: node builtins only.
 *
 * Usage: node .github/collect-bundles.mjs --target <t> --version <v> --out <dir>
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const die = (msg) => {
  process.stderr.write(`collect-bundles: ${msg}\n`);
  process.exit(1);
};

const arg = (name) => {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? null : process.argv[i + 1];
};

const target = arg('target');
const version = arg('version');
const out = arg('out');
if (!target || !version || !out) {
  die('usage: collect-bundles.mjs --target <t> --version <v> --out <dir>');
}

/**
 * The repo's target keys on the left, what a download list calls them on the
 * right. `win32`/`darwin` are Node's words for a platform and belong in
 * `node-runtime.json`; nobody downloads a "win32" installer.
 */
const LABELS = {
  'linux-x64': 'linux-x64',
  'linux-arm64': 'linux-arm64',
  'darwin-arm64': 'macos-arm64',
  'darwin-x64': 'macos-x64',
  'win32-x64': 'windows-x64',
};
if (!LABELS[target]) die(`unknown target ${target} — known: ${Object.keys(LABELS).join(', ')}`);
const label = LABELS[target];

/**
 * What counts as a shippable artifact, and the tail its canonical name gets —
 * keyed by the target's OS rather than collected from the whole tree, so a
 * `target/` carrying anything but this run's output cannot contribute to this
 * run's release. `.app` is deliberately absent everywhere: it is a directory,
 * and the `.dmg` beside it is the same bundle in the form a Mac user is handed
 * one.
 */
const SHIPPABLE = {
  linux: { '.deb': '.deb', '.rpm': '.rpm', '.appimage': '.AppImage' },
  darwin: { '.dmg': '.dmg' },
  win32: { '.msi': '.msi', '.exe': '-setup.exe' },
};
const shippable = SHIPPABLE[target.split('-')[0]];

const bundles = path.join(repo, 'app', 'src-tauri', 'target', 'release', 'bundle');
if (!fs.existsSync(bundles)) die(`no bundle tree at ${bundles} — did 'tauri build' run?`);

fs.mkdirSync(out, { recursive: true });

const collected = [];
const taken = new Map();
for (const entry of fs.readdirSync(bundles, { recursive: true, withFileTypes: true })) {
  if (!entry.isFile()) continue;
  // The dmg bundler builds through a read-write scratch image beside the real
  // one; a run that dies mid-way leaves it there, and it is not an artifact.
  if (entry.name.startsWith('rw.')) continue;
  const suffix = shippable[path.extname(entry.name).toLowerCase()];
  if (!suffix) continue;
  const from = path.join(entry.parentPath ?? entry.path, entry.name);
  const name = `turminder-${version}-${label}${suffix}`;
  // Two candidates for one published name means the tree holds something this
  // run did not build; picking one silently is how the wrong bytes ship.
  if (taken.has(name))
    die(`both ${taken.get(name)} and ${from} want to be published as ${name}`);
  taken.set(name, from);
  const to = path.join(out, name);
  fs.copyFileSync(from, to);
  collected.push({ to, bytes: fs.statSync(to).size });
}

if (!collected.length) {
  die(
    `'tauri build' left no shippable artifact under ${bundles} — a release that quietly ` +
      `contains nothing for ${label} is worse than a failed build.`,
  );
}

for (const { to, bytes } of collected) {
  process.stdout.write(`${path.basename(to)}  (${Math.round(bytes / 1e6)}MB)\n`);
}
