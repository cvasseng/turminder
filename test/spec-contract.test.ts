import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MIGRATIONS } from '../src/db/migrations/index.js';
import { BASE_PROMPTS } from '../src/prompts/base.js';
import { SHIPPED_ASSETS } from '../src/prompts/shipped.js';

/**
 * The spec is binding (spec.md, opening note) — these tests are the teeth.
 * They fail when code and spec drift in the ways that have actually happened:
 * a dependency nobody put through App. J, or a migration added outside the
 * numbered path. Module boundaries (App. I) are enforced by eslint, not here.
 */

const root = join(import.meta.dirname, '..');
const spec = readFileSync(join(root, 'spec.md'), 'utf8');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
};

/**
 * §27's one-door rule, mechanized. The store is only a guarantee if nothing
 * else writes inside `secrets/`: one un-vaulted file and the `os` backend's
 * promise is theatre. eslint enforces the App. I boundaries; this is the same
 * idea for a directory rather than a module.
 */
describe('§27 — only the secret store touches secrets/', () => {
  const sourceFiles = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) return sourceFiles(full);
      return entry.isFile() && entry.name.endsWith('.ts') ? [full] : [];
    });

  /**
   * Reaching into `secrets/`: building a path into it, or an fs call that
   * names it. Prose about secrets is fine — the rule is about access, so
   * comments come out before matching and a hint string that merely mentions
   * the directory is not a violation.
   */
  const FS_CALL = /\bfs\.\w+|readFileSync|writeFileSync|rmSync|mkdirSync|chmodSync/;
  const SECRET_PATH = /path\(\s*['"]secrets['"]|secretsDir/;

  const reachesIntoSecrets = (source: string): boolean => {
    const code = source
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n')
      .filter((line) => !line.trim().startsWith('//'))
      .join('\n');
    if (SECRET_PATH.test(code)) return true;
    return code.split('\n').some((line) => FS_CALL.test(line) && /secrets/.test(line));
  };

  it('no module outside core/secret-store reaches into secrets/', () => {
    const allowed = [
      join(root, 'src', 'core', 'secret-store'),
      // The scaffold creates the directory and chmods it; it writes no secret.
      join(root, 'src', 'core', 'datadir.ts'),
      // The composition point: it hands the store its directory and nothing else.
      join(root, 'src', 'core', 'config.ts'),
    ];
    const offenders = sourceFiles(join(root, 'src'))
      .filter((file) => !allowed.some((ok) => file.startsWith(ok)))
      .filter((file) => reachesIntoSecrets(readFileSync(file, 'utf8')));
    expect(
      offenders.map((f) => f.slice(root.length + 1)),
      'secrets/ is written through core/secret-store and nowhere else (§27)',
    ).toEqual([]);
  });

  it('catches a deliberate violation, so the guard has teeth', () => {
    // The probe the rule exists to fail on, checked against the rule itself
    // rather than against a file nobody would write twice.
    expect(reachesIntoSecrets(`fs.writeFileSync(home.path('secrets', 'x.json'), token);`)).toBe(
      true,
    );
    expect(reachesIntoSecrets(`const dir = home.secretsDir;`)).toBe(true);
    // Prose and hints are not access.
    expect(reachesIntoSecrets(`// tokens used to live in secrets/google-token.json`)).toBe(
      false,
    );
    expect(reachesIntoSecrets(`throw new Error('put ASANA_PAT in the secret store');`)).toBe(
      false,
    );
    expect(reachesIntoSecrets(`fs.writeFileSync(home.path('files', 'ok.md'), text);`)).toBe(
      false,
    );
  });
});

describe('App. J — dependency whitelist', () => {
  // Everything backticked in Appendix J counts as named by the spec.
  const appendixJ = spec.slice(spec.indexOf('## Appendix J'));
  const named = new Set([...appendixJ.matchAll(/`([^`]+)`/g)].map((m) => m[1]));

  // Dev-only build/lint tooling, exempted by App. J's own text.
  const tooling = new Set([
    'typescript',
    'tsx',
    'eslint',
    'typescript-eslint',
    '@eslint/js',
    'prettier',
    'vitest',
  ]);

  const covered = (name: string): boolean =>
    named.has(name) || tooling.has(name) || name.startsWith('@types/');

  it('every runtime dependency is named in Appendix J', () => {
    const missing = Object.keys(pkg.dependencies ?? {}).filter((d) => !covered(d));
    expect(
      missing,
      `not in spec App. J: ${missing.join(', ')} — adding a dependency is a spec change; ` +
        `either remove it or add it to the Appendix J table in the same commit`,
    ).toEqual([]);
  });

  it('every dev dependency is named in Appendix J or is exempt tooling', () => {
    const missing = Object.keys(pkg.devDependencies ?? {}).filter((d) => !covered(d));
    expect(missing, `not in spec App. J: ${missing.join(', ')}`).toEqual([]);
  });
});

describe('prompt library — one file per prompt, no literals', () => {
  // Loading itself enforces most of the contract (frontmatter validation and
  // fragment substitution throw), so these imports succeeding is the bulk of
  // the test. What remains is drift the loaders cannot see.

  it('every agent kind has a base prompt and nothing unsubstituted ships', () => {
    expect(Object.keys(BASE_PROMPTS).sort()).toEqual([
      'chat',
      'distill',
      'handler',
      'ingress',
      'maintenance',
      'onboarding',
    ]);
    for (const [kind, prompt] of Object.entries(BASE_PROMPTS)) {
      // Fragment-shaped placeholders only: `{{embed:01J…}}` appears in prose
      // as the literal marker syntax and is not a fragment reference.
      expect(prompt, `unresolved placeholder in base/${kind}.md`).not.toMatch(/\{\{\w+\}\}/);
      expect(prompt.length, `base/${kind}.md suspiciously short`).toBeGreaterThan(100);
    }
  });

  it('shipped assets come from the library and target only skills/ and handlers/', () => {
    expect(SHIPPED_ASSETS.length).toBeGreaterThanOrEqual(8);
    for (const asset of SHIPPED_ASSETS) {
      expect(asset.path).toMatch(/^(skills|handlers)\/[a-z0-9-]+\.md$/);
    }
  });

  it('no prompt-sized string literals creep back into prompts/*.ts', () => {
    const dir = join(root, 'src', 'prompts');
    for (const file of readdirSync(dir).filter((f) => f.endsWith('.ts'))) {
      const source = readFileSync(join(dir, file), 'utf8');
      // Generous ceiling: shared rule fragments are fine, whole documents are
      // not. A legitimate need for more prose means a new library file.
      const literals = [...source.matchAll(/`[^`]*`/gs)].map((m) => m[0]);
      const oversized = literals.filter((l) => l.length > 2000);
      expect(oversized, `${file} embeds a document-sized template literal`).toEqual([]);
    }
  });
});

describe('migrations — the numbered path is the only path', () => {
  const dir = join(root, 'src', 'db', 'migrations');
  const files = readdirSync(dir)
    .filter((f) => /^\d{3}-.+\.ts$/.test(f))
    .sort();

  it('migration versions are unique and sequential from 1', () => {
    const versions = MIGRATIONS.map((m) => m.version).sort((a, b) => a - b);
    expect(versions).toEqual(versions.map((_, i) => i + 1));
  });

  it('every migration file on disk is registered, in filename order', () => {
    expect(MIGRATIONS.length, `files on disk: ${files.join(', ')}`).toBe(files.length);
    for (const [i, file] of files.entries()) {
      const fromName = Number(file.slice(0, 3));
      expect(MIGRATIONS[i]!.version, `${file} vs registration order`).toBe(fromName);
    }
  });

  it('filename numbers match the version each migration declares', () => {
    for (const file of files) {
      const source = readFileSync(join(dir, file), 'utf8');
      const declared = source.match(/version:\s*(\d+)/)?.[1];
      expect(Number(declared), `${file} declares version ${declared}`).toBe(
        Number(file.slice(0, 3)),
      );
    }
  });
});
