import { z } from 'zod';
import type { ConversationsRepo } from '../../db/repos/conversations.js';
import type { ProjectStore } from '../../projects/store.js';
import type { ToolContext, ToolDefinition } from '../types.js';

export interface ProjectDeps {
  projects: ProjectStore;
  conversations: ConversationsRepo;
}

/**
 * The word is overloaded in every workspace this system will ever meet, so
 * both descriptions carry the same disambiguation verbatim (App. F.18): asked
 * to "make a project" before this shipped, the live model improvised across
 * three external meanings of it.
 */
const WHAT_A_PROJECT_IS =
  'a Turminder knowledge project (a fenced island of files, memories, and history) — not a project in Asana, a time tracker, or any external tool.';

/** What the load result tells the model about where to put things (§31.5). */
function noteFor(filesRoot: string): string {
  return `Files you write for this project belong under ${filesRoot} — the location is what scopes them. Memories you save while it is loaded are tagged with it automatically.`;
}

/**
 * The `project` integration (App. F.18, §31). Two tools, and deliberately no
 * `project.list`: the roster is already in the system prompt, so a list tool
 * would spend a call re-reading context the model has — and the unknown-name
 * error teaches the names anyway.
 *
 * The isolation these tools open is enforced nowhere near here: the filters
 * live in the retrieval layer (§31.3), where the model cannot reach them.
 * Loading a project only records a fact on the conversation row.
 */
export function projectTools(deps: ProjectDeps): ToolDefinition[] {
  return [
    {
      name: 'project.load',
      description: `Load a project into this conversation so its files, memories and past discussions become visible to you. Use it when the user says "let's work on X". This is ${WHAT_A_PROJECT_IS}`,
      tier: 'ro',
      args: z.object({ name: z.string().min(1).describe('the project slug, from the roster') }),
      async execute(args: { name: string }, ctx: ToolContext) {
        const project = deps.projects.get(args.name);
        if (!project) {
          return {
            error: 'unknown_project',
            message: `there is no project named "${args.name}"`,
            available: deps.projects.roster().map((p) => p.name),
          };
        }
        if (!ctx.conversationId) {
          // Loading is a fact about a conversation; a run without one would
          // report success and change nothing anyone could see.
          return {
            error: 'no_conversation',
            message: 'projects load into a conversation, and this run has none',
          };
        }
        deps.conversations.loadProject(ctx.conversationId, project.name);
        return {
          name: project.name,
          description: project.description,
          brief: project.brief,
          files_root: project.filesRoot,
          note: noteFor(project.filesRoot),
        };
      },
    },
    {
      name: 'project.create',
      description: `Start a new project: ${WHAT_A_PROJECT_IS} It gets its own folder, and from then on its files and memories stay inside it. Loaded into this conversation as part of creating it.`,
      tier: 'se',
      bulkArgs: ['brief'],
      args: z.object({
        name: z
          .string()
          .min(1)
          .describe('slug: lowercase words joined by hyphens, e.g. "acme-q4"'),
        description: z.string().min(1).describe('one line, what this project is'),
        brief: z
          .string()
          .optional()
          .describe('the README for whoever arrives cold — what it is, where things live'),
      }),
      async execute(
        args: { name: string; description: string; brief?: string },
        ctx: ToolContext,
      ) {
        const created = deps.projects.create(args);
        if ('error' in created) return created;
        const { project } = created;
        if (ctx.conversationId)
          deps.conversations.loadProject(ctx.conversationId, project.name);
        return {
          name: project.name,
          created: true,
          file: project.file,
          files_root: project.filesRoot,
          note: noteFor(project.filesRoot),
        };
      },
    },
  ];
}
