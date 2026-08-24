import os from 'node:os';
import type { Command } from 'commander';
import { bootstrap } from '../app.js';
import { connectBase, connectQrAnsi, connectUrl } from '../core/connect.js';
import { log } from '../core/logger.js';
import { HttpServer } from '../net/http.js';
import { Service } from '../service.js';
import { globalOpts } from './common.js';

const l = log('serve');

/**
 * Where the server can actually be reached. A wildcard bind logs as
 * "0.0.0.0", which is not an address anyone can type into a phone — so
 * enumerate the real interfaces and name them instead.
 */
function reachableUrls(host: string, port: number): string[] {
  if (host !== '0.0.0.0' && host !== '::') return [`http://${host}:${port}/`];
  const urls = [`http://127.0.0.1:${port}/`];
  for (const addrs of Object.values(os.networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family === 'IPv4' && !a.internal) urls.push(`http://${a.address}:${port}/`);
    }
  }
  return urls;
}

export function registerServeCommand(program: Command): void {
  program
    .command('serve', { isDefault: true })
    .description('run the assistant (default command)')
    .action(async (_opts, cmd: Command) => {
      const app = bootstrap(globalOpts(cmd));
      if (app.newUiToken) {
        l.info(
          { token: app.newUiToken },
          'ui device token generated — paste this into the web UI once (shown only now)',
        );
        // The same value as something a phone can scan (§24.3). This is the
        // one print the token ever gets; the config keeps only its hash.
        const settings = app.config.settings;
        const base = connectBase(settings.gatewayPublicUrl, settings.bind);
        const url = connectUrl(base.base_url, app.newUiToken, 'ui');
        process.stdout.write(`\n${await connectQrAnsi(url)}\n${url}\n`);
        if (base.guessed) {
          process.stdout.write(
            "address guessed from this machine's interfaces — set gateway.public_url if the scan cannot reach it\n\n",
          );
        }
      }
      const service = new Service(app);
      await service.start();
      const http = new HttpServer(service);
      const { host, port } = await http.listen();

      const identity = app.config.identity();
      const urls = reachableUrls(host, port);
      if (host === '0.0.0.0' || host === '::') {
        l.warn(
          { bind: `${host}:${port}`, urls },
          'listening on every interface — the device token is the only thing between the network and this assistant, and it travels unencrypted',
        );
      }
      l.info(
        {
          url: urls[urls.length - 1],
          urls,
          configured: service.configured,
          instance: identity?.frontmatter.instance_name ?? null,
          next: !service.configured
            ? 'open the url to run setup'
            : identity
              ? 'ready'
              : 'open the url to finish onboarding',
        },
        'turminder is up',
      );

      await new Promise<void>((resolve) => {
        const stop = (sig: string) => {
          l.info({ sig }, 'shutting down');
          void (async () => {
            await http.close();
            await service.stop();
            app.close();
            resolve();
          })();
        };
        process.once('SIGINT', () => stop('SIGINT'));
        process.once('SIGTERM', () => stop('SIGTERM'));
      });
    });
}
