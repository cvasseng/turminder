import { errMessage } from './errors.js';
import { log } from './logger.js';

const l = log('background');

/**
 * Work that nobody waits for — naming a conversation, tidying up — but that
 * still has to finish before the process tears the database out from under it.
 *
 * Fire-and-forget without this is how you get "the database connection is not
 * open" after shutdown: the promise outlives the service that owned its state.
 */
export class BackgroundTasks {
  private readonly pending = new Set<Promise<unknown>>();
  private stopped = false;

  get size(): number {
    return this.pending.size;
  }

  /** Starts tracked work. Failures are logged, never thrown at the caller. */
  run(label: string, fn: () => Promise<unknown>): void {
    if (this.stopped) {
      l.debug({ label }, 'not starting background work during shutdown');
      return;
    }
    const task = fn()
      .catch((e: unknown) => l.warn({ label, err: errMessage(e) }, 'background task failed'))
      .finally(() => this.pending.delete(task));
    this.pending.add(task);
  }

  /** Waits for everything in flight. Called before the database is closed. */
  async drain(timeoutMs = 30_000): Promise<void> {
    if (!this.pending.size) return;
    const waiting = this.pending.size;
    const timeout = new Promise<'timeout'>((resolve) =>
      setTimeout(() => resolve('timeout'), timeoutMs).unref?.(),
    );
    const outcome = await Promise.race([Promise.allSettled([...this.pending]), timeout]);
    if (outcome === 'timeout') {
      l.warn({ waiting: this.pending.size }, 'background tasks did not finish in time');
    } else {
      l.debug({ drained: waiting }, 'background tasks finished');
    }
  }

  /** No new work after this; in-flight work still drains. */
  async stop(timeoutMs = 30_000): Promise<void> {
    this.stopped = true;
    await this.drain(timeoutMs);
  }
}
