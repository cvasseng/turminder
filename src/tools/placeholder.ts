import { isTranscriptPlaceholder } from '../core/markers.js';
import type { ToolCallOutcome, ToolHandle } from './types.js';

/**
 * The placeholder guard (§20.6, §20.8). After a bulk-content call runs, the
 * transcript shows its `content` as a `[[stored: …]]` marker. A model that
 * reads that as "my write was replaced" re-sends the write — and, on a bad
 * day, re-sends the *marker* as the content. Nothing stopped that: on
 * 2026-08-30 two `memory.update` calls wrote the housekeeping text into a
 * memory and committed it (run `01M18071PR7SRR04VV7B8TZQZP`).
 *
 * So the one boundary every tool call crosses refuses the one shape that can
 * only ever be a mistake: a declared bulk field whose value *is* a transcript
 * placeholder. Mentioning a marker inside real content is still allowed —
 * §20.8's argument stands, documentation about this system contains its
 * markers — because the test is "is the whole value a placeholder", not
 * "does it contain one". Refusal is a return value the model can read, and the
 * tool never runs, so no stub is written and no commit is made.
 */
export function placeholderGuarded(handle: ToolHandle): ToolHandle {
  const fields = handle.bulkArgs;
  if (!fields?.length) return handle;
  return {
    ...handle,
    async call(args, ctx): Promise<ToolCallOutcome> {
      if (args && typeof args === 'object' && !Array.isArray(args)) {
        const record = args as Record<string, unknown>;
        const pasted = fields.find((f) => isTranscriptPlaceholder(record[f]));
        if (pasted) {
          return {
            ok: false,
            output: {
              error: 'placeholder_as_content',
              field: pasted,
              message:
                `\`${pasted}\` is a transcript placeholder, not content: it stands for text ` +
                `you already sent in an earlier ${handle.name} call, which was written and is ` +
                `stored. Nothing was written now. Read the stored content back with the tool ` +
                `if you need it; to change it, send the new text itself.`,
            },
          };
        }
      }
      return handle.call(args, ctx);
    },
  };
}
