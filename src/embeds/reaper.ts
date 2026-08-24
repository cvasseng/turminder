import { log } from '../core/logger.js';
import { errMessage } from '../core/errors.js';
import type { EmbedStore } from './store.js';

const l = log('embeds');

const DAY_MS = 24 * 3600 * 1000;

export interface EmbedReaperDeps {
  store: EmbedStore;
  /** Read per sweep, so editing `embed_ttl_days` takes effect without a restart. */
  ttlDays: () => number;
  now?: () => Date;
}

export interface ReapResult {
  reaped: string[];
  handlersRemoved: string[];
  orphanedBindings: string[];
}

/**
 * The daily reaper (§22.1). What it protects against is a data dir that fills
 * with scratch dashboards nobody will open again — and, just as much, a
 * graveyard of handlers bound to embeds that no longer exist.
 *
 * Both clocks have to be quiet: `updated_at` and `last_served_at`. Serving from
 * *any* conversation bumps the second one, so an embed in active use never
 * reaps regardless of where it was born.
 */
export class EmbedReaper {
  private timer: NodeJS.Timeout | null = null;
  private readonly now: () => Date;

  constructor(private readonly deps: EmbedReaperDeps) {
    this.now = deps.now ?? (() => new Date());
  }

  sweep(): ReapResult {
    const cutoff = new Date(this.now().getTime() - this.deps.ttlDays() * DAY_MS).toISOString();
    const reaped: string[] = [];
    const handlersRemoved: string[] = [];
    for (const row of this.deps.store.repo.reapable(cutoff)) {
      handlersRemoved.push(...this.deps.store.destroy(row, 'reap'));
      reaped.push(row.id);
    }
    // Repair after reaping, not before: a crash mid-cascade leaves exactly the
    // orphan this catches, and doing it in this order fixes it on the next run.
    const orphanedBindings = this.deps.store.repairOrphanedBindings();
    if (reaped.length || orphanedBindings.length) {
      l.info({ reaped: reaped.length, handlersRemoved, orphanedBindings }, 'reaped embeds');
    }
    return { reaped, handlersRemoved, orphanedBindings };
  }

  start(intervalMs = DAY_MS): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      try {
        this.sweep();
      } catch (e) {
        // A failed sweep is a full data dir eventually, never a dead service.
        l.warn({ err: errMessage(e) }, 'embed reap sweep failed');
      }
    }, intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
