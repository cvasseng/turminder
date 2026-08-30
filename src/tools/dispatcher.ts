import { jsonSchema, tool, type ToolSet } from 'ai';
import { globMatchAny } from '../core/glob.js';
import { errMessage } from '../core/errors.js';
import { log } from '../core/logger.js';
import type { DispatchCall, DispatchResult, ToolDispatcher } from '../model/dispatcher.js';
import { redactTraceArgs } from './redact.js';
import type { ToolContext, ToolHandle } from './types.js';

const l = log('tools');

export interface Grants {
  /** Glob patterns whose tools auto-execute. */
  tools?: readonly string[];
  /** Glob patterns whose tools are visible but human-gated (App. F.7). */
  confirm?: readonly string[];
}

/**
 * Asks the human about a `confirm`-level call (§7.3, App. F.7). Both executors
 * supply `ConfirmBroker.request`, which queues a `confirm` delivery and
 * suspends the run until the button click arrives back as a
 * `notification.action` event.
 */
export type ConfirmFn = (call: DispatchCall, handle: ToolHandle) => Promise<boolean>;

/**
 * The default for dispatchers built with no `confirm` globs at all — the embed
 * binder, most tests. Reaching it means a gated tool got through to a
 * dispatcher that has nobody to ask, so the only safe answer is no.
 */
const denyUnasked: ConfirmFn = async () => false;

/**
 * The enforcement point (§11.4, App. F.7). Built per run from that run's grants:
 * ungranted tools are absent from the definitions the model sees, and a forged
 * call is refused here rather than reaching an implementation.
 *
 * Three grant levels per tool: absent (invisible), `confirm` (visible,
 * human-gated), `tools` (visible, auto).
 */
/** Either a fixed value or something re-read whenever the dispatcher looks. */
type OrProvider<T> = T | (() => T);

function read<T>(input: OrProvider<T>): T {
  return typeof input === 'function' ? (input as () => T)() : input;
}

export class GrantedDispatcher implements ToolDispatcher {
  /**
   * @param available Tools in the process. Pass a function when the set can
   *   change during the run — installing an MCP server mid-conversation does
   *   exactly that (§19.3).
   * @param grants The run's grant. Also accepts a function, so access approved
   *   part-way through a run is usable on the next turn of that same run
   *   rather than the next message.
   */
  constructor(
    private readonly available: OrProvider<readonly ToolHandle[]>,
    private readonly grants: OrProvider<Grants>,
    private readonly ctx: ToolContext,
    private readonly confirm: ConfirmFn = denyUnasked,
  ) {}

  /**
   * Split what is available into auto and human-gated. Recomputed per call
   * rather than cached: it is a handful of glob matches, and a stale grant is
   * either a capability the user revoked and still has, or one they approved
   * and cannot use.
   */
  private resolve(): { auto: ToolHandle[]; gated: ToolHandle[] } {
    const available = read(this.available);
    const grants = read(this.grants);
    // `confirm` wins over `tools`: naming one tool for confirmation is always
    // more specific than the broad glob that also swept it up, so
    // `tools: [calendar.*]` + `confirm: [calendar.delete_event]` means what it
    // looks like it means.
    const gated = available.filter((t) => globMatchAny(grants.confirm ?? [], t.name));
    const auto = available.filter(
      (t) => globMatchAny(grants.tools ?? [], t.name) && !gated.includes(t),
    );
    return { auto, gated };
  }

  /** Names the model can see — auto plus human-gated. */
  granted(): string[] {
    const { auto, gated } = this.resolve();
    return [...auto, ...gated].map((t) => t.name);
  }

  /** The handles behind `granted()`, for callers that need more than names. */
  grantedHandles(): ToolHandle[] {
    const { auto, gated } = this.resolve();
    return [...auto, ...gated];
  }

  toolSet(): ToolSet {
    const { auto, gated } = this.resolve();
    const set: ToolSet = {};
    // Sorted by name (§21.2.7): the definitions are serialised in insertion
    // order at the head of every prompt, so anything but a stable order is a
    // prefix-cache miss on a turn that changed nothing.
    const ordered = [...auto, ...gated].sort((a, b) =>
      a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
    );
    for (const handle of ordered) {
      set[handle.name] = tool({
        description: gated.includes(handle)
          ? `${handle.description} (requires the user's approval)`
          : handle.description,
        inputSchema: jsonSchema(handle.inputSchema as never),
      });
    }
    return set;
  }

  async dispatch(call: DispatchCall): Promise<DispatchResult> {
    // Computed once and attached to every return path: a refused call is still
    // a traced call, and a `setup.*` refusal must not record what it refused.
    // Absent when nothing needed masking, which is the common case.
    const redacted = redactTraceArgs(call.name, call.args);
    const traceArgs = redacted === call.args ? {} : { traceArgs: redacted };
    const { auto, gated } = this.resolve();
    const handle =
      auto.find((t) => t.name === call.name) ?? gated.find((t) => t.name === call.name);
    if (!handle) {
      l.warn({ tool: call.name, granted: this.granted() }, 'refused ungranted tool call');
      return {
        ok: false,
        output: { error: 'unknown_tool' },
        denied: 'not_granted',
        ...traceArgs,
      };
    }

    if (gated.includes(handle)) {
      const approved = await this.confirm(call, handle);
      if (!approved) {
        return {
          ok: false,
          output: { error: 'denied_by_user' },
          denied: 'confirm_denied',
          ...traceArgs,
        };
      }
    }

    try {
      // `traceOutput` (§20.3) rides through untouched: the trace must show what
      // the tool returned, not what the transcript budget left of it.
      // `bulkArgs` is reported only from here, the one path where the tool ran
      // and its content is therefore readable back (§20.6) — and only when it
      // succeeded: a refused or failed write stored nothing, and a stub saying
      // "written and is stored" over content that was not is exactly the lie
      // that sent a model re-sending its writes (2026-08-30).
      const outcome = await handle.call(call.args, this.ctx);
      const stored = outcome.ok && !isErrorReturn(outcome.output);
      return {
        ...outcome,
        ...traceArgs,
        ...(handle.bulkArgs?.length && stored ? { bulkArgs: handle.bulkArgs } : {}),
        // Structural emptiness, decided here because this is where the handle
        // is (§20.9). The loop counts; it does not judge.
        empty: isEmptyResult(handle, outcome.output),
      };
    } catch (e) {
      l.warn({ tool: call.name, err: errMessage(e) }, 'tool execution failed');
      return {
        ok: false,
        output: { error: 'tool_failed', message: errMessage(e) },
        ...traceArgs,
        empty: true,
      };
    }
  }
}

/**
 * Did the tool return nothing (§20.9)? A declared predicate answers for the
 * tools that can; everything else — including every external MCP tool — gets
 * the fail-open fallback: an `{error: …}` return counts as empty, and nothing
 * else does. "Returned nothing" is structural; "was useless" is the model's
 * call, and this must never quietly become that.
 */
function isEmptyResult(handle: ToolHandle, output: unknown): boolean {
  if (handle.isEmpty) {
    try {
      return handle.isEmpty(output);
    } catch {
      // A predicate that throws is a bug in one tool, not a reason to stop.
      return false;
    }
  }
  return isErrorReturn(output);
}

/** The expected-failure shape every tool speaks (`{error, message}`). */
function isErrorReturn(output: unknown): boolean {
  return Boolean(output && typeof output === 'object' && 'error' in output);
}
