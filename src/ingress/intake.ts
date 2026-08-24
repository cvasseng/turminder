import { log } from '../core/logger.js';
import type { Settings } from '../core/config.js';
import type { Repos } from '../db/repos/index.js';
import type { EventRecord } from '../db/repos/events.js';

const l = log('intake');

export interface SubmitInput {
  type: string;
  source: string;
  payload: unknown;
  occurred_at?: string | null;
  idempotency_key?: string | null;
  serialization_key?: string | null;
  /** Provenance: the event that caused this one (§4.1). */
  caused_by?: string | null;
  /** The run that emitted it — supplies handler identity for the cycle check. */
  emitted_by_run?: string | null;
}

export type RejectionReason = 'depth_exceeded' | 'cycle_detected';

export type SubmitResult =
  | { status: 'accepted'; event: EventRecord }
  | { status: 'duplicate'; event: EventRecord }
  | { status: 'rejected'; event: EventRecord; reason: RejectionReason };

/**
 * The one door into the event log (§4). Dedupe, provenance stamping and loop
 * prevention live here, so no source can bypass them — including handlers
 * emitting events through the `events.emit` tool (§5.5).
 */
export class EventIntake {
  private onAccepted: ((event: EventRecord) => void) | null = null;

  constructor(
    private readonly repos: Repos,
    private readonly settings: Settings,
  ) {}

  /** The work queue registers here to be woken on arrival. */
  onEvent(cb: (event: EventRecord) => void): void {
    this.onAccepted = cb;
  }

  submit(input: SubmitInput): SubmitResult {
    const parent = input.caused_by ? this.repos.events.get(input.caused_by) : null;
    if (input.caused_by && !parent) {
      l.warn(
        { caused_by: input.caused_by },
        'caused_by names an unknown event; treating as root',
      );
      // Don't carry a dangling reference into the row: events.caused_by is a
      // foreign key, and an audit trail pointing at nothing is worse than none.
      input = { ...input, caused_by: null };
    }
    const depth = parent ? parent.depth + 1 : 0;

    if (depth > this.settings.maxDepth) {
      return this.reject(input, depth, 'depth_exceeded');
    }
    if (parent && this.cycleDetected(input, parent)) {
      return this.reject(input, depth, 'cycle_detected');
    }

    const { event, duplicate } = this.repos.events.insert({
      type: input.type,
      source: input.source,
      payload: input.payload,
      occurred_at: input.occurred_at ?? null,
      idempotency_key: input.idempotency_key ?? null,
      serialization_key: input.serialization_key ?? null,
      caused_by: input.caused_by ?? null,
      depth,
    });

    if (duplicate) {
      l.debug({ id: event.id, key: input.idempotency_key }, 'duplicate event dropped');
      return { status: 'duplicate', event };
    }

    this.repos.trace.append('state', { from: null, to: 'received' }, { eventId: event.id });
    if (input.caused_by) {
      this.repos.trace.append(
        'emit',
        { emitted_event_id: event.id, type: event.type },
        { eventId: input.caused_by, runId: input.emitted_by_run ?? null },
      );
    }
    l.info({ id: event.id, type: event.type, source: event.source, depth }, 'event received');
    this.onAccepted?.(event);
    return { status: 'accepted', event };
  }

  /**
   * Loop prevention (§5.5): the same emitter producing the same serialization
   * key twice in one provenance chain is a cascade, not a workflow.
   */
  private cycleDetected(input: SubmitInput, parent: EventRecord): boolean {
    const identity = this.emitterIdentity(input.emitted_by_run ?? null, input.type);
    const key = input.serialization_key ?? null;
    for (const ancestor of this.repos.events.chain(parent.id)) {
      const emitter = this.repos.trace.emitterOf(ancestor.id);
      const ancestorIdentity = emitter?.handlerName
        ? `handler:${emitter.handlerName}`
        : `type:${ancestor.type}`;
      if (ancestorIdentity === identity && (ancestor.serialization_key ?? null) === key) {
        return true;
      }
    }
    return false;
  }

  private emitterIdentity(runId: string | null, type: string): string {
    if (runId) {
      const run = this.repos.runs.get(runId);
      if (run?.handler_name) return `handler:${run.handler_name}`;
    }
    return `type:${type}`;
  }

  /**
   * A rejected event is still written — the audit trail is the point (App. C.2)
   * — and reports itself as `system.loop_suspected` at depth 0.
   */
  private reject(input: SubmitInput, depth: number, reason: RejectionReason): SubmitResult {
    const { event } = this.repos.events.insert({
      type: input.type,
      source: input.source,
      payload: input.payload,
      occurred_at: input.occurred_at ?? null,
      idempotency_key: input.idempotency_key ?? null,
      serialization_key: input.serialization_key ?? null,
      caused_by: input.caused_by ?? null,
      depth,
      status: 'rejected',
    });
    this.repos.events.setStatus(event.id, 'rejected', { last_error: reason });
    this.repos.trace.append(
      'state',
      { from: null, to: 'rejected', reason },
      { eventId: event.id },
    );
    l.warn({ id: event.id, type: input.type, depth, reason }, 'event rejected');

    const report = this.repos.events.insert({
      type: 'system.loop_suspected',
      source: 'system',
      payload: {
        rejected_type: input.type,
        caused_by: input.caused_by ?? null,
        depth,
        reason,
        rejected_event_id: event.id,
      },
      depth: 0,
    });
    this.repos.trace.append(
      'state',
      { from: null, to: 'received' },
      { eventId: report.event.id },
    );
    this.onAccepted?.(report.event);

    return { status: 'rejected', event: { ...event, status: 'rejected' }, reason };
  }
}
