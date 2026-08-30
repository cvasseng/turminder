import type { Identity, Personality } from '../core/config-schemas.js';
import type { RunKind } from '../model/types.js';
import { BASE_PROMPTS, VOICE_FRAGMENT } from './base.js';

export interface SkillRosterEntry {
  name: string;
  description: string;
}

/** One line per project — name and description, never content (§31.2). */
export interface ProjectRosterEntry {
  name: string;
  description: string;
}

export interface MemoryBlockEntry {
  name: string;
  description: string;
  content: string;
}

export interface PromptParts {
  kind: RunKind;
  identity?: { frontmatter: Identity; body: string } | null;
  personality?: { frontmatter: Personality; body: string } | null;
  /** Description-only roster; bodies are fetched on match (§11.1). */
  skills?: SkillRosterEntry[];
  /**
   * The project roster (§31.2, H.1 item 3): what islands exist, so the
   * assistant can offer to load one instead of hallucinating that it cannot.
   * Same volatility class as the skill roster — it changes when a project is
   * created or its manifest edited, which is rare enough for the prefix cache.
   */
  projects?: ProjectRosterEntry[];
  /**
   * Closed-namespace catalog lines (§21.2.2, H.1 item 3½). Conversation-stable:
   * it changes only when the open set does, which is exactly the moment a
   * prefix bust is bought and paid for.
   */
  toolCatalog?: string[];
  /**
   * @deprecated Retrieved memory is message-side now (§20.5, H.1 item 5):
   * pass it through `fenceMemoryRecall` into the messages array instead.
   * Kept only so a caller that still sets it fails loudly at review rather
   * than silently reintroducing the cache-busting placement.
   */
  memories?: never;
  /**
   * This is a voice conversation (§33.1): the `voice` fragment (H.5) joins the
   * base prompt. Conversation-scoped, not turn-scoped — it is true for every
   * turn of a spoken conversation and for none of a typed one, which is what
   * makes it safe to put in the prefix at all (§20.5).
   */
  voice?: boolean;
  /** Handler document body, or other per-run task instructions. */
  taskContext?: string;
  /**
   * Current time. Only for agent kinds with no tools — the ingress classifier
   * and the distiller — because a timestamp in a prompt goes stale and
   * invalidates everything after it in the prompt cache (App. F.10, H.1).
   * Everything that can call `time.now` is told to do that instead.
   */
  now?: string;
}

function identitySection(parts: PromptParts): string | null {
  const id = parts.identity?.frontmatter;
  const p = parts.personality?.frontmatter;
  if (!id && !p) return null;
  const lines: string[] = [];
  if (id) {
    lines.push(
      `Your name is ${id.instance_name}. The user is ${id.user_name}.`,
      `Their timezone is ${id.timezone} and their locale is ${id.locale}.`,
    );
    if (parts.identity?.body) lines.push(parts.identity.body);
  }
  if (p) {
    lines.push(
      `Register: formality ${p.formality}, verbosity ${p.verbosity}, humor ${p.humor}.`,
    );
    if (parts.personality?.body) lines.push(parts.personality.body);
  }
  return lines.join('\n');
}

/**
 * Assembles the system prompt: H.1 items 1–4 only — base prompt, identity and
 * personality, skill roster, closed-namespace catalog. Items 5–7 (retrieved
 * memory, task context, the payload or latest user message) are message-side,
 * because anything that changes per turn ends the byte-stable prefix where it
 * sits (§20.5).
 */
export function assembleSystemPrompt(parts: PromptParts): string {
  const base = parts.voice
    ? `${BASE_PROMPTS[parts.kind]}\n\n${VOICE_FRAGMENT}`
    : BASE_PROMPTS[parts.kind];
  const sections: string[] = [base];

  const identity = identitySection(parts);
  if (identity) sections.push(`# Who you are\n\n${identity}`);

  if (parts.skills?.length) {
    const roster = parts.skills.map((s) => `- ${s.name}: ${s.description}`).join('\n');
    sections.push(
      `# Skills available\n\nFetch the full document with skills.fetch when one looks relevant.\n\n${roster}`,
    );
  }

  if (parts.projects?.length) {
    const roster = parts.projects.map((p) => `- ${p.name}: ${p.description}`).join('\n');
    sections.push(
      `# Projects\n\nKnowledge islands: files, memories and past discussions fenced off ` +
        `until one is loaded. Call project.load when the user wants to work on one; ` +
        `until then you can see these names and nothing inside them.\n\n${roster}`,
    );
  }

  if (parts.toolCatalog?.length) {
    sections.push(
      `# Tool namespaces not loaded\n\n` +
        `These are available to you but not loaded right now, to keep the ` +
        `context small. Open one with tools.open before using its tools; it ` +
        `stays open for the rest of this conversation.\n\n` +
        parts.toolCatalog.join('\n'),
    );
  }

  if (parts.taskContext) sections.push(parts.taskContext);
  if (parts.now) sections.push(`Current time: ${parts.now}`);

  return sections.join('\n\n---\n\n');
}
