import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LAYOUT_VERSION } from '../src/core/datadir.js';
import { DB_VERSION } from '../src/db/index.js';
import { runCli as turminder, tmpDir } from './helpers.js';

describe('turminder CLI (phase 0 exit criteria)', () => {
  let t: { dir: string; cleanup: () => void };
  beforeEach(() => {
    t = tmpDir('turminder-cli-');
  });
  afterEach(() => t.cleanup());

  it('creates a valid data home, then starts again idempotently', async () => {
    const root = path.join(t.dir, 'home');
    const first = await turminder(['--data-dir', root, 'doctor']);
    expect(first.code).toBe(0);
    // The report is pretty-printed JSON followed by the token line; the closing
    // brace at column 0 is the end of it (nested objects have indented ones).
    const report = JSON.parse(first.stdout.slice(0, first.stdout.indexOf('\n}\n') + 3));
    expect(report.layout_version).toBe(LAYOUT_VERSION);
    expect(report.db_version).toBe(DB_VERSION);
    expect(report.models_configured).toBe(false);
    expect(report.git_head).toBeTruthy();
    expect(first.stdout).toMatch(/ui device token/);

    const second = await turminder(['--data-dir', root, 'doctor']);
    expect(second.code).toBe(0);
    expect(second.stdout).not.toMatch(/ui device token/);
  });

  it('exits non-zero on a MANIFEST from the future', async () => {
    const root = path.join(t.dir, 'home');
    expect((await turminder(['--data-dir', root, 'doctor'])).code).toBe(0);
    fs.writeFileSync(
      path.join(root, 'MANIFEST'),
      'layout_version: 99\ncreated_at: 2026-01-01T00:00:00.000Z\n',
    );
    const r = await turminder(['--data-dir', root, 'doctor']);
    expect(r.code).toBe(1);
    expect(r.stdout + r.stderr).toMatch(/layout_from_the_future/);
  });

  it('manages device tokens', async () => {
    const root = path.join(t.dir, 'home');
    await turminder(['--data-dir', root, 'doctor']);
    const created = await turminder(['--data-dir', root, 'token', 'create', 'laptop']);
    expect(created.code).toBe(0);
    expect(created.stdout.trim()).toMatch(/^[0-9a-f]{64}$/);
    expect((await turminder(['--data-dir', root, 'token', 'list'])).stdout).toMatch(/laptop/);
    expect((await turminder(['--data-dir', root, 'token', 'revoke', 'laptop'])).code).toBe(0);
    expect((await turminder(['--data-dir', root, 'token', 'list'])).stdout).not.toMatch(
      /laptop/,
    );
    expect((await turminder(['--data-dir', root, 'token', 'revoke', 'ghost'])).code).toBe(1);
  });
});
