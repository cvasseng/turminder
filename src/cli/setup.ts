import type { Command } from 'commander';
import { bootstrap } from '../app.js';
import { UserFacingError } from '../core/errors.js';
import { probeEndpoint } from '../model/probe.js';
import { handleCommit } from '../net/setup-api.js';
import { Service } from '../service.js';
import { globalOpts } from './common.js';

const out = (s: string) => process.stdout.write(`${s}\n`);

/** Headless equivalent of the setup page (plan §3b). */
export function registerSetupCommand(program: Command): void {
  program
    .command('setup')
    .description('probe an OpenAI-compatible endpoint and write config/models.yaml')
    .requiredOption('--url <url>', 'endpoint base url, e.g. http://localhost:8080')
    .option('--name <name>', 'endpoint name in models.yaml', 'main')
    .option('--api-key <key>', 'bearer token for the endpoint')
    .option('--probe-only', 'report the probe result without writing anything')
    .action(
      async (
        opts: { url: string; name: string; apiKey?: string; probeOnly?: boolean },
        cmd: Command,
      ) => {
        const app = bootstrap(globalOpts(cmd));
        try {
          const probe = await probeEndpoint(opts.url, {
            ...(opts.apiKey ? { apiKey: opts.apiKey } : {}),
            timeoutMs: 120_000,
          });
          out(JSON.stringify(probe, null, 2));
          if (!probe.reachable) {
            throw new UserFacingError(
              'endpoint_unreachable',
              probe.error ?? 'endpoint unreachable',
            );
          }
          if (!probe.checks.completion) {
            throw new UserFacingError(
              'endpoint_unusable',
              'the endpoint is reachable but produced no completion',
            );
          }
          for (const note of probe.notes) process.stderr.write(`! ${note}\n`);
          if (opts.probeOnly) return;

          const service = new Service(app, { sweepMs: 0 });
          const result = handleCommit(service, {
            endpoints: [
              {
                name: opts.name,
                url: probe.url,
                ...(probe.model_id ? { model: probe.model_id } : {}),
                ...(opts.apiKey ? { api_key: opts.apiKey } : {}),
                classes: ['fast', 'best'],
                caps: probe.caps,
                ...(probe.context_size ? { context_size: probe.context_size } : {}),
              },
            ],
          });
          out(`wrote config/models.yaml (endpoints: ${result.endpoints.join(', ')})`);
          if (!probe.checks.tools) {
            process.stderr.write(
              '! this endpoint cannot be trusted with tool calls — chat works, handlers will be limited\n',
            );
          }
        } finally {
          app.close();
        }
      },
    );
}
