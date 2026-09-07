import type { Command } from 'commander';
import { bootstrap } from '../app.js';
import { errMessage, UserFacingError } from '../core/errors.js';
import { tagFreshness } from '../core/config-schemas.js';
import { ModelRouter } from '../model/router.js';
import { reprobeEndpoint } from '../tools/integrations/setup/reprobe.js';
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
  const group = program
    .command('models')
    .description('list model endpoints and how each purpose resolves');

  group
    .command('list', { isDefault: true })
    .description('list model endpoints and how each purpose resolves')
    .action((_o: unknown, cmd: Command) => {
      const app = bootstrap(globalOpts(cmd));
      const { models, error } = app.config.modelsOrNull();
      if (!models) {
        process.stdout.write(`no usable models.yaml${error ? `: ${error}` : ''}\n`);
        app.close();
        return;
      }
      const router = new ModelRouter(models);
      const configured = new Map(models.endpoints.map((e) => [e.name, e]));
      const rows = router.list().map((e) => ({
        name: e.name,
        kind: e.kind,
        classes: e.classes.join(',') || '-',
        caps: e.caps.join(',') || '-',
        // Whether those caps still describe the model this entry names
        // (§10.2). `unknown` is an entry written before probes recorded their
        // subject — not a claim that anything is wrong. An embedding or speech
        // endpoint has no capability tags to be right or wrong about (§10.1),
        // so it gets the same `-` its empty CAPS column already carries rather
        // than an `unknown` implying something could be known.
        tags: e.kind === 'chat' ? tagFreshness(configured.get(e.name) ?? {}) : '-',
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
        'tags',
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

      // A warning, never a refusal (§10.2): stale tags are still used, because
      // they may well still be right and a router degrading on a suspicion
      // helps nobody. Saying which command fixes it is the whole point.
      for (const e of models.endpoints) {
        if (tagFreshness(e) !== 'stale') continue;
        process.stdout.write(
          `\n! ${e.name}: caps and context were measured against ${e.probed_model}, ` +
            `which is not the ${e.model} it now serves —\n` +
            `  re-derive them with: turminder models probe ${e.name}\n`,
        );
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

  /**
   * `turminder models probe <name>` (§10.2) — the headless half of
   * `setup.reprobe`, sharing its one implementation. For the case this exists
   * for: a `model:` corrected by hand, leaving `caps` describing something
   * else with nothing in the system aware of the mismatch.
   */
  group
    .command('probe <name>')
    .description("re-derive an endpoint's capability tags against the model it now names")
    .action(async (name: string, _o: unknown, cmd: Command) => {
      const app = bootstrap(globalOpts(cmd));
      try {
        const result = await reprobeEndpoint({ home: app.home, config: app.config }, name);
        if ('error' in result) {
          throw new UserFacingError(result.error, result.message);
        }
        for (const note of result.notes) process.stderr.write(`! ${note}\n`);
        process.stdout.write(
          `${result.endpoint}: caps ${result.caps.join(',') || '-'}, context ` +
            `${result.context_size ?? '-'}, measured against ${result.probed_model ?? '-'}\n`,
        );
        process.stdout.write(
          result.changed
            ? `config/models.yaml updated${result.committed ? ' and committed' : ''}\n`
            : 'nothing changed — the tags already describe this model\n',
        );
      } finally {
        app.close();
      }
    });
}
