import { z } from 'zod';
import type { TraceRepo } from '../../db/repos/trace.js';
import type { ToolDefinition } from '../types.js';

export interface UsageDeps {
  trace: TraceRepo;
  /** Injectable so a window test does not depend on what day it is. */
  now?: () => Date;
}

type Period = 'day' | 'week' | 'month' | 'all';

const DAY_MS = 24 * 3600 * 1000;

/** The window a period names, ending now (§10.5, F.17). */
export function periodWindow(period: Period, now: Date): { from: string | null; to: string } {
  const to = now.toISOString();
  if (period === 'all') return { from: null, to };
  const days = period === 'day' ? 1 : period === 'week' ? 7 : 30;
  return { from: new Date(now.getTime() - days * DAY_MS).toISOString(), to };
}

/**
 * The `usage` integration (App. F.17, §10.5): what the model has cost.
 *
 * `ro`, and therefore bindable (§23.2) — which is the point of the tier here:
 * "make me a cost dashboard" is an embed with a `usage.summary` binding, and
 * the numbers reach the page without ever passing through a token stream.
 *
 * Costless endpoints report tokens and no money. They are `local`, not
 * `0.00`: an unpriced call and a free call are different claims, and only one
 * of them is a measurement.
 */
export function usageTools(deps: UsageDeps): ToolDefinition[] {
  const now = deps.now ?? (() => new Date());
  return [
    {
      name: 'usage.summary',
      description:
        'What the language models have cost, over a period, grouped by endpoint or by what kind of run it was. Endpoints with no configured price report tokens and no money — that is "local", not free. Costs are estimates from the prices in the config, never a bill.',
      tier: 'ro',
      isEmpty: (result) => ((result as { groups?: unknown[] }).groups ?? []).length === 0,
      args: z.object({
        period: z.enum(['day', 'week', 'month', 'all']).optional(),
        group_by: z.enum(['endpoint', 'kind', 'none']).optional(),
      }),
      async execute(args: { period?: Period; group_by?: 'endpoint' | 'kind' | 'none' }) {
        const period = args.period ?? 'month';
        const groupBy = args.group_by ?? 'endpoint';
        const window = periodWindow(period, now());
        const rows = deps.trace.usage({ from: window.from, to: window.to, groupBy });

        const groups = rows.map((r) => ({
          key: r.key,
          calls: r.calls,
          tokens_in: r.tokens_in,
          tokens_out: r.tokens_out,
          ...(r.cost !== null && r.currency
            ? { cost: round(r.cost), currency: r.currency }
            : { cost: null, currency: 'local' }),
        }));
        // Mixed currencies group rather than add (§10.5): one total per
        // currency, and tokens across all of them.
        const byCurrency = new Map<string, number>();
        for (const row of rows) {
          if (row.cost === null || !row.currency) continue;
          byCurrency.set(row.currency, (byCurrency.get(row.currency) ?? 0) + row.cost);
        }
        const totals = [...byCurrency.entries()].map(([currency, cost]) => ({
          currency,
          cost: round(cost),
        }));
        return {
          period,
          from: window.from,
          to: window.to,
          groups,
          total: {
            calls: rows.reduce((n, r) => n + r.calls, 0),
            tokens_in: rows.reduce((n, r) => n + r.tokens_in, 0),
            tokens_out: rows.reduce((n, r) => n + r.tokens_out, 0),
            ...(totals.length === 1
              ? { cost: totals[0]!.cost, currency: totals[0]!.currency }
              : totals.length
                ? { by_currency: totals }
                : { cost: null, currency: 'local' }),
          },
        };
      },
    },
  ];
}

/** Cents matter; floating-point tails do not. */
function round(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}
