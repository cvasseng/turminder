/**
 * Fan-out for "this embed is not what you are looking at any more", with no
 * idea what a socket is — the chat UI subscribes so an inlined view refreshes
 * when the assistant iterates on it, instead of showing last version's chart
 * until the page is reloaded.
 *
 * Deliberately narrow. It fires for authoring acts on the *content* — an edit,
 * a binding change, a manual data refresh — and never for a state-pouch write.
 * An embed's own `setState` would otherwise reload the page under the user's
 * finger every time they clicked something in it.
 */
export interface EmbedChanged {
  embedId: string;
  /** Why, for logs; the frame carries only the id (App. D). */
  reason: 'edited' | 'data';
}

export class EmbedEvents {
  private readonly listeners = new Set<(e: EmbedChanged) => void>();

  subscribe(listener: (e: EmbedChanged) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  changed(e: EmbedChanged): void {
    for (const listener of this.listeners) listener(e);
  }
}
