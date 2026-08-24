import type { Command } from 'commander';
import { bootstrap } from '../app.js';
import { dbVersion } from '../db/index.js';
import { globalOpts } from './common.js';

export function registerDoctorCommand(program: Command): void {
  program
    .command('doctor')
    .description('boot the data home, report its state, and exit')
    .action((_opts, cmd: Command) => {
      const app = bootstrap(globalOpts(cmd));
      const manifest = app.home.readManifest();
      const { models, error } = app.config.modelsOrNull();
      const identity = app.config.identity();
      const records = app.config.integrations().integrations;
      const grants = app.config.grants().grants;
      const report = {
        data_dir: app.home.root,
        layout_version: manifest.layout_version,
        created_at: manifest.created_at,
        db_version: dbVersion(app.db),
        git_head: app.home.git.head(),
        bind: `${app.config.settings.bind.host}:${app.config.settings.bind.port}`,
        models_configured: Boolean(models),
        models_error: error ?? null,
        endpoints: models?.endpoints.map((e) => e.name) ?? [],
        onboarded: Boolean(identity),
        instance_name: identity?.frontmatter.instance_name ?? null,
        devices: app.config.channels().devices.map((d) => d.device),
        file_store: app.config.settings.filesDir ?? app.home.filesDir,
        // What is switched on (§19.5), and what it is wired to (§19.3).
        integrations_active: Object.entries(records)
          .filter(([, r]) => r.active)
          .map(([name]) => name),
        mcp_servers: app.config.mcp().servers.map((server) => server.name),
        // Tool access the user approved at runtime, on top of chat.tools (§19).
        granted_at_runtime: grants.map((g) => `${g.pattern} (${g.level})`),
        // Where secrets rest, and whether that backend is answering (§27.1).
        secrets: (() => {
          const status = app.config.secretStore.status();
          return {
            backend: status.backend,
            pinned: status.pinned,
            healthy: status.health.ok,
            keys: status.keys.length,
            ...(status.health.ok ? {} : { reason: status.health.reason ?? null }),
          };
        })(),
        // External binaries and what they gate (§23.1) — a missing one is a
        // feature that will decline honestly, not a broken install.
        systools: app.systools.report().map((probe) => ({
          name: probe.name,
          ok: probe.ok,
          command: probe.command ?? null,
          version: probe.version ?? null,
          ...(probe.ok ? {} : { reason: probe.reason ?? null, hint: probe.hint }),
        })),
      };
      process.stdout.write(JSON.stringify(report, null, 2) + '\n');
      if (app.newUiToken) {
        process.stdout.write(`\nui device token (shown once): ${app.newUiToken}\n`);
      }
      app.close();
    });
}
