import { log } from '../core/logger.js';
import { errMessage } from '../core/errors.js';
import type { UploadStore } from './store.js';

const l = log('uploads');
const DAY_MS = 24 * 3600 * 1000;

export interface UploadReaperDeps {
  store: UploadStore;
  /** Read per sweep, so editing `uploads.ttl_days` needs no restart. */
  ttlDays: () => number;
  now?: () => Date;
}

/**
 * The attachment reaper (§26.1), the same shape as the embed one: uploads are
 * conversation ephemera, and a data dir filling with year-old screenshots is
 * the failure this prevents.
 *
 * A transcript that outlives its attachment renders a placeholder, never an
 * error — which is why the row goes with the file rather than being kept as a
 * tombstone.
 */
export class UploadReaper {
  private readonly now: () => Date;
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly deps: UploadReaperDeps) {
    this.now = deps.now ?? (() => new Date());
  }

  sweep(): { reaped: string[] } {
    const cutoff = new Date(this.now().getTime() - this.deps.ttlDays() * DAY_MS).toISOString();
    const reaped: string[] = [];
    for (const row of this.deps.store.repo.reapable(cutoff)) {
      this.deps.store.destroy(row);
      reaped.push(row.id);
    }
    if (reaped.length) l.info({ reaped: reaped.length }, 'uploads reaped');
    return { reaped };
  }

  start(intervalMs = DAY_MS): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      try {
        this.sweep();
      } catch (e) {
        // A failed sweep is a fuller disk eventually, never a dead service.
        l.warn({ err: errMessage(e) }, 'upload reap sweep failed');
      }
    }, intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
