import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AsanaClient } from '../src/tools/integrations/asana/client.js';
import { DEFAULT_ASANA_CONFIG } from '../src/tools/integrations/asana/inbox-source.js';
import { asanaTools } from '../src/tools/integrations/asana/tools.js';
import { capResult } from '../src/tools/budget.js';
import { FakeAsana, asanaFetch, type FakeTask } from './fake-asana.js';

const ctx = { runId: null, eventId: null };

describe('asana tool results are slim and cut at whole tasks (§20.3)', () => {
  let fake: FakeAsana;
  let tools: ReturnType<typeof asanaTools>;

  beforeEach(async () => {
    fake = new FakeAsana();
    const base = await fake.start();
    const client = new AsanaClient({
      pat: 'p',
      fetch: asanaFetch(base),
      sleep: async () => {},
    });
    tools = asanaTools(client, {
      inboxSection: DEFAULT_ASANA_CONFIG.inboxSection,
      dailySection: DEFAULT_ASANA_CONFIG.dailySection,
    });
    fake.section('Inbox');
  });
  afterEach(async () => {
    await fake.stop();
  });

  const tool = (name: string) => tools.find((t) => t.name === name)!;
  const task = (i: number, over: Partial<FakeTask> = {}): FakeTask => ({
    gid: `t${i}`,
    name: `Task ${i}`,
    notes: '',
    completed: false,
    modified_at: '2026-08-20T10:00:00.000Z',
    assignee: { gid: '999', name: 'Test User' },
    projects: [],
    tags: [],
    permalink_url: `https://app.asana.com/0/1/t${i}`,
    due_on: null,
    ...over,
  });

  it('drops assignee, modified_at and empty tags/projects on the user lists', async () => {
    fake.section('Inbox').tasks.push(
      task(1),
      task(2, {
        projects: [{ gid: 'p', name: 'Weekly' }],
        tags: [{ gid: 'g', name: 'urgent' }],
      }),
    );
    const inbox = (await tool('asana.inbox').execute({ workspace: 'ws1' }, ctx)) as any;
    const mine = (await tool('asana.my_tasks').execute({ workspace: 'ws1' }, ctx)) as any;
    const [bare, rich] = inbox.tasks;
    for (const t of [...inbox.tasks, ...mine.sections[0].tasks]) {
      expect(t).not.toHaveProperty('assignee');
      expect(t).not.toHaveProperty('modified_at');
    }
    expect(bare).not.toHaveProperty('tags');
    expect(bare).not.toHaveProperty('projects');
    expect(rich.projects).toEqual(['Weekly']);
    expect(rich.tags).toEqual(['urgent']);
    expect(bare).toMatchObject({
      gid: 't1',
      name: 'Task 1',
      completed: false,
      due_on: null,
      url: 'https://app.asana.com/0/1/t1',
    });
  });

  it('task_detail keeps the assignee', async () => {
    fake.section('Inbox').tasks.push(task(1));
    const res = (await tool('asana.task_detail').execute({ gid: 't1' }, ctx)) as any;
    expect(res.task.assignee).toBe('Test User');
    expect(res.task).not.toHaveProperty('modified_at');
  });

  it('a nested sections[].tasks listing is cut at whole tasks', async () => {
    fake
      .section('Inbox')
      .tasks.push(
        ...Array.from({ length: 60 }, (_, i) =>
          task(i, { name: `Task ${i} ${'n'.repeat(120)}` }),
        ),
      );
    const res = await tool('asana.my_tasks').execute({ workspace: 'ws1' }, ctx);
    const capped = capResult(res, 4000);
    const out = capped.output as any;
    expect(out._truncated.field).toBe('sections.0.tasks');
    expect(out._truncated.total).toBe(60);
    expect(out._truncated.kept).toBe(out.sections[0].tasks.length);
    expect(out.sections[0].tasks[0].gid).toBe('t0');
    expect(JSON.stringify(out).length).toBeLessThanOrEqual(4000);
    expect((capped.traceOutput as any).sections[0].tasks).toHaveLength(60);
  });
});
