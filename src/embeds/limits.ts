/**
 * Per-embed rate limits (§22.4, App. A). Enforced server-side because the
 * client is LLM-authored: a loop in generated JS must hit the limiter first and
 * `MAX_DEPTH` only second, or one bad `setInterval` becomes an event storm.
 */
export interface TokenBucketOptions {
  /** Sustained rate, tokens per second. */
  ratePerS: number;
  /** How many may be spent at once. */
  burst: number;
  now?: () => number;
}

interface BucketState {
  tokens: number;
  at: number;
}

export class TokenBuckets {
  private readonly buckets = new Map<string, BucketState>();
  private readonly now: () => number;

  constructor(private readonly opts: TokenBucketOptions) {
    this.now = opts.now ?? (() => Date.now());
  }

  /** Spend one token. False means over the limit — the caller answers 429. */
  take(key: string): boolean {
    const at = this.now();
    const state = this.buckets.get(key) ?? { tokens: this.opts.burst, at };
    const refilled = Math.min(
      this.opts.burst,
      state.tokens + ((at - state.at) / 1000) * this.opts.ratePerS,
    );
    if (refilled < 1) {
      // Keep the clock moving even on a refusal, so a hammering client still
      // recovers at the sustained rate rather than never.
      this.buckets.set(key, { tokens: refilled, at });
      return false;
    }
    this.buckets.set(key, { tokens: refilled - 1, at });
    return true;
  }

  /** Drops state for an embed that no longer exists. */
  forget(key: string): void {
    this.buckets.delete(key);
  }
}
