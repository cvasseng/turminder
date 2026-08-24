import fs from 'node:fs';
import type { Command } from 'commander';
import { bootstrap } from '../app.js';
import { UserFacingError } from '../core/errors.js';
import { globalOpts } from './common.js';

const out = (s: string) => process.stdout.write(`${s}\n`);

/**
 * Re-enter onboarding (plan §3c). Deleting the identity files is enough: the
 * next conversation detects their absence. git keeps the old ones recoverable.
 */
export function registerOnboardCommand(program: Command): void {
  program
    .command('onboard')
    .description('inspect or restart onboarding')
    .option('--redo', 'clear identity/personality so the next chat re-onboards')
    .action((opts: { redo?: boolean }, cmd: Command) => {
      const app = bootstrap(globalOpts(cmd));
      try {
        const identity = app.config.identity();
        if (!opts.redo) {
          out(
            JSON.stringify(
              {
                onboarded: identity !== null,
                instance_name: identity?.frontmatter.instance_name ?? null,
                user_name: identity?.frontmatter.user_name ?? null,
                timezone: identity?.frontmatter.timezone ?? null,
              },
              null,
              2,
            ),
          );
          return;
        }
        if (!app.config.models()) {
          throw new UserFacingError(
            'models_unconfigured',
            'onboarding runs on the model layer — run `turminder setup` first',
          );
        }
        let removed = 0;
        for (const file of ['config/identity.md', 'config/personality.md']) {
          const abs = app.home.path(file);
          if (fs.existsSync(abs)) {
            fs.rmSync(abs);
            removed += 1;
          }
        }
        app.home.git.commit('onboarding: reset identity', ['config']);
        app.config.reload();
        out(`cleared ${removed} file(s); the next conversation will re-onboard`);
      } finally {
        app.close();
      }
    });
}
