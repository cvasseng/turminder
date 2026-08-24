import { log } from '../../../core/logger.js';
import { nowIso } from '../../../core/time.js';
import { htmlToText } from '../web-fetch.js';
import type { SubmitInput } from '../../../ingress/intake.js';
import { PollingSource, type PollResult, type SourceDeps } from '../../../ingress/source.js';
import type { AsanaClient, AsanaStory, AsanaTask } from './client.js';

const l = log('asana');

export interface AsanaSourceConfig {
  pollSeconds: number;
  /** Workspace gids to watch; empty means every workspace the token can see. */
  workspaces: string[];
  /** The My Tasks section that is the inbox — where untriaged work lands. */
  inboxSection: string;
  /** Where triaged "do it now" work lives; handlers use it to move things. */
  dailySection: string;
  /** Include the task's recent comments in the event payload. */
  includeComments: boolean;
  /** Cap on items reported per poll, so a bulk import cannot flood the loop. */
  maxPerPoll: number;
  /** Also announce a task that has been moved *into* the daily section. */
  watchDaily: boolean;
}

export const DEFAULT_ASANA_CONFIG: AsanaSourceConfig = {
  pollSeconds: 180,
  workspaces: [],
  // Asana's own default is "Recently assigned"; the todo-cli convention is
  // "Inbox". Match on either unless the user names one.
  inboxSection: 'Inbox',
  dailySection: 'Do today',
  includeComments: true,
  maxPerPoll: 25,
  watchDaily: false,
};

/** What we remember about a task between polls. */
interface SeenEntry {
  section: string;
  modified: string;
}

const INBOX_ALIASES = ['inbox', 'recently assigned', 'new tasks', 'untriaged'];

function isInboxSection(name: string, configured: string): boolean {
  const lower = name.trim().toLowerCase();
  return lower === configured.trim().toLowerCase() || INBOX_ALIASES.includes(lower);
}

/**
 * Watches the Asana inbox — the real one: the section of My Tasks where
 * untriaged work lands. A task is an inbox item because it is *sitting in the
 * inbox*, which is exactly what the user sees in Asana, and needs neither a
 * premium search nor a guess about what "concerns me".
 *
 * Two things are worth an event: a task arriving in the inbox, and (optionally)
 * a task being moved into the daily section. A task the user has already
 * triaged out of the inbox is not news.
 */
export class AsanaInboxSource extends PollingSource {
  constructor(
    deps: SourceDeps,
    private readonly client: AsanaClient,
    private readonly config: AsanaSourceConfig = DEFAULT_ASANA_CONFIG,
  ) {
    super('asana.inbox', deps, config.pollSeconds * 1000);
  }

  protected override async ready(): Promise<{ ok: boolean; reason?: string }> {
    const check = await this.client.check();
    if (!check.ok) return { ok: false, reason: check.error ?? 'asana unreachable' };
    l.info({ user: check.user }, 'asana authenticated');
    return { ok: true };
  }

  protected async poll(): Promise<PollResult> {
    const seenKey = 'source:asana.inbox:seen';
    const seen = this.deps.meta.json<Record<string, SeenEntry>>(seenKey, {});
    const firstRun = Object.keys(seen).length === 0;
    const workspaces = this.config.workspaces.length
      ? this.config.workspaces
      : (await this.client.workspaces()).map((w) => w.gid);

    const events: SubmitInput[] = [];
    const live = new Set<string>();

    for (const workspace of workspaces) {
      const grouped = await this.client.myTasks(workspace);
      const sectionNames = grouped.map((g) => g.section.name);
      const inbox = grouped.filter((g) =>
        isInboxSection(g.section.name, this.config.inboxSection),
      );
      if (!inbox.length) {
        l.warn(
          { workspace, sections: sectionNames, looking_for: this.config.inboxSection },
          'no inbox section in My Tasks; set asana.inbox_section to one of these',
        );
      }

      const watched = this.config.watchDaily
        ? grouped.filter(
            (g) =>
              isInboxSection(g.section.name, this.config.inboxSection) ||
              g.section.name.trim().toLowerCase() ===
                this.config.dailySection.trim().toLowerCase(),
          )
        : inbox;

      for (const { section, tasks } of watched) {
        for (const task of tasks) {
          if (task.completed) continue;
          live.add(task.gid);
          const previous = seen[task.gid];
          const entry: SeenEntry = {
            section: section.name,
            modified: task.modified_at ?? nowIso(),
          };
          // Arrived in a watched section, or moved between them.
          const arrived = !previous || previous.section !== section.name;
          seen[task.gid] = entry;
          if (!arrived) continue;
          // A first run would otherwise announce the whole standing backlog.
          if (firstRun && !previous) continue;
          if (events.length >= this.config.maxPerPoll) continue;

          let comments: AsanaStory[] = [];
          if (this.config.includeComments) {
            try {
              comments = await this.client.comments(task.gid, 5);
            } catch (e) {
              l.debug({ task: task.gid, err: (e as Error).message }, 'comments unavailable');
            }
          }
          events.push(this.inboxEvent(task, section.name, comments, workspace));
        }
      }
    }

    // Forget tasks that have left the watched sections, so a task moved back
    // into the inbox later is news again.
    for (const gid of Object.keys(seen)) {
      if (!live.has(gid)) delete seen[gid];
    }
    this.deps.meta.setJson(seenKey, seen);

    if (firstRun) {
      l.info(
        { tracked: Object.keys(seen).length },
        'first asana poll: recorded the standing inbox without announcing it',
      );
    }
    return { events };
  }

  private inboxEvent(
    task: AsanaTask,
    sectionName: string,
    comments: AsanaStory[],
    workspace: string,
  ): SubmitInput {
    const inInbox = isInboxSection(sectionName, this.config.inboxSection);
    return {
      type: inInbox ? 'asana.inbox_item' : 'asana.task_scheduled',
      source: `asana.${workspace}`,
      payload: {
        section: sectionName,
        task: {
          gid: task.gid,
          name: task.name,
          // Asana notes carry its own HTML-ish markup (<UL>, <ASANA_OBJECT>);
          // the model wants the prose, not the tags.
          notes: task.notes ? htmlToText(task.notes).text.slice(0, 4000) : '',
          completed: task.completed,
          due_on: task.due_on ?? null,
          due_at: task.due_at ?? null,
          created_at: task.created_at ?? null,
          modified_at: task.modified_at ?? null,
          created_by: task.created_by?.name ?? null,
          assignee: task.assignee?.name ?? null,
          projects: task.projects?.map((p) => p.name) ?? [],
          tags: task.tags?.map((t) => t.name) ?? [],
          parent: task.parent?.name ?? null,
          permalink_url: task.permalink_url ?? null,
        },
        comments: comments.map((c) => ({
          at: c.created_at,
          by: c.created_by?.name ?? null,
          text: c.text ?? '',
        })),
      },
      occurred_at: task.modified_at ?? nowIso(),
      // Section plus modified_at: re-polling the same state is a duplicate,
      // but a task that leaves and comes back to the inbox is news again.
      idempotency_key: `asana:${task.gid}:${sectionName}:${task.modified_at ?? ''}`,
      // One task at a time, in order — comments arrive in bursts.
      serialization_key: `asana:${task.gid}`,
    };
  }
}
