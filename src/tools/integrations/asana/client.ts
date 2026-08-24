import { log } from '../../../core/logger.js';
import { errMessage, UserFacingError } from '../../../core/errors.js';

const l = log('asana');

const API = 'https://app.asana.com/api/1.0';

export interface AsanaUser {
  gid: string;
  name: string;
  email?: string;
  workspaces: { gid: string; name: string }[];
}

export interface AsanaSection {
  gid: string;
  name: string;
}

export interface AsanaTask {
  gid: string;
  name: string;
  notes?: string;
  completed: boolean;
  due_on?: string | null;
  due_at?: string | null;
  modified_at?: string;
  created_at?: string;
  permalink_url?: string;
  assignee?: { gid: string; name: string } | null;
  created_by?: { gid: string; name: string } | null;
  projects?: { gid: string; name: string }[];
  tags?: { gid: string; name: string }[];
  parent?: { gid: string; name: string } | null;
  memberships?: { section?: { gid: string; name: string } | null }[];
  /** Filled in by this client from the membership that matched My Tasks. */
  section?: { gid: string; name: string } | null;
}

export interface AsanaStory {
  gid: string;
  created_at: string;
  created_by?: { gid: string; name: string } | null;
  resource_subtype?: string;
  text?: string;
  type?: string;
}

const TASK_FIELDS = [
  'gid',
  'name',
  'notes',
  'completed',
  'due_on',
  'due_at',
  'modified_at',
  'created_at',
  'permalink_url',
  'assignee.name',
  'created_by.name',
  'projects.name',
  'tags.name',
  'parent.name',
  'memberships.section.gid',
  'memberships.section.name',
].join(',');

export class AsanaAuthError extends Error {
  readonly status = 401;
}

export class AsanaRateLimited extends Error {
  constructor(readonly retryAfterS: number) {
    super(`Asana is rate-limiting us; retry after ${retryAfterS}s`);
  }
}

export interface AsanaClientOptions {
  pat: string;
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
  /** Retries for 429 responses. */
  maxRetries?: number;
  /** Injected in tests so backoff does not make them slow. */
  sleep?: (ms: number) => Promise<void>;
}

interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
  params?: Record<string, string>;
  /** Asana wraps write bodies in `{data: …}`. */
  body?: unknown;
}

/**
 * A thin Asana REST client. The PAT comes from the secret store (§27); it is
 * never logged, and task text is other people's writing, so everything it
 * returns is untrusted content (App. H.2).
 *
 * Shaped after the todo-cli client: full pagination, `Retry-After`-aware 429
 * backoff, and My Tasks (`user_task_list`) plus its sections as the model —
 * which is where Asana's actual inbox lives.
 */
export class AsanaClient {
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly opts: AsanaClientOptions) {
    this.fetchImpl = opts.fetch ?? globalThis.fetch;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    if (!opts.pat) {
      throw new UserFacingError(
        'asana_pat_missing',
        'no Asana personal access token',
        'connect Asana from chat ("set up asana") — the form puts ASANA_PAT in the secret store',
      );
    }
  }

  private async request<T>(
    path: string,
    options: RequestOptions = {},
    attempt = 0,
  ): Promise<{ data: T; nextOffset?: string }> {
    const { method = 'GET', params, body } = options;
    const url = new URL(`${API}${path}`);
    for (const [k, v] of Object.entries(params ?? {})) url.searchParams.set(k, v);

    const res = await this.fetchImpl(url, {
      method,
      headers: {
        authorization: `Bearer ${this.opts.pat}`,
        accept: 'application/json',
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      // Asana expects writes wrapped in a data envelope.
      ...(body ? { body: JSON.stringify({ data: body }) } : {}),
      signal: AbortSignal.timeout(this.opts.timeoutMs ?? 30_000),
    });

    if (res.status === 429) {
      const retryAfterS = Number(res.headers.get('retry-after') ?? 60);
      const maxRetries = this.opts.maxRetries ?? 3;
      if (attempt < maxRetries) {
        const backoff = Math.min(retryAfterS * 1000, 60_000) * 2 ** attempt;
        l.warn(
          { path, attempt: attempt + 1, backoff_ms: backoff },
          'asana rate limited, backing off',
        );
        await this.sleep(backoff);
        return this.request<T>(path, options, attempt + 1);
      }
      throw new AsanaRateLimited(retryAfterS);
    }

    if (res.status === 401) {
      throw new AsanaAuthError(
        'Asana rejected the token (401 Not Authorized). Check ASANA_PAT in ' +
          'secrets/secrets.yaml — a truncated paste looks exactly like this. ' +
          'Verify with `turminder auth asana-check`.',
      );
    }

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      let message = `asana ${path} failed: HTTP ${res.status}`;
      try {
        const parsed = JSON.parse(text) as { errors?: { message?: string }[] };
        if (parsed.errors?.[0]?.message) message += ` — ${parsed.errors[0].message}`;
      } catch {
        if (text) message += ` ${text.slice(0, 200)}`;
      }
      const err = new Error(message);
      (err as { status?: number }).status = res.status;
      throw err;
    }

    if (res.status === 204) return { data: {} as T };
    const body_ = (await res.json()) as { data: T; next_page?: { offset?: string } | null };
    const nextOffset = body_.next_page?.offset;
    return nextOffset ? { data: body_.data, nextOffset } : { data: body_.data };
  }

  /** Follows Asana's `next_page.offset` until the collection is exhausted. */
  private async all<T>(path: string, params: Record<string, string> = {}): Promise<T[]> {
    const out: T[] = [];
    let offset: string | undefined;
    do {
      const page = await this.request<T[]>(path, {
        params: { ...params, ...(offset ? { offset } : {}) },
      });
      out.push(...page.data);
      offset = page.nextOffset;
    } while (offset);
    return out;
  }

  async me(): Promise<AsanaUser> {
    const { data } = await this.request<AsanaUser>('/users/me', {
      params: { opt_fields: 'gid,name,email,workspaces.name' },
    });
    return data;
  }

  async workspaces(): Promise<{ gid: string; name: string }[]> {
    return this.all<{ gid: string; name: string }>('/workspaces', { opt_fields: 'gid,name' });
  }

  /**
   * The gid of "My Tasks" for a workspace. It behaves like a project, so its
   * sections — Inbox, Do today, and whatever else the user has made — are
   * readable through the project endpoints.
   */
  async myTasksGid(workspaceGid: string): Promise<string> {
    const { data } = await this.request<{ gid: string }>('/users/me/user_task_list', {
      params: { workspace: workspaceGid, opt_fields: 'gid,name' },
    });
    return data.gid;
  }

  async sections(projectGid: string): Promise<AsanaSection[]> {
    return this.all<AsanaSection>(`/projects/${projectGid}/sections`, {
      opt_fields: 'gid,name',
    });
  }

  /** Tasks in one section, with the section stamped on each. */
  async sectionTasks(section: AsanaSection): Promise<AsanaTask[]> {
    const tasks = await this.all<AsanaTask>(`/sections/${section.gid}/tasks`, {
      opt_fields: TASK_FIELDS,
      limit: '100',
    });
    return tasks.map((t) => ({ ...t, section: { gid: section.gid, name: section.name } }));
  }

  /** Every task in My Tasks, grouped by section. */
  async myTasks(
    workspaceGid: string,
  ): Promise<{ section: AsanaSection; tasks: AsanaTask[] }[]> {
    const listGid = await this.myTasksGid(workspaceGid);
    const sections = await this.sections(listGid);
    const results: { section: AsanaSection; tasks: AsanaTask[] }[] = [];
    for (const section of sections) {
      results.push({ section, tasks: await this.sectionTasks(section) });
    }
    return results;
  }

  async task(gid: string): Promise<AsanaTask> {
    const { data } = await this.request<AsanaTask>(`/tasks/${gid}`, {
      params: { opt_fields: TASK_FIELDS },
    });
    return { ...data, section: data.memberships?.find((m) => m.section)?.section ?? null };
  }

  /** Everything that happened on a task: comments, assignment, due-date moves. */
  async stories(gid: string, limit = 20): Promise<AsanaStory[]> {
    const stories = await this.all<AsanaStory>(`/tasks/${gid}/stories`, {
      opt_fields: 'gid,created_at,created_by.name,resource_subtype,text,type',
      limit: String(limit),
    });
    return stories.slice(-limit);
  }

  /** Just the human comments, which is usually what matters. */
  async comments(gid: string, limit = 20): Promise<AsanaStory[]> {
    const stories = await this.stories(gid, 100);
    return stories.filter((s) => s.resource_subtype === 'comment_added').slice(-limit);
  }

  /* ── writes ───────────────────────────────────────────────────────────── */

  async addComment(gid: string, text: string): Promise<{ gid: string }> {
    const { data } = await this.request<{ gid: string }>(`/tasks/${gid}/stories`, {
      method: 'POST',
      body: { text },
    });
    return data;
  }

  async setCompleted(gid: string, completed: boolean): Promise<AsanaTask> {
    const { data } = await this.request<AsanaTask>(`/tasks/${gid}`, {
      method: 'PUT',
      body: { completed },
      params: { opt_fields: TASK_FIELDS },
    });
    return data;
  }

  async setDueOn(gid: string, dueOn: string | null): Promise<AsanaTask> {
    const { data } = await this.request<AsanaTask>(`/tasks/${gid}`, {
      method: 'PUT',
      body: { due_on: dueOn },
      params: { opt_fields: TASK_FIELDS },
    });
    return data;
  }

  /** Triage: move a task into one of My Tasks' sections. */
  async moveToSection(sectionGid: string, taskGid: string): Promise<void> {
    await this.request(`/sections/${sectionGid}/addTask`, {
      method: 'POST',
      body: { task: taskGid },
    });
  }

  async createTask(input: {
    name: string;
    workspace: string;
    notes?: string;
    dueOn?: string;
    assigneeGid?: string;
  }): Promise<AsanaTask> {
    const { data } = await this.request<AsanaTask>('/tasks', {
      method: 'POST',
      body: {
        name: input.name,
        workspace: input.workspace,
        assignee: input.assigneeGid ?? 'me',
        ...(input.notes ? { notes: input.notes } : {}),
        ...(input.dueOn ? { due_on: input.dueOn } : {}),
      },
      params: { opt_fields: TASK_FIELDS },
    });
    return data;
  }

  /** A cheap reachability check that also proves the PAT works. */
  async check(): Promise<{ ok: boolean; user?: string; error?: string }> {
    try {
      const me = await this.me();
      return { ok: true, user: me.name };
    } catch (e) {
      return { ok: false, error: errMessage(e) };
    }
  }
}
