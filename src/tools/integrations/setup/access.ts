import { log } from '../../../core/logger.js';
import type { GrantLevel } from '../../../core/config-schemas.js';
import { globMatch } from '../../../core/glob.js';
import type { FieldSpec, FormOutcome } from '../../../chat/forms.js';
import type { Grants } from '../../dispatcher.js';
import type { GrantStore } from '../../grants.js';
import type { ToolHandle } from '../../types.js';

const l = log('tool:setup');

/** How the form's answer maps onto the three grant levels (App. F.7). */
export const LEVEL_CHOICES: Record<string, GrantLevel> = {
  'Yes — let it use these on its own': 'tools',
  'Yes, but ask me before each call': 'confirm',
};

export interface AccessRequest {
  /** Globs or exact names, as the agent asked for them. */
  patterns: string[];
  /** What the agent says it needs them for. Shown to the user verbatim. */
  reason: string;
  /** What these tools are, in the agent's words. Shown under the title. */
  description?: string;
}

export interface MatchedAccess {
  /** Tools that exist, are not yet reachable, and match what was asked for. */
  missing: ToolHandle[];
  /** Tools that match and are already reachable — nothing to do for these. */
  already: { name: string; level: GrantLevel }[];
  /** Patterns that matched nothing at all in this process. */
  unmatched: string[];
}

/**
 * Work out what a request actually amounts to. A tool that does not exist
 * cannot be granted, and saying so is the difference between the agent trying
 * something else and the agent asking again forever.
 */
export function matchAccess(
  request: AccessRequest,
  available: readonly ToolHandle[],
  base: Grants,
  grants: GrantStore,
): MatchedAccess {
  const missing = new Map<string, ToolHandle>();
  const already: { name: string; level: GrantLevel }[] = [];
  const unmatched: string[] = [];

  for (const pattern of request.patterns) {
    const hits = available.filter((t) => globMatch(pattern, t.name));
    if (!hits.length) {
      unmatched.push(pattern);
      continue;
    }
    for (const handle of hits) {
      const covered = grants.covers(base, handle.name);
      if (covered) {
        if (!already.some((a) => a.name === handle.name)) {
          already.push({ name: handle.name, level: covered });
        }
        continue;
      }
      missing.set(handle.name, handle);
    }
  }
  return { missing: [...missing.values()], already, unmatched };
}

/**
 * The form the user answers. Everything they need to decide is on it: which
 * tools, where they came from, what each one does, and why the assistant wants
 * them — because "grant access to github.*" is not a question anyone can
 * answer well.
 */
export function accessForm(
  request: AccessRequest,
  missing: ToolHandle[],
): {
  title: string;
  description: string;
  fields: FieldSpec[];
} {
  const sources = [...new Set(missing.map((t) => t.source))];
  const subject =
    sources.length === 1
      ? `${sources[0]} (${missing.length} tool${missing.length === 1 ? '' : 's'})`
      : `${missing.length} tools from ${sources.length} sources`;

  const listing = missing
    .map((t) => `• ${t.name} — ${firstSentence(t.description)}`)
    .join('\n');

  return {
    title: `Let the assistant use ${subject}?`,
    description:
      `${request.description ? `${request.description.trim()}\n\n` : ''}` +
      `It wants these for: ${request.reason.trim()}\n\n${listing}\n\n` +
      'Approving records this in config/grants.yaml, which you can edit or revert like any other config.',
    fields: [
      {
        name: 'decision',
        label: 'Enable these tools',
        type: 'select',
        options: Object.keys(LEVEL_CHOICES),
        value: Object.keys(LEVEL_CHOICES)[0]!,
      },
    ],
  };
}

/** One sentence is enough to judge a tool by; a paragraph is not readable in a list. */
function firstSentence(text: string): string {
  const trimmed = text.trim().replace(/\s+/g, ' ');
  const stop = trimmed.search(/\.\s|\.$/);
  const sentence = stop > 0 ? trimmed.slice(0, stop + 1) : trimmed;
  return sentence.length > 160 ? `${sentence.slice(0, 157)}…` : sentence;
}

/**
 * Narrow the granted patterns to what was actually approved. Asking for
 * `github.*` when six of sixteen tools were already reachable still grants
 * `github.*` — the user saw the whole list and said yes to it — but a request
 * that named tools one by one is recorded that way, so the file reads as what
 * happened.
 */
export function patternsToRecord(request: AccessRequest, missing: ToolHandle[]): string[] {
  const named = new Set(missing.map((t) => t.name));
  const useful = request.patterns.filter((p) => missing.some((t) => globMatch(p, t.name)));
  // Prefer the agent's own patterns; fall back to exact names if it asked for
  // something broad that only partly matched.
  return useful.length ? [...new Set(useful)] : [...named];
}

export function accessResult(
  outcome: FormOutcome,
  matched: MatchedAccess,
  granted: { level: GrantLevel; patterns: string[]; callable: string[] } | null,
): Record<string, unknown> {
  if (!granted) {
    return {
      granted: false,
      reason: outcome.submitted ? 'declined' : outcome.reason,
      message:
        'The user did not grant this. Say what you cannot do because of it, and do not ask again unprompted.',
    };
  }
  l.info({ patterns: granted.patterns, level: granted.level }, 'tool access granted');
  return {
    granted: true,
    level: granted.level,
    patterns: granted.patterns,
    tools: granted.callable,
    ...(matched.already.length ? { already_had: matched.already.map((a) => a.name) } : {}),
    message:
      granted.level === 'confirm'
        ? 'You can call these now; each call asks the user first.'
        : 'You can call these now, on your next turn.',
  };
}
