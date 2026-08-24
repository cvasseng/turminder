import type { Command } from 'commander';
import { bootstrap } from '../app.js';
import { UserFacingError } from '../core/errors.js';
import { createRepos } from '../db/repos/index.js';
import { globalOpts } from './common.js';

const out = (s: string) => process.stdout.write(`${s}\n`);

/** Scheduled events (§6) — what the assistant is waiting to do. */
export function registerSchedulesCommand(program: Command): void {
  const schedules = program.command('schedules').description('inspect scheduled events');

  schedules
    .command('list')
    .description('list schedules')
    .option('--all', 'include done, cancelled and missed')
    .action((opts: { all?: boolean }, cmd: Command) => {
      const app = bootstrap(globalOpts(cmd));
      try {
        for (const s of createRepos(app.db).schedules.list({
          includeDone: Boolean(opts.all),
        })) {
          out(
            `${s.fire_at}  ${s.status.padEnd(9)} ${s.id.slice(-8)}  ${s.note}` +
              `${s.rrule ? `  [${s.rrule}]` : ''}`,
          );
        }
      } finally {
        app.close();
      }
    });

  schedules
    .command('cancel <id>')
    .description('cancel a schedule')
    .action((id: string, _opts, cmd: Command) => {
      const app = bootstrap(globalOpts(cmd));
      try {
        const repos = createRepos(app.db);
        const target = repos.schedules
          .list({ includeDone: true })
          .find((s) => s.id.endsWith(id));
        if (!target) throw new UserFacingError('not_found', `no schedule matching "${id}"`);
        if (!repos.schedules.cancel(target.id)) {
          throw new UserFacingError('not_active', `schedule is ${target.status}, not active`);
        }
        out(`cancelled ${target.id}`);
      } finally {
        app.close();
      }
    });
}
