import { z } from 'zod';
import { log } from '../../../core/logger.js';
import { errMessage } from '../../../core/errors.js';
import { htmlToText } from '../web-fetch.js';
import type { ToolDefinition } from '../../types.js';
import type { AsanaClient, AsanaTask } from './client.js';

const l = log('asana');

export interface AsanaToolsConfig {
  inboxSection: string;
  dailySection: string;
}

function summarise(task: AsanaTask): Record<string, unknown> {
  return {
    gid: task.gid,
    name: task.name,
    section: task.section?.name ?? null,
    completed: task.completed,
    due_on: task.due_on ?? null,
    assignee: task.assignee?.name ?? null,
    projects: task.projects?.map((p) => p.name) ?? [],
    tags: task.tags?.map((t) => t.name) ?? [],
    url: task.permalink_url ?? null,
    modified_at: task.modified_at ?? null,
  };
}

/**
 * `asana.*` tools, built around My Tasks and its sections — the same model the
 * user's own todo CLI uses, so "the inbox" here means what it means in Asana.
 * Task text is other people's writing: results are untrusted content (App. H.2).
 */
export function asanaTools(client: AsanaClient, config: AsanaToolsConfig): ToolDefinition[] {
  const guard = async <T>(
    fn: () => Promise<T>,
  ): Promise<T | { error: string; message: string }> => {
    try {
      return await fn();
    } catch (e) {
      l.warn({ err: errMessage(e) }, 'asana call failed');
      return { error: 'asana_failed', message: errMessage(e) };
    }
  };

  const workspaceOf = async (given?: string): Promise<string | null> =>
    given ?? (await client.workspaces())[0]?.gid ?? null;

  /** Resolve a section by name within My Tasks. */
  const findSection = async (workspace: string, name: string) => {
    const listGid = await client.myTasksGid(workspace);
    const sections = await client.sections(listGid);
    const wanted = name.trim().toLowerCase();
    return (
      sections.find((s) => s.name.trim().toLowerCase() === wanted) ??
      sections.find((s) => s.name.trim().toLowerCase().includes(wanted)) ??
      null
    );
  };

  return [
    {
      name: 'asana.list_workspaces',
      description: 'List the Asana workspaces this account can see.',
      tier: 'ro',
      args: z.object({}),
      async execute() {
        return guard(async () => ({ workspaces: await client.workspaces() }));
      },
    },
    {
      name: 'asana.list_sections',
      description:
        'List the sections of My Tasks — the columns the user triages into, e.g. Inbox and Do today.',
      tier: 'ro',
      args: z.object({ workspace: z.string().optional() }),
      async execute(args: { workspace?: string }) {
        return guard(async () => {
          const workspace = await workspaceOf(args.workspace);
          if (!workspace) return { sections: [] };
          const listGid = await client.myTasksGid(workspace);
          return { sections: await client.sections(listGid) };
        });
      },
    },
    {
      name: 'asana.inbox',
      description:
        'What is waiting in the user\'s Asana inbox: untriaged tasks in the inbox section of My Tasks. Use this for "what\'s in my inbox" and for triage.',
      tier: 'ro',
      args: z.object({
        workspace: z.string().optional(),
        section: z.string().optional().describe('override which section counts as the inbox'),
      }),
      async execute(args: { workspace?: string; section?: string }) {
        return guard(async () => {
          const workspace = await workspaceOf(args.workspace);
          if (!workspace) return { tasks: [], untrusted: true };
          const wanted = (args.section ?? config.inboxSection).trim().toLowerCase();
          const grouped = await client.myTasks(workspace);
          const match =
            grouped.find((g) => g.section.name.trim().toLowerCase() === wanted) ??
            grouped.find((g) =>
              ['inbox', 'recently assigned'].includes(g.section.name.trim().toLowerCase()),
            );
          if (!match) {
            return {
              error: 'section_not_found',
              message: `no inbox section in My Tasks; sections are: ${grouped
                .map((g) => g.section.name)
                .join(', ')}`,
            };
          }
          return {
            section: match.section.name,
            tasks: match.tasks.filter((t) => !t.completed).map(summarise),
            untrusted: true,
          };
        });
      },
    },
    {
      name: 'asana.my_tasks',
      description:
        'All of My Tasks, grouped by section, so you can see what is triaged where. Completed tasks are left out unless asked for.',
      tier: 'ro',
      args: z.object({
        workspace: z.string().optional(),
        include_completed: z.boolean().optional(),
      }),
      async execute(args: { workspace?: string; include_completed?: boolean }) {
        return guard(async () => {
          const workspace = await workspaceOf(args.workspace);
          if (!workspace) return { sections: [], untrusted: true };
          const grouped = await client.myTasks(workspace);
          return {
            sections: grouped.map((g) => ({
              section: g.section.name,
              tasks: g.tasks
                .filter((t) => args.include_completed || !t.completed)
                .map(summarise),
            })),
            untrusted: true,
          };
        });
      },
    },
    {
      name: 'asana.task_detail',
      description: 'Read one Asana task in full, including its notes and recent comments.',
      tier: 'ro',
      args: z.object({
        gid: z.string().min(1),
        comment_limit: z.number().int().min(1).max(50).optional(),
      }),
      async execute(args: { gid: string; comment_limit?: number }) {
        return guard(async () => {
          const [task, comments] = await Promise.all([
            client.task(args.gid),
            client.comments(args.gid, args.comment_limit ?? 10),
          ]);
          return {
            task: {
              ...summarise(task),
              notes: task.notes ? htmlToText(task.notes).text.slice(0, 8000) : '',
              created_by: task.created_by?.name ?? null,
              parent: task.parent?.name ?? null,
            },
            comments: comments.map((c) => ({
              at: c.created_at,
              by: c.created_by?.name ?? null,
              text: c.text ?? '',
            })),
            untrusted: true,
          };
        });
      },
    },

    {
      name: 'asana.triage',
      description:
        'Move a task from the inbox into one of My Tasks\' sections — the triage step. Section is matched by name, e.g. "Do today".',
      tier: 'se',
      args: z.object({
        gid: z.string().min(1),
        section: z.string().optional().describe(`defaults to "${config.dailySection}"`),
        workspace: z.string().optional(),
      }),
      async execute(args: { gid: string; section?: string; workspace?: string }) {
        return guard(async () => {
          const workspace = await workspaceOf(args.workspace);
          if (!workspace) return { error: 'no_workspace', message: 'no Asana workspace found' };
          const wanted = args.section ?? config.dailySection;
          const section = await findSection(workspace, wanted);
          if (!section) {
            return {
              error: 'section_not_found',
              message: `no section named "${wanted}" in My Tasks`,
            };
          }
          await client.moveToSection(section.gid, args.gid);
          return { gid: args.gid, moved_to: section.name };
        });
      },
    },
    {
      name: 'asana.comment',
      description:
        'Add a comment to a task. This is visible to everyone following it, so write it as the user would.',
      tier: 'se',
      args: z.object({ gid: z.string().min(1), text: z.string().min(1) }),
      async execute(args: { gid: string; text: string }) {
        return guard(async () => {
          const story = await client.addComment(args.gid, args.text);
          return { gid: args.gid, comment_gid: story.gid };
        });
      },
    },
    {
      name: 'asana.complete_task',
      description: 'Mark a task complete (or reopen it with completed: false).',
      tier: 'se',
      args: z.object({ gid: z.string().min(1), completed: z.boolean().optional() }),
      async execute(args: { gid: string; completed?: boolean }) {
        return guard(async () => {
          const task = await client.setCompleted(args.gid, args.completed ?? true);
          return { gid: task.gid, completed: task.completed };
        });
      },
    },
    {
      name: 'asana.set_due_date',
      description: 'Set or clear a task due date. Date is YYYY-MM-DD; null clears it.',
      tier: 'se',
      args: z.object({
        gid: z.string().min(1),
        due_on: z.string().nullable().describe('YYYY-MM-DD, or null to clear'),
      }),
      async execute(args: { gid: string; due_on: string | null }) {
        return guard(async () => {
          const task = await client.setDueOn(args.gid, args.due_on);
          return { gid: task.gid, due_on: task.due_on ?? null };
        });
      },
    },
    {
      name: 'asana.create_task',
      description:
        'Create a task assigned to the user. Use it to capture something the user asked to remember as work, not for notes to yourself — that is memory.save.',
      tier: 'se',
      args: z.object({
        name: z.string().min(1),
        notes: z.string().optional(),
        due_on: z.string().optional().describe('YYYY-MM-DD'),
        workspace: z.string().optional(),
      }),
      async execute(args: {
        name: string;
        notes?: string;
        due_on?: string;
        workspace?: string;
      }) {
        return guard(async () => {
          const workspace = await workspaceOf(args.workspace);
          if (!workspace) return { error: 'no_workspace', message: 'no Asana workspace found' };
          const task = await client.createTask({
            name: args.name,
            workspace,
            ...(args.notes ? { notes: args.notes } : {}),
            ...(args.due_on ? { dueOn: args.due_on } : {}),
          });
          return { gid: task.gid, name: task.name, url: task.permalink_url ?? null };
        });
      },
    },
  ];
}
