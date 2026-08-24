import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { DataHome } from '../../core/datadir.js';
import { log } from '../../core/logger.js';
import { resolveWritablePath } from '../paths.js';
import { validateWrite } from '../validate-write.js';
import type { ToolDefinition } from '../types.js';

const l = log('tool:config');

/**
 * `config` integration (App. F.6). The assistant editing its own configuration
 * is the point; git per mutation is what makes it safe.
 */
export function configTools(home: DataHome): ToolDefinition[] {
  return [
    {
      name: 'config.read',
      description:
        'Read a configuration, handler or skill file. Path is relative to the data directory, e.g. config/personality.md.',
      tier: 'ro',
      args: z.object({
        path: z.string().describe('data-dir-relative path under config/, handlers/ or skills/'),
      }),
      async execute(args: { path: string }) {
        const abs = resolveWritablePath(home, args.path);
        if (!fs.existsSync(abs)) return { path: args.path, exists: false, content: null };
        return { path: args.path, exists: true, content: fs.readFileSync(abs, 'utf8') };
      },
    },
    {
      name: 'config.write',
      description:
        'Write a config, handler or skill file and commit it. Overwrites the whole file — read it first if you mean to edit. Refuses anything the loader would reject, and says why.',
      tier: 'se',
      // §20.6: config.read is the way back to it.
      bulkArgs: ['content'],
      args: z.object({
        path: z.string().describe('data-dir-relative, under config/, handlers/ or skills/'),
        content: z.string(),
        message: z.string().describe('git commit message'),
      }),
      async execute(args: { path: string; content: string; message: string }) {
        const abs = resolveWritablePath(home, args.path);
        const rel = path.relative(home.root, abs);
        // Refuse before writing: a file the loader will reject, committed and
        // reported as a success, is a mistake the caller cannot see.
        const check = validateWrite(rel, args.content);
        if (!check.ok) {
          l.warn({ path: rel, reason: check.message }, 'refused an invalid write');
          return { error: check.error, message: check.message, detail: check.detail };
        }
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.writeFileSync(abs, args.content, 'utf8');
        const committed = home.git.commit(args.message, [rel]);
        l.info({ path: rel, committed }, 'config written');
        return { path: rel, committed };
      },
    },
  ];
}
