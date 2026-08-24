import type { AgentActivity } from '../model/types.js';

/**
 * Streaming chat frames are transient (App. D): they are pushed to whoever is
 * listening now, never outboxed, never replayed. A reconnecting client
 * re-fetches the completed turn from history instead.
 */
export interface ChatDelta {
  conversationId: string;
  runId: string;
  text: string;
}

/**
 * Unsay the turn in flight (§20.8). Transient like every other stream frame,
 * and it needs no text: the client drops what it is holding for this run, and
 * whatever comes next arrives as ordinary deltas.
 */
export interface ChatRetract {
  conversationId: string;
  runId: string;
}

export interface ChatDone {
  conversationId: string;
  runId: string;
  turnSeq: number;
}

export interface ChatFailure {
  conversationId: string;
  message: string;
}

export interface ChatActivity {
  conversationId: string;
  runId: string;
  activity: AgentActivity;
}

export interface ChatClosed {
  conversationId: string;
}

/**
 * How full the context got, and what the work cost (shown under the input).
 *
 * The distinction §21.1 insists on: `contextUsed` is *pressure* — the largest
 * single prompt the run sent — while `tokensIn` is *billing*, the same prompt
 * counted once per turn. A 16-turn run bills 245k for a 16.5k context, and
 * showing the 245k against the window makes an ordinary conversation look
 * like it is about to fall over.
 */
export interface ChatUsage {
  conversationId: string;
  runId: string;
  model: string;
  turns: number;
  /** Peak single-turn prompt: how much of the window the run actually used. */
  contextUsed: number;
  /** Prompt tokens evaluated rather than served from cache; null = unknown. */
  promptEvaluated: number | null;
  /** Prompt tokens billed on the turns `promptEvaluated` covers. */
  billedWithTimings: number;
  tokensIn: number;
  tokensOut: number;
  contextSize: number | null;
  conversationTokensIn: number;
  conversationTokensOut: number;
  /**
   * What this run and this conversation cost at configured prices (§10.5).
   * Null when everything in scope was costless *by declaration* — the local
   * box — which is a different statement from zero.
   */
  cost: { run: number; conversation: number; currency: string } | null;
  durationMs: number;
  queueWaitMs: number;
}

export interface ChatTitled {
  conversationId: string;
  title: string;
}

export interface ChatDeleted {
  conversationId: string;
  turns: number;
}

export interface ChatModeChange {
  conversationId: string;
  mode: 'normal' | 'onboarding';
}

export interface ChatStreamEvents {
  delta(e: ChatDelta): void;
  retract(e: ChatRetract): void;
  activity(e: ChatActivity): void;
  closed(e: ChatClosed): void;
  deleted(e: ChatDeleted): void;
  usage(e: ChatUsage): void;
  titled(e: ChatTitled): void;
  done(e: ChatDone): void;
  failed(e: ChatFailure): void;
  mode(e: ChatModeChange): void;
}

type Listener = Partial<ChatStreamEvents>;

/** Fan-out with no dependency on the transport — sockets subscribe here. */
export class ChatStreamHub implements ChatStreamEvents {
  private readonly listeners = new Set<Listener>();

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  delta(e: ChatDelta): void {
    for (const l of this.listeners) l.delta?.(e);
  }
  retract(e: ChatRetract): void {
    for (const l of this.listeners) l.retract?.(e);
  }
  activity(e: ChatActivity): void {
    for (const l of this.listeners) l.activity?.(e);
  }
  closed(e: ChatClosed): void {
    for (const l of this.listeners) l.closed?.(e);
  }
  deleted(e: ChatDeleted): void {
    for (const l of this.listeners) l.deleted?.(e);
  }
  usage(e: ChatUsage): void {
    for (const l of this.listeners) l.usage?.(e);
  }
  titled(e: ChatTitled): void {
    for (const l of this.listeners) l.titled?.(e);
  }
  done(e: ChatDone): void {
    for (const l of this.listeners) l.done?.(e);
  }
  failed(e: ChatFailure): void {
    for (const l of this.listeners) l.failed?.(e);
  }
  mode(e: ChatModeChange): void {
    for (const l of this.listeners) l.mode?.(e);
  }
}
