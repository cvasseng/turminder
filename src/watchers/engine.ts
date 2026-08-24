import { log } from '../core/logger.js';
import { errMessage } from '../core/errors.js';
import { nowIso, isoPlusSeconds } from '../core/time.js';
import type { Repos } from '../db/repos/index.js';
import type { WatcherRow } from '../db/repos/watchers.js';
import type { EventIntake } from '../ingress/intake.js';
import type { FileStore } from '../files/store.js';
import type { RunGrantView } from '../tools/run-grants.js';
import type { ToolContext, ToolHandle } from '../tools/types.js';
import {
  resolveFrozenCall,
  resolvePath,
  shapeDigest,
  type FrozenCallError,
} from '../tools/frozen-call.js';

const l = log('watch');

/** App. A (§30.3): nothing may poll tighter than this, or default looser. */
export const WATCH_MIN_INTERVAL_S = 300;
export const WATCH_DEFAULT_INTERVAL_S = 1800;
/** Consecutive failures before one `watch.failed` fires (App. A, §30.2). */
export const WATCH_FAILURE_THRESHOLD = 5;
/** The §23.2 binding call timeout, same constant for the same reason. */
const POLL_TIMEOUT_MS = 10_000;

export type WatchScalar = string | number | boolean;

export interface CreateWatchRequest {
  note: string;
  tool: string;
  args?: Record<string, unknown>;
  args_from?: boolean;
  status_path: string;
  terminal_values?: readonly WatchScalar[];
  every_s?: number;
  state_file?: string;
}

export type WatchError =
  | FrozenCallError
  | { error: 'invalid_binding_args'; message: string; tool?: string }
  | { error: 'bad_status_path'; message: string }
  | { error: 'bad_args'; message: string }
  | { error: 'not_found'; message: string };

export interface WatcherEngineDeps {
  repos: Repos;
  intake: EventIntake;
  files: FileStore;
  /** Every tool in the process; a function because the hub gains tools mid-life. */
  tools: () => readonly ToolHandle[];
  /** The trace's memory of a run's own successful calls (§23.2 `args_from`). */
  priorArgs: (runId: string, tool: string) => Record<string, unknown> | null;
  now?: () => Date;
}

/**
 * The watcher engine (§30.2) — the deterministic half of the state layer.
 *
 * There is no gateway here, on purpose. A poll executes a frozen read-only
 * call, extracts one scalar, and compares it to the last one; the model is
 * involved only when that comparison finds a difference, and then through
 * normal ingress like anything else. **Silent means no LLM, never no record**:
 * every poll is an event with a run and a tool_call trace, so a watcher that
 * saw nothing for a week is still a week of auditable history.
 */
export class WatcherEngine {
  private readonly now: () => Date;

  constructor(private readonly deps: WatcherEngineDeps) {
    this.now = deps.now ?? (() => new Date());
  }

  /**
   * Create a watcher, first poll included (§30.3). The first poll is what makes
   * the create all-or-nothing: it proves the call works, seeds the status, and
   * writes the state file's first line. A watcher that fails on its first real
   * poll would be a watcher the user thinks is working.
   */
  async create(
    request: CreateWatchRequest,
    ctx: { runId: string | null; grants: RunGrantView | null; toolCtx: ToolContext },
  ): Promise<
    | {
        watch_id: string;
        note: string;
        status: WatchScalar;
        state_file: string;
        next_poll_at: string;
      }
    | WatchError
  > {
    const everyS = request.every_s ?? WATCH_DEFAULT_INTERVAL_S;
    if (everyS < WATCH_MIN_INTERVAL_S) {
      return {
        error: 'bad_args',
        message: `the tightest cadence is ${WATCH_MIN_INTERVAL_S}s (asked for ${everyS}s) — a watcher is not a stopwatch`,
      };
    }

    const resolved = resolveFrozenCall(
      {
        tool: request.tool,
        ...(request.args ? { args: request.args } : {}),
        ...(request.args_from ? { args_from: true } : {}),
      },
      {
        tools: this.deps.tools,
        grants: ctx.grants,
        priorArgs: (tool) => (ctx.runId ? this.deps.priorArgs(ctx.runId, tool) : null),
      },
    );
    if ('error' in resolved) return resolved;

    // The seed poll: the tool's own words ride any refusal (§30.3).
    const seed = await this.execute(resolved.handle, resolved.args, ctx.toolCtx);
    if ('error' in seed) {
      return {
        error: 'invalid_binding_args',
        message: `${request.tool} refused the frozen call: ${seed.message}`,
        tool: request.tool,
      };
    }
    const status = resolvePath(seed.output, request.status_path);
    if (!isScalar(status)) {
      return {
        error: 'bad_status_path',
        message:
          `${request.status_path} did not select a scalar from what ${request.tool} returned. ` +
          `The result looked like: ${shapeDigest(seed.output)}`,
      };
    }

    const stateFile = request.state_file?.trim() || defaultStateFile(request.note);
    const at = nowIso();
    const schedule = this.deps.repos.schedules.create({
      fireAt: isoPlusSeconds(everyS, this.now()),
      note: `watch ${request.note}`,
      rrule: `FREQ=SECONDLY;INTERVAL=${everyS}`,
      eventType: 'watch.due',
      eventPayload: {},
      ...(ctx.runId ? { createdByRun: ctx.runId } : {}),
    });
    const watcher = this.deps.repos.watchers.create({
      note: request.note,
      tool: resolved.tool,
      args: resolved.args,
      statusPath: request.status_path,
      ...(request.terminal_values?.length ? { terminalValues: request.terminal_values } : {}),
      stateFile,
      scheduleId: schedule.id,
      lastStatus: String(status),
      ...(ctx.runId ? { createdByRun: ctx.runId } : {}),
    });
    // The schedule payload needs the watcher id, which the schedule row could
    // not know before the watcher existed. Written back immediately, so a fire
    // between the two statements is the only gap and it is microseconds wide.
    this.deps.repos.schedules.setPayload(schedule.id, { watch_id: watcher.id });

    this.writeStateFile(
      watcher,
      [`- ${at} — created, status \`${String(status)}\``],
      String(status),
      at,
      false,
    );

    l.info({ watch: watcher.id, note: watcher.note, every_s: everyS }, 'watcher created');
    return {
      watch_id: watcher.id,
      note: watcher.note,
      status,
      state_file: stateFile,
      next_poll_at: schedule.fire_at,
    };
  }

  /**
   * One step (§30.2): poll, extract, diff. Called by the scheduled `watch.due`
   * event and by `watch.poll`; the only difference is who asked.
   */
  async step(
    watchId: string,
    ctx: { toolCtx: ToolContext; causedBy?: string | null; eventId?: string | null },
  ): Promise<
    | { watch_id: string; status: WatchScalar | null; changed: boolean; terminal: boolean }
    | WatchError
  > {
    const watcher = this.deps.repos.watchers.get(watchId);
    if (!watcher || watcher.status !== 'active') {
      return { error: 'not_found', message: `no active watcher ${watchId}` };
    }
    /**
     * Silent means no LLM, **never no record** (§30). A scheduled poll runs
     * under its own run so the tool_call trace has somewhere to attach; a poll
     * asked for by a tool call is already inside one. Either way the invariant
     * holds: one tool_call row, zero llm_call rows.
     */
    const ownRun = ctx.toolCtx.runId
      ? null
      : this.deps.repos.runs.create({
          kind: 'maintenance',
          eventId: ctx.eventId ?? ctx.causedBy ?? null,
        });
    const runId = ctx.toolCtx.runId ?? ownRun;
    const trace = this.deps.repos.trace.sink({
      eventId: ctx.eventId ?? ctx.causedBy ?? null,
      runId,
    });
    const toolCtx: ToolContext = { ...ctx.toolCtx, runId };

    const handle = this.deps.tools().find((t) => t.name === watcher.tool);
    if (!handle) {
      // The tool went away — an integration was deactivated, an MCP server is
      // gone. That is a failure like any other: the last status stands.
      if (ownRun)
        this.deps.repos.runs.finish(ownRun, { status: 'failed', error: 'tool_missing' });
      return this.fail(
        watcher,
        `the tool ${watcher.tool} is not available`,
        ctx.causedBy ?? null,
      );
    }
    const args = this.deps.repos.watchers.argsOf(watcher);
    const startedAt = Date.now();
    const outcome = await this.execute(handle, args, toolCtx);
    trace.append('tool_call', {
      tool: watcher.tool,
      args,
      ok: !('error' in outcome),
      result_excerpt: JSON.stringify('error' in outcome ? outcome : outcome.output).slice(
        0,
        1000,
      ),
      duration_ms: Date.now() - startedAt,
    });
    if (ownRun) this.deps.repos.runs.finish(ownRun, { status: 'done', turns: 0 });
    if ('error' in outcome) return this.fail(watcher, outcome.message, ctx.causedBy ?? null);

    const status = resolvePath(outcome.output, watcher.status_path);
    if (!isScalar(status)) {
      return this.fail(
        watcher,
        `${watcher.status_path} no longer selects a scalar (got ${shapeDigest(outcome.output)})`,
        ctx.causedBy ?? null,
      );
    }

    const at = nowIso();
    const from = watcher.last_status;
    const to = String(status);
    if (from === to) {
      // The overwhelmingly common case, and the whole point of the layer: a
      // row update, a trace, and not one token of inference.
      this.deps.repos.watchers.markPolled(watcher.id, at);
      return { watch_id: watcher.id, status, changed: false, terminal: false };
    }

    const terminal = this.deps.repos.watchers
      .terminalOf(watcher)
      .some((value) => String(value) === to);
    this.deps.repos.watchers.markChanged(watcher.id, to, at);
    this.appendTransition(watcher, from, to, at, terminal);

    if (terminal) {
      // Ending the watch is the engine's deterministic act, never a handler's
      // decision (§30.2).
      this.deps.repos.schedules.cancel(watcher.schedule_id);
      this.deps.repos.watchers.setStatus(watcher.id, 'done');
    }
    this.deps.intake.submit({
      type: 'watch.changed',
      source: 'watcher',
      payload: {
        watch_id: watcher.id,
        note: watcher.note,
        from,
        to,
        terminal,
        state_file: watcher.state_file,
      },
      ...(ctx.causedBy ? { caused_by: ctx.causedBy } : {}),
      serialization_key: watcher.id,
    });
    l.info({ watch: watcher.id, from, to, terminal }, 'watcher transition');
    return { watch_id: watcher.id, status, changed: true, terminal };
  }

  /** Cancel a watcher and its cadence together (F.16). */
  cancel(watchId: string): { watch_id: string; cancelled: true } | WatchError {
    const watcher = this.deps.repos.watchers.get(watchId);
    if (!watcher) return { error: 'not_found', message: `no watcher ${watchId}` };
    this.deps.repos.schedules.cancel(watcher.schedule_id);
    this.deps.repos.watchers.setStatus(watchId, 'cancelled');
    return { watch_id: watchId, cancelled: true };
  }

  /** A failed poll: the last status stands, marked stale (§30.2). */
  private fail(
    watcher: WatcherRow,
    message: string,
    causedBy: string | null,
  ): { watch_id: string; status: WatchScalar | null; changed: false; terminal: false } {
    const failures = this.deps.repos.watchers.markFailed(watcher.id);
    // Edge-triggered: once per streak, not once per poll. A carrier API down
    // for a day should cost one notification, not two hundred.
    if (failures === WATCH_FAILURE_THRESHOLD) {
      this.deps.intake.submit({
        type: 'watch.failed',
        source: 'watcher',
        payload: {
          watch_id: watcher.id,
          note: watcher.note,
          error: message,
          consecutive_failures: failures,
        },
        ...(causedBy ? { caused_by: causedBy } : {}),
        serialization_key: watcher.id,
      });
    }
    l.warn({ watch: watcher.id, failures, err: message }, 'watcher poll failed');
    return {
      watch_id: watcher.id,
      status: watcher.last_status,
      changed: false,
      terminal: false,
    };
  }

  private async execute(
    handle: ToolHandle,
    args: Record<string, unknown>,
    toolCtx: ToolContext,
  ): Promise<{ output: unknown } | { error: string; message: string }> {
    try {
      const outcome = await Promise.race([
        handle.call(args, toolCtx),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('poll timed out')), POLL_TIMEOUT_MS),
        ),
      ]);
      if (!outcome.ok) {
        const err = outcome.output as { error?: string; message?: string } | null;
        return {
          error: err?.error ?? 'tool_failed',
          message: err?.message ?? err?.error ?? 'the call failed',
        };
      }
      return { output: outcome.output };
    } catch (e) {
      return { error: 'tool_failed', message: errMessage(e) };
    }
  }

  /**
   * The human half (§30.4), written on transitions only — never per poll. No
   * commit spam, no reindex churn, and the git log of the file is the journey.
   */
  private appendTransition(
    watcher: WatcherRow,
    from: string | null,
    to: string,
    at: string,
    terminal: boolean,
  ): void {
    const existing = this.deps.files.readText(watcher.state_file)?.content ?? '';
    const body = existing.replace(/^---[\s\S]*?---\n*/, '').trimEnd();
    const line = `- ${at} — \`${from ?? 'unknown'}\` → \`${to}\``;
    this.writeStateFile(watcher, [body, line].filter(Boolean), to, at, terminal);
  }

  private writeStateFile(
    watcher: WatcherRow,
    lines: string[],
    status: string,
    since: string,
    terminal: boolean,
  ): void {
    const front =
      `---\nwatch: ${watcher.id}\nnote: ${watcher.note}\nstatus: ${status}\n` +
      `since: ${since}\nterminal: ${terminal}\n---\n\n`;
    try {
      this.deps.files.write(
        watcher.state_file,
        `${front}${lines.join('\n')}\n`,
        `watch ${watcher.note}: ${status}`,
      );
    } catch (e) {
      // A state file that cannot be written must not lose the transition: the
      // row and the event carry it regardless.
      l.warn({ watch: watcher.id, err: errMessage(e) }, 'state file write failed');
    }
  }
}

function isScalar(value: unknown): value is WatchScalar {
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean';
}

/** `state/<note-slug>.md` (§30.4); collisions are the caller's to resolve. */
export function defaultStateFile(note: string): string {
  const slug =
    note
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'watch';
  return `state/${slug}.md`;
}
