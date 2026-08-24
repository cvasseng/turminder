import { log } from '../core/logger.js';
import { PRIORITY_RANK, type Priority } from './types.js';

const l = log('scheduler');

interface Waiter {
  seq: number;
  priority: Priority;
  enqueuedAt: number;
  admit: (queueWaitMs: number) => void;
  reject: (err: unknown) => void;
  abortSignal?: AbortSignal;
}

interface EndpointState {
  inFlight: number;
  backgroundInFlight: number;
  concurrency: number;
  queue: Waiter[];
}

export interface RunArgs<T> {
  endpoint: string;
  priority: Priority;
  /** Endpoint slot count (llama.cpp `-np`); defaults to 1. */
  concurrency?: number;
  abortSignal?: AbortSignal;
  /** Called when the call could not start immediately — feedback, not policy. */
  onQueued?: () => void;
  fn: (ctx: { queueWaitMs: number }) => Promise<T>;
}

export interface SchedulerStats {
  endpoint: string;
  inFlight: number;
  queued: number;
  queuedByPriority: Record<Priority, number>;
}

/**
 * Per-endpoint priority queue (§10.3). The GPU is mostly serial, so admission
 * control lives here and nowhere else: every LLM call in the system goes through
 * `run()`, which is also where queue-wait is measured for the trace.
 *
 * Policy (§17.1, flagged for revisit): strict priority, FIFO within a priority,
 * background work additionally capped by `backgroundConcurrency`.
 */
export class InferenceScheduler {
  private readonly states = new Map<string, EndpointState>();
  private seq = 0;

  constructor(private readonly backgroundConcurrency = 1) {}

  private state(endpoint: string, concurrency: number): EndpointState {
    let s = this.states.get(endpoint);
    if (!s) {
      s = { inFlight: 0, backgroundInFlight: 0, concurrency, queue: [] };
      this.states.set(endpoint, s);
    }
    // A later call may know the real slot count (probe result); take the max.
    if (concurrency > s.concurrency) s.concurrency = concurrency;
    return s;
  }

  async run<T>(args: RunArgs<T>): Promise<T> {
    const s = this.state(args.endpoint, args.concurrency ?? 1);
    // acquire() takes the slot; releasing it is this function's job alone.
    const queueWaitMs = await this.acquire(s, args.priority, args.abortSignal, args.onQueued);
    try {
      return await args.fn({ queueWaitMs });
    } finally {
      this.release(s, args.priority);
      this.pump(s);
    }
  }

  private take(s: EndpointState, priority: Priority): void {
    s.inFlight += 1;
    if (priority === 'background') s.backgroundInFlight += 1;
  }

  private release(s: EndpointState, priority: Priority): void {
    s.inFlight -= 1;
    if (priority === 'background') s.backgroundInFlight -= 1;
  }

  private canStart(s: EndpointState, priority: Priority): boolean {
    if (s.inFlight >= s.concurrency) return false;
    if (priority === 'background' && s.backgroundInFlight >= this.backgroundConcurrency) {
      return false;
    }
    return true;
  }

  private acquire(
    s: EndpointState,
    priority: Priority,
    abortSignal?: AbortSignal,
    onQueued?: () => void,
  ): Promise<number> {
    if (abortSignal?.aborted) return Promise.reject(abortSignal.reason ?? new Error('aborted'));
    if (s.queue.length === 0 && this.canStart(s, priority)) {
      this.take(s, priority);
      return Promise.resolve(0);
    }
    onQueued?.();

    return new Promise<number>((resolve, reject) => {
      const waiter: Waiter = {
        seq: this.seq++,
        priority,
        enqueuedAt: Date.now(),
        admit: resolve,
        reject,
        ...(abortSignal ? { abortSignal } : {}),
      };
      s.queue.push(waiter);
      if (abortSignal) {
        abortSignal.addEventListener(
          'abort',
          () => {
            const i = s.queue.indexOf(waiter);
            if (i >= 0) {
              s.queue.splice(i, 1);
              waiter.reject(abortSignal.reason ?? new Error('aborted'));
            }
          },
          { once: true },
        );
      }
      l.debug({ priority, queued: s.queue.length }, 'queued llm call');
      this.pump(s);
    });
  }

  /** Admit as many waiters as the endpoint can take, highest priority first. */
  private pump(s: EndpointState): void {
    for (;;) {
      if (s.queue.length === 0) return;
      const sorted = [...s.queue].sort(
        (a, b) => PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority] || a.seq - b.seq,
      );
      const next = sorted.find((w) => this.canStart(s, w.priority));
      if (!next) return;
      s.queue.splice(s.queue.indexOf(next), 1);
      this.take(s, next.priority);
      next.admit(Date.now() - next.enqueuedAt);
    }
  }

  stats(): SchedulerStats[] {
    return [...this.states.entries()].map(([endpoint, s]) => ({
      endpoint,
      inFlight: s.inFlight,
      queued: s.queue.length,
      queuedByPriority: {
        interactive: s.queue.filter((w) => w.priority === 'interactive').length,
        event: s.queue.filter((w) => w.priority === 'event').length,
        background: s.queue.filter((w) => w.priority === 'background').length,
      },
    }));
  }
}
