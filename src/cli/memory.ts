import type { Command } from 'commander';
import { bootstrap } from '../app.js';
import { UserFacingError } from '../core/errors.js';
import { MemoryStore } from '../memory/store.js';
import { globalOpts } from './common.js';

const out = (s: string) => process.stdout.write(`${s}\n`);

/** Reading and pruning memory by hand — the files are the source of truth. */
export function registerMemoryCommand(program: Command): void {
  const memory = program.command('memory').description('inspect the memory store');

  memory
    .command('list')
    .description('list stored memories')
    .action((_opts, cmd: Command) => {
      const app = bootstrap(globalOpts(cmd));
      try {
        for (const m of new MemoryStore(app.home).list()) {
          out(`${m.type.padEnd(10)} ${m.name}\n           ${m.description}`);
        }
      } finally {
        app.close();
      }
    });

  memory
    .command('show <name>')
    .description('print one memory in full')
    .action((name: string, _opts, cmd: Command) => {
      const app = bootstrap(globalOpts(cmd));
      try {
        const record = new MemoryStore(app.home).get(name);
        if (!record) throw new UserFacingError('not_found', `no memory named "${name}"`);
        out(JSON.stringify(record, null, 2));
      } finally {
        app.close();
      }
    });
}
