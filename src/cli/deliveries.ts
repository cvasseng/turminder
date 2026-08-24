import type { Command } from 'commander';
import { bootstrap } from '../app.js';
import { createRepos } from '../db/repos/index.js';
import { globalOpts } from './common.js';

const out = (s: string) => process.stdout.write(`${s}\n`);

/** The outbox (§7.1) — what the assistant tried to tell the user. */
export function registerDeliveriesCommand(program: Command): void {
  program
    .command('deliveries')
    .description('list recent deliveries and their state')
    .option('-n, --limit <n>', 'how many', '20')
    .option('--pending', 'only unacked, unexpired deliveries')
    .action((opts: { limit: string; pending?: boolean }, cmd: Command) => {
      const app = bootstrap(globalOpts(cmd));
      try {
        const repos = createRepos(app.db);
        const rows = opts.pending
          ? repos.deliveries.pending()
          : repos.deliveries.recent(Number(opts.limit)).reverse();
        for (const d of rows) {
          const title = String((d.payload as { title?: string }).title ?? '');
          out(
            `${d.created_at} seq=${String(d.seq).padStart(4)} ${d.intent.padEnd(7)} ` +
              `${d.status.padEnd(9)} ${d.id.slice(-8)}  ${title}` +
              `${d.acked_by ? `  (acked by ${d.acked_by})` : ''}`,
          );
        }
      } finally {
        app.close();
      }
    });
}
