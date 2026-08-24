import { jsonSchema, tool, type ToolSet } from 'ai';
import { log } from '../core/logger.js';
import type { DispatchCall, DispatchResult, ToolDispatcher } from '../model/dispatcher.js';
import type { GrantedDispatcher } from './dispatcher.js';
import type { ToolHandle } from './types.js';

const l = log('tools');

/** App. F.12 — synthetic, so it has no integration and no `ToolHandle`. */
export const OPEN_TOOL = 'tools.open';

const OPEN_TOOL_SCHEMA = {
  type: 'object',
  properties: {
    namespace: { type: 'string', description: 'a namespace name from the catalog' },
  },
  required: ['namespace'],
  additionalProperties: false,
} as const;

const OPEN_TOOL_DESCRIPTION =
  'Load a closed tool namespace from the catalog, for the rest of this conversation.';

export interface PagingStore {
  /** Namespaces opened so far, persisted per conversation (§21.2.5). */
  opened(): readonly string[];
  /** Record one as open. Called on every open, explicit or implicit. */
  open(namespace: string): void;
}

export interface PagedDispatcherOptions {
  /** Always open, from `chat.core_namespaces` (§21.2.1). */
  core: readonly string[];
  /** Where the conversation's own open set lives. */
  store: PagingStore;
  /**
   * One line of prose per namespace for the catalog: the integration manifest's
   * description, or an `mcp.yaml` server's. Absent falls back to tool names.
   */
  describe?: (namespace: string) => string | undefined;
  /**
   * The skill (usage guide) for a namespace, when one exists — by convention a
   * skill named exactly like the namespace. Delivered IN the `tools.open`
   * result: "read the skill before using these" was demonstrably skipped, and
   * a rule the model must remember loses to a body it cannot fail to see.
   * Once per conversation by construction, since opens are sticky.
   */
  skillFor?: (namespace: string) => { name: string; content: string } | null;
}

/**
 * Tool paging (§21.2): a wrapper that decides which of the *already-granted*
 * tools are rendered this turn.
 *
 * The reason this is a wrapper and not a change to `GrantedDispatcher`: paging
 * is a context optimization, never a permission layer. Grant enforcement stays
 * exactly where the security review left it — every call still goes through
 * the inner dispatcher, which knows nothing about open sets and cannot be
 * talked out of a refusal by one. The most this class can do is reveal a tool
 * the grants already allow.
 */
export class PagedDispatcher implements ToolDispatcher {
  constructor(
    private readonly inner: GrantedDispatcher,
    private readonly opts: PagedDispatcherOptions,
  ) {}

  /** Core ∪ persisted, sorted and deduped. */
  openNamespaces(): string[] {
    return [...new Set([...this.opts.core, ...this.opts.store.opened()])].sort();
  }

  /** Granted tools grouped by namespace — the hub connection that serves them. */
  private byNamespace(): Map<string, ToolHandle[]> {
    const map = new Map<string, ToolHandle[]>();
    for (const handle of this.inner.grantedHandles()) {
      const list = map.get(handle.source);
      if (list) list.push(handle);
      else map.set(handle.source, [handle]);
    }
    for (const list of map.values()) list.sort((a, b) => cmp(a.name, b.name));
    return map;
  }

  /**
   * Namespaces with at least one granted tool that are not open. The grant
   * filter is load-bearing: a catalog line for a namespace whose tools would
   * all be refused advertises a capability that does not exist (§21.2.2).
   */
  closedNamespaces(): string[] {
    const open = new Set(this.openNamespaces());
    return [...this.byNamespace().keys()].filter((ns) => !open.has(ns)).sort();
  }

  /**
   * One line per closed namespace, for the system prompt. Sorted, and derived
   * only from the open set and the grants, so two turns that changed neither
   * render identical bytes (§21.2.7).
   */
  catalog(): string[] {
    const groups = this.byNamespace();
    return this.closedNamespaces().map((ns) => {
      const tools = groups.get(ns) ?? [];
      const description =
        this.opts.describe?.(ns) ??
        // Nothing described it, so say what it holds: three names tell the
        // model more about `home-assistant` than the word "home-assistant".
        tools
          .slice(0, 3)
          .map((t) => t.name)
          .join(', ');
      const count = `${tools.length} tool${tools.length === 1 ? '' : 's'}`;
      return `- ${ns}: ${count} — ${description} (closed; open with ${OPEN_TOOL})`;
    });
  }

  toolSet(): ToolSet {
    const open = new Set(this.openNamespaces());
    const full = this.inner.toolSet();
    const visible = new Map<string, ToolHandle>();
    for (const handle of this.inner.grantedHandles()) {
      if (open.has(handle.source)) visible.set(handle.name, handle);
    }
    const set: ToolSet = {};
    // Sorted, like the inner dispatcher's, and for the same reason (§21.2.7).
    for (const name of [...visible.keys()].sort(cmp)) {
      // Taken from the inner toolset rather than rebuilt: the confirm-tier
      // description suffix is its business, and duplicating it here would let
      // the two drift.
      const def = full[name];
      if (def) set[name] = def;
    }
    // Last, so it sorts after nothing: `tools.open` is not one of the paged
    // tools and its position must not depend on which namespaces are open.
    if (this.closedNamespaces().length) {
      set[OPEN_TOOL] = tool({
        description: OPEN_TOOL_DESCRIPTION,
        inputSchema: jsonSchema(OPEN_TOOL_SCHEMA as never),
      });
    }
    return set;
  }

  async dispatch(call: DispatchCall): Promise<DispatchResult> {
    if (call.name === OPEN_TOOL) return this.open(call);

    // Implicit open (§21.2.4): the model remembered a tool from earlier in the
    // conversation, or from a namespace it never opened. Granted is granted —
    // refusing here would turn a context optimization into a regression.
    const handle = this.inner.grantedHandles().find((t) => t.name === call.name);
    let implicitOpen: string | undefined;
    if (handle && !this.openNamespaces().includes(handle.source)) {
      this.opts.store.open(handle.source);
      implicitOpen = handle.source;
      l.info({ tool: call.name, namespace: handle.source }, 'implicitly opened namespace');
    }

    // Ungranted calls fall through untouched: the refusal is the inner
    // dispatcher's, byte for byte what it was before paging existed.
    const result = await this.inner.dispatch(call);
    return implicitOpen ? { ...result, implicitOpen } : result;
  }

  /** `tools.open` itself. Read-only in effect: it reveals, never executes. */
  private async open(call: DispatchCall): Promise<DispatchResult> {
    const requested = (call.args as { namespace?: unknown } | null)?.namespace;
    const groups = this.byNamespace();
    const namespace = typeof requested === 'string' ? requested.trim() : '';
    const tools = groups.get(namespace);
    if (!namespace || !tools?.length) {
      return {
        ok: false,
        output: {
          error: 'unknown_namespace',
          // What it could have asked for, not every namespace that exists: an
          // already-open one is not an answer to "that name was wrong".
          available: this.closedNamespaces(),
        },
      };
    }
    const names = tools.map((t) => t.name);
    if (this.openNamespaces().includes(namespace)) {
      // Already open — idempotent rather than an error. The model asking twice
      // costs one cheap turn; a refusal costs it a plan. The skill was
      // delivered with the first open and is in the transcript; not again.
      return { ok: true, output: { opened: namespace, tools: names } };
    }
    this.opts.store.open(namespace);
    l.info({ namespace, tools: names.length }, 'opened namespace');
    const skill = this.opts.skillFor?.(namespace) ?? null;
    return {
      ok: true,
      output: {
        opened: namespace,
        tools: names,
        ...(skill
          ? {
              skill: {
                name: skill.name,
                content: skill.content,
                note: 'the usage guide for this namespace — follow it; no need to fetch it again',
              },
            }
          : {}),
      },
    };
  }
}

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
