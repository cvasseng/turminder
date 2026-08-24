import type { Command } from 'commander';
import { bootstrap } from '../app.js';
import { ModelRouter } from '../model/router.js';
import { globalOpts } from './common.js';

/** The kind → class table of §10.6, made concrete against this install. */
const KIND_DEFAULTS: { kind: string; class: 'fast' | 'best' }[] = [
  { kind: 'chat', class: 'best' },
  { kind: 'handler', class: 'fast' },
  { kind: 'ingress', class: 'fast' },
  { kind: 'distill', class: 'best' },
];

/**
 * `turminder models` (§10.6): the endpoints, and who would serve what.
 *
 * Routing was correct and invisible; this is the second half of fixing that —
 * the table the spec describes, resolved against the config actually on disk,
 * so "why did the big model answer that" has an answer before the trace does.
 */
export function registerModelsCommand(program: Command): void {
  program
    .command('models')
    .description('list model endpoints and how each agent kind resolves')
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
        classes: e.classes.join(','),
        caps: e.caps.join(',') || '-',
        context: e.contextSize ?? '-',
        // Absent means the knob is never sent — the endpoint's own default
        // stands, unguessed (§10.6).
        efforts: e.efforts?.join(',') ?? '-',
        // `local` rather than `0.00`: unpriced and free are different claims.
        price: e.cost
          ? `${e.cost.inPerMtok}/${e.cost.outPerMtok} ${e.cost.currency} per Mtok`
          : 'local',
      }));
      const width = (key: keyof (typeof rows)[number]) =>
        Math.max(key.length, ...rows.map((r) => String(r[key]).length));
      const columns: (keyof (typeof rows)[number])[] = [
        'name',
        'classes',
        'caps',
        'context',
        'efforts',
        'price',
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

      process.stdout.write('\nresolution by agent kind (§10.6):\n');
      for (const entry of KIND_DEFAULTS) {
        let served: string;
        try {
          served = router.pick({ class: entry.class }).name;
        } catch {
          served = '(nothing qualifies)';
        }
        process.stdout.write(`  ${entry.kind.padEnd(8)} class=${entry.class}  → ${served}\n`);
      }
      process.stdout.write(
        '\na handler may pin an endpoint or a class in its frontmatter, and a\n' +
          'conversation may override both from the chat selector — either beats\n' +
          'the table above.\n',
      );
      app.close();
    });
}
