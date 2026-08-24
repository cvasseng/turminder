import fs from 'node:fs';
import matter from 'gray-matter';
import YAML from 'yaml';
import {
  ProjectFrontmatterSchema,
  PROJECT_DESCRIPTION_MAX,
  PROJECT_SLUG_MAX,
  PROJECT_SLUG_RE,
} from '../core/config-schemas.js';
import { log } from '../core/logger.js';
import type { FileStore } from '../files/store.js';

const l = log('projects');

/** Where every island lives, relative to the file store (§31.2). */
export const PROJECTS_ROOT = 'projects';
const MANIFEST = 'project.md';

/**
 * Which island a store-relative path belongs to (§31.2), or null for general.
 * The path *is* the tag — one function, so the indexer that stamps a row and
 * the store that answers "what is this project" cannot disagree.
 */
export function projectOfPath(rel: string): string | null {
  const parts = rel.split('/');
  if (parts.length < 2 || parts[0] !== PROJECTS_ROOT) return null;
  const slug = parts[1]!;
  return PROJECT_SLUG_RE.test(slug) ? slug : null;
}

export interface ProjectRecord {
  name: string;
  description: string;
  /** The manifest body: the brief `project.load` returns verbatim (§31.4). */
  brief: string;
  /** Store-relative path of the manifest. */
  file: string;
  /** Store-relative subtree everything of this project's belongs under. */
  filesRoot: string;
}

export type CreateResult =
  | { project: ProjectRecord; committed: boolean }
  | { error: 'project_exists' | 'bad_args'; message: string };

/**
 * Projects on disk (§31.2): a files-store subtree with a manifest. There is no
 * table and no registry — a project *is* `projects/<name>/project.md`, so the
 * user can make one with an editor, the watcher picks up their edits, and git
 * carries the history like it does for every other artifact.
 *
 * The scoping this feeds is enforced elsewhere (§31.3, in the retrieval
 * layer); this class only knows what exists and what it says about itself.
 */
export class ProjectStore {
  constructor(private readonly files: FileStore) {}

  /** Every project, by slug. Unreadable manifests are skipped, never fatal. */
  list(): ProjectRecord[] {
    const root = this.files.resolve(PROJECTS_ROOT);
    if (!fs.existsSync(root)) return [];
    const out: ProjectRecord[] = [];
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const record = this.read(entry.name);
      if (record) out.push(record);
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }

  /** Name + description only — what the system prompt carries (H.1). */
  roster(): { name: string; description: string }[] {
    return this.list().map((p) => ({ name: p.name, description: p.description }));
  }

  get(name: string): ProjectRecord | null {
    if (!PROJECT_SLUG_RE.test(name)) return null;
    return this.read(name);
  }

  exists(name: string): boolean {
    return this.get(name) !== null;
  }

  create(input: { name: string; description: string; brief?: string }): CreateResult {
    const name = input.name.trim();
    const description = input.description.trim();
    if (!PROJECT_SLUG_RE.test(name) || name.length > PROJECT_SLUG_MAX) {
      return {
        error: 'bad_args',
        message: `"${name}" is not a valid project name: lowercase letters, digits and single hyphens, at most ${PROJECT_SLUG_MAX} characters (e.g. "acme-q4")`,
      };
    }
    if (!description || description.length > PROJECT_DESCRIPTION_MAX) {
      return {
        error: 'bad_args',
        message: `description is one line of at most ${PROJECT_DESCRIPTION_MAX} characters`,
      };
    }
    if (this.exists(name)) {
      return { error: 'project_exists', message: `a project named ${name} already exists` };
    }
    const file = this.manifestPath(name);
    const frontmatter = YAML.stringify({ name, description }).trimEnd();
    const brief = (input.brief ?? '').trim();
    const body = `---\n${frontmatter}\n---\n\n${brief || `${description}\n`}`;
    const written = this.files.write(file, body, `project: create ${name}`);
    l.info({ project: name }, 'project created');
    return {
      project: {
        name,
        description,
        brief: brief || description,
        file,
        filesRoot: `${PROJECTS_ROOT}/${name}/`,
      },
      committed: written.committed,
    };
  }

  private manifestPath(name: string): string {
    return `${PROJECTS_ROOT}/${name}/${MANIFEST}`;
  }

  private read(slug: string): ProjectRecord | null {
    const rel = this.manifestPath(slug);
    const abs = this.files.resolve(rel);
    if (!fs.existsSync(abs)) return null;
    try {
      const parsed = matter(fs.readFileSync(abs, 'utf8'));
      const frontmatter = ProjectFrontmatterSchema.parse(parsed.data);
      if (frontmatter.name !== slug) {
        // The directory is the identity — a manifest that disagrees would make
        // `projects/a/` scope as `b` in one corpus and `a` in another.
        l.warn(
          { dir: slug, name: frontmatter.name },
          'project manifest name does not match its directory; using the directory',
        );
      }
      return {
        name: slug,
        description: frontmatter.description,
        brief: parsed.content.trim() || frontmatter.description,
        file: rel,
        filesRoot: `${PROJECTS_ROOT}/${slug}/`,
      };
    } catch (e) {
      // A hand-edited manifest with broken frontmatter must not take the
      // roster (and with it every system prompt) down with it.
      l.warn({ file: rel, err: (e as Error).message }, 'skipping bad project manifest');
      return null;
    }
  }
}
