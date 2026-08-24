import type { Command } from 'commander';
import { bootstrap } from '../app.js';
import { UserFacingError } from '../core/errors.js';
import { createRepos } from '../db/repos/index.js';
import { EmbedStore } from '../embeds/store.js';
import { globalOpts } from './common.js';

const out = (s: string) => process.stdout.write(`${s}\n`);

/**
 * Embed inspection and link revocation (§22.3.4). `rotate` is the answer to "I
 * pasted that link somewhere I shouldn't have": it changes what every
 * outstanding scoped token hashes against, and costs nothing but a re-resolve.
 */
export function registerEmbedsCommand(program: Command): void {
  const embeds = program.command('embeds').description('inspect embeds and revoke their links');

  const open = (cmd: Command) => {
    const app = bootstrap(globalOpts(cmd));
    const store = new EmbedStore({
      home: app.home,
      config: app.config,
      repo: createRepos(app.db).embeds,
    });
    return { app, store };
  };

  embeds
    .command('list', { isDefault: true })
    .description('list embeds, newest first')
    .action((_opts, cmd: Command) => {
      const { app, store } = open(cmd);
      try {
        const rows = store.repo.list({ limit: 200 });
        if (!rows.length) {
          out('no embeds');
          return;
        }
        for (const row of rows) {
          out(`${row.id}  ${row.kind.padEnd(10)} ${row.title}`);
          out(`  updated ${row.updated_at}  served ${row.last_served_at ?? 'never'}`);
        }
      } finally {
        app.close();
      }
    });

  embeds
    .command('rotate <id>')
    .description('revoke every outstanding link to an embed and print the new one')
    .action((id: string, _opts, cmd: Command) => {
      const { app, store } = open(cmd);
      try {
        const result = store.rotate(id);
        if ('error' in result) throw new UserFacingError(result.error, result.message);
        out(`generation ${result.token_generation}`);
        out(result.url);
      } finally {
        app.close();
      }
    });
}
