import type { Command } from 'commander';
import { bootstrap } from '../app.js';
import { UserFacingError } from '../core/errors.js';
import {
  driftedShippedAssets,
  refreshShippedAssets,
  SHIPPED_ASSETS,
} from '../prompts/shipped.js';
import { globalOpts } from './common.js';

const out = (s: string) => process.stdout.write(`${s}\n`);

/**
 * Shipped assets (§12.3). Turminder keeps its own copies current on its own;
 * this is the door for the ones it declined to touch — a file whose bytes
 * differ from the library with nothing on record to say who wrote them.
 */
export function registerAssetsCommand(program: Command): void {
  const assets = program
    .command('assets')
    .description('shipped skills and handlers, and which of them have drifted');

  assets
    .command('list', { isDefault: true })
    .description('list shipped assets and whether each still matches the library')
    .action((_opts, cmd: Command) => {
      const app = bootstrap(globalOpts(cmd));
      try {
        const drifted = new Map(driftedShippedAssets(app.home).map((d) => [d.path, d.reason]));
        for (const asset of SHIPPED_ASSETS) {
          const reason = drifted.get(asset.path);
          out(`${asset.path}  ${reason ? `[differs: ${reason}]` : '[current]'}`);
        }
        if (drifted.size) {
          out(
            `\n${drifted.size} asset(s) differ from the shipped version and are left alone.\n` +
              'edited: you changed it, and it outranks ours permanently.\n' +
              'unknown: installed before the manifest recorded hashes, so we cannot tell.\n' +
              'Take the shipped version with: turminder assets refresh <path>',
          );
        }
      } finally {
        app.close();
      }
    });

  assets
    .command('refresh [paths...]')
    .description('overwrite named shipped assets with the version this build ships')
    .option('--all', 'refresh every shipped asset that currently differs')
    .action((paths: string[], opts: { all?: boolean }, cmd: Command) => {
      const app = bootstrap(globalOpts(cmd));
      try {
        // `--all` is a typed choice, never a default: this is the one command
        // that may overwrite something the user wrote (§12.3).
        if (!paths.length && !opts.all) {
          throw new UserFacingError(
            'no_target',
            'name the assets to refresh, or pass --all',
            'turminder assets list shows which ones differ.',
          );
        }
        const targets = opts.all
          ? driftedShippedAssets(app.home).map((d) => d.path)
          : [...new Set(paths)];
        if (!targets.length) {
          out('nothing to refresh: every shipped asset already matches the library');
          return;
        }
        const { refreshed, unknown } = refreshShippedAssets(app.home, targets);
        for (const p of refreshed) out(`refreshed ${p}`);
        if (unknown.length) {
          out(`\nnot shipped by this build, so left alone:\n  ${unknown.join('\n  ')}`);
          process.exitCode = 1;
        }
      } finally {
        app.close();
      }
    });
}
