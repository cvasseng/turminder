/**
 * Reasoning normalisation (§20.1). Thinking-model output is handled here, by
 * policy, rather than left to llama.cpp server flags — because the consequence
 * of getting it wrong is silent: think text re-fed as history is wasted tokens
 * *and* off-distribution for a chat template that expects history without it.
 *
 * Two layers, both needed. The AI SDK's reasoning channel handles endpoints
 * that extract think blocks for us; this module handles the ones that do not,
 * and it must do so on the delta stream as well as the final text — otherwise
 * the user watches the model think out loud in the answer pane.
 */

export const THINK_OPEN = '<think>';
export const THINK_CLOSE = '</think>';

/** Longest tag we might be part-way through holding. */
const MAX_HOLD = Math.max(THINK_OPEN.length, THINK_CLOSE.length);

/**
 * The longest suffix of `text` that is a proper prefix of `tag`. This is the
 * whole trick: a tag can be split across delta boundaries at any byte, so the
 * filter must hold back exactly enough to recognise it later — and no more,
 * because everything held back is text the user is not yet seeing.
 */
export function heldSuffixLength(text: string, tag: string): number {
  const max = Math.min(text.length, tag.length - 1);
  for (let n = max; n > 0; n -= 1) {
    if (text.endsWith(tag.slice(0, n))) return n;
  }
  return 0;
}

/**
 * Remove `<think>…</think>` spans from a finished string. An unterminated block
 * takes everything after it: a model that opened a think block and stopped was
 * still thinking when it ran out.
 */
export function stripThink(text: string): string {
  let out = '';
  let rest = text;
  for (;;) {
    const open = rest.indexOf(THINK_OPEN);
    if (open < 0) return out + rest;
    out += rest.slice(0, open);
    const close = rest.indexOf(THINK_CLOSE, open + THINK_OPEN.length);
    if (close < 0) return out;
    rest = rest.slice(close + THINK_CLOSE.length);
  }
}

/**
 * Streaming think filter (§20.1.3). Feed it deltas, forward what it returns.
 *
 * Outside a block it forwards text, holding back only a trailing suffix that
 * could be the start of `<think>`; inside a block it forwards nothing, holding
 * back only a suffix that could be the start of `</think>`. At stream end an
 * outside hold-back is flushed — an unterminated `<think` is literal text the
 * model produced, and eating user-visible text is a worse failure than showing
 * a stray angle bracket. An inside hold-back is discarded: it is think content.
 */
export class ThinkFilter {
  private inside = false;
  private held = '';
  private reasoningChars = 0;

  /** True when the stream is currently inside a think block. */
  get thinking(): boolean {
    return this.inside;
  }

  /** How much think content this filter has swallowed, for the trace. */
  get suppressed(): number {
    return this.reasoningChars;
  }

  /** Text safe to forward now. May be empty. */
  push(delta: string): string {
    let buf = this.held + delta;
    this.held = '';
    let out = '';

    for (;;) {
      if (!this.inside) {
        const open = buf.indexOf(THINK_OPEN);
        if (open >= 0) {
          out += buf.slice(0, open);
          buf = buf.slice(open + THINK_OPEN.length);
          this.inside = true;
          continue;
        }
        const hold = heldSuffixLength(buf, THINK_OPEN);
        out += hold ? buf.slice(0, buf.length - hold) : buf;
        this.held = hold ? buf.slice(buf.length - hold) : '';
        return out;
      }

      const close = buf.indexOf(THINK_CLOSE);
      if (close >= 0) {
        this.reasoningChars += close;
        buf = buf.slice(close + THINK_CLOSE.length);
        this.inside = false;
        continue;
      }
      const hold = heldSuffixLength(buf, THINK_CLOSE);
      this.reasoningChars += buf.length - hold;
      this.held = hold ? buf.slice(buf.length - hold) : '';
      return out;
    }
  }

  /** Whatever is safe to forward at stream end. */
  flush(): string {
    const held = this.held;
    this.held = '';
    if (this.inside) {
      // Still thinking when the stream ended: the hold-back is think content.
      this.reasoningChars += held.length;
      return '';
    }
    return held;
  }

  /** Longest hold-back this filter will ever apply, for reasoning about latency. */
  static get maxHoldBack(): number {
    return MAX_HOLD - 1;
  }
}
