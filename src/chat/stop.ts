import { log } from '../core/logger.js';

const l = log('chat');

/**
 * The in-flight chat runs, keyed by conversation (App. D `chat.stop`). The
 * `RunGrants` shape (§23.2), for the same reason: the executor registers for
 * exactly the life of the run, the socket layer asks by conversation, and
 * "abort this" has one source. One entry per conversation by construction —
 * `chat.message` serializes on the conversation id (§4.4), so two runs for
 * one conversation cannot be in flight at once.
 */
export class ChatStops {
  private readonly inFlight = new Map<string, { runId: string; controller: AbortController }>();

  /** Registers for the life of the run; call the returned function to drop it. */
  register(conversationId: string, runId: string, controller: AbortController): () => void {
    if (this.inFlight.has(conversationId)) {
      // Serialization should make this impossible; if it happens, the newer
      // run is the one the user is watching, so it wins the slot.
      l.warn({ conversation: conversationId }, 'two chat runs registered for one conversation');
    }
    this.inFlight.set(conversationId, { runId, controller });
    return () => {
      const current = this.inFlight.get(conversationId);
      if (current?.runId === runId) this.inFlight.delete(conversationId);
    };
  }

  /**
   * Abort the running turn, if any. Null means nothing was running — which the
   * frame layer treats as success, the `ack` precedent: the state the user
   * asked for is already the state.
   */
  stop(conversationId: string): { runId: string } | null {
    const entry = this.inFlight.get(conversationId);
    if (!entry) return null;
    entry.controller.abort(new Error('stopped_by_user'));
    l.info({ conversation: conversationId, run: entry.runId }, 'chat run stopped by user');
    return { runId: entry.runId };
  }
}
