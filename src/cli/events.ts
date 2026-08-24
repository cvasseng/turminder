import type { Command } from 'commander';
import { bootstrap } from '../app.js';
import { Service } from '../service.js';
import { UserFacingError } from '../core/errors.js';
import { createRepos } from '../db/repos/index.js';
import type { EventRecord } from '../db/repos/events.js';
import type { TraceEntry } from '../db/repos/trace.js';
import { globalOpts } from './common.js';

const out = (s: string) => process.stdout.write(`${s}\n`);

function short(id: string): string {
  return id.slice(-8);
}

function line(e: EventRecord): string {
  const status = e.status.padEnd(11);
  const attempts = e.attempts ? ` a${e.attempts}` : '';
  const key = e.serialization_key ? ` key=${e.serialization_key}` : '';
  const depth = e.depth ? ` depth=${e.depth}` : '';
  return `${e.received_at} ${short(e.id)} ${status} ${e.type} <${e.source}>${key}${depth}${attempts}${
    e.summary ? ` — ${e.summary}` : ''
  }`;
}

function parsePayload(raw: string | undefined): unknown {
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch (e) {
    throw new UserFacingError(
      'bad_payload',
      `--payload is not valid JSON: ${(e as Error).message}`,
    );
  }
}

/** The debugging window until real observability exists (plan phase 2). */
export function registerEventsCommand(program: Command): void {
  const events = program.command('events').description('inspect and inject events');

  events
    .command('inject')
    .description('submit a synthetic event through the normal intake')
    .requiredOption('--type <type>', 'event type, e.g. email.received')
    .option('--source <source>', 'source instance identifier', 'cli')
    .option('--payload <json>', 'JSON payload', '{}')
    .option('--key <key>', 'serialization key (§4.4)')
    .option('--idem <key>', 'idempotency key (§4.1)')
    .option('--caused-by <event-id>', 'provenance parent')
    .option('--occurred-at <iso>', 'source-reported time')
    .option('--run', 'process the event before exiting')
    .action(async (opts: Record<string, string | undefined>, cmd: Command) => {
      const app = bootstrap(globalOpts(cmd));
      const service = new Service(app, { pollMs: 50 });
      try {
        const result = service.intake.submit({
          type: String(opts.type),
          source: String(opts.source ?? 'cli'),
          payload: parsePayload(opts.payload),
          serialization_key: opts.key ?? null,
          idempotency_key: opts.idem ?? null,
          caused_by: opts.causedBy ?? null,
          occurred_at: opts.occurredAt ?? null,
        });
        out(
          JSON.stringify({
            status: result.status,
            event_id: result.event.id,
            ...(result.status === 'rejected' ? { reason: result.reason } : {}),
          }),
        );
        if (opts.run) {
          await service.start();
          await service.queue.drain();
          await service.stop();
        }
      } finally {
        app.close();
      }
    });

  events
    .command('list')
    .description('list recent events')
    .option('-n, --limit <n>', 'how many', '20')
    .option('--status <status>', 'filter by status')
    .option('--type <glob>', 'filter by type glob')
    .action((opts: Record<string, string | undefined>, cmd: Command) => {
      const app = bootstrap(globalOpts(cmd));
      try {
        const repos = createRepos(app.db);
        const list = repos.events.recent({
          limit: Number(opts.limit ?? 20),
          ...(opts.status ? { status: opts.status as EventRecord['status'] } : {}),
          ...(opts.type ? { type: opts.type } : {}),
        });
        for (const e of list.reverse()) out(line(e));
        const counts = repos.events.countsByStatus();
        if (Object.keys(counts).length) out(`\n${JSON.stringify(counts)}`);
      } finally {
        app.close();
      }
    });

  events
    .command('tail')
    .description('follow events as they arrive')
    .option('-n, --limit <n>', 'backlog to show first', '10')
    .action(async (opts: Record<string, string | undefined>, cmd: Command) => {
      const app = bootstrap(globalOpts(cmd));
      const repos = createRepos(app.db);
      const backlog = repos.events.recent({ limit: Number(opts.limit ?? 10) }).reverse();
      for (const e of backlog) out(line(e));
      let cursor = backlog.at(-1)?.id ?? repos.events.latestId() ?? '';

      await new Promise<void>((resolve) => {
        const timer = setInterval(() => {
          const fresh = cursor ? repos.events.since(cursor) : repos.events.recent({ limit: 1 });
          for (const e of fresh) {
            out(line(e));
            cursor = e.id;
          }
        }, 300);
        const stop = () => {
          clearInterval(timer);
          resolve();
        };
        process.once('SIGINT', stop);
        process.once('SIGTERM', stop);
      });
      app.close();
    });

  events
    .command('show <id>')
    .description('the full trace of one event: status, runs, verdicts, calls, outcome')
    .option('--json', 'machine-readable output')
    .action((id: string, opts: { json?: boolean }, cmd: Command) => {
      const app = bootstrap(globalOpts(cmd));
      try {
        const repos = createRepos(app.db);
        const event = repos.events.get(id) ?? findBySuffix(repos, id);
        if (!event) throw new UserFacingError('not_found', `no event matching "${id}"`);
        const runs = repos.runs.forEvent(event.id);
        const trace = repos.trace.forEvent(event.id);
        const chain = repos.events.chain(event.id).slice(1);

        if (opts.json) {
          out(JSON.stringify({ event, runs, trace, provenance: chain }, null, 2));
          return;
        }

        const verdicts = trace
          .filter((t) => t.kind === 'verdict')
          .map(
            (t) =>
              t.data as { handler: string; offered: boolean; matched: boolean; reason: string },
          );

        out(`event    ${event.id}`);
        out(`type     ${event.type}  <${event.source}>`);
        out(`status   ${event.status}${event.attempts ? `  attempts=${event.attempts}` : ''}`);
        out(
          `received ${event.received_at}${event.occurred_at ? `  occurred ${event.occurred_at}` : ''}`,
        );
        if (event.serialization_key) out(`key      ${event.serialization_key}`);
        if (event.idempotency_key) out(`idem     ${event.idempotency_key}`);
        if (event.depth || event.caused_by) {
          out(`prov     depth=${event.depth} caused_by=${event.caused_by ?? '-'}`);
        }
        if (event.summary) out(`summary  ${event.summary}`);
        if (event.last_error) out(`error    ${event.last_error}`);
        if (event.next_attempt_at) out(`retry_at ${event.next_attempt_at}`);
        out(`payload  ${JSON.stringify(event.payload)}`);

        if (chain.length) {
          out('\nprovenance (newest first):');
          for (const a of chain)
            out(`  ${short(a.id)} ${a.type} <${a.source}> depth=${a.depth}`);
        }

        if (verdicts.length) {
          // "Why didn't my handler fire" lives here (§5.3).
          out('\nverdicts:');
          for (const v of verdicts) {
            const mark = v.matched ? 'MATCH' : v.offered ? 'skip ' : 'excl ';
            out(`  ${mark} ${v.handler}: ${v.reason}`);
          }
        } else if (event.type !== 'chat.message') {
          out('\nverdicts: none — no handler was offered this event');
        }

        if (runs.length) {
          out('\nruns:');
          for (const r of runs) {
            out(
              `  ${short(r.id)} ${r.kind}${r.handler_name ? `/${r.handler_name}` : ''} ` +
                `${r.status} model=${r.model ?? '-'} turns=${r.turns} ` +
                `tokens=${r.tokens_in}/${r.tokens_out}${r.error ? ` error=${r.error}` : ''}`,
            );
          }
        }

        out('\ntrace:');
        for (const t of trace) out(`  ${t.at} ${t.kind.padEnd(10)} ${traceLine(t)}`);

        const tokens = runs.reduce((n, r) => n + r.tokens_in + r.tokens_out, 0);
        const waited = trace
          .filter((t) => t.kind === 'llm_call')
          .reduce(
            (n, t) => n + Number((t.data as { queue_wait_ms?: number }).queue_wait_ms ?? 0),
            0,
          );
        out(
          `\noutcome  ${event.status}  runs=${runs.length} tokens=${tokens} ` +
            `queue_wait=${waited}ms tools=${trace.filter((t) => t.kind === 'tool_call').length}`,
        );
      } finally {
        app.close();
      }
    });
}

function findBySuffix(
  repos: ReturnType<typeof createRepos>,
  suffix: string,
): EventRecord | null {
  return (
    repos.events.recent({ limit: 500 }).find((e) => e.id.endsWith(suffix.toUpperCase())) ?? null
  );
}

function traceLine(t: TraceEntry): string {
  const d = t.data as Record<string, unknown>;
  switch (t.kind) {
    case 'state':
      return `${d.from ?? '(new)'} → ${d.to}${d.reason ? ` (${d.reason})` : ''}`;
    case 'verdict':
      return `${d.handler}: ${d.matched ? 'MATCH' : 'skip '} — ${d.reason}`;
    case 'llm_call':
      return `${d.model} ${d.priority} wait=${d.queue_wait_ms}ms dur=${d.duration_ms}ms tok=${d.tokens_in}/${d.tokens_out} stop=${d.stop_reason}`;
    case 'tool_call':
      return `${d.tool} ok=${d.ok}${d.denied ? ` denied=${d.denied}` : ''} ${String(d.result_excerpt ?? '').slice(0, 120)}`;
    case 'emit':
      return `${d.type} → ${String(d.emitted_event_id ?? '').slice(-8)}`;
    case 'delivery':
      return `${d.intent} ${String(d.delivery_id ?? '').slice(-8)}`;
    case 'error':
      return String(d.message ?? '');
    default:
      return JSON.stringify(d);
  }
}
