import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { loadMarkdownFile } from '../core/config.js';
import { SkillFrontmatterSchema } from '../core/config-schemas.js';
import type { DataHome } from '../core/datadir.js';
import { log } from '../core/logger.js';
import type { ToolDefinition } from './types.js';

const l = log('skills');

export interface Skill {
  name: string;
  description: string;
  body: string;
  file: string;
}

/**
 * Skills are the prompt-level layer over tools (§11.1): every skill's
 * description is in the system prompt, and the body is fetched only when the
 * agent decides one is relevant. Same resolution mechanics handlers use.
 */
export interface SkillLoadError {
  file: string;
  message: string;
}

export class SkillLoader {
  private cache: Skill[] | null = null;
  private loadErrors: SkillLoadError[] = [];

  constructor(private readonly home: DataHome) {}

  reload(): void {
    this.cache = null;
  }

  all(): Skill[] {
    if (this.cache) return this.cache;
    const dir = this.home.skillsDir;
    const skills: Skill[] = [];
    this.loadErrors = [];
    if (fs.existsSync(dir)) {
      for (const entry of fs.readdirSync(dir).sort()) {
        if (!entry.endsWith('.md')) continue;
        const abs = path.join(dir, entry);
        try {
          const doc = loadMarkdownFile(abs, `skills/${entry}`, SkillFrontmatterSchema);
          if (!doc) continue;
          const expected = entry.replace(/\.md$/, '');
          if (doc.frontmatter.name !== expected) {
            l.warn(
              { file: `skills/${entry}`, name: doc.frontmatter.name },
              'skill name does not match its filename; using the frontmatter name',
            );
          }
          skills.push({
            name: doc.frontmatter.name,
            description: doc.frontmatter.description,
            body: doc.body,
            file: `skills/${entry}`,
          });
        } catch (e) {
          // One malformed skill must not take the assistant down — but say
          // exactly what is wrong with it, or it will never get fixed.
          const detail = (e as { detail?: string }).detail;
          const message = detail ? `${(e as Error).message} (${detail})` : (e as Error).message;
          this.loadErrors.push({ file: `skills/${entry}`, message });
          l.warn({ file: `skills/${entry}`, err: message }, 'skipping bad skill');
        }
      }
    }
    this.cache = skills;
    return skills;
  }

  /** Skills that failed to load, for the CLI and for diagnosis. */
  errors(): SkillLoadError[] {
    this.all();
    return [...this.loadErrors];
  }

  /** Description-only roster for the system prompt (App. H.1 step 3). */
  roster(): { name: string; description: string }[] {
    return this.all().map((s) => ({ name: s.name, description: s.description }));
  }

  get(name: string): Skill | null {
    return this.all().find((s) => s.name === name) ?? null;
  }
}

/** `skills.fetch` — always granted, read-only (App. G.8). */
export function skillTools(loader: SkillLoader): ToolDefinition[] {
  return [
    {
      name: 'skills.fetch',
      description:
        'Fetch the full text of a skill by name. Do this when a skill listed in your system prompt looks relevant to the task.',
      tier: 'ro',
      args: z.object({ name: z.string().min(1) }),
      async execute(args: { name: string }) {
        loader.reload();
        const skill = loader.get(args.name);
        if (!skill) {
          return {
            error: 'not_found',
            available: loader.roster().map((s) => s.name),
          };
        }
        return { name: skill.name, description: skill.description, content: skill.body };
      },
    },
  ];
}
