import type { Command } from 'commander';
import { bootstrap } from '../app.js';
import { UserFacingError } from '../core/errors.js';
import { globMatchAny } from '../core/glob.js';
import { HandlerLoader } from '../exec/handlers.js';
import { Service } from '../service.js';
import { globalOpts } from './common.js';

const out = (s: string) => process.stdout.write(`${s}\n`);

type Grant = 'auto' | 'confirm' | 'none';

/**
 * Serialized size of one tool definition, as the model receives it (§21.4).
 * The measure that matters is what rides in every request, so it counts the
 * name, the description, and the JSON Schema together — a slim description on
 * a 900-char schema is not a slim tool.
 */
function definitionChars(handle: {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}): number {
  return JSON.stringify({
    name: handle.name,
    description: handle.description,
    parameters: handle.inputSchema,
  }).length;
}

/** Roughly what a tokenizer makes of it. Signal, not billing. */
const approxTokens = (chars: number) => Math.round(chars / 4);

function grantFor(name: string, tools: readonly string[], confirm: readonly string[]): Grant {
  // `confirm` wins over `tools` — same precedence as the dispatcher.
  if (globMatchAny(confirm, name)) return 'confirm';
  if (globMatchAny(tools, name)) return 'auto';
  return 'none';
}

/**
 * Every tool in the process, and whether a given run could actually call it.
 * This is the answer to "why can't it see X" — the tool-layer counterpart of
 * `events show` answering "why didn't my handler fire" (§5.3, §11.4).
 */
export function registerToolsCommand(program: Command): void {
  const tools = program.command('tools').description('inspect the tool catalog and grants');

  tools
    .command('list', { isDefault: true })
    .description('list every tool, with the grant a chat turn or handler would get')
    .option('--for <who>', 'chat (default), onboarding, or a handler name')
    .option('--size', 'show serialized definition size per tool and namespace')
    .option('--json', 'machine-readable output')
    .action(async (opts: { for?: string; size?: boolean; json?: boolean }, cmd: Command) => {
      const app = bootstrap(globalOpts(cmd));
      const service = new Service(app, {
        sweepMs: 0,
        watchMemory: false,
        runSources: false,
        runScheduler: false,
      });
      try {
        await service.start();
        const who = opts.for ?? 'chat';
        const settings = app.config.settings;

        let granted: readonly string[];
        let confirmed: readonly string[];
        if (who === 'chat') {
          granted = settings.chatTools;
          confirmed = settings.chatConfirm;
        } else if (who === 'onboarding') {
          granted = ['config.read', 'config.write'];
          confirmed = [];
        } else {
          const handler = new HandlerLoader(app.home).get(who);
          if (!handler) {
            throw new UserFacingError(
              'not_found',
              `no handler named "${who}"`,
              'use --for chat, --for onboarding, or a handler name from `turminder handlers list`',
            );
          }
          granted = handler.frontmatter.tools;
          confirmed = handler.frontmatter.confirm;
        }

        const rows = service.tools.handles().map((handle) => ({
          name: handle.name,
          tier: handle.tier,
          source: handle.source,
          grant: grantFor(handle.name, granted, confirmed),
          chars: definitionChars(handle),
        }));

        if (opts.json) {
          out(
            JSON.stringify(
              { for: who, grants: { tools: granted, confirm: confirmed }, tools: rows },
              null,
              2,
            ),
          );
          return;
        }

        if (opts.size) return printSizes(rows, who, settings.chatCoreNamespaces);

        out(`grants for ${who}: tools=[${granted.join(', ')}]`);
        if (confirmed.length) out(`                confirm=[${confirmed.join(', ')}]`);
        out('');
        const mark = { auto: 'yes    ', confirm: 'approve', none: 'no     ' } as const;
        for (const row of rows.sort((a, b) => a.name.localeCompare(b.name))) {
          out(`${mark[row.grant]} ${row.name.padEnd(24)} ${row.tier}  <${row.source}>`);
        }

        const invisible = rows.filter((r) => r.grant === 'none');
        if (invisible.length) {
          out(
            `\n${invisible.length} tool(s) exist but ${who} cannot see them. ` +
              'Add a matching glob to chat.tools in config/turminder.yaml, or to the ' +
              "handler's frontmatter.",
          );
        }
        const dormant = service.sources.status.filter((s) => !s.active);
        for (const s of dormant) {
          out(`\n${s.name} contributes no tools: ${s.detail ?? 'not activated'}`);
        }
      } finally {
        await service.stop();
        app.close();
      }
    });
}

interface SizedTool {
  name: string;
  source: string;
  grant: Grant;
  chars: number;
}

/**
 * The bloat report (§21.4). Sorted biggest-first inside each namespace, with a
 * paged-in total at the end, because the number the phase-16 work is judged on
 * is what a *fresh conversation* renders — not what the process could render.
 */
function printSizes(rows: SizedTool[], who: string, core: readonly string[]): void {
  const visible = rows.filter((r) => r.grant !== 'none');
  const byNamespace = new Map<string, SizedTool[]>();
  for (const row of visible) {
    const list = byNamespace.get(row.source);
    if (list) list.push(row);
    else byNamespace.set(row.source, [row]);
  }

  out(`serialized tool definitions for ${who} — chars (~tokens)\n`);
  let total = 0;
  let coreTotal = 0;
  for (const namespace of [...byNamespace.keys()].sort()) {
    const tools = byNamespace.get(namespace)!;
    const sum = tools.reduce((n, t) => n + t.chars, 0);
    total += sum;
    const open = core.includes(namespace);
    if (open) coreTotal += sum;
    out(
      `${namespace.padEnd(18)} ${String(sum).padStart(6)} (~${approxTokens(sum)})  ` +
        `${tools.length} tool${tools.length === 1 ? '' : 's'}${open ? '  [core]' : ''}`,
    );
    for (const tool of [...tools].sort((a, b) => b.chars - a.chars)) {
      out(`  ${tool.name.padEnd(26)} ${String(tool.chars).padStart(6)}`);
    }
  }
  out('');
  out(`granted total       ${String(total).padStart(6)} (~${approxTokens(total)})`);
  out(
    `core namespaces     ${String(coreTotal).padStart(6)} (~${approxTokens(coreTotal)})` +
      `  — what a fresh conversation renders (§21.2.1)`,
  );
  const paged = total - coreTotal;
  out(`paged out           ${String(paged).padStart(6)} (~${approxTokens(paged)})`);
}
