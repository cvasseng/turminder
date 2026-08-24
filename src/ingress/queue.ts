import { log } from '../core/logger.js';
import { errMessage } from '../core/errors.js';
import { isoPlusSeconds, msUntil, nowIso } from '../core/time.js';
import type { Repos } from '../db/repos/index.js';
import type { EventRecord, EventStatus } from '../db/repos/events.js';

const l = log('queue');

export interface ProcessContext {
  attempt: number;
}

/** Throwing means "this event failed" — retries and dead-lettering are ours. */
export type EventProcessor = (event: EventRecord, ctx: ProcessContext) => Promise<void>;

export interface WorkQueueOptions {
  retryAttempts: number;
  retryBackoffS: number[];
  maxConcurrent?: number;
  pollMs?: number;
  /** Called once an event has exhausted its retries (§13.2). */
  onDeadLetter?: (event: EventRecord, error: string, attempts: number) => void;
}

/**
 * The in-process work queue over SQLite (§4.4). Two invariants it exists to
 * hold: events sharing a serialization_key run strictly in arrival order, and
 * everything else may run in parallel up to a concurrency cap.
 */
export class WorkQueue {
  private running = false;
  private timer: NodeJS.Timeout | null = null;
  private readonly activeKeys = new Set<string>();
  private readonly inFlightIds = new Set<string>();
  private readonly maxConcurrent: number;
  private readonly pollMs: number;
  private ticking = false;
  private idleWaiters: (() => void)[] = [];

  constructor(
    private readonly repos: Repos,
    private readonly processor: EventProcessor,
    private readonly opts: WorkQueueOptions,
  ) {
    this.maxConcurrent = opts.maxConcurrent ?? 4;
    this.pollMs = opts.pollMs ?? 500;
  }

  get inFlight(): number {
    return this.inFlightIds.size;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    const requeued = this.repos.events.requeueOrphaned();
    if (requeued) l.warn({ requeued }, 'requeued events interrupted by a previous run');
    this.schedule(0);
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    await this.idle();
  }

  /** Wake up now — called by intake when an event arrives. */
  notify(): void {
    if (this.running) this.schedule(0);
  }

  /** Resolves when nothing is in flight. */
  idle(): Promise<void> {
    if (this.inFlightIds.size === 0) return Promise.resolve();
    return new Promise((resolve) => this.idleWaiters.push(resolve));
  }

  /**
   * Run until nothing is *runnable* and nothing is in flight. Events waiting out
   * a retry backoff, and events blocked behind an earlier one on their
   * serialization key, are not runnable — draining does not wait for them.
   */
  async drain(timeoutMs = 10_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      await this.tick();
      await this.idle();
      if (!this.claimable() && this.inFlightIds.size === 0) return;
      if (Date.now() > deadline) throw new Error('drain timed out');
      await new Promise((r) => setTimeout(r, 5));
    }
  }

  private schedule(delayMs: number): void {
    if (!this.running) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.tick().then(() => this.scheduleNext());
    }, delayMs);
  }

  /** Sleep until the next retry is due, or the poll interval, whichever is sooner. */
  private scheduleNext(): void {
    if (!this.running) return;
    const nextRetry = this.repos.events.nextRetryAt();
    const untilRetry = nextRetry === null ? Infinity : Math.max(0, msUntil(nextRetry));
    this.schedule(Math.min(this.pollMs, untilRetry));
  }

  private async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      for (;;) {
        if (this.inFlightIds.size >= this.maxConcurrent) return;
        const claimed = this.claimNext();
        if (!claimed) return;
        void this.execute(claimed);
      }
    } finally {
      this.ticking = false;
    }
  }

  /** The next runnable event, respecting per-key ordering. Does not claim it. */
  private claimable(): EventRecord | null {
    const candidates = this.repos.events.eligible(nowIso(), this.maxConcurrent * 8);
    for (const ev of candidates) {
      if (this.inFlightIds.has(ev.id)) continue;
      const key = ev.serialization_key;
      if (key) {
        if (this.activeKeys.has(key)) continue;
        // Strict order: only the oldest pending event for this key may run,
        // including when that event is waiting out a retry backoff (§4.4).
        if (this.repos.events.oldestPending(key) !== ev.id) continue;
      }
      return ev;
    }
    return null;
  }

  /** Pick and claim one runnable event. */
  private claimNext(): EventRecord | null {
    const ev = this.claimable();
    if (!ev) return null;
    const attempts = ev.attempts + 1;
    this.transition(ev, 'processing', { attempts });
    if (ev.serialization_key) this.activeKeys.add(ev.serialization_key);
    this.inFlightIds.add(ev.id);
    return { ...ev, status: 'processing', attempts };
  }

  private async execute(event: EventRecord): Promise<void> {
    try {
      await this.processor(event, { attempt: event.attempts });
      this.transition(event, 'done', { last_error: null, next_attempt_at: null });
    } catch (e) {
      this.onFailure(event, errMessage(e));
    } finally {
      this.inFlightIds.delete(event.id);
      if (event.serialization_key) this.activeKeys.delete(event.serialization_key);
      if (this.inFlightIds.size === 0) {
        const waiters = this.idleWaiters;
        this.idleWaiters = [];
        for (const w of waiters) w();
      }
      if (this.running) this.schedule(0);
    }
  }

  private onFailure(event: EventRecord, error: string): void {
    const attempts = event.attempts;
    if (attempts >= this.opts.retryAttempts) {
      this.transition(event, 'dead_letter', { last_error: error, next_attempt_at: null });
      l.error({ id: event.id, type: event.type, attempts, error }, 'event dead-lettered');
      this.repos.trace.append('error', { message: error, attempts }, { eventId: event.id });
      this.opts.onDeadLetter?.(event, error, attempts);
      return;
    }
    const backoff =
      this.opts.retryBackoffS[Math.min(attempts - 1, this.opts.retryBackoffS.length - 1)] ?? 60;
    const nextAt = isoPlusSeconds(backoff);
    this.transition(event, 'failed', { last_error: error, next_attempt_at: nextAt });
    l.warn({ id: event.id, attempts, retry_in_s: backoff, error }, 'event failed, will retry');
    this.repos.trace.append(
      'error',
      { message: error, attempts, retry_at: nextAt },
      {
        eventId: event.id,
      },
    );
  }

  private transition(
    event: EventRecord,
    to: EventStatus,
    extra: {
      attempts?: number;
      next_attempt_at?: string | null;
      last_error?: string | null;
    } = {},
  ): void {
    this.repos.events.setStatus(event.id, to, extra);
    this.repos.trace.append('state', { from: event.status, to }, { eventId: event.id });
  }
}
