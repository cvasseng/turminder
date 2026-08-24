import type { Command } from 'commander';
import { bootstrap } from '../app.js';
import { Service } from '../service.js';
import { globalOpts } from './common.js';

const out = (s: string) => process.stdout.write(`${s}\n`);

/**
 * RAG maintenance (§8.3, §18.1). Two corpora, deliberately separate — memory is
 * the assistant's, files are shared — and both are derived data: never precious.
 */
export function registerIndexCommand(program: Command): void {
  const index = program
    .command('index')
    .description('inspect or rebuild the memory and file indexes');

  const quiet = { sweepMs: 0, watchMemory: false, watchFiles: false } as const;

  index
    .command('rebuild')
    .description('discard data/cache and rebuild both indexes from the files on disk')
    .action(async (_opts, cmd: Command) => {
      const app = bootstrap(globalOpts(cmd));
      const service = new Service(app, { ...quiet, rebuildIndex: true });
      try {
        await service.start();
        out(
          JSON.stringify(
            { memory: service.rag.stats(), files: service.fileIndex.stats() },
            null,
            2,
          ),
        );
      } finally {
        await service.stop();
        app.close();
      }
    });

  index
    .command('status')
    .description('report what is indexed')
    .action(async (_opts, cmd: Command) => {
      const app = bootstrap(globalOpts(cmd));
      const service = new Service(app, quiet);
      try {
        await service.start();
        out(
          JSON.stringify(
            {
              memory: { ...service.rag.stats(), memories: service.memoryStore.list().length },
              files: { ...service.fileIndex.stats(), store: service.files.root },
            },
            null,
            2,
          ),
        );
      } finally {
        await service.stop();
        app.close();
      }
    });

  index
    .command('query <text>')
    .description('run a retrieval against the memory index')
    .option('-k, --limit <n>', 'how many results', '5')
    .action(async (text: string, opts: { limit: string }, cmd: Command) => {
      const app = bootstrap(globalOpts(cmd));
      const service = new Service(app, quiet);
      try {
        await service.start();
        const result = await service.rag.retrieve(text, Number(opts.limit));
        out(
          JSON.stringify(
            {
              mode: result.mode,
              hits: result.hits.map((h) => ({
                name: h.name,
                score: Number(h.score.toFixed(4)),
                description: h.description,
              })),
            },
            null,
            2,
          ),
        );
      } finally {
        await service.stop();
        app.close();
      }
    });

  index
    .command('search <text>')
    .description('run a retrieval against the file index — a different corpus (§18.1)')
    .option('-k, --limit <n>', 'how many results', '5')
    .action(async (text: string, opts: { limit: string }, cmd: Command) => {
      const app = bootstrap(globalOpts(cmd));
      const service = new Service(app, quiet);
      try {
        await service.start();
        const result = await service.fileIndex.search(text, Number(opts.limit));
        out(
          JSON.stringify(
            {
              mode: result.mode,
              hits: result.results.map((r) => ({
                path: r.path,
                score: Number(r.score.toFixed(4)),
              })),
            },
            null,
            2,
          ),
        );
      } finally {
        await service.stop();
        app.close();
      }
    });
}
