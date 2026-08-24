import type { ConversationsRepo } from '../db/repos/conversations.js';

/**
 * Which islands a run is allowed to see (§31.3).
 *
 * Resolved from the conversation row at the moment of the call, never
 * snapshotted at run start: `project.load` and the retrieval that follows it
 * happen in the same run, and a stale snapshot would make the load look like
 * it did nothing. Runs with no conversation — handlers, sources, the
 * distiller's own agent — resolve to the empty set, which is the base layer
 * and nothing else.
 */
export class ProjectScope {
  constructor(private readonly conversations: ConversationsRepo) {}

  loaded(conversationId: string | null | undefined): string[] {
    return conversationId ? this.conversations.loadedProjects(conversationId) : [];
  }

  /** Where an untargeted `memory.save` lands (§31.5): the last one loaded. */
  mostRecent(conversationId: string | null | undefined): string | null {
    return this.loaded(conversationId).at(-1) ?? null;
  }
}

/**
 * The scope predicate, in one place (§31.3): a row tagged with a project is
 * returned **only** when that project is loaded here; untagged rows always
 * qualify. Used by the memory and files corpora, whose rows carry one project.
 */
export function scopeClause(
  column: string,
  loaded: string[],
): { sql: string; params: string[] } {
  if (!loaded.length) return { sql: `${column} IS NULL`, params: [] };
  return {
    sql: `(${column} IS NULL OR ${column} IN (${loaded.map(() => '?').join(', ')}))`,
    params: loaded,
  };
}

/**
 * The same question for a row that carries a *set* of projects — a history
 * turn inherits everything its conversation had loaded (§31.2). Every tag must
 * be loaded, not merely one: "loading A never exposes B" (§31.1), and a turn
 * from an A+B conversation is partly about B.
 */
export function inScope(rowProjects: string[], loaded: string[]): boolean {
  return rowProjects.every((p) => loaded.includes(p));
}
