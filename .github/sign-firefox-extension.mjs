#!/usr/bin/env node
/**
 * Get the Firefox extension signed by Mozilla for **self-distribution** (§29.6).
 *
 * A Chromium user can install an unpacked directory; a Firefox user cannot
 * install anything Mozilla has not signed — an unsigned XPI is refused by
 * release Firefox outright, and `about:debugging` only ever loads a *temporary*
 * add-on that is gone at the next restart. So "download the zip and install it"
 * is a Chrome-only sentence today, and this is what makes it true for Firefox
 * without listing on addons.mozilla.org: the **unlisted** channel, where AMO
 * reviews automatically, signs, and hands the file back for us to host.
 *
 * Signing is driven by credentials, exactly like macOS (§32.4): with
 * `AMO_JWT_ISSUER` and `AMO_JWT_SECRET` present this produces a signed `.xpi`
 * beside the zips; without them it says so and exits 0, because a repository
 * with no Mozilla account must still be able to build a release.
 *
 * **A version is signed once.** AMO refuses a version string it has already
 * seen, and it is right to: the signature is over those bytes. The extension
 * carries its own manifest version (§32.3) and most releases do not change it,
 * so this looks for an already-signed build of that exact version first and
 * downloads it if there is one. That is what makes the nightly channel work at
 * all — night two would otherwise fail on a version night one had signed.
 *
 * CI tooling tier: node builtins only (App. J), no service imports.
 *
 * Usage: node .github/sign-firefox-extension.mjs --zip <path> --out <dir>
 */
import { createHmac, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const API = 'https://addons.mozilla.org/api/v5';

const say = (msg) => process.stdout.write(`\x1b[36m==\x1b[0m ${msg}\n`);
const die = (msg) => {
  process.stderr.write(`\x1b[31m==\x1b[0m sign-firefox-extension: ${msg}\n`);
  process.exit(1);
};

const arg = (name) => {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? null : process.argv[i + 1];
};

const zipPath = arg('zip');
const out = arg('out');
if (!zipPath || !out) die('usage: sign-firefox-extension.mjs --zip <path> --out <dir>');

const issuer = process.env.AMO_JWT_ISSUER ?? '';
const secret = process.env.AMO_JWT_SECRET ?? '';
if (!issuer || !secret) {
  say('no AMO credentials configured — the Firefox zip ships unsigned and says so (§32.4)');
  process.exit(0);
}

/* ── the add-on this is, according to the manifest that shipped ───────────── */

const manifest = JSON.parse(
  fs.readFileSync(path.join(repo, 'extension', 'manifest.firefox.json'), 'utf8'),
);
const guid = manifest.browser_specific_settings?.gecko?.id;
const version = manifest.version;
if (!guid)
  die('manifest.firefox.json has no browser_specific_settings.gecko.id to sign against');
if (!fs.existsSync(zipPath)) die(`no such zip: ${zipPath}`);

/* ── auth: a JWT per request, because they expire in minutes ──────────────── */

const b64url = (buf) => Buffer.from(buf).toString('base64url');

/**
 * AMO wants HS256 with `iss`/`jti`/`iat`/`exp`, and refuses a token whose life
 * is longer than five minutes. Minted per call rather than once: a signing run
 * waits on a review queue, and a token that was valid when the run started is
 * not necessarily valid when it finishes.
 */
function token() {
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payload = b64url(
    JSON.stringify({ iss: issuer, jti: randomUUID(), iat: now, exp: now + 60 }),
  );
  const signature = createHmac('sha256', secret)
    .update(`${header}.${payload}`)
    .digest('base64url');
  return `${header}.${payload}.${signature}`;
}

async function amo(pathname, init = {}) {
  const res = await fetch(pathname.startsWith('http') ? pathname : `${API}${pathname}`, {
    ...init,
    headers: { authorization: `JWT ${token()}`, ...(init.headers ?? {}) },
  });
  return res;
}

/** The body of a failed call, trimmed — AMO explains itself in JSON. */
async function why(res) {
  const text = await res.text().catch(() => '');
  return `HTTP ${res.status} ${text.slice(0, 400)}`;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ── has this exact version already been signed? ──────────────────────────── */

/**
 * `filter=all_with_unlisted`, because the default listing hides exactly the
 * channel this script uses and an unlisted version would otherwise look absent.
 * A 404 here means the add-on has never been submitted, which is the first-run
 * case and not an error.
 */
async function existingVersion() {
  const res = await amo(
    `/addons/addon/${encodeURIComponent(guid)}/versions/?filter=all_with_unlisted`,
  );
  if (res.status === 404) return null;
  if (!res.ok) die(`could not list versions: ${await why(res)}`);
  const body = await res.json();
  return (body.results ?? []).find((v) => v.version === version) ?? null;
}

/** The signed file on a version, once AMO has actually signed it. */
const signedFile = (v) => {
  const file = v?.file ?? (Array.isArray(v?.files) ? v.files[0] : null);
  return file?.url && file?.status !== 'disabled' ? file : null;
};

async function download(url, to) {
  const res = await amo(url);
  if (!res.ok) die(`could not download the signed xpi: ${await why(res)}`);
  fs.writeFileSync(to, Buffer.from(await res.arrayBuffer()));
}

/* ── upload → validate → create the version → wait for the signature ──────── */

async function upload() {
  const form = new FormData();
  form.append('upload', new Blob([fs.readFileSync(zipPath)]), path.basename(zipPath));
  form.append('channel', 'unlisted');
  const res = await amo('/addons/upload/', { method: 'POST', body: form });
  if (!res.ok) die(`upload refused: ${await why(res)}`);
  const { uuid } = await res.json();
  say(`uploaded ${path.basename(zipPath)} — validating`);

  // Validation is a queue, not a call. Ten minutes is generous for an
  // extension this size and still bounded, so a stuck queue fails the build
  // rather than holding a runner until the job timeout.
  const deadline = Date.now() + 600_000;
  while (Date.now() < deadline) {
    await sleep(5_000);
    const poll = await amo(`/addons/upload/${uuid}/`);
    if (!poll.ok) die(`could not read the upload: ${await why(poll)}`);
    const state = await poll.json();
    if (!state.processed) continue;
    if (!state.valid) {
      const messages = (state.validation?.messages ?? [])
        .filter((m) => m.type === 'error')
        .map((m) => `  - ${m.message}`)
        .join('\n');
      die(
        `Mozilla's validator rejected the extension:\n${messages || JSON.stringify(state.validation ?? {}).slice(0, 600)}`,
      );
    }
    return uuid;
  }
  die('the upload never finished validating');
}

async function createVersion(uuid) {
  const body = JSON.stringify({ upload: uuid });
  const headers = { 'content-type': 'application/json' };
  let res = await amo(`/addons/addon/${encodeURIComponent(guid)}/versions/`, {
    method: 'POST',
    body,
    headers,
  });
  // First submission ever: the add-on does not exist yet, so it is created
  // with this version rather than having one added to it. `/addons/addon/`,
  // not `/addons/` — the collection every add-on endpoint hangs off carries
  // the `addon` segment, and the bare path is a 404 that says only
  // `{"detail": "Not found."}`, which reads exactly like the add-on being
  // missing rather than the route being wrong.
  if (res.status === 404) {
    say(`${guid} is new to AMO — creating it`);
    res = await amo('/addons/addon/', {
      method: 'POST',
      body: JSON.stringify({ version: { upload: uuid } }),
      headers,
    });
  }
  if (!res.ok) die(`could not create version ${version}: ${await why(res)}`);
  return await res.json();
}

/**
 * Automatic review is usually a minute or two, and is allowed to be slower.
 * The wait is bounded for the same reason the validation wait is.
 */
async function waitForSignature() {
  const deadline = Date.now() + 900_000;
  while (Date.now() < deadline) {
    await sleep(10_000);
    const existing = await existingVersion();
    const file = signedFile(existing);
    if (file) return file;
  }
  die(`version ${version} was accepted but never came back signed`);
}

/* ── what actually runs ───────────────────────────────────────────────────── */

fs.mkdirSync(out, { recursive: true });
const xpi = path.join(out, `turminder-capture-${version}-firefox.xpi`);

say(`signing ${guid} ${version} on the unlisted channel`);
const already = signedFile(await existingVersion());
if (already) {
  // Not a fallback — the ordinary case. Most releases do not touch the
  // extension, and its version is the thing AMO signs.
  say(`version ${version} is already signed; taking that build rather than making a new one`);
  await download(already.url, xpi);
} else {
  await createVersion(await upload());
  say('accepted — waiting for automatic review to sign it');
  await download((await waitForSignature()).url, xpi);
}

const bytes = fs.statSync(xpi).size;
if (bytes < 1024) die(`the downloaded xpi is ${bytes} bytes, which is not a signed extension`);
say(`signed: ${path.basename(xpi)} (${Math.round(bytes / 1024)}KB)`);
