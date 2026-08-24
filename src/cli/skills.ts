import type { Command } from 'commander';
import { bootstrap } from '../app.js';
import { UserFacingError } from '../core/errors.js';
import { SkillLoader } from '../tools/skills.js';
import { globalOpts } from './common.js';

const out = (s: string) => process.stdout.write(`${s}\n`);

/**
 * Skill inspection (App. G.8). A skill that fails to load is skipped silently
 * at runtime by design — this is where you find out it happened.
 */
export function registerSkillsCommand(program: Command): void {
  const skills = program.command('skills').description('inspect skill documents');

  skills
    .command('list', { isDefault: true })
    .description('list skills, and any that failed to load')
    .action((_opts, cmd: Command) => {
      const app = bootstrap(globalOpts(cmd));
      try {
        const loader = new SkillLoader(app.home);
        for (const s of loader.all()) {
          out(`${s.name}`);
          out(`  ${s.description}`);
        }
        const errors = loader.errors();
        if (errors.length) {
          out('\nfailed to load:');
          for (const e of errors) out(`  ${e.file}: ${e.message}`);
          out('\nA skill needs YAML frontmatter with name and description (App. G.8).');
          process.exitCode = 1;
        }
      } finally {
        app.close();
      }
    });

  skills
    .command('show <name>')
    .description('print one skill in full')
    .action((name: string, _opts, cmd: Command) => {
      const app = bootstrap(globalOpts(cmd));
      try {
        const skill = new SkillLoader(app.home).get(name);
        if (!skill) throw new UserFacingError('not_found', `no skill named "${name}"`);
        out(`# ${skill.name}\n${skill.description}\n`);
        out(skill.body);
      } finally {
        app.close();
      }
    });
}
