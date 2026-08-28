#!/usr/bin/env node
/**
 * Give the shell the service's version, at build time (§28.1, §32.3).
 *
 * "Service version == app version — the sidecar updates with the app, so
 * 'what version are they running' has one answer" is a §28.1 promise that
 * three hand-maintained numbers cannot keep. `package.json` is the one the
 * release is cut from, so it wins, and the app's two copies are stamped from
 * it on the build machine — in the working tree only, never committed. The
 * checkout stays authored; the artifact stays honest.
 *
 * Edits are surgical rather than parse-and-reserialize: rewriting
 * `tauri.conf.json` through `JSON.parse` would reformat a file a human owns,
 * and a stamping script has no business touching anything but the number.
 *
 * CI tooling tier: node builtins only.
 *
 * Usage: node .github/stamp-version.mjs <semver>
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const die = (msg) => {
  process.stderr.write(`stamp-version: ${msg}\n`);
  process.exit(1);
};

const version = process.argv[2];
if (!version) die('usage: stamp-version.mjs <semver>');
// Tauri parses this as semver and the bundlers derive their own formats from
// it; anything it cannot parse fails deep inside a bundler with a worse
// message than this one.
//
// Prerelease and build spelled out separately, at most one of each, which is
// what semver actually says. The shorter `(?:[-+][0-9A-Za-z.-]+)*` accepted
// the same strings but let `-` start a group *and* sit inside one, so a
// version like `9.9.9+` followed by a run of `--` could be split between the
// groups in exponentially many ways and the match would hang looking for one
// that worked. A tag is not hostile input, but neither is it worth a regex
// that can be made to spin.
if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(version)) {
  die(`"${version}" is not a semver version`);
}

/**
 * Each target names the *first* match deliberately: `tauri.conf.json` has one
 * `version` key and it is the top-level one, and `Cargo.toml`'s only
 * line-initial `version =` is the `[package]` one — dependency versions live
 * inside inline tables and never start a line.
 */
const targets = [
  { file: 'app/src-tauri/tauri.conf.json', pattern: /("version"\s*:\s*")[^"]*(")/ },
  { file: 'app/src-tauri/Cargo.toml', pattern: /^(version\s*=\s*")[^"]*(")/m },
];

for (const { file, pattern } of targets) {
  const full = path.join(repo, file);
  if (!fs.existsSync(full)) die(`no ${file} to stamp — is this a Turminder checkout?`);
  const before = fs.readFileSync(full, 'utf8');
  if (!pattern.test(before)) die(`${file} has no version line where one was expected`);
  const after = before.replace(pattern, `$1${version}$2`);
  fs.writeFileSync(full, after);
  process.stdout.write(`stamped ${version} into ${file}\n`);
}
