import path from 'node:path';
import chokidar, { type FSWatcher } from 'chokidar';
import { log } from '../core/logger.js';
import { errMessage } from '../core/errors.js';
import { globMatchAny } from '../core/glob.js';
import { nowIso } from '../core/time.js';
import type { BackgroundTasks } from '../core/background.js';
import type { EventIntake } from '../ingress/intake.js';
import type { FilesIndex } from '../rag/files-index.js';
import { extractMarkers } from './markers.js';
import type { FileChange, FileStore } from './store.js';
import type { SnapshotStore } from './snapshots.js';

const l = log('files');

export interface WatchSettings {
  quiescenceS: number;
  markers: string[];
  watchRateLimitS: number;
}

export interface FileWatcherDeps {
  store: FileStore;
  snapshots: SnapshotStore;
  index: FilesIndex;
  intake: EventIntake;
  /** Which handlers subscribed to which paths (G.7, tier 3). */
  watchPatterns: () => string[];
  /** Read per settle, so a config reload takes effect without a restart. */
  settings: () => WatchSettings;
  background: BackgroundTasks;
  /** Told about every change the store or the user made, for the UI panel. */
  onChange?(rel: string, change: FileChange): void;
}

/**
 * The watcher (§18.4). A raw save is never an event: the only paths from "file
 * changed" to "LLM invoked" are a deliberate marker or an explicit handler
 * subscription, and both sit behind three gates — quiescence, content hash, and
 * the store's own writes.
 *
 * Tier 1, the default consequence of editing a file, is a background reindex.
 * An autosaving editor therefore generates zero ingress traffic out of the box,
 * which is a structural property here rather than a throttle.
 */
export class FileWatcher {
  private watcher: FSWatcher | null = null;
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private readonly lastChangedEmit = new Map<string, number>();
  private readonly coalescing = new Map<string, NodeJS.Timeout>();
  private stopped = false;

  constructor(private readonly deps: FileWatcherDeps) {}

  /**
   * Baseline first, then watch. Files we have never seen are recorded without
   * firing anything — a vault full of old markers must not detonate on first
   * start — while a file that changed while the service was down is a real
   * change and is processed as one.
   */
  async start(): Promise<void> {
    if (this.watcher) return;
    this.deps.store.ensure();
    await this.baseline();

    this.watcher = chokidar.watch(this.deps.store.root, {
      ignoreInitial: true,
      ignored: (target: string) => {
        const rel = this.relative(target);
        return rel === null ? false : this.deps.store.ignored(rel);
      },
      awaitWriteFinish: { stabilityThreshold: 200, pollInterval: 50 },
    });
    const touched = (target: string) => this.schedule(target);
    this.watcher.on('add', touched).on('change', touched).on('unlink', touched);
    l.info(
      { dir: this.deps.store.root, quiescence_s: this.deps.settings().quiescenceS },
      'watching the file store',
    );
  }

  async stop(): Promise<void> {
    this.stopped = true;
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    for (const timer of this.coalescing.values()) clearTimeout(timer);
    this.coalescing.clear();
    await this.watcher?.close();
    this.watcher = null;
  }

  /** Paths waiting out their quiescence window. Inspected by tests and doctor. */
  get pending(): number {
    return this.timers.size;
  }

  private relative(target: string): string | null {
    const rel = path.relative(this.deps.store.root, target);
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
    return rel.split(path.sep).join('/');
  }

  /**
   * Tier 0, first gate: nothing is looked at until the file has been quiet for
   * `files.quiescence_s`. An editor writing every two seconds resets this timer
   * every two seconds, so it never fires mid-edit.
   */
  private schedule(target: string): void {
    const rel = this.relative(target);
    if (rel === null || this.deps.store.ignored(rel)) return;
    const existing = this.timers.get(rel);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(
      () => {
        this.timers.delete(rel);
        void this.settle(rel);
      },
      Math.max(0, this.deps.settings().quiescenceS * 1000),
    );
    timer.unref?.();
    this.timers.set(rel, timer);
  }

  /**
   * One file has gone quiet. Everything from here is the consequence chain of
   * §18.4, in order: hash gate, marker extraction, reindex, subscriptions.
   * Exposed so tests can drive a settled file without waiting 30 seconds.
   */
  async settle(rel: string): Promise<void> {
    if (this.stopped || this.deps.store.ignored(rel)) return;
    const { snapshots, store, index } = this.deps;
    const previous = snapshots.get(rel);

    if (!store.exists(rel)) {
      if (previous) {
        snapshots.forget(rel);
        this.deps.background.run('files:index', () => index.indexOne(rel, null));
        this.deps.onChange?.(rel, 'deleted');
        this.notifySubscribers(rel, 'deleted');
      }
      return;
    }

    const file = store.readText(rel);
    if (!file) {
      // Binary: stored, listed, never indexed and never read into context.
      this.deps.onChange?.(rel, previous ? 'modified' : 'created');
      return;
    }

    // Second gate: mtime lies, content does not. This is also self-write
    // suppression — the store records its own writes as snapshots, so by the
    // time the watcher looks, the assistant's edit is not a change.
    if (previous?.hash === file.hash) return;

    const settings = this.deps.settings();
    const hits = extractMarkers(rel, previous?.content ?? null, file.content, settings.markers);
    snapshots.record(rel, file.content, nowIso());

    // Tier 1: the default consequence of an edit, at background priority.
    this.deps.background.run('files:index', () => index.indexOne(rel, file.content));
    this.deps.onChange?.(rel, previous ? 'modified' : 'created');

    // Tier 2: a deliberate marker is the one thing that becomes an event.
    for (const hit of hits) {
      const result = this.deps.intake.submit({
        type: 'file.request',
        source: 'files',
        payload: { path: rel, line: hit.line, text: hit.text, context: hit.context },
        idempotency_key: hit.key,
        serialization_key: rel,
      });
      l.info({ path: rel, line: hit.line, status: result.status }, 'file marker request');
    }

    // Tier 3: opt-in handler subscriptions.
    this.notifySubscribers(rel, previous ? 'modified' : 'created', file.hash);
  }

  /**
   * `file.changed` for subscribed handlers, rate-limited per file and
   * **coalescing, not queueing** (§18.4): file events are state-based, so the
   * handler reads the file as it is now and a collapsed intermediate loses
   * nothing.
   */
  private notifySubscribers(rel: string, change: FileChange, hash?: string): void {
    const patterns = this.deps.watchPatterns();
    if (!patterns.length || !globMatchAny(patterns, rel)) return;

    const limitMs = this.deps.settings().watchRateLimitS * 1000;
    const last = this.lastChangedEmit.get(rel) ?? 0;
    const waited = Date.now() - last;
    if (waited < limitMs) {
      if (this.coalescing.has(rel)) return; // already scheduled; latest state wins
      const timer = setTimeout(() => {
        this.coalescing.delete(rel);
        const current = this.deps.store.readText(rel);
        this.emitChanged(
          rel,
          this.deps.store.exists(rel) ? 'modified' : 'deleted',
          current?.hash,
        );
      }, limitMs - waited);
      timer.unref?.();
      this.coalescing.set(rel, timer);
      l.debug({ path: rel, in_ms: limitMs - waited }, 'file.changed coalesced');
      return;
    }
    this.emitChanged(rel, change, hash);
  }

  private emitChanged(rel: string, change: FileChange, hash?: string): void {
    this.lastChangedEmit.set(rel, Date.now());
    this.deps.intake.submit({
      type: 'file.changed',
      source: 'files',
      payload: { path: rel, change },
      idempotency_key: `${rel}:${hash ?? change}`,
      serialization_key: rel,
    });
  }

  /** Snapshot every text file, and forget what is gone. Emits nothing. */
  private async baseline(): Promise<void> {
    const { store, snapshots } = this.deps;
    const known = new Set(snapshots.paths());
    const changed: string[] = [];
    for (const entry of store.list()) {
      const file = store.readText(entry.path);
      if (!file) continue;
      const previous = snapshots.get(entry.path);
      if (!previous) {
        snapshots.record(entry.path, file.content, nowIso());
        known.delete(entry.path);
        continue;
      }
      known.delete(entry.path);
      if (previous.hash !== file.hash) changed.push(entry.path);
    }
    for (const gone of known) {
      snapshots.forget(gone);
      this.deps.background.run('files:index', () => this.deps.index.indexOne(gone, null));
    }

    // Edited while we were not running: a real change, handled as one.
    for (const rel of changed) {
      try {
        await this.settle(rel);
      } catch (e) {
        l.warn({ path: rel, err: errMessage(e) }, 'settling a file changed offline failed');
      }
    }
    if (changed.length || known.size) {
      l.info({ changed: changed.length, removed: known.size }, 'file store baseline');
    }
  }
}
