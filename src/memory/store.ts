import fs from 'node:fs';
import YAML from 'yaml';
import { loadMarkdownFile } from '../core/config.js';
import { MemoryFrontmatterSchema, type MemoryType } from '../core/config-schemas.js';
import type { DataHome } from '../core/datadir.js';
import { log } from '../core/logger.js';
import { nowIso } from '../core/time.js';

const l = log('memory');

export interface MemoryRecord {
  name: string;
  description: string;
  type: MemoryType;
  created: string;
  updated: string;
  content: string;
  /** The project island this memory belongs to (§31.2); null is general. */
  project: string | null;
  /** data-dir-relative path. */
  file: string;
}

export function slugify(text: string, max = 60): string {
  const base = text
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, max)
    .replace(/-+$/g, '');
  return base || 'memory';
}

/**
 * The markdown memory store (§8.1). Human-editable by design: one fact per
 * file, frontmatter plus prose, and every mutation is a git commit (§8.2).
 */
export class MemoryStore {
  constructor(private readonly home: DataHome) {}

  private absPath(fileName: string): string {
    return this.home.path('memory', fileName);
  }

  fileNameFor(name: string): string {
    return `${slugify(name)}.md`;
  }

  list(): MemoryRecord[] {
    const dir = this.home.memoryDir;
    if (!fs.existsSync(dir)) return [];
    const out: MemoryRecord[] = [];
    for (const entry of fs.readdirSync(dir).sort()) {
      if (!entry.endsWith('.md')) continue;
      const record = this.read(entry);
      if (record) out.push(record);
    }
    return out;
  }

  private read(fileName: string): MemoryRecord | null {
    try {
      const doc = loadMarkdownFile(
        this.absPath(fileName),
        `memory/${fileName}`,
        MemoryFrontmatterSchema,
      );
      if (!doc) return null;
      return {
        name: doc.frontmatter.name,
        description: doc.frontmatter.description,
        type: doc.frontmatter.type,
        created: doc.frontmatter.created,
        updated: doc.frontmatter.updated,
        content: doc.body,
        project: doc.frontmatter.project ?? null,
        file: `memory/${fileName}`,
      };
    } catch (e) {
      // A hand-edited memory with broken frontmatter must not break retrieval.
      l.warn(
        { file: `memory/${fileName}`, err: (e as Error).message },
        'skipping bad memory file',
      );
      return null;
    }
  }

  get(name: string): MemoryRecord | null {
    const direct = this.read(this.fileNameFor(name));
    if (direct) return direct;
    return this.list().find((m) => m.name === name) ?? null;
  }

  private write(record: MemoryRecord): void {
    const frontmatter = YAML.stringify({
      name: record.name,
      description: record.description,
      type: record.type,
      created: record.created,
      updated: record.updated,
      // Only when scoped: a general memory's file looks exactly as it did
      // before projects existed, which is what most memories are (§31.2).
      ...(record.project ? { project: record.project } : {}),
    }).trimEnd();
    const body = `---\n${frontmatter}\n---\n\n${record.content.trim()}\n`;
    fs.mkdirSync(this.home.memoryDir, { recursive: true });
    fs.writeFileSync(this.home.path(record.file), body, 'utf8');
  }

  /** Creates a new memory file, avoiding filename collisions. */
  create(input: {
    name?: string;
    description: string;
    type: MemoryType;
    content: string;
    /** The island this belongs to (§31.5); absent or null = general. */
    project?: string | null;
  }): MemoryRecord {
    const desired = input.name?.trim() || input.description;
    let name = desired;
    let fileName = this.fileNameFor(name);
    let n = 2;
    while (fs.existsSync(this.absPath(fileName))) {
      name = `${desired} ${n}`;
      fileName = this.fileNameFor(name);
      n += 1;
    }
    const now = nowIso();
    const record: MemoryRecord = {
      name,
      description: input.description,
      type: input.type,
      created: now,
      updated: now,
      content: input.content,
      project: input.project ?? null,
      file: `memory/${fileName}`,
    };
    this.write(record);
    l.info({ file: record.file }, 'memory created');
    return record;
  }

  update(
    name: string,
    changes: { description?: string; content?: string; type?: MemoryType },
  ): MemoryRecord | null {
    const existing = this.get(name);
    if (!existing) return null;
    const updated: MemoryRecord = {
      ...existing,
      ...(changes.description ? { description: changes.description } : {}),
      ...(changes.content ? { content: changes.content } : {}),
      ...(changes.type ? { type: changes.type } : {}),
      updated: nowIso(),
    };
    this.write(updated);
    l.info({ file: updated.file }, 'memory updated');
    return updated;
  }

  remove(name: string): MemoryRecord | null {
    const existing = this.get(name);
    if (!existing) return null;
    fs.rmSync(this.home.path(existing.file));
    l.info({ file: existing.file }, 'memory forgotten');
    return existing;
  }

  /** Every mutation is a git commit (§8.2) — the "why did it change" story. */
  commit(message: string, files: string[]): boolean {
    return this.home.git.commit(message, files.length ? files : ['memory']);
  }
}
