import type { Command } from 'commander';
import { bootstrap } from '../app.js';
import { errMessage } from '../core/errors.js';
import { ModelRouter } from '../model/router.js';
import { DEFAULT_ROUTES, ROUTABLE_PURPOSES } from '../model/routes.js';
import { priceLabel } from '../model/types.js';
import { globalOpts } from './common.js';

/**
 * `turminder models` (§10.6): the endpoints, and who would serve what.
 *
 * Routing was correct and invisible; this is the second half of fixing that —
 * the table the spec describes, resolved against the config actually on disk,
 * so "why did the big model answer that" has an answer before the trace does.
 * The purpose table is derived from `ROUTABLE_PURPOSES`/`DEFAULT_ROUTES`
 * (`src/model/routes.ts`) and `models.routes` — there is no second copy of
 * either kept here.
 */
export function registerModelsCommand(program: Command): void {
  program
    .command('models')
    .description('list model endpoints and how each purpose resolves')
    .action((_o, cmd: Command) => {
      const app = bootstrap(globalOpts(cmd));
      const { models, error } = app.config.modelsOrNull();
      if (!models) {
        process.stdout.write(`no usable models.yaml${error ? `: ${error}` : ''}\n`);
        app.close();
        return;
      }
      const router = new ModelRouter(models);
      const rows = router.list().map((e) => ({
        name: e.name,
        kind: e.kind,
        classes: e.classes.join(',') || '-',
        caps: e.caps.join(',') || '-',
        context: e.contextSize ?? '-',
        // Absent means the knob is never sent — the endpoint's own default
        // stands, unguessed (§10.6).
        efforts: e.efforts?.join(',') ?? '-',
        // `local` rather than `0.00`: unpriced and free are different claims.
        price: priceLabel(e.cost),
        // The one fact a speech endpoint has that no column above holds
        // (§10.9): which voice it speaks with, which language it listens for.
        note: e.voice ?? (e.language ? `language=${e.language}` : '-'),
      }));
      const width = (key: keyof (typeof rows)[number]) =>
        Math.max(key.length, ...rows.map((r) => String(r[key]).length));
      const columns: (keyof (typeof rows)[number])[] = [
        'name',
        'kind',
        'classes',
        'caps',
        'context',
        'efforts',
        'price',
        'note',
      ];
      const line = (cells: string[]) =>
        cells
          .map((c, i) => c.padEnd(width(columns[i]!)))
          .join('  ')
          .trimEnd();
      process.stdout.write(`${line(columns.map((c) => c.toUpperCase()))}\n`);
      for (const row of rows) {
        process.stdout.write(`${line(columns.map((c) => String(row[c])))}\n`);
      }

      process.stdout.write('\nresolution by purpose (§10.6):\n');
      for (const purpose of ROUTABLE_PURPOSES) {
        if (purpose === 'embedding') {
          const configured = models.routes?.embedding;
          const selector = configured
            ? `endpoint=${configured.endpoint}`
            : 'first kind=embedding';
          const ep = router.embedding();
          process.stdout.write(
            `  ${purpose.padEnd(8)} source=${(configured ? 'config' : 'default').padEnd(7)} ` +
              `${selector.padEnd(22)} → ${ep ? ep.name : '(none — lexical search)'}\n`,
          );
          continue;
        }
        // Speech resolves by kind, not by class (§10.9) — and its absence is a
        // fact about this install, not an error: no transcriber means no voice.
        if (purpose === 'stt' || purpose === 'tts') {
          const configured = models.routes?.[purpose];
          const selector = configured
            ? `endpoint=${configured.endpoint}`
            : `first kind=${purpose}`;
          let served: string;
          try {
            served = router.speech(purpose)?.name ?? '(none)';
          } catch (e) {
            served = `(${errMessage(e)})`;
          }
          process.stdout.write(
            `  ${purpose.padEnd(8)} source=${(configured ? 'config' : 'default').padEnd(7)} ` +
              `${selector.padEnd(22)} → ${served}\n`,
          );
          continue;
        }
        const configured = models.routes?.[purpose];
        const route = configured ?? DEFAULT_ROUTES[purpose];
        const selector = route
          ? 'class' in route
            ? `class=${route.class}`
            : `endpoint=${route.endpoint}`
          : '(none)';
        let served: string;
        try {
          served = router.resolve({ purpose }).endpoint.name;
        } catch {
          served = '(nothing qualifies)';
        }
        process.stdout.write(
          `  ${purpose.padEnd(8)} source=${(configured ? 'config' : 'default').padEnd(7)} ` +
            `${selector.padEnd(22)} → ${served}\n`,
        );
      }
      process.stdout.write(
        '\na handler may pin an endpoint or a class in its frontmatter, and a\n' +
          'conversation may override both from the chat selector — either beats\n' +
          'the table above.\n',
      );
      app.close();
    });
}
