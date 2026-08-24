import { log } from '../core/logger.js';
import { errMessage } from '../core/errors.js';
import type { MetaRepo } from '../db/repos/meta.js';
import type { EventIntake, SubmitInput } from './intake.js';

const l = log('source');

export interface PollResult {
  /** Events to submit; idempotency keys keep re-polling harmless. */
  events: SubmitInput[];
  /** Opaque cursor to persist for the next poll. */
  cursor?: string | null;
}

export interface SourceDeps {
  intake: EventIntake;
  meta: MetaRepo;
}

/**
 * A source is a poller that turns external state into events (§4.3). Cursors
 * are durable, failures are logged rather than fatal, and every emitted event
 * carries an idempotency key so a repeated poll cannot duplicate work.
 */
export abstract class PollingSource {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private inFlight = false;
  private failures = 0;

  constructor(
    readonly name: string,
    protected readonly deps: SourceDeps,
    private readonly intervalMs: number,
  ) {}

  /** One pass over the external system. Return events plus the next cursor. */
  protected abstract poll(cursor: string | null): Promise<PollResult>;

  /** Optional readiness check; a source that is not ready never polls. */
  protected async ready(): Promise<{ ok: boolean; reason?: string }> {
    return { ok: true };
  }

  async start(): Promise<void> {
    if (this.running) return;
    const readiness = await this.ready();
    if (!readiness.ok) {
      l.warn({ source: this.name, reason: readiness.reason }, 'source not started');
      return;
    }
    this.running = true;
    l.info(
      { source: this.name, every_s: Math.round(this.intervalMs / 1000) },
      'source started',
    );
    this.schedule(0);
  }

  stop(): void {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  /** Run one poll now. Returns how many events were accepted. */
  async tick(): Promise<number> {
    if (this.inFlight) return 0;
    this.inFlight = true;
    try {
      const cursor = this.deps.meta.cursor(this.name);
      const result = await this.poll(cursor);
      let accepted = 0;
      for (const event of result.events) {
        const submitted = this.deps.intake.submit(event);
        if (submitted.status === 'accepted') accepted += 1;
      }
      // Cursor last: a crash mid-poll re-emits, and dedupe absorbs it.
      if (result.cursor !== undefined && result.cursor !== null) {
        this.deps.meta.setCursor(this.name, result.cursor);
      }
      if (accepted) l.info({ source: this.name, accepted }, 'source emitted events');
      this.failures = 0;
      return accepted;
    } catch (e) {
      this.failures += 1;
      l.warn(
        { source: this.name, err: errMessage(e), consecutive_failures: this.failures },
        'source poll failed',
      );
      return 0;
    } finally {
      this.inFlight = false;
    }
  }

  private schedule(delayMs: number): void {
    if (!this.running) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.tick().then(() => this.schedule(this.backoff()));
    }, delayMs);
    this.timer.unref?.();
  }

  /** Back off on repeated failure so a dead API is not hammered. */
  private backoff(): number {
    if (this.failures === 0) return this.intervalMs;
    return Math.min(this.intervalMs * 2 ** Math.min(this.failures, 5), 30 * 60_000);
  }
}
