import type { Command } from 'commander';
import { bootstrap } from '../app.js';
import { UserFacingError } from '../core/errors.js';
import { HandlerLoader } from '../exec/handlers.js';
import { globalOpts } from './common.js';

const out = (s: string) => process.stdout.write(`${s}\n`);

/** Handler inspection — the files are the source of truth (§5.1). */
export function registerHandlersCommand(program: Command): void {
  const handlers = program.command('handlers').description('inspect configured handlers');

  handlers
    .command('list')
    .description('list handlers, and any that failed to load')
    .action((_opts, cmd: Command) => {
      const app = bootstrap(globalOpts(cmd));
      try {
        const loader = new HandlerLoader(app.home);
        for (const h of loader.all()) {
          const match = h.frontmatter.match
            ? ` match=${JSON.stringify(h.frontmatter.match)}`
            : ' (offered every event)';
          // The routing line: class or pin, and the reasoning level if this
          // behaviour asked for one (§10.6).
          const routing = [
            // Absent means the `handler` route decides (§10.6) — said so
            // rather than printing `undefined`.
            h.frontmatter.endpoint ?? h.frontmatter.model_class ?? 'handler route',
            ...(h.frontmatter.effort ? [`effort ${h.frontmatter.effort}`] : []),
          ].join(', ');
          out(`${h.name}  [${routing}]${match}`);
          out(`  ${h.description}`);
          if (h.frontmatter.tools.length) out(`  tools: ${h.frontmatter.tools.join(', ')}`);
          if (h.frontmatter.confirm.length)
            out(`  confirm: ${h.frontmatter.confirm.join(', ')}`);
        }
        const errors = loader.errors();
        if (errors.length) {
          out('\nfailed to load:');
          for (const e of errors) out(`  ${e.file}: ${e.message}`);
          process.exitCode = 1;
        }
      } finally {
        app.close();
      }
    });

  handlers
    .command('show <name>')
    .description('print one handler, frontmatter and instructions')
    .action((name: string, _opts, cmd: Command) => {
      const app = bootstrap(globalOpts(cmd));
      try {
        const handler = new HandlerLoader(app.home).get(name);
        if (!handler) throw new UserFacingError('not_found', `no handler named "${name}"`);
        out(JSON.stringify(handler.frontmatter, null, 2));
        out('');
        out(handler.body);
      } finally {
        app.close();
      }
    });
}
