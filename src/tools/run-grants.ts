import { log } from '../core/logger.js';
import type { ToolHandle } from './types.js';

const l = log('tools');

/** What a run's grant set can answer. `GrantedDispatcher` satisfies it as-is. */
export interface RunGrantView {
  granted(): string[];
  grantedHandles(): ToolHandle[];
}

/**
 * The grant sets of runs currently in flight, keyed by run id.
 *
 * It exists for exactly one question: `embeds.bind` must refuse to freeze a
 * call the calling run could not have made itself (§23.2) — "you cannot bind
 * what you could not call". The tool cannot work that out from its own
 * arguments, and re-deriving the grant set from config would put a second
 * answer to "what may this run call" next to the dispatcher's, which is how
 * a capability comes to look reachable and not be.
 *
 * So the dispatcher registers itself, and the answer has one source. What is
 * registered is always the **inner** `GrantedDispatcher`, never the paged
 * wrapper: paging decides what is *rendered* this turn, and a binding must not
 * depend on which namespaces happened to be open (§21.2).
 */
export class RunGrants {
  private readonly inFlight = new Map<string, RunGrantView>();

  /** Registers for the life of the run; call the returned function to drop it. */
  register(runId: string, view: RunGrantView): () => void {
    if (this.inFlight.has(runId)) {
      // Two dispatchers for one run id means someone reused an id; the second
      // would silently answer for the first.
      l.warn({ run: runId }, 'run grants registered twice for one run');
    }
    this.inFlight.set(runId, view);
    return () => {
      this.inFlight.delete(runId);
    };
  }

  /**
   * The run's grant view, or null when there is none — a tool call outside any
   * run, which fails closed at the call sites that ask.
   */
  get(runId: string | null | undefined): RunGrantView | null {
    return runId ? (this.inFlight.get(runId) ?? null) : null;
  }
}
