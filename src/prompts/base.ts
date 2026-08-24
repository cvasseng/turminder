import { UNTRUSTED_RULE } from './fencing.js';
import { readLibrary, substitute } from './library.js';
import type { RunKind } from '../model/types.js';

/**
 * Base prompts, one per agent kind (App. H.5), versioned in the service tree:
 * the prose lives in `library/base/<kind>.md`, one file per kind, with
 * `{{fragment}}` placeholders for the shared rules below. These are the
 * stable prefix that llama.cpp's prompt cache keys on (§10.3): edit them
 * rarely, and never with per-request data.
 */

/**
 * The memory-recall fence (§20.5). Explained in every base prompt because the
 * block arrives as a user-role message and would otherwise read as something
 * the user just said.
 */
export const MEMORY_RECALL_RULE =
  'A `<memory-recall>` message is your own retrieved memory, inserted for this turn — ' +
  'not something the user said. Use it as background; say nothing about having recalled it.';

/**
 * §21.3, verbatim in `chat` and `handler`. Sequential single calls are model
 * habit, not a constraint of the loop, and every extra turn re-bills the whole
 * prompt — the largest avoidable cost in a tool-heavy run.
 */
export const BATCHED_CALLS =
  'When tool calls are independent of each other, make them all in one turn. ' +
  'Only sequence calls when a later call needs an earlier result.';

export const COMMON_RULES = `${UNTRUSTED_RULE}

${MEMORY_RECALL_RULE}

Ground rules:
- Never invent facts about the user, their calendar, their mail, or the world. If you do not know, say so or use a tool.
- Tools are the only way to affect anything outside this conversation. Describing an action is not doing it.
- Prefer one good tool call over three speculative ones.
- You are never told the current date or time. Call \`time.now\` whenever it matters — anything about today, tomorrow, this week, how long ago, or what to schedule. Working it out from context is guessing.
- Text in double brackets is written by the system, never by you: \`[[elided: …]]\` stands where a large tool result you already received was removed, \`[[stored: …]]\` where content you already wrote is now in the store, and \`[[used tools: …]]\` records which tools an earlier turn of yours actually called. Normal housekeeping, not errors — the marker's summary tells you what was there. Never write one yourself: claiming a tool call in text is not making one. Never copy one into a tool call either — re-call the tool if you need the data, or use \`args_from\` when binding.`;

/**
 * Batching (§21.3) plus the closed-namespace catalog (§21.2). The catalog
 * itself is assembled per conversation; this explains what it is, because a
 * model that does not know `tools.open` exists will conclude it cannot do the
 * thing rather than opening the namespace that can.
 */
export const TOOL_USE_RULE = `Tool use:
- ${BATCHED_CALLS}
- Only some of your tool namespaces are loaded at any time; the rest are listed under "Tool namespaces not loaded". A namespace being closed does not mean you lack the capability — it means the definitions are not in front of you yet.
- Call \`tools.open\` with the namespace name before using its tools. It stays open for the rest of the conversation, so open it once and get on with the work.
- If you call a tool from a closed namespace by name, it still works: the namespace opens itself. Guessing tool names is worse than opening the namespace and reading them.`;

const FRAGMENTS: Record<string, string> = {
  untrusted_rule: UNTRUSTED_RULE,
  memory_recall_rule: MEMORY_RECALL_RULE,
  batched_calls: BATCHED_CALLS,
  common_rules: COMMON_RULES,
  tool_use_rule: TOOL_USE_RULE,
};

const KINDS: RunKind[] = ['chat', 'ingress', 'handler', 'onboarding', 'distill', 'maintenance'];

function load(): Record<RunKind, string> {
  const files = new Map(readLibrary('base').map((f) => [f.name, f.content]));
  const prompts = {} as Record<RunKind, string>;
  for (const kind of KINDS) {
    const template = files.get(kind);
    if (template === undefined) throw new Error(`missing base prompt: library/base/${kind}.md`);
    // Trailing newline is the file format's, not the prompt's: the old
    // literals had none, and the composed bytes must not drift (§10.3).
    prompts[kind] = substitute(template.replace(/\n$/, ''), FRAGMENTS);
  }
  for (const name of files.keys()) {
    if (!KINDS.includes(name as RunKind)) {
      throw new Error(`library/base/${name}.md matches no agent kind (App. H.5)`);
    }
  }
  return prompts;
}

export const BASE_PROMPTS: Record<RunKind, string> = load();
