import { z } from 'zod';
import { FileStoreError, type FileStore } from '../../files/store.js';
import type { FilesIndex } from '../../rag/files-index.js';
import type { ProjectScope } from '../../projects/scope.js';
import { PathRejected } from '../paths.js';
import type { ToolContext, ToolDefinition } from '../types.js';

export interface FilesDeps {
  store: FileStore;
  index: FilesIndex;
  /** Which project islands this conversation may search (§31.3). */
  scope: ProjectScope;
}

/** Store errors are outcomes the model should reason about, not exceptions. */
function asError(e: unknown): { error: string; message: string } {
  if (e instanceof FileStoreError) return { error: e.code, message: e.message };
  if (e instanceof PathRejected) return { error: 'path_rejected', message: e.reason };
  throw e;
}

const pathArg = z.string().min(1).describe('store-relative path, e.g. notes/todo.md');
const messageArg = z.string().min(1).describe('git commit message, one line');

/**
 * The `files` integration (App. F.8, §18). Two constraints are deliberate and
 * load-bearing: `files.edit` matches exactly once, and every write takes a
 * commit message. The first keeps a small model from silently losing half a
 * file; the second is what makes the git history readable afterwards.
 */
export function filesTools(deps: FilesDeps): ToolDefinition[] {
  const { store, index } = deps;
  return [
    {
      name: 'files.list',
      /** An empty directory listing (§20.9). */
      isEmpty: (result) => ((result as { entries?: unknown[] }).entries ?? []).length === 0,
      description:
        "List files in the shared workspace — the user's notes, todo lists, drafts and plans. Use it to find out what exists before reading or searching.",
      tier: 'ro',
      args: z.object({
        dir: z.string().optional().describe('subdirectory to list; omit for the whole store'),
        glob: z.string().optional().describe('filter, e.g. *.md or meeting-notes/**'),
      }),
      async execute(args: { dir?: string; glob?: string }) {
        try {
          return { entries: store.list({ ...args }) };
        } catch (e) {
          return asError(e);
        }
      },
    },
    {
      name: 'files.read',
      description:
        'Read one file from the shared workspace. Binary files (images, PDFs) return metadata only — their contents cannot be read yet.',
      tier: 'ro',
      /**
       * Returning a document *is* this tool's job, and it takes offset/limit
       * for when a caller wants less (§20.3). Capping a normal-sized note at
       * the default 4000 would make "read me that note" fail by design; the
       * elision pass (§20.4) reclaims the space once the note is stale.
       */
      maxResultChars: 20_000,
      args: z.object({
        path: pathArg,
        offset_lines: z.number().int().nonnegative().optional(),
        limit_lines: z.number().int().positive().optional(),
      }),
      async execute(args: { path: string; offset_lines?: number; limit_lines?: number }) {
        try {
          return store.read(args.path, {
            ...(args.offset_lines !== undefined ? { offsetLines: args.offset_lines } : {}),
            ...(args.limit_lines !== undefined ? { limitLines: args.limit_lines } : {}),
          });
        } catch (e) {
          return asError(e);
        }
      },
    },
    {
      name: 'files.write',
      description:
        'Create a file, or replace one completely. Prefer files.edit for changing part of an existing file — this overwrites everything. Commits to git.',
      tier: 'se',
      // §20.6: the file is the store, so the arg need not be the store too.
      bulkArgs: ['content'],
      args: z.object({ path: pathArg, content: z.string(), message: messageArg }),
      async execute(args: { path: string; content: string; message: string }) {
        try {
          return store.write(args.path, args.content, args.message);
        } catch (e) {
          return asError(e);
        }
      },
    },
    {
      name: 'files.append',
      description:
        'Add to the end of a file, creating it if it does not exist. The safe way to add a line to a list. Commits to git.',
      tier: 'se',
      bulkArgs: ['content'],
      args: z.object({ path: pathArg, content: z.string(), message: messageArg }),
      async execute(args: { path: string; content: string; message: string }) {
        try {
          return store.append(args.path, args.content, args.message);
        } catch (e) {
          return asError(e);
        }
      },
    },
    {
      name: 'files.edit',
      description:
        'Replace one exact piece of text in a file. `find` must appear exactly once — include enough surrounding text to make it unique. This is how you tick a checkbox or change a line without touching the rest. Commits to git.',
      tier: 'se',
      args: z.object({
        path: pathArg,
        find: z.string().min(1).describe('the exact text to replace, appearing exactly once'),
        replace: z.string().describe('what to put there instead'),
        message: messageArg,
      }),
      async execute(args: { path: string; find: string; replace: string; message: string }) {
        try {
          return store.edit(args.path, args.find, args.replace, args.message);
        } catch (e) {
          return asError(e);
        }
      },
    },
    {
      name: 'files.search',
      /** No hits (§20.9). */
      isEmpty: (result) => ((result as { results?: unknown[] }).results ?? []).length === 0,
      description:
        'Search the shared workspace by meaning. This searches files only — your own memory is a separate store, reached with memory.query.',
      tier: 'ro',
      args: z.object({
        query: z.string().min(1),
        k: z.number().int().min(1).max(20).optional(),
      }),
      async execute(args: { query: string; k?: number }, ctx: ToolContext) {
        // Scope lives in retrieval, never in the model's discipline (§31.3):
        // a file under an unloaded project is not filtered out of the answer,
        // it never reaches it.
        const { results, mode } = await index.search(
          args.query,
          args.k ?? 5,
          deps.scope.loaded(ctx.conversationId),
        );
        return {
          results: results.map((r) => ({
            path: r.path,
            excerpt: r.excerpt,
            score: Number(r.score.toFixed(4)),
          })),
          retrieval: mode,
        };
      },
    },
    {
      name: 'files.delete',
      description:
        "Delete a file from the shared workspace. Git makes it recoverable, but it is still the user's file — say what you are deleting and why in the message.",
      tier: 'se',
      args: z.object({ path: pathArg, message: messageArg }),
      async execute(args: { path: string; message: string }) {
        try {
          return store.delete(args.path, args.message);
        } catch (e) {
          return asError(e);
        }
      },
    },
  ];
}
