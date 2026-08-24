import chokidar, { type FSWatcher } from 'chokidar';
import { log } from '../core/logger.js';
import { errMessage } from '../core/errors.js';
import type { DataHome } from '../core/datadir.js';
import type { RagIndex } from './index-store.js';

const l = log('rag');

/**
 * Reindex when the memory files change (§8.3) — including when the user edits
 * them by hand, which is the whole point of a markdown store.
 */
export class MemoryWatcher {
  private watcher: FSWatcher | null = null;
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly home: DataHome,
    private readonly index: RagIndex,
    private readonly debounceMs = 500,
  ) {}

  start(): void {
    if (this.watcher) return;
    this.watcher = chokidar.watch(this.home.memoryDir, {
      ignoreInitial: true,
      awaitWriteFinish: { stabilityThreshold: 200, pollInterval: 50 },
    });
    const onChange = () => this.schedule();
    this.watcher.on('add', onChange).on('change', onChange).on('unlink', onChange);
    l.debug({ dir: this.home.memoryDir }, 'watching memory files');
  }

  private schedule(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.index
        .sync()
        .then((r) => l.info(r, 'reindexed memory after a file change'))
        .catch((e) => l.warn({ err: errMessage(e) }, 'reindex failed'));
    }, this.debounceMs);
    this.timer.unref?.();
  }

  async stop(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    await this.watcher?.close();
    this.watcher = null;
  }
}
