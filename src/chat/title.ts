import { z } from 'zod';
import { log } from '../core/logger.js';
import { errMessage } from '../core/errors.js';
import { runAgent } from '../model/agent-loop.js';
import type { ModelGateway } from '../model/gateway.js';
import type { TraceSink } from '../model/types.js';

const l = log('chat');

const TitleOutput = z.object({ title: z.string() });

const TITLE_SCHEMA = {
  name: 'conversation_title',
  schema: {
    type: 'object',
    properties: {
      title: {
        type: 'string',
        description: 'at most 48 characters, no quotes, no trailing punctuation',
      },
    },
    required: ['title'],
    additionalProperties: false,
  },
};

export const MAX_TITLE = 48;

export interface TitleRequest {
  userText: string;
  assistantText: string;
  trace?: TraceSink;
}

export interface TitleResult {
  title: string | null;
  turns: number;
  tokensIn: number;
  tokensOut: number;
  model: string | null;
}

/**
 * Names a conversation from its opening exchange, so the sidebar reads like a
 * list of topics rather than a list of ids. Deliberately cheap: the fast model,
 * one turn, background priority, and a hard character cap — nobody is waiting
 * for it, and it must never delay a reply.
 */
export async function suggestTitle(
  gateway: ModelGateway,
  req: TitleRequest,
): Promise<TitleResult> {
  try {
    const result = await runAgent(gateway, {
      selector: { class: 'fast', caps: ['json'] },
      priority: 'background',
      system:
        'You name conversations. Given the opening exchange, return a short title — ' +
        `at most ${MAX_TITLE} characters — that says what it is about.\n\n` +
        'Rules:\n' +
        '- Name the subject, not the interaction: "Hafslund invoice", not "User asks about an invoice".\n' +
        '- No quotes, no trailing punctuation, no "Chat about".\n' +
        '- Sentence case. Keep proper nouns.\n' +
        '- If the exchange is small talk with no subject, use one word for what it was, e.g. "Greeting".',
      messages: [
        {
          role: 'user',
          content: `User: ${req.userText.slice(0, 1500)}\n\nAssistant: ${req.assistantText.slice(0, 1500)}`,
        },
      ],
      ...(req.trace ? { trace: req.trace } : {}),
      budgets: { maxTurns: 1, maxTokens: 4000, timeoutS: 120 },
      jsonSchema: TITLE_SCHEMA,
      maxOutputTokens: 2048,
    });
    const metrics = {
      turns: result.turns,
      tokensIn: result.tokensIn,
      tokensOut: result.tokensOut,
      model: result.endpoint || null,
    };
    if (result.stopReason !== 'stop') return { title: null, ...metrics };
    const parsed = TitleOutput.safeParse(JSON.parse(result.text.trim()));
    if (!parsed.success) return { title: null, ...metrics };
    return { title: cleanTitle(parsed.data.title), ...metrics };
  } catch (e) {
    // A conversation without a title is a cosmetic problem, not a failure.
    l.debug({ err: errMessage(e) }, 'title suggestion failed');
    return { title: null, turns: 0, tokensIn: 0, tokensOut: 0, model: null };
  }
}

export function cleanTitle(raw: string): string | null {
  const trimmed = raw
    .replace(/\s+/g, ' ')
    .replace(/^["'`\s]+|["'`\s.]+$/g, '')
    .trim();
  if (!trimmed) return null;
  return trimmed.length > MAX_TITLE ? `${trimmed.slice(0, MAX_TITLE - 1).trimEnd()}…` : trimmed;
}
