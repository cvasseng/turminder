import { describe, expect, it } from 'vitest';
import { describeConfirm, type ConfirmSubject } from '../src/exec/confirm-summary.js';

/**
 * The words a human authorises from (§7.3, §11.3, App. D.3).
 *
 * The thing being guarded is not prettiness. It is that this text is written
 * by the server — from the catalog and the schema — rather than by the party
 * asking to act, and that a `${secret:}` reference cannot ride an argument
 * onto somebody's screen (§27).
 */
const ctx = { actor: 'Sleeper Service', dataDir: '/home/ada/.turminder' };

function subject(over: Partial<ConfirmSubject> = {}): ConfirmSubject {
  return {
    name: 'files.delete',
    description: 'Delete a file from the shared workspace. Git makes it recoverable.',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string' }, message: { type: 'string' } },
    },
    ...over,
  };
}

/** Every detail line as `label: value`, which is also what `text` carries. */
function lines(handle: ConfirmSubject, args: unknown): string[] {
  return describeConfirm(handle, args, ctx).details.map((d) => `${d.label}: ${d.value}`);
}

describe('the title is a sentence the server wrote (§14.2)', () => {
  it('names the instance and the action, from the catalog description', () => {
    const d = describeConfirm(subject(), { path: 'a.md' }, ctx);
    expect(d.title).toBe('Sleeper Service wants to delete a file from the shared workspace');
    // The dot in the tool name never reaches a reader.
    expect(d.title).not.toContain('files.delete');
  });

  it('names the handler when a handler is the one asking', () => {
    const d = describeConfirm(
      subject(),
      { path: 'a.md' },
      { ...ctx, actor: 'Handler inbox-triage' },
    );
    expect(d.title.startsWith('Handler inbox-triage wants to ')).toBe(true);
  });

  it('keeps an acronym upright', () => {
    const d = describeConfirm(
      subject({
        name: 'calendar.respond',
        description: 'RSVP to an invitation as the user: …',
      }),
      {},
      ctx,
    );
    expect(d.title).toBe('Sleeper Service wants to RSVP to an invitation as the user');
  });

  it('does not end the sentence inside a parenthetical', () => {
    const d = describeConfirm(
      subject({
        name: 'asana.complete_task',
        description: 'Mark a task complete (or reopen it with completed: false).',
      }),
      {},
      ctx,
    );
    expect(d.title).toBe('Sleeper Service wants to mark a task complete');
  });

  it('falls back to the name when a server described nothing', () => {
    const d = describeConfirm(
      subject({ name: 'weird_tool', description: 'weird_tool' }),
      {},
      ctx,
    );
    expect(d.title).toBe('Sleeper Service wants to run weird_tool');
  });
});

describe('one readable line per argument', () => {
  it('follows schema order, then anything the schema never mentioned', () => {
    // `extra` is surfaced, not hidden: an argument nobody declared is exactly
    // what someone approving a call would want to see.
    expect(lines(subject(), { extra: 1, message: 'tidying', path: 'notes/a.md' })).toEqual([
      'Path: notes/a.md',
      'Message: tidying',
      'Extra: 1',
    ]);
  });

  it('renders a path inside the data dir as the path you recognise', () => {
    expect(lines(subject(), { path: '/home/ada/.turminder/files/notes/a.md' })).toEqual([
      'Path: files/notes/a.md',
    ]);
  });

  it('elides a long value instead of pasting a wall', () => {
    const [line] = lines(subject(), { message: 'x'.repeat(500) });
    expect(line!.length).toBeLessThan(200);
    expect(line!.endsWith('…')).toBe(true);
  });

  it('says how many, then a few', () => {
    const handle = subject({
      name: 'mail.send',
      description: 'Send an email.',
      inputSchema: { type: 'object', properties: { to: { type: 'array' } } },
    });
    expect(lines(handle, { to: ['a@x', 'b@x', 'c@x', 'd@x'] })).toEqual([
      'To: 4 items: a@x, b@x, c@x, …',
    ]);
    expect(lines(handle, { to: [] })).toEqual(['To: (none)']);
  });

  it('says yes and no rather than true and false', () => {
    const handle = subject({
      inputSchema: { type: 'object', properties: { recursive: { type: 'boolean' } } },
    });
    expect(lines(handle, { recursive: false })).toEqual(['Recursive: no']);
    expect(lines(handle, { recursive: true })).toEqual(['Recursive: yes']);
  });

  it('measures authored content instead of showing it (§20.6)', () => {
    const handle = subject({
      name: 'embeds.create',
      description: 'Author a small self-contained HTML page.',
      inputSchema: { type: 'object', properties: { html: { type: 'string' } } },
      bulkArgs: ['html'],
    });
    const [line] = lines(handle, { html: `${'<p>hello</p>\n'.repeat(400)}` });
    expect(line).toMatch(/^Html: 401 lines, \d+ KB$/);
  });

  it('has nothing to say about a call with no arguments', () => {
    const d = describeConfirm(subject(), {}, ctx);
    expect(d.details).toEqual([]);
    expect(d.text).toBe('(no arguments)');
  });

  it('reads as prose, not as a wire format', () => {
    const d = describeConfirm(
      subject(),
      { path: 'notes/2026/august.md', message: 'clearing out last summer' },
      ctx,
    );
    // The whole point of F2: no brace, bracket or quote anywhere in it.
    expect(`${d.title}\n${d.text}`).not.toMatch(/[{}[\]"]/);
  });
});

describe('a secret reference never reaches the reader (§27)', () => {
  const secret = '${secret:ASANA_TOKEN}';

  it('replaces the reference wherever it sits in the arguments', () => {
    const handle = subject({
      name: 'http.call',
      description: 'Call an HTTP endpoint.',
      inputSchema: {
        type: 'object',
        properties: { url: { type: 'string' }, headers: { type: 'object' } },
      },
    });
    const d = describeConfirm(
      handle,
      { url: `https://x/?k=${secret}`, headers: { authorization: `Bearer ${secret}` } },
      ctx,
    );
    const all = `${d.title}\n${d.text}\n${JSON.stringify(d.details)}`;
    expect(all).not.toContain('${secret:');
    // Not the value, and not the key name either — neither is the reader's.
    expect(all).not.toContain('ASANA_TOKEN');
    expect(all).toContain('(a stored secret)');
  });

  it('masks before eliding, so a cut cannot expose the front of a key', () => {
    const handle = subject({
      inputSchema: { type: 'object', properties: { message: { type: 'string' } } },
    });
    const d = describeConfirm(handle, { message: `${'x'.repeat(150)}${secret}` }, ctx);
    expect(d.text).not.toContain('${secret');
    expect(d.text).not.toContain('ASANA_TOK');
  });

  it('masks a tool override\u2019s lines too, not only the generic ones', () => {
    const handle = subject({
      confirmSummary: () => ({
        action: 'do a thing',
        lines: [{ label: 'Key', value: secret }],
      }),
    });
    const d = describeConfirm(handle, {}, ctx);
    expect(d.details).toEqual([{ label: 'Key', value: '(a stored secret)' }]);
  });
});

describe('a tool may write its own words (§11.3)', () => {
  it('uses the override, and still supplies the actor itself', () => {
    const handle = subject({
      confirmSummary: (args: any) => ({
        action: 'delete a file',
        lines: [{ label: 'File', value: String(args.path) }],
      }),
    });
    const d = describeConfirm(handle, { path: 'notes/a.md' }, ctx);
    expect(d.title).toBe('Sleeper Service wants to delete a file');
    expect(d.details).toEqual([{ label: 'File', value: 'notes/a.md' }]);
  });

  it('falls back to the generic rendering when an override throws', () => {
    // A broken override must not take the dialog with it: a call nobody can be
    // asked about is a call that silently denies.
    const handle = subject({
      confirmSummary: () => {
        throw new Error('boom');
      },
    });
    const d = describeConfirm(handle, { path: 'notes/a.md' }, ctx);
    expect(d.title).toContain('delete a file from the shared workspace');
    expect(d.details).toEqual([{ label: 'Path', value: 'notes/a.md' }]);
  });
});
