import type { Command } from 'commander';
import { bootstrap } from '../app.js';
import { UserFacingError } from '../core/errors.js';
import { connectBase, connectQrAnsi, connectUrl } from '../core/connect.js';
import { createRepos } from '../db/repos/index.js';
import { globalOpts } from './common.js';

/**
 * Device token management (App. E, §24.1). Together with `setup.token_create`
 * these are the only writers of `config/channels.yaml`, and both go through
 * the store in `core/tokens.ts` — hashing, metadata and the git commit live
 * there so the two flows cannot drift.
 */
export function registerTokenCommand(program: Command): void {
  const token = program.command('token').description('manage device tokens');

  token
    .command('list')
    .description('list registered devices')
    .action((_o, cmd: Command) => {
      const app = bootstrap(globalOpts(cmd));
      // Metadata only — a token value is not recoverable from anything here
      // (§24). `last_seen` is the highest delivery seq the device ever acked,
      // which is what makes a dead device recognizable.
      const lastSeen = createRepos(app.db).deliveries.lastSeenByDevice();
      for (const d of app.tokens.list()) {
        const bits = [
          d.device,
          d.label ?? '',
          d.created_at ?? '',
          `last_seen=${lastSeen[d.device] ?? 0}`,
        ];
        process.stdout.write(`${bits.join('\t')}\n`);
      }
      app.close();
    });

  token
    .command('create <device>')
    .description('create (or rotate) a device token and print it once')
    .option('--label <label>', 'human name for the device, shown in listings')
    .option('--qr', 'also print a scannable connect code (§24.3)')
    .action(async (device: string, opts: { label?: string; qr?: boolean }, cmd: Command) => {
      const app = bootstrap(globalOpts(cmd));
      // Rotation in place: a person at the terminal already holds the data
      // dir, so refusing them a name they own would be ceremony. The model's
      // path (§24.2) refuses instead — it cannot know what it would clobber.
      const created = app.tokens.create(device, {
        ...(opts.label ? { label: opts.label } : {}),
        rotate: true,
      });
      const settings = app.config.settings;
      app.close();
      if ('error' in created) throw new UserFacingError(created.error, created.message);
      // The one moment the value exists (§24). Nothing can print it again.
      process.stdout.write(`${created.token}\n`);
      if (!opts.qr) return;
      // Scanning beats typing 64 hex characters into a phone (§24.3).
      const base = connectBase(settings.gatewayPublicUrl, settings.bind);
      const url = connectUrl(base.base_url, created.token, device);
      process.stdout.write(`\n${await connectQrAnsi(url)}\n${url}\n`);
      if (base.guessed) {
        process.stdout.write(
          "address guessed from this machine's interfaces — set gateway.public_url if the scan cannot reach it\n",
        );
      }
    });

  token
    .command('revoke <device>')
    .description('remove a device token')
    .action((device: string, _o, cmd: Command) => {
      const app = bootstrap(globalOpts(cmd));
      const removed = app.tokens.revoke(device);
      app.close();
      if (!removed) throw new UserFacingError('not_found', `no device named ${device}`);
    });
}
