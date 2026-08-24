import http from 'node:http';
import type { AddressInfo } from 'node:net';

export interface FakeTask {
  gid: string;
  name: string;
  notes?: string;
  completed?: boolean;
  modified_at?: string;
  created_at?: string;
  due_on?: string | null;
  assignee?: { gid: string; name: string } | null;
  created_by?: { gid: string; name: string } | null;
  projects?: { gid: string; name: string }[];
  tags?: { gid: string; name: string }[];
  permalink_url?: string;
}

export interface FakeSection {
  gid: string;
  name: string;
  tasks: FakeTask[];
}

/**
 * A stand-in for the Asana REST API, shaped like the real thing: `{data: …}`
 * envelopes, `next_page.offset` pagination, My Tasks as a project with
 * sections, and stories per task.
 */
export class FakeAsana {
  private server: http.Server | null = null;
  readonly requests: {
    method: string;
    path: string;
    query: Record<string, string>;
    body: any;
  }[] = [];
  /** My Tasks, section by section — the inbox is just one of these. */
  sections: FakeSection[] = [];
  stories: Record<string, { created_at: string; text: string; resource_subtype: string }[]> =
    {};
  meGid = '999';
  myTasksGid = 'utl-1';
  failNext: number | null = null;
  /** Serve section tasks one per page, to exercise pagination. */
  paginate = false;
  retryAfter = '1';

  /** Convenience: every task across every section. */
  get tasks(): FakeTask[] {
    return this.sections.flatMap((s) => s.tasks);
  }

  section(name: string): FakeSection {
    const found = this.sections.find((s) => s.name === name);
    if (found) return found;
    const created: FakeSection = { gid: `sec-${this.sections.length + 1}`, name, tasks: [] };
    this.sections.push(created);
    return created;
  }

  /** Move a task between sections, the way triage does. */
  move(taskGid: string, toSection: string): void {
    let moved: FakeTask | undefined;
    for (const s of this.sections) {
      const i = s.tasks.findIndex((t) => t.gid === taskGid);
      if (i >= 0) moved = s.tasks.splice(i, 1)[0];
    }
    if (moved) {
      // Asana touches modified_at when a task changes section.
      moved.modified_at = new Date(Date.now() + 1).toISOString();
      this.section(toSection).tasks.push(moved);
    }
  }

  async start(): Promise<string> {
    this.server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c as Buffer));
      req.on('end', () => {
        const url = new URL(req.url ?? '/', 'http://localhost');
        const raw = Buffer.concat(chunks).toString('utf8');
        let body: any = raw;
        try {
          body = raw ? JSON.parse(raw) : undefined;
        } catch {
          /* leave raw */
        }
        const query = Object.fromEntries(url.searchParams.entries());
        this.requests.push({ method: req.method ?? 'GET', path: url.pathname, query, body });

        const json = (
          status: number,
          payload: unknown,
          headers: Record<string, string> = {},
        ) => {
          res.writeHead(status, { 'content-type': 'application/json', ...headers });
          res.end(JSON.stringify(payload));
        };

        if (this.failNext !== null) {
          const status = this.failNext;
          this.failNext = null;
          return json(
            status,
            { errors: [{ message: status === 429 ? 'Rate limited' : 'scripted failure' }] },
            status === 429 ? { 'retry-after': this.retryAfter } : {},
          );
        }

        const p = url.pathname.replace(/^\/api\/1\.0/, '');

        if (p === '/users/me') {
          return json(200, {
            data: {
              gid: this.meGid,
              name: 'Test User',
              email: 'test@example.com',
              workspaces: [{ gid: 'ws1', name: 'Workspace One' }],
            },
          });
        }
        if (p === '/workspaces') {
          return json(200, { data: [{ gid: 'ws1', name: 'Workspace One' }] });
        }
        if (p === '/users/me/user_task_list') {
          return json(200, { data: { gid: this.myTasksGid, name: 'My Tasks' } });
        }
        if (p === `/projects/${this.myTasksGid}/sections`) {
          return json(200, {
            data: this.sections.map((s) => ({ gid: s.gid, name: s.name })),
          });
        }

        const sectionTasks = /^\/sections\/([^/]+)\/tasks$/.exec(p);
        if (sectionTasks && req.method === 'GET') {
          const section = this.sections.find((s) => s.gid === sectionTasks[1]);
          const all = (section?.tasks ?? []).map((t) => this.withMembership(t, section));
          if (!this.paginate) return json(200, { data: all });
          // One item per page, so the client must follow next_page.offset.
          const offset = Number(query.offset ?? '0');
          const page = all.slice(offset, offset + 1);
          const next = offset + 1 < all.length ? { offset: String(offset + 1) } : null;
          return json(200, { data: page, next_page: next });
        }

        const addTask = /^\/sections\/([^/]+)\/addTask$/.exec(p);
        if (addTask && req.method === 'POST') {
          const target = this.sections.find((s) => s.gid === addTask[1]);
          if (!target) return json(404, { errors: [{ message: 'no such section' }] });
          this.move(String(body?.data?.task), target.name);
          return json(200, { data: {} });
        }

        const storiesPath = /^\/tasks\/([^/]+)\/stories$/.exec(p);
        if (storiesPath && req.method === 'GET') {
          return json(200, { data: this.stories[storiesPath[1]!] ?? [] });
        }
        if (storiesPath && req.method === 'POST') {
          const list = (this.stories[storiesPath[1]!] ??= []);
          list.push({
            created_at: new Date().toISOString(),
            text: String(body?.data?.text ?? ''),
            resource_subtype: 'comment_added',
          });
          return json(200, { data: { gid: `story-${list.length}` } });
        }

        const onePath = /^\/tasks\/([^/]+)$/.exec(p);
        if (onePath && req.method === 'GET') {
          const gid = onePath[1]!;
          const section = this.sections.find((s) => s.tasks.some((t) => t.gid === gid));
          const task = section?.tasks.find((t) => t.gid === gid);
          return task
            ? json(200, { data: this.withMembership(task, section) })
            : json(404, { errors: [{ message: 'not found' }] });
        }
        if (onePath && req.method === 'PUT') {
          const gid = onePath[1]!;
          const section = this.sections.find((s) => s.tasks.some((t) => t.gid === gid));
          const task = section?.tasks.find((t) => t.gid === gid);
          if (!task) return json(404, { errors: [{ message: 'not found' }] });
          Object.assign(task, body?.data ?? {});
          return json(200, { data: this.withMembership(task, section) });
        }
        if (p === '/tasks' && req.method === 'POST') {
          const created: FakeTask = {
            gid: `new-${this.tasks.length + 1}`,
            name: String(body?.data?.name ?? ''),
            completed: false,
            notes: body?.data?.notes,
            due_on: body?.data?.due_on ?? null,
            modified_at: new Date().toISOString(),
            permalink_url: 'https://app.asana.com/0/1/new',
          };
          this.section(this.sections[0]?.name ?? 'Inbox').tasks.push(created);
          return json(200, { data: created });
        }

        return json(404, { errors: [{ message: 'no route' }] });
      });
    });
    await new Promise<void>((r) => this.server!.listen(0, '127.0.0.1', r));
    return `http://127.0.0.1:${(this.server!.address() as AddressInfo).port}`;
  }

  private withMembership(
    task: FakeTask,
    section?: FakeSection,
  ): FakeTask & {
    memberships?: { section: { gid: string; name: string } }[];
  } {
    return section
      ? { ...task, memberships: [{ section: { gid: section.gid, name: section.name } }] }
      : { ...task };
  }

  async stop(): Promise<void> {
    const s = this.server;
    this.server = null;
    if (s) await new Promise<void>((r) => s.close(() => r()));
  }
}

/** A fetch that rewrites app.asana.com to the fake, so the client is untouched. */
export function asanaFetch(base: string): typeof globalThis.fetch {
  return (async (input: any, init?: any) => {
    const url = new URL(String(input instanceof URL ? input : (input.url ?? input)));
    const rewritten = new URL(url.pathname + url.search, base);
    return globalThis.fetch(rewritten, init);
  }) as unknown as typeof globalThis.fetch;
}
