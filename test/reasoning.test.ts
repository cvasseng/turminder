import { describe, expect, it } from 'vitest';
import {
  THINK_CLOSE,
  THINK_OPEN,
  ThinkFilter,
  heldSuffixLength,
  stripThink,
} from '../src/model/reasoning.js';

/** Feed a string through the filter split at `size`-char boundaries. */
function stream(text: string, size: number): string {
  const filter = new ThinkFilter();
  let out = '';
  for (let i = 0; i < text.length; i += size) out += filter.push(text.slice(i, i + size));
  return out + filter.flush();
}

/** Feed a string through the filter split at exactly one offset. */
function splitAt(text: string, offset: number): string {
  const filter = new ThinkFilter();
  const out = filter.push(text.slice(0, offset)) + filter.push(text.slice(offset));
  return out + filter.flush();
}

describe('held-suffix arithmetic (§20.1.3)', () => {
  it('finds the longest suffix that could still become a tag', () => {
    expect(heldSuffixLength('hello <', THINK_OPEN)).toBe(1);
    expect(heldSuffixLength('hello <th', THINK_OPEN)).toBe(3);
    expect(heldSuffixLength('hello <think', THINK_OPEN)).toBe(6);
    // A complete tag is not a *proper* prefix: the caller has already matched it.
    expect(heldSuffixLength('hello <think>', THINK_OPEN)).toBe(0);
    expect(heldSuffixLength('nothing here', THINK_OPEN)).toBe(0);
    expect(heldSuffixLength('a</thi', THINK_CLOSE)).toBe(5);
    // Never holds back more than a tag's worth.
    expect(heldSuffixLength('<<<<<<<<<<', THINK_OPEN)).toBe(1);
  });
});

describe('stripThink on finished text', () => {
  it('removes complete blocks and keeps everything else', () => {
    expect(stripThink('before<think>musing</think>after')).toBe('beforeafter');
    expect(stripThink('a<think>x</think>b<think>y</think>c')).toBe('abc');
    expect(stripThink('no tags at all')).toBe('no tags at all');
    expect(stripThink('<think>only thinking</think>')).toBe('');
  });

  it('treats an unterminated block as thinking to the end', () => {
    expect(stripThink('answer<think>still going')).toBe('answer');
    expect(stripThink('<think>')).toBe('');
  });

  it('leaves a stray closing tag alone — it is just text', () => {
    expect(stripThink('a </think> b')).toBe('a </think> b');
  });
});

describe('the streaming filter, split at every byte offset', () => {
  const cases: { name: string; input: string; visible: string }[] = [
    {
      name: 'a block in the middle',
      input: 'Here is the answer: <think>let me reconsider</think>42.',
      visible: 'Here is the answer: 42.',
    },
    {
      name: 'a block first, then the answer',
      input: '<think>weighing it up</think>The capital is Oslo.',
      visible: 'The capital is Oslo.',
    },
    { name: 'nothing but thinking', input: '<think>hmm</think>', visible: '' },
    {
      name: 'no thinking at all',
      input: 'Plain text, no tags.',
      visible: 'Plain text, no tags.',
    },
    {
      name: 'two blocks',
      input: 'a<think>one</think>b<think>two</think>c',
      visible: 'abc',
    },
    {
      name: 'angle brackets that are not tags',
      input: 'compare 3 < 4 and <thinking> and </think2>',
      visible: 'compare 3 < 4 and <thinking> and </think2>',
    },
    {
      name: 'a tag-like false start before a real tag',
      input: 'x <thi y <think>z</think> done',
      visible: 'x <thi y  done',
    },
  ];

  for (const c of cases) {
    it(`${c.name}: identical output at every split point`, () => {
      // Every possible single split, which is where off-by-ones live.
      for (let offset = 0; offset <= c.input.length; offset += 1) {
        expect(splitAt(c.input, offset), `split at ${offset}`).toBe(c.visible);
      }
      // And every fixed chunk size, including one byte at a time.
      for (let size = 1; size <= c.input.length + 1; size += 1) {
        expect(stream(c.input, size), `chunks of ${size}`).toBe(c.visible);
      }
    });
  }

  it('never eats user text when the stream ends mid-hold', () => {
    // The failure mode the spec calls out: a held suffix that never completes.
    for (const tail of ['<', '<t', '<th', '<thi', '<thin', '<think']) {
      expect(stream(`answer ${tail}`, 1)).toBe(`answer ${tail}`);
      expect(stream(`answer ${tail}`, 3)).toBe(`answer ${tail}`);
    }
  });

  it('does not leak think content when the stream ends mid-block', () => {
    for (const size of [1, 2, 5, 100]) {
      expect(stream('answer<think>secret musing', size)).toBe('answer');
      // Including when it ends part-way through the closing tag.
      expect(stream('answer<think>musing</thin', size)).toBe('answer');
    }
  });

  it('reports how much it suppressed, and whether it is mid-block', () => {
    const filter = new ThinkFilter();
    expect(filter.thinking).toBe(false);
    filter.push('hi <think>abc');
    expect(filter.thinking).toBe(true);
    expect(filter.suppressed).toBe(3);
    filter.push('de</think>bye');
    expect(filter.thinking).toBe(false);
    expect(filter.suppressed).toBe(5);
  });

  it('holds back at most one tag less than a full tag', () => {
    expect(ThinkFilter.maxHoldBack).toBe(THINK_CLOSE.length - 1);
    const filter = new ThinkFilter();
    // A long run of '<' cannot force an unbounded hold.
    const out = filter.push(`${'<'.repeat(500)}x`);
    expect(out).toBe(`${'<'.repeat(500)}x`);
  });
});
