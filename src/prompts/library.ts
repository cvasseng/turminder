import fs from 'node:fs';
import path from 'node:path';

/**
 * The prompt library: one markdown file per prompt, under
 * `src/prompts/library/<category>/<name>.md` — never string literals in a
 * module. Prose gets markdown tooling, diffs read as prose, and a directory
 * is its own manifest: a file that exists is shipped, a file that doesn't
 * isn't, and there is no registry to forget to update.
 *
 * The build must copy `library/` next to the compiled module (see the
 * `build` script); under tsx it is simply read in place. A missing directory
 * is a broken build, not a degradable condition — fail loudly and say why.
 */
const LIBRARY_DIR = path.join(import.meta.dirname, 'library');

export function libraryDir(category: string): string {
  const dir = path.join(LIBRARY_DIR, category);
  if (!fs.existsSync(dir)) {
    throw new Error(
      `prompt library missing: ${dir} — if this is a built distribution, ` +
        `the build did not copy src/prompts/library/ (see the "build" script)`,
    );
  }
  return dir;
}

export interface LibraryFile {
  /** Filename without `.md`. */
  name: string;
  content: string;
}

/** Every `.md` file in one category, sorted by name for determinism. */
export function readLibrary(category: string): LibraryFile[] {
  const dir = libraryDir(category);
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.md'))
    .sort()
    .map((f) => ({
      name: f.slice(0, -3),
      content: fs.readFileSync(path.join(dir, f), 'utf8'),
    }));
}

/**
 * Strict `{{fragment}}` substitution for base-prompt templates. Unknown
 * placeholders throw: a typo'd fragment name must fail at startup, not ship
 * a literal `{{common_rules}}` to the model.
 */
export function substitute(template: string, fragments: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, name: string) => {
    const value = fragments[name];
    if (value === undefined) throw new Error(`unknown prompt fragment {{${name}}}`);
    return value;
  });
}
