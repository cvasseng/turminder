/**
 * The names tools travel under on the wire, and the way back (§11.5).
 *
 * Turminder names tools `<namespace>.<verb>` — `memory.save`, `web.search`,
 * `calendar.create_task`. That is App. F's scheme and the vocabulary of grants,
 * handler frontmatter, the tool catalog and every prompt that mentions a
 * capability. It is also **not a legal tool name** at two of the three big
 * hosted providers: Anthropic pins `^[a-zA-Z0-9_-]{1,128}$` and OpenAI the same
 * shape, so a dotted name is rejected before the model ever sees it
 * (`tools.0.custom.name: String should match pattern …`). llama.cpp, vLLM and
 * Gemini accept dots, which is exactly why this went unnoticed: the endpoints
 * this was developed against are the permissive ones, and the §10.2 capability
 * probe therefore reported "no tool support" for models that have had it for
 * years.
 *
 * So the dot is an internal fact, and the wire gets `__`. The translation is a
 * **facade at the one boundary every call crosses** rather than a change to the
 * naming scheme: renaming the catalog would rename grants, handler frontmatter,
 * users' existing `grants.yaml` files and App. F itself to satisfy somebody
 * else's regex, and would leave the next provider free to pick a different one.
 *
 * ## Why `__` and not `_`
 *
 * Because the pair below must be a **true inverse**, not a lookup. A single
 * underscore is ambiguous — `calendar.create_task` and `calendar_create.task`
 * both flatten to `calendar_create_task` — so reversing it needs a table of the
 * names in play. That table is exactly what is *not* available where it
 * matters: under §21.2 paging the model legitimately calls tools that are not
 * in the current tool set (granted-but-closed namespaces open themselves), and
 * an ungranted or hallucinated call names a tool that was never offered. Those
 * are the calls whose names most need to survive intact, because they are the
 * ones a refusal or an error is about to quote back.
 *
 * `__` is unambiguous as long as no tool name contains one, which
 * `spec-contract.test.ts` pins for the whole catalog. It is also what MCP
 * clients conventionally use to join a namespace to a tool.
 */

/** The dot's stand-in. Anything in `[a-zA-Z0-9_-]` is legal everywhere. */
export const WIRE_SEPARATOR = '__';

/** `memory.save` → `memory__save`. */
export function wireToolName(internal: string): string {
  return internal.split('.').join(WIRE_SEPARATOR);
}

/** `memory__save` → `memory.save`. The exact inverse, for any input. */
export function internalToolName(wire: string): string {
  return wire.split(WIRE_SEPARATOR).join('.');
}

/**
 * The same tool set, keyed by wire names.
 *
 * Definitions are shared rather than copied — same schema object, new key — and
 * insertion order is preserved, never re-sorted. The caller's order is
 * deliberate and load-bearing: §21.2.7 sorts the paged definitions and appends
 * `tools.open` *after* that sort, so its position cannot depend on which
 * namespaces happen to be open. Sorting again here would quietly move it.
 */
export function toWireToolSet<T>(tools: Record<string, T>): Record<string, T> {
  const out: Record<string, T> = {};
  for (const key of Object.keys(tools)) out[wireToolName(key)] = tools[key]!;
  return out;
}

/**
 * Rewrite the tool names carried by message history.
 *
 * A run's own `tool-call` and `tool-result` parts name their tool, and they go
 * back to the provider on every later step — so a dotted name in turn three is
 * refused exactly like a dotted name in the tool set. Copies are made only
 * where a name actually changes: §20's within-run messages are append-only and
 * must not be mutated in place.
 */
export function toWireMessages<T>(messages: readonly T[]): T[] {
  return messages.map((message) => {
    const m = message as { content?: unknown };
    if (!Array.isArray(m.content)) return message;
    let touched = false;
    const content = m.content.map((part: any) => {
      if (part?.type !== 'tool-call' && part?.type !== 'tool-result') return part;
      const wire = wireToolName(part.toolName);
      if (wire === part.toolName) return part;
      touched = true;
      return { ...part, toolName: wire };
    });
    return touched ? ({ ...(message as object), content } as T) : message;
  });
}
