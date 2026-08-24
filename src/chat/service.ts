import { log } from '../core/logger.js';
import { isoPlusSeconds } from '../core/time.js';
import type { Config } from '../core/config.js';
import type { Repos } from '../db/repos/index.js';
import type { ConversationRow, Turn } from '../db/repos/index.js';
import type { EventIntake } from '../ingress/intake.js';
import type { ChatStreamHub } from './stream.js';
import type { UploadStore } from '../uploads/store.js';

const l = log('chat');

/** What a message says about its attachments (§26.2, App. B). */
export interface AttachmentMeta {
  upload_id: string;
  name: string;
  mime: string;
  bytes: number;
}

export interface SendResult {
  conversationId: string;
  eventId: string;
  mode: ConversationRow['mode'];
}

/**
 * What the network layer talks to. Creating conversations, deciding onboarding
 * mode, and closing conversations are policy, so they live here rather than in
 * a socket handler.
 */
/**
 * The serialization key every greeting shares (App. B), so the two emitters
 * cannot produce two of them — and so a pending one is findable.
 */
const ONBOARDING_KEY = 'onboarding';

export class ChatService {
  constructor(
    private readonly repos: Repos,
    private readonly config: Config,
    private readonly intake: EventIntake,
    private readonly stream: ChatStreamHub,
    /** Chat attachments (§26.2); absent in composition roots without them. */
    private readonly uploads?: UploadStore,
  ) {}

  /** True until onboarding has written config/identity.md (plan §3c). */
  needsOnboarding(): boolean {
    return this.config.identity() === null;
  }

  /**
   * Ask for the opening greeting, if this install still needs one (§3c).
   *
   * Onboarding is a conversation, and until now it was a conversation nobody
   * started: the prompt is written as an introduction, but the only thing that
   * created a conversation was the user sending a message. So a fresh install
   * finished setup and landed in an empty chat with an `onboarding` badge and
   * no idea it was waiting to be spoken to.
   *
   * An event rather than a direct call, because a run belongs to an event
   * (§1.1) — this is the same shape as every other thing that makes the
   * assistant act on its own. Called from two places, since either can be the
   * moment it becomes true: setup committing a model, and any start that finds
   * models but no identity.
   *
   * Returns whether an event was emitted, which is what the callers log.
   */
  requestOnboarding(): boolean {
    if (!this.needsOnboarding()) return false;
    // A greeting still on the queue is a greeting: both emitters run on every
    // start, and the first one's *run* has not created a conversation yet, so
    // the check below cannot see it. `oldestPending` is the same per-key
    // primitive the queue orders by (§4.4), asked a different question.
    if (this.repos.events.oldestPending(ONBOARDING_KEY)) return false;
    // An existing onboarding conversation that has already said something is
    // one already in progress; an empty one is a greeting that never landed,
    // and the run reuses it rather than leaving a litter of empties behind.
    const existing = this.repos.conversations.onboardingConversation();
    if (existing && this.repos.conversations.turnCount(existing.id) > 0) return false;
    const submitted = this.intake.submit({
      type: 'system.onboarding_ready',
      source: 'system',
      payload: {},
      // Constant, so the emit at start and the emit at setup-commit cannot
      // produce two greetings running at once (App. B).
      serialization_key: ONBOARDING_KEY,
    });
    return submitted.status === 'accepted';
  }

  /**
   * Turn upload ids into the metadata a message carries (§26.2). Separate from
   * `send` and returning a value on failure, because an id that does not
   * resolve is the client's mistake: it must come back as an error at send
   * time, never as a silently text-only message. Taking *metadata* rather than
   * ids in `send` is what makes skipping this step a type error.
   */
  resolveAttachments(
    ids: readonly string[],
  ): AttachmentMeta[] | { error: 'not_found'; message: string } {
    if (!ids.length) return [];
    const rows = this.uploads?.repo.many(ids) ?? [];
    if (rows.length !== ids.length) {
      const missing = ids.filter((id) => !rows.some((r) => r.id === id));
      return {
        error: 'not_found',
        message: `no such upload: ${missing.join(', ')} — it may have expired`,
      };
    }
    // Metadata, never bytes (§26.2): the server reads the file at assembly
    // time, so nothing here has to travel through a payload or a turn.
    return rows.map((r) => ({
      upload_id: r.id,
      name: r.name,
      mime: r.mime,
      bytes: r.bytes,
    }));
  }

  send(input: {
    conversationId?: string | null;
    text: string;
    attachments?: readonly AttachmentMeta[];
  }): SendResult {
    let conversation = input.conversationId
      ? this.repos.conversations.get(input.conversationId)
      : null;
    if (input.conversationId && !conversation) {
      // A client may propose an id; honour it so retries stay idempotent.
      conversation = this.repos.conversations.create({
        id: input.conversationId,
        mode: this.needsOnboarding() ? 'onboarding' : 'normal',
      });
    }
    if (!conversation) {
      conversation = this.repos.conversations.create({
        mode: this.needsOnboarding() ? 'onboarding' : 'normal',
      });
    }
    if (conversation.status === 'closed') {
      // Keep talking where you left off. Forking a new conversation here is
      // what made history appear to vanish: the client went on pointing at the
      // old id while turns landed somewhere else. Distillation has already run
      // on close; it runs again on the new turns, and memory dedupes.
      this.repos.conversations.reopen(conversation.id);
      conversation = { ...conversation, status: 'open' };
      l.info({ conversation: conversation.id }, 'reopened a closed conversation');
    }

    const attachments = input.attachments ?? [];
    if (attachments.length) {
      // First reference claims them, so the reaper and the UI both know which
      // conversation an upload belongs to (§26.1).
      this.uploads?.repo.attachTo(
        conversation.id,
        attachments.map((a) => a.upload_id),
      );
    }

    const result = this.intake.submit({
      type: 'chat.message',
      source: 'chat',
      payload: {
        conversation_id: conversation.id,
        text: input.text,
        ...(attachments.length ? { attachments } : {}),
      },
      serialization_key: conversation.id,
    });

    return {
      conversationId: conversation.id,
      eventId: result.event.id,
      mode: conversation.mode,
    };
  }

  history(
    conversationId: string,
    opts: { limit?: number; beforeSeq?: number } = {},
  ): { turns: Turn[]; more: boolean } {
    const limit = Math.min(opts.limit ?? 50, 200);
    const turns = this.repos.conversations.history(conversationId, {
      limit: limit + 1,
      ...(opts.beforeSeq ? { beforeSeq: opts.beforeSeq } : {}),
    });
    const more = turns.length > limit;
    return { turns: more ? turns.slice(turns.length - limit) : turns, more };
  }

  list(opts: { includeArchived?: boolean } = {}): ConversationRow[] {
    return this.repos.conversations.list({
      limit: 50,
      ...(opts.includeArchived ? { includeArchived: true } : {}),
    });
  }

  /**
   * Delete a conversation outright. Closing archives (and distils); deleting is
   * the user saying they want it gone, so nothing is distilled from it.
   */
  delete(conversationId: string): { deleted: boolean; turns: number } {
    // Embeds outlive their birth conversation (§22.1) — NULL the anchor first,
    // or the foreign key refuses the whole delete. A crash between the two
    // statements leaves harmlessly-early orphans, never a broken delete.
    const orphaned = this.repos.embeds.orphanConversation(conversationId);
    // Attachments hold the same kind of key and get the opposite answer (§26.1):
    // they are ephemera of this transcript, so they go with it — row and bytes.
    const uploads = this.uploads?.destroyForConversation(conversationId) ?? 0;
    const result = this.repos.conversations.remove(conversationId);
    if (result.deleted) {
      this.stream.deleted({ conversationId, turns: result.turns });
      l.info(
        {
          conversation: conversationId,
          turns: result.turns,
          embeds_orphaned: orphaned,
          uploads_destroyed: uploads,
        },
        'conversation deleted',
      );
    }
    return result;
  }

  /**
   * Archive a conversation. Only the user closes one — going idle never does
   * (§9) — and closing emits the hook the distillation pass hangs off.
   */
  close(conversationId: string): { closed: boolean; turnCount: number } {
    const conversation = this.repos.conversations.get(conversationId);
    if (!conversation) return { closed: false, turnCount: 0 };
    const turnCount = this.repos.conversations.turnCount(conversationId);
    const closed = this.repos.conversations.close(conversationId);
    if (closed) {
      this.intake.submit({
        type: 'system.conversation_closed',
        source: 'system',
        // `since` is the mark before this trigger claims it (App. B): the pass
        // reads only turns after it, and the payload freezing the boundary
        // keeps retries of this event distilling the same delta (§8.2).
        payload: {
          conversation_id: conversationId,
          turn_count: turnCount,
          since: conversation.distilled_at,
        },
      });
      this.repos.conversations.markDistilled(conversationId);
      // Tell whoever is connected: another client may have this conversation
      // open, and archiving it here should not leave that one out of date.
      this.stream.closed({ conversationId });
      l.info({ conversation: conversationId, turnCount }, 'conversation closed');
    }
    return { closed, turnCount };
  }

  /**
   * Idle timeout (App. A: 30 min). Called on a timer by the service. A quiet
   * conversation is one the user is probably done with for now, which is when
   * distillation is worth running — but it is *not* the user saying they are
   * done with it, so the conversation stays open and stays in the list.
   * Archiving is theirs to do (§9).
   */
  distillIdle(): number {
    const cutoff = isoPlusSeconds(-this.config.settings.conversationIdleMin * 60);
    const idle = this.repos.conversations.needingDistillation(cutoff);
    let distilled = 0;
    for (const c of idle) {
      const turnCount = this.repos.conversations.turnCount(c.id);
      // An empty conversation nobody spoke in has nothing to distil. Mark it
      // anyway, so the sweep stops picking it up every minute; the first turn
      // in it moves `last_activity_at` past the mark and makes it eligible.
      this.repos.conversations.markDistilled(c.id);
      if (turnCount === 0) continue;
      this.intake.submit({
        type: 'system.conversation_idle',
        source: 'system',
        // The row was read before markDistilled above, so `c.distilled_at` is
        // still the previous mark — the delta boundary (§8.2, App. B).
        payload: { conversation_id: c.id, turn_count: turnCount, since: c.distilled_at },
      });
      distilled += 1;
      l.info({ conversation: c.id }, 'idle conversation queued for distillation');
    }
    return distilled;
  }

  onStream(listener: Parameters<ChatStreamHub['subscribe']>[0]): () => void {
    return this.stream.subscribe(listener);
  }
}
