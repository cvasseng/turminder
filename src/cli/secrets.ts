import fs from 'node:fs';
import type { Command } from 'commander';
import YAML from 'yaml';
import { bootstrap } from '../app.js';
import { UserFacingError } from '../core/errors.js';
import type { BackendName } from '../core/secret-store/index.js';
import { globalOpts } from './common.js';

const BACKENDS: BackendName[] = ['plain', 'gpg', 'os'];

/**
 * Secret store management (§27.1, App. E). Two commands, both of which report
 * **names only** — there is no CLI path that prints a secret value, on purpose.
 */
export function registerSecretsCommand(program: Command): void {
  const secrets = program.command('secrets').description('manage the secret store');

  secrets
    .command('status')
    .description('which backend, which keys, and whether it is working')
    .action((_o, cmd: Command) => {
      const app = bootstrap(globalOpts(cmd));
      const status = app.config.secretStore.status();
      // What this machine could offer, so choosing is informed rather than a
      // guess (§27.1: the setup flow probes, then the user picks).
      const available = app.config.secretStore.available();
      process.stdout.write(
        JSON.stringify(
          {
            backend: status.backend,
            // `auto` means nobody has chosen yet; onboarding writes a concrete
            // value and from then on a broken backend is a startup failure.
            pinned: status.pinned,
            healthy: status.health.ok,
            ...(status.health.ok
              ? {}
              : { reason: status.health.reason ?? null, fix: status.health.fix ?? null }),
            keys: status.keys,
            available,
          },
          null,
          2,
        ) + '\n',
      );
      app.close();
    });

  secrets
    .command('migrate <backend>')
    .description(`move every secret to another backend (${BACKENDS.join(' | ')})`)
    .action((backend: string, _o, cmd: Command) => {
      if (!BACKENDS.includes(backend as BackendName)) {
        throw new UserFacingError(
          'unknown_backend',
          `no such backend: ${backend}`,
          `choose one of: ${BACKENDS.join(', ')}`,
        );
      }
      const app = bootstrap(globalOpts(cmd));
      const result = app.config.secretStore.migrate(backend as BackendName);
      if ('error' in result) {
        app.close();
        throw new UserFacingError(result.error, result.message);
      }
      // Record the choice, rather than leaving it as homework: an unpinned
      // backend is one a restart silently forgets (§27.1).
      pinBackend(app.home.path('config', 'turminder.yaml'), backend as BackendName);
      app.home.git.commit(`config: secrets backend ${backend}`, ['config/turminder.yaml']);
      app.close();
      process.stdout.write(
        `moved ${result.moved.length} secret(s) from ${result.from} to ${backend}\n` +
          `${result.moved.map((k) => `  ${k}`).join('\n')}\n` +
          `\nsecrets.backend is now pinned to ${backend} in config/turminder.yaml\n`,
      );
    });
}

/**
 * Write `secrets.backend` into the settings file, leaving everything else
 * alone. YAML round-tripping loses comments, which is the same trade the rest
 * of the config writers make (G.1) — the alternative is a hand-rolled editor.
 */
function pinBackend(file: string, backend: BackendName): void {
  const raw = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  const doc = (YAML.parse(raw) ?? {}) as Record<string, unknown>;
  const secrets = (doc.secrets ?? {}) as Record<string, unknown>;
  doc.secrets = { ...secrets, backend };
  fs.writeFileSync(file, YAML.stringify(doc), 'utf8');
}
