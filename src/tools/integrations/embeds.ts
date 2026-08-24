import { z } from 'zod';
import type { EmbedBinder } from '../../embeds/binder.js';
import type { EmbedStore } from '../../embeds/store.js';
import type { RunGrants } from '../run-grants.js';
import type { ToolContext, ToolDefinition } from '../types.js';

export interface EmbedsDeps {
  store: EmbedStore;
  /** Data bindings (§23.2): the only sanctioned path for numbers into a page. */
  binder: EmbedBinder;
  /** Grant sets of runs in flight — what `embeds.bind` validates against. */
  runGrants: RunGrants;
}

const idArg = z.string().min(1).describe('the embed id');

/**
 * The `embeds` integration (App. F.13, §22). What it can do is deliberately
 * narrow: author an artifact, read it back, seed its pouch, keep it, delete it.
 * An embed *says* things; only a user-authored handler bound to it can *do*
 * anything, under that handler's own grants (§22.5).
 */
export function embedsTools(deps: EmbedsDeps): ToolDefinition[] {
  const { store, binder, runGrants } = deps;
  return [
    {
      name: 'embeds.create',
      description:
        'Author a small self-contained HTML page — a chart, a dashboard, a mini-app — and get back a marker to put in your reply so it renders in the chat. One file: inline the CSS and JS; no external fonts or images (data: URIs for pictures). Exactly two script sources ARE allowed and encouraged: the Highcharts CDN (https://code.highcharts.com/…) for charts, and /embed-vendor/… for reveal.js decks. Any value that came out of a tool goes in as a {{data:name}} placeholder (or turminder.data in scripts), attached with embeds.bind in the same turn — never typed into the html from a tool result. Read the `embeds` skill before your first one. Check embeds.list first if the user is asking to see something that may already exist.',
      tier: 'se',
      // §20.6: the artifact is paid for once as output; embeds.read is the way
      // back to it.
      bulkArgs: ['html'],
      args: z.object({
        title: z.string().min(1).describe('short human name, how the user will refer to it'),
        html: z
          .string()
          .min(1)
          .describe(
            'the complete page: markup, inline <style>, inline <script>; tool-derived values as {{data:name}} placeholders, not literals',
          ),
        kind: z
          .enum(['ephemeral', 'persistent'])
          .optional()
          .describe('ephemeral (default) expires when unused; persistent is the user’s call'),
        allow_duplicate: z
          .boolean()
          .optional()
          .describe(
            'only after the user chose "start fresh" over continuing a similar existing embed',
          ),
      }),
      async execute(
        args: {
          title: string;
          html: string;
          kind?: 'ephemeral' | 'persistent';
          allow_duplicate?: boolean;
        },
        ctx: ToolContext,
      ) {
        const created = store.create({
          title: args.title,
          html: args.html,
          ...(args.kind ? { kind: args.kind } : {}),
          ...(args.allow_duplicate ? { allowDuplicate: true } : {}),
          conversationId: ctx.conversationId ?? null,
          runId: ctx.runId,
        });
        if ('error' in created) return created;
        // A deterministic nudge beats a rule the model has to remember: every
        // create starts with zero bindings, and forgetting embeds.bind is the
        // most common authoring mistake — a page whose numbers were typed in
        // from tool results, unauditable and permanently stale (§23.2).
        const usesData = args.html.includes('{{data:') || args.html.includes('turminder.data');
        return {
          ...created,
          bindings: [],
          ...(usesData
            ? { note: 'page references bound data — call embeds.bind now to attach it' }
            : {
                note:
                  'no bindings attached — if any value on this page came from a tool, ' +
                  'replace it with a {{data:name}} placeholder (embeds.edit) and attach ' +
                  'the call with embeds.bind; typed-in values go stale and cannot be audited',
              }),
        };
      },
    },
    {
      name: 'embeds.edit',
      description:
        'Change one exact piece of an embed. `find` must appear exactly once — include enough surrounding text to make it unique. Use this rather than rewriting the whole page.',
      tier: 'se',
      bulkArgs: ['replace'],
      args: z.object({
        embed_id: idArg,
        find: z.string().min(1).describe('the exact text to replace, appearing exactly once'),
        replace: z.string().describe('what to put there instead'),
      }),
      async execute(args: { embed_id: string; find: string; replace: string }) {
        return store.edit(args.embed_id, args.find, args.replace);
      },
    },
    {
      name: 'embeds.read',
      description:
        'Read an embed’s HTML back. Do this before editing one you did not just write.',
      tier: 'ro',
      /** Returning the document is the job, and it takes offset/limit (§20.3). */
      maxResultChars: 20_000,
      args: z.object({
        embed_id: idArg,
        offset_lines: z.number().int().nonnegative().optional(),
        limit_lines: z.number().int().positive().optional(),
      }),
      async execute(args: { embed_id: string; offset_lines?: number; limit_lines?: number }) {
        return store.read(args.embed_id, {
          ...(args.offset_lines !== undefined ? { offsetLines: args.offset_lines } : {}),
          ...(args.limit_lines !== undefined ? { limitLines: args.limit_lines } : {}),
        });
      },
    },
    {
      name: 'embeds.list',
      description:
        'Find embeds that already exist, by title. Always do this when the user asks to see, show or open something — embeds are not tied to one conversation, so the thing they mean may already be built. Re-render its marker instead of building a duplicate.',
      tier: 'ro',
      args: z.object({
        kind: z.enum(['ephemeral', 'persistent']).optional(),
        query: z.string().optional().describe('case-insensitive title substring'),
      }),
      async execute(args: { kind?: 'ephemeral' | 'persistent'; query?: string }) {
        return {
          embeds: store.repo
            .list({
              ...(args.kind ? { kind: args.kind } : {}),
              ...(args.query ? { query: args.query } : {}),
            })
            .map((row) => ({
              id: row.id,
              title: row.title,
              kind: row.kind,
              conversation_id: row.conversation_id,
              updated_at: row.updated_at,
            })),
        };
      },
    },
    {
      name: 'embeds.write_state',
      description:
        'Seed or overwrite an embed’s state pouch — the small JSON blob its own code reads with turminder.getState(). Whole-blob replace, at most 64KB.',
      tier: 'se',
      args: z.object({
        embed_id: idArg,
        state: z
          .record(z.string(), z.unknown())
          .describe('the whole pouch, replacing what was there'),
      }),
      async execute(args: { embed_id: string; state: Record<string, unknown> }) {
        return store.writeState(args.embed_id, args.state);
      },
    },
    {
      name: 'embeds.bind',
      description:
        'Attach live data to an embed. You name each binding and the read-only tool call that produces it; the page then reads the values through {{data:<name>}} placeholders and turminder.data. Each binding’s args are EXACTLY the object a direct call to that tool takes — if you called the tool earlier in this conversation, copy that args object verbatim (flat values like {"area": "NO5"}, never re-wrapped or nested). Do this instead of typing numbers from a tool result into the HTML — bound values never pass through you, so they cannot come out wrong. Replaces the whole binding list and fetches everything once; bindings whose args fail validation are rejected with the tool’s message.',
      tier: 'se',
      args: z.object({
        embed_id: idArg,
        bindings: z
          .array(
            z.object({
              name: z
                .string()
                .regex(/^[A-Za-z0-9_-]+$/)
                .describe('what the page calls this value, e.g. revenue'),
              tool: z.string().min(1).describe('a read-only tool you are allowed to call'),
              args: z
                .record(z.string(), z.unknown())
                .optional()
                .describe(
                  'the exact args a direct call takes — flat values, no extra nesting; prefer args_from',
                ),
              args_from: z
                .boolean()
                .optional()
                .describe(
                  'true = freeze the args of your most recent successful call to this tool in this run — the server copies them; preferred over re-writing args',
                ),
              refresh: z
                .enum(['manual', 'on_serve'])
                .optional()
                .describe('on_serve re-fetches every time the page is opened'),
            }),
          )
          .describe('the complete list; anything left out is unbound'),
      }),
      async execute(
        args: {
          embed_id: string;
          bindings: {
            name: string;
            tool: string;
            args?: Record<string, unknown>;
            refresh?: 'manual' | 'on_serve';
          }[];
        },
        ctx: ToolContext,
      ) {
        if (!store.repo.get(args.embed_id)) {
          return { error: 'not_found', message: `no embed with id ${args.embed_id}` };
        }
        return binder.bind(args.embed_id, args.bindings, runGrants.get(ctx.runId), ctx.runId);
      },
    },
    {
      name: 'embeds.refresh',
      description:
        'Re-run an embed’s data bindings now. Nothing is re-decided and no data passes through you — the frozen calls execute again and the page picks up the new values.',
      tier: 'se',
      args: z.object({
        embed_id: idArg,
        names: z.array(z.string()).optional().describe('only these bindings; default all'),
      }),
      async execute(args: { embed_id: string; names?: string[] }) {
        if (!store.repo.get(args.embed_id)) {
          return { error: 'not_found', message: `no embed with id ${args.embed_id}` };
        }
        return {
          embed_id: args.embed_id,
          refreshed: await binder.refresh(args.embed_id, {
            ...(args.names ? { names: args.names } : {}),
          }),
        };
      },
    },
    {
      name: 'embeds.promote',
      description:
        'Keep an embed for good: it moves into the data repo with history, gets a permanent link, and stops expiring. Ask first — this is the user’s decision.',
      tier: 'se',
      args: z.object({ embed_id: idArg }),
      async execute(args: { embed_id: string }) {
        return store.promote(args.embed_id);
      },
    },
    {
      name: 'embeds.delete',
      description:
        'Delete an embed and every handler bound to it. Say what you are deleting and why before you do.',
      tier: 'se',
      args: z.object({ embed_id: idArg }),
      async execute(args: { embed_id: string }) {
        return store.delete(args.embed_id);
      },
    },
  ];
}
