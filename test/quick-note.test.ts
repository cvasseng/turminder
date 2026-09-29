import { afterEach, describe, expect, it } from 'vitest';
import { renderEventPayload } from '../src/prompts/index.js';
import { NoteCapturedPayload, QUICK_NOTE_MAX_CHARS } from '../src/core/config-schemas.js';
import { bootService, postJson, type ServiceHarness } from './service-harness.js';

let h: ServiceHarness;
afterEach(async () => {
  await h?.cleanup();
});

const drain = (harness: ServiceHarness) => harness.service.queue.drain();

/**
 * The server half of the tray quick note (§28.7). The shell is not here; what
 * is under test is the contract it speaks — the cap, the trust split, and the
 * shipped handler that turns one typed line into a filed todo.
 */
describe('quick note ingress (§28.7, App. E)', () => {
  it('enforces quick_note_max_chars server-side, and says which field', async () => {
    h = await bootService({ onboarded: true, watchFiles: false });
    const huge = await postJson(
      `${h.baseUrl}/api/events`,
      { type: 'note.captured', payload: { text: 'x'.repeat(QUICK_NOTE_MAX_CHARS + 1) } },
      h.token,
    );
    expect(huge.status).toBe(413);
    expect(huge.body).toMatchObject({ error: 'too_large' });
    expect(huge.body.message).toContain('text');

    // The limit is a limit, not a margin.
    const atCap = await postJson(
      `${h.baseUrl}/api/events`,
      { type: 'note.captured', payload: { text: 'x'.repeat(QUICK_NOTE_MAX_CHARS) } },
      h.token,
    );
    expect(atCap.status).toBe(200);
  });

  it('validates the payload shape it claims (App. B)', () => {
    expect(NoteCapturedPayload.safeParse({ text: 'renew the passport' }).success).toBe(true);
    expect(NoteCapturedPayload.safeParse({ text: '' }).success).toBe(false);
    expect(
      NoteCapturedPayload.safeParse({ text: 'renew the passport', extra: 1 }).success,
    ).toBe(false);
  });

  it('stamps source from the token, like every other event', async () => {
    h = await bootService({ onboarded: true, watchFiles: false });
    const res = await postJson(
      `${h.baseUrl}/api/events`,
      {
        type: 'note.captured',
        payload: { text: 'renew the passport' },
        source: 'not-the-shell',
      },
      h.token,
    );
    expect(res.status).toBe(200);
    const event = h.service.repos.events.get(res.body.event_id)!;
    expect(event.source).toBe('ui');
  });
});

describe('the App. B trust map, note.captured (H.2, §28.7)', () => {
  it('renders text outside the fence and removes it from the payload', () => {
    const rendered = renderEventPayload(
      { type: 'note.captured', source: 'shell', payload: { text: 'renew the passport' } },
      { maxChars: 8000, userName: 'Alex' },
    );
    const fenceAt = rendered.indexOf('<untrusted');
    expect(rendered).toContain('Note from Alex: "renew the passport"');
    expect(rendered.indexOf('Note from Alex')).toBeLessThan(fenceAt);
    // Fenced half no longer carries the text — nothing left inside to read as data.
    expect(rendered.slice(fenceAt)).not.toContain('renew the passport');
  });
});

describe('the shipped quick-note handler (§28.7)', () => {
  it('is installed at scaffold with exactly the §28.7 grant', async () => {
    h = await bootService({ onboarded: true, watchFiles: false });
    const handler = h.service.handlers.all().find((x) => x.name === 'quick-note')!;
    expect(handler).toBeTruthy();
    expect(handler.frontmatter.match?.types).toContain('note.captured');
    expect(handler.frontmatter.budgets?.max_turns).toBe(6);
    expect(handler.frontmatter.tools).toEqual([
      'memory.query',
      'memory.save',
      'files.list',
      'files.read',
      'files.write',
      'files.append',
      'files.edit',
      'files.search',
      'schedule.create',
      'schedule.list',
      'skills.fetch',
      'time.now',
      'deliver.notify',
    ]);
    expect(handler.frontmatter.tools?.some((t) => t.startsWith('web.'))).toBe(false);
    expect(handler.frontmatter.tools).not.toContain('files.delete');
  });

  it('runs a quick note through to one deliver.notify and a line in todo.md', async () => {
    h = await bootService({ onboarded: true, watchFiles: false });
    let toolCallsDone = false;
    h.fake.always((req: any) => {
      if (req.body.response_format) {
        return {
          text: JSON.stringify({
            summary: 'a quick note came in',
            verdicts: [{ handler: 'quick-note', matched: true, reason: 'a note arrived' }],
          }),
        };
      }
      if (req.body.tools && !toolCallsDone) {
        toolCallsDone = true;
        return {
          toolCalls: [
            {
              name: 'files.append',
              args: {
                path: 'todo.md',
                content: '- [ ] renew the passport\n',
                message: 'quick note: renew the passport',
              },
            },
            {
              name: 'deliver.notify',
              args: { title: 'Added to todo.md', body: 'renew the passport' },
            },
          ],
        };
      }
      return { text: 'Filed it.' };
    });

    const res = await postJson(
      `${h.baseUrl}/api/events`,
      { type: 'note.captured', payload: { text: 'add to todo: renew the passport' } },
      h.token,
    );
    await drain(h);

    const deliveries = h.service.repos.deliveries.pending();
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]?.payload.title).toBe('Added to todo.md');
    expect(h.service.files.read('todo.md')).toMatchObject({
      content: expect.stringContaining('renew the passport'),
    });
    // The typed line reached the model as an instruction, outside the fence.
    const handlerRun = h.fake.requests.find((r: any) =>
      JSON.stringify(r.body.messages).includes('quick-note'),
    )!;
    expect(JSON.stringify(handlerRun.body.messages)).toContain('Note from');
    expect(res.body.event_id).toBeTruthy();
  });
});
