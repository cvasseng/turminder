import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The desktop shell's filesystem isolation (§28.3), from the service's side.
 *
 * The exit criterion is literally `rm -rf app/` leaving lint, typecheck and
 * tests green — so what this file guards is the *shape* of the boundary: the
 * app's whole footprint is its own directory plus two script aliases, and
 * nothing in `src/` knows it exists. A Rust toolchain must never become
 * something the service needs to build.
 */
const root = path.resolve(import.meta.dirname, '..');
const read = (rel: string): string => fs.readFileSync(path.join(root, rel), 'utf8');
/**
 * The criterion cuts both ways: a checkout with `app/` deleted must stay
 * green, so the cases that read the app's own files skip rather than fail.
 * The cases that guard the *service* side run either way — those are the ones
 * that catch the boundary being crossed.
 */
const hasApp = fs.existsSync(path.join(root, 'app'));

describe('the app is a packaging tier (§28.3)', () => {
  it('is not imported by, or mentioned in, any service source file', () => {
    const walk = (dir: string): string[] =>
      fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) return walk(full);
        return entry.isFile() && /\.(ts|js)$/.test(entry.name) ? [full] : [];
      });
    const offenders = [...walk(path.join(root, 'src')), ...walk(path.join(root, 'daemon'))]
      .filter((file) => /from '.*app\/|require\('.*app\//.test(fs.readFileSync(file, 'utf8')))
      .map((file) => file.slice(root.length + 1));
    expect(offenders, 'nothing in src/ may import from app/ (§28.3)').toEqual([]);
  });

  it('adds exactly two script aliases to the root package.json, and no dependency', () => {
    const pkg = JSON.parse(read('package.json')) as {
      scripts: Record<string, string>;
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const appScripts = Object.keys(pkg.scripts).filter((s) => s.startsWith('app:'));
    expect(appScripts.sort()).toEqual(['app:build', 'app:dev']);
    // The Rust/Tauri toolchain lives in app/shell.nix; a `@tauri-apps/*` in the
    // service's dependencies would make the app something everyone installs.
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };
    expect(Object.keys(deps).filter((d) => d.includes('tauri'))).toEqual([]);
  });

  it('keeps the service toolchain out of app/', () => {
    // tsc, eslint and prettier all stop at the boundary — otherwise deleting
    // the directory would change their results, which is the same bug as
    // needing it.
    expect(JSON.parse(read('tsconfig.json')).include).toEqual([
      'src/**/*.ts',
      'daemon/**/*.ts',
      'test/**/*.ts',
    ]);
    expect(read('eslint.config.js')).toContain("'app/**'");
    expect(read('.prettierignore')).toContain('app/');
    // And the compiled Rust never reaches git — while the connect screen,
    // which lives at app/dist/ and is source rather than build output, does.
    const gitignore = read('.gitignore');
    expect(gitignore).toContain('app/src-tauri/target/');
    expect(gitignore).toContain('!app/dist/');
  });

  it.skipIf(!hasApp)(
    'declares its own toolchain, so a machine without nix still builds the service',
    () => {
      const shell = read('app/shell.nix');
      for (const dep of ['cargo', 'cargo-tauri', 'webkitgtk_4_1', 'dbus']) {
        expect(shell, `app/shell.nix should name ${dep}`).toContain(dep);
      }
      // The bundle targets name every platform the shell is meant to reach;
      // Tauri builds only the ones the host can make, so a Linux run still
      // produces just the `deb` (driven 2026-08-24). AppImage stays off the
      // list on purpose — its bundler chokes on nix store paths (LIMITS.md).
      const conf = JSON.parse(read('app/src-tauri/tauri.conf.json')) as {
        bundle: { targets: string[] };
      };
      expect(conf.bundle.targets).toContain('deb');
      expect(conf.bundle.targets).not.toContain('appimage');
      // And the pinned runtime table has to carry a row for anything the
      // targets promise, or the staging script cannot assemble that bundle.
      const runtimes = JSON.parse(read('app/node-runtime.json')) as {
        targets: Record<string, { archive: string; sha256: string; binary: string }>;
      };
      for (const target of ['linux-x64', 'darwin-arm64', 'darwin-x64', 'win32-x64']) {
        const row = runtimes.targets[target];
        expect(row, `node-runtime.json needs a ${target} row`).toBeTruthy();
        // A checksum pinned in the repo, not fetched from the same host as the
        // download — a pin that trusts its own source is not a pin.
        expect(row!.sha256).toMatch(/^[0-9a-f]{64}$/);
      }
    },
  );
});
