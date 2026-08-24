import type { Command } from 'commander';
import { bootstrap } from '../app.js';
import { UserFacingError } from '../core/errors.js';
import { Service } from '../service.js';
import { globalOpts } from './common.js';

const out = (s: string) => process.stdout.write(`${s}\n`);

/**
 * External sources (§4.3): what is activated, what is watched, and a manual
 * poll. Activation itself lives in chat (§19.5) — this is the inspection window.
 */
export function registerSourcesCommand(program: Command): void {
  const sources = program
    .command('sources')
    .alias('integrations')
    .description('inspect activated integrations and their event sources');

  sources
    .command('status')
    .description('report configured sources and their cursors')
    .action(async (_opts, cmd: Command) => {
      const app = bootstrap(globalOpts(cmd));
      const service = new Service(app, { sweepMs: 0, watchMemory: false, runSources: false });
      try {
        await service.start();
        out(
          JSON.stringify(
            service.sources.status.map((s) => ({
              ...s,
              cursor: service.repos.meta.cursor(
                s.name === 'asana' ? 'asana.inbox' : 'google.calendar',
              ),
            })),
            null,
            2,
          ),
        );
      } finally {
        await service.stop();
        app.close();
      }
    });

  sources
    .command('poll [name]')
    .description('run one poll now, for one source or all of them')
    .option('--no-process', 'emit the events but do not wait for them to be processed')
    .option('--wait <seconds>', 'how long to wait for processing', '600')
    .action(
      async (
        name: string | undefined,
        opts: { process: boolean; wait: string },
        cmd: Command,
      ) => {
        const app = bootstrap(globalOpts(cmd));
        const service = new Service(app, { sweepMs: 0, watchMemory: false, runSources: false });
        try {
          await service.start();
          const chosen = name
            ? service.sources.sources.filter((s) => s.name.includes(name))
            : service.sources.sources;
          if (!chosen.length) {
            throw new UserFacingError(
              'not_found',
              name ? `no enabled source matching "${name}"` : 'no sources are enabled',
              'activate one from chat ("set up asana"), or check `turminder sources status`',
            );
          }
          for (const source of chosen) {
            const emitted = await source.tick();
            out(`${source.name}: ${emitted} event(s)`);
          }
          if (opts.process) await service.queue.drain(Number(opts.wait) * 1000);
        } finally {
          await service.stop();
          app.close();
        }
      },
    );
}
