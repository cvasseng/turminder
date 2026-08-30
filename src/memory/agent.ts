import { z } from 'zod';
import { log } from '../core/logger.js';
import { errMessage } from '../core/errors.js';
import type { MemoryType } from '../core/config-schemas.js';
import type { ModelGateway } from '../model/gateway.js';
import type { TraceSink } from '../model/types.js';
import type { RagIndex, RetrievalHit } from '../rag/index-store.js';
import { MemoryStore, type MemoryRecord } from './store.js';

const l = log('memory');

export interface SaveInput {
  type: MemoryType;
  description: string;
  content: string;
  name?: string;
  /** One line for the git commit message; falls back to the description. */
  reason?: string;
  /**
   * The island this memory belongs to (§31.5), resolved by the caller — the
   * tool from the conversation's loaded set, the distiller from its H.4
   * output validated against that same set. Null is general. The model may
   * choose among what the conversation was granted, never beyond it.
   */
  project?: string | null;
}

export interface SaveResult {
  name: string;
  file: string;
  action: 'created' | 'merged';
}

const DedupeVerdict = z.object({
  duplicate_of: z.string(),
  merged_content: z.string(),
});

const DEDUPE_SCHEMA = {
  name: 'memory_dedupe',
  schema: {
    type: 'object',
    properties: {
      duplicate_of: {
        type: 'string',
        description: 'name of the existing memory this duplicates, or "" if none',
      },
      merged_content: {
        type: 'string',
        description: 'the combined content to store when duplicating, else ""',
      },
    },
    required: ['duplicate_of', 'merged_content'],
    additionalProperties: false,
  },
} as const;

/**
 * The single writer (§8.2). Everything that changes memory goes through here:
 * it dedupes against what already exists, updates rather than duplicating, and
 * commits each mutation with a message that explains itself.
 */
export class MemoryAgent {
  constructor(
    readonly store: MemoryStore,
    private readonly index: RagIndex,
    private readonly gateway: ModelGateway | null,
  ) {}

  async query(
    query: string,
    k = 5,
    loaded: string[] = [],
  ): Promise<{ results: RetrievalHit[]; mode: string }> {
    const { hits, mode } = await this.index.retrieve(query, k, loaded);
    return { results: hits, mode };
  }

  /**
   * `trace` is the caller's run trace (§10.6): a save's dedupe check is a
   * real model call and was invisible before it — every caller (the
   * `memory.save` tool, the distiller) has a run and threads its sink
   * through rather than the agent guessing one.
   */
  async save(input: SaveInput, trace?: TraceSink): Promise<SaveResult> {
    const existing = await this.findDuplicate(input, trace);
    if (existing) {
      const merged = this.store.update(existing.name, {
        content: existing.mergedContent,
        description: input.description,
        type: input.type,
      });
      if (merged) {
        this.store.commit(
          `memory(merged): ${merged.name} — ${input.reason ?? input.description}`,
          [merged.file],
        );
        await this.index.sync();
        return { name: merged.name, file: merged.file, action: 'merged' };
      }
    }

    const created = this.store.create({
      ...(input.name ? { name: input.name } : {}),
      description: input.description,
      type: input.type,
      content: input.content,
      project: input.project ?? null,
    });
    this.store.commit(
      `memory(created): ${created.name} — ${input.reason ?? input.description}`,
      [created.file],
    );
    await this.index.sync();
    return { name: created.name, file: created.file, action: 'created' };
  }

  async update(
    name: string,
    changes: { content?: string; description?: string },
  ): Promise<{ name: string; file: string; updated: true; chars?: number } | null> {
    const updated = this.store.update(name, changes);
    if (!updated) return null;
    this.store.commit(`memory(updated): ${updated.name} — ${updated.description}`, [
      updated.file,
    ]);
    await this.index.sync();
    // Say plainly that it landed, and how much: the transcript will shortly
    // show this call's `content` as a placeholder (§20.6), and a result that
    // only echoed the name left a model unsure whether anything was written.
    return {
      name: updated.name,
      file: updated.file,
      updated: true,
      ...(changes.content !== undefined ? { chars: changes.content.length } : {}),
    };
  }

  async forget(name: string, reason: string): Promise<{ name: string; deleted: boolean }> {
    const removed = this.store.remove(name);
    if (!removed) return { name, deleted: false };
    this.store.commit(`memory(forgot): ${removed.name} — ${reason}`, [removed.file]);
    await this.index.sync();
    return { name: removed.name, deleted: true };
  }

  list(): MemoryRecord[] {
    return this.store.list();
  }

  /**
   * Dedupe against existing memories. An exact name match is decided in code;
   * anything fuzzier is a semantic judgement, so it goes to the fast model —
   * and if no model is available, we simply create a new file.
   */
  private async findDuplicate(
    input: SaveInput,
    trace?: TraceSink,
  ): Promise<{ name: string; mergedContent: string } | null> {
    // Dedupe only within the island being written to (§31.5). Merging across
    // the boundary would fold project content into a general memory — a leak
    // through the *write* path, which is the one no read filter can undo.
    const target = input.project ?? null;
    const sameIsland = (record: { project: string | null }) => record.project === target;

    if (input.name) {
      const exact = this.store.get(input.name);
      if (exact && sameIsland(exact)) {
        return { name: exact.name, mergedContent: mergeText(exact.content, input.content) };
      }
    }

    const { hits } = await this.index.retrieve(
      `${input.description}\n${input.content}`,
      3,
      target ? [target] : [],
    );
    const sameScope = hits.filter((h) => (h.project ?? null) === target);
    if (!sameScope.length) return null;
    const top = sameScope[0]!;
    if (!this.gateway) {
      // No model: only trust a very strong lexical/vector signal.
      return top.score > 0.85
        ? { name: top.name, mergedContent: mergeText(top.content, input.content) }
        : null;
    }

    const candidates = sameScope
      .map((h) => `- ${h.name}: ${h.description}\n  ${h.content.slice(0, 400)}`)
      .join('\n');
    try {
      const turn = await this.gateway.turn({
        selector: { purpose: 'memory', caps: ['json'] },
        priority: 'background',
        system:
          "You maintain a personal assistant's memory store. Decide whether a new fact is already covered by an existing memory.\n" +
          "If it is, return that memory's exact name in duplicate_of and the full merged content in merged_content — keep everything still true, drop nothing, add the new detail.\n" +
          'If it is genuinely new, return "" for both fields. Prefer "" when unsure: a duplicate is cheap, a lost fact is not.',
        messages: [
          {
            role: 'user',
            content: `Existing memories:\n${candidates}\n\nNew fact:\ndescription: ${input.description}\ncontent: ${input.content}`,
          },
        ],
        jsonSchema: DEDUPE_SCHEMA as unknown as {
          name: string;
          schema: Record<string, unknown>;
        },
        maxOutputTokens: 4096,
        ...(trace ? { trace } : {}),
      });
      const parsed = DedupeVerdict.safeParse(JSON.parse(turn.text.trim()));
      if (!parsed.success) return null;
      const name = parsed.data.duplicate_of.trim();
      if (!name) return null;
      // The model may name anything; only a memory in the same island counts.
      const named = this.store.get(name);
      const match =
        sameScope.find((h) => h.name === name) ?? (named && sameIsland(named) ? named : null);
      if (!match) return null;
      const mergedContent =
        parsed.data.merged_content.trim() || mergeText(match.content, input.content);
      l.info({ name: match.name }, 'memory deduped into an existing file');
      return { name: match.name, mergedContent };
    } catch (e) {
      l.warn({ err: errMessage(e) }, 'dedupe check failed; storing as a new memory');
      return null;
    }
  }
}

function mergeText(existing: string, addition: string): string {
  if (existing.includes(addition.trim())) return existing;
  return `${existing.trim()}\n\n${addition.trim()}`;
}
