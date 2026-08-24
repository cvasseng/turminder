#!/usr/bin/env node
/**
 * CHANGELOG.md → the body of one release's notes (§32.2).
 *
 * The changelog is already written for someone reading release notes rather
 * than someone reading history (`changelog-upkeep`), so a release has no
 * second place to say what changed — it has this file, and a pipeline that
 * transcribes it. Nothing here summarizes, reformats or embellishes: whatever
 * the section says is what the release says, which is the only way the two
 * stay true to each other.
 *
 * A missing or empty section is a **failure**, not an empty release body. The
 * one thing that reliably rots about release notes is shipping without them
 * once; refusing to build is what stops the first time. The nightly channel is
 * the one exception and passes `--allow-empty`: cutting a version leaves a
 * fresh empty `# Next` behind by procedure, so the morning after a release the
 * emptiness is correct rather than an omission.
 *
 * CI tooling tier: node builtins only, and deleting `.github/` takes it with
 * the workflows it serves.
 *
 * Usage: node .github/release-notes.mjs <version|Next> [--out FILE] [--allow-empty]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const die = (msg) => {
  process.stderr.write(`release-notes: ${msg}\n`);
  process.exit(1);
};

const args = process.argv.slice(2);
const outIndex = args.indexOf('--out');
const out = outIndex === -1 ? null : args[outIndex + 1];
const allowEmpty = args.includes('--allow-empty');
// The positional is whatever is left once the flags and `--out`'s own value
// are set aside; `outIndex + 1` only names a value when there was an `--out`.
const wanted = args.filter(
  (a, i) => !a.startsWith('--') && !(outIndex !== -1 && i === outIndex + 1),
)[0];
if (!wanted) die('usage: release-notes.mjs <version|Next> [--out FILE] [--allow-empty]');

/**
 * The changelog's headings are h1 and nothing else is (`# Next`,
 * `# 0.2.0 — 2026-09-01`). Every line in the file also carries one space of
 * indent, so the pattern tolerates leading whitespace and the reader dedents
 * below rather than assuming column zero.
 */
const HEADING = /^[ \t]*#[ \t]+(\S.*?)[ \t]*$/;

/** `v1.2.0`, `1.2.0`, `1.2.0 — 2026-09-01` and `Next` all compare equal to their own name. */
const key = (label) => label.trim().split(/\s+/)[0].replace(/^v/i, '').toLowerCase();

const source = path.join(repo, 'CHANGELOG.md');
if (!fs.existsSync(source)) die(`no CHANGELOG.md at ${source}`);
const lines = fs.readFileSync(source, 'utf8').split('\n');

const sections = [];
for (const [n, line] of lines.entries()) {
  const match = line.match(HEADING);
  if (match) sections.push({ label: match[1], from: n + 1 });
}
for (const [i, section] of sections.entries()) {
  section.to = i + 1 < sections.length ? sections[i + 1].from - 1 : lines.length;
}

const section = sections.find((s) => key(s.label) === key(wanted));
if (!section) {
  die(
    `CHANGELOG.md has no section for "${wanted}" — it has: ${sections.map((s) => s.label).join(', ')}`,
  );
}

const body = lines.slice(section.from, section.to);
// One space of indent runs through the whole file; strip whatever the section
// actually shares rather than assuming it, so a reflow never breaks this.
const indents = body.filter((l) => l.trim()).map((l) => l.match(/^[ \t]*/)[0].length);
const dedent = indents.length ? Math.min(...indents) : 0;
const text = body
  .map((l) => l.slice(dedent))
  .join('\n')
  .trim();

if (!text && !allowEmpty) {
  die(
    `CHANGELOG.md's "${section.label}" section is empty — a release with nothing to say about ` +
      `itself is a release that should not be built. Write the entries first.`,
  );
}

const notes =
  text ||
  `Nothing user-visible has been recorded under \`# Next\` since the last release — ` +
    `this build is what \`main\` looks like, no more.`;

if (out) fs.writeFileSync(out, `${notes}\n`);
else process.stdout.write(`${notes}\n`);
