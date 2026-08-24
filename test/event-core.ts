import path from 'node:path';
import { Config, DEFAULT_SETTINGS, type Settings } from '../src/core/config.js';
import { openDataHome } from '../src/core/datadir.js';
import { openDb, type Db } from '../src/db/index.js';
import { createRepos, type Repos } from '../src/db/repos/index.js';
import { EventIntake } from '../src/ingress/intake.js';
import { WorkQueue, type EventProcessor, type WorkQueueOptions } from '../src/ingress/queue.js';
import { tmpDir } from './helpers.js';

export interface Harness {
  db: Db;
  repos: Repos;
  intake: EventIntake;
  settings: Settings;
  config: Config;
  dir: string;
  queue(processor: EventProcessor, opts?: Partial<WorkQueueOptions>): WorkQueue;
  cleanup(): Promise<void>;
}

/** A data home + database + intake, wired like the real service but disposable. */
export function harness(overrides: Partial<Settings> = {}): Harness {
  const t = tmpDir('turminder-events-');
  const { home } = openDataHome(path.join(t.dir, 'home'));
  const db = openDb(home.dbPath);
  const repos = createRepos(db);
  const settings: Settings = { ...DEFAULT_SETTINGS, ...overrides };
  const intake = new EventIntake(repos, settings);
  const queues: WorkQueue[] = [];

  return {
    db,
    repos,
    intake,
    settings,
    config: new Config(home),
    dir: home.root,
    queue(processor, opts = {}) {
      const q = new WorkQueue(repos, processor, {
        retryAttempts: settings.retryAttempts,
        retryBackoffS: settings.retryBackoffS,
        pollMs: 20,
        ...opts,
      });
      intake.onEvent(() => q.notify());
      queues.push(q);
      return q;
    },
    async cleanup() {
      for (const q of queues) await q.stop();
      db.close();
      t.cleanup();
    },
  };
}
