import type { FileChange } from './store.js';

export interface FileChanged {
  path: string;
  change: FileChange;
}

/**
 * Fan-out for file-store changes, with no idea what a socket is — the UI panel
 * subscribes here so an open file list does not go stale under the user.
 * Transient like the chat stream: the durable record is the git history.
 */
export class FileEvents {
  private readonly listeners = new Set<(e: FileChanged) => void>();

  subscribe(listener: (e: FileChanged) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  changed(e: FileChanged): void {
    for (const listener of this.listeners) listener(e);
  }
}
