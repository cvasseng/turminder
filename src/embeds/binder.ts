import crypto from 'node:crypto';
import { log } from '../core/logger.js';
import { nowIso } from '../core/time.js';
import type { BoundValue, EmbedBinding, EmbedsRepo } from '../db/repos/embeds.js';
import { GrantedDispatcher } from '../tools/dispatcher.js';
import type { RunGrantView } from '../tools/run-grants.js';
import type { ToolHandle } from '../tools/types.js';

const l = log('embeds');

/** App. A: bindings per embed, and the size of everything they returned. */
export const MAX_BINDINGS = 20;
export const MAX_BOUND_BYTES = 256 * 1024;
/** App. A: one binding call, and how long an `on_serve` result stays fresh. */
export const BINDING_TIMEOUT_MS = 10_000;
export const ON_SERVE_TTL_MS = 60_000;

export interface BinderDeps {
  repo: EmbedsRepo;
  /**
   * Every tool in the process. A function because the hub is built after the
   * service and can gain tools mid-life (§19.3) — a binding to a tool from an
   * integration activated later must still replay.
   */
  tools: () => readonly ToolHandle[];
  /**
   * Called when a refresh changed what the page would show (§22.6). Not called
   * for the serve-time pass: that page is being fetched anyway, and telling a
   * browser to reload the thing it is mid-way through loading is a loop.
   */
  onChanged?: (id: string) => void;
  /**
   * `args_from` resolution (§23.2): the most recent successful call to a tool
   * in the binding run, from the trace — which keeps originals, so this works
   * even after the transcript copy was elided. The model references its own
   * call; the server moves the bytes. Anti-telephone, applied to args.
   */
  priorArgs?: (runId: string, tool: string) => Record<string, unknown> | null;
  now?: () => Date;
}

/** Bind-time refusals (App. F.13). Expected outcomes, so values not throws. */
export interface BindError {
  error:
    | 'unknown_tool'
    | 'not_ro'
    | 'not_granted'
    | 'not_found'
    | 'too_many_bindings'
    | 'invalid_binding_args'
    | 'no_prior_call'
    | 'args_conflict';
  message: string;
  tool?: string;
  /** `invalid_binding_args` only: which bindings failed, with the tool's own words. */
  failures?: { name: string; tool: string; message: string }[];
}

/** What the model asks for; `refresh` defaults to manual (App. F.13). */
export interface BindRequest {
  name: string;
  tool: string;
  args?: Record<string, unknown>;
  /** "Freeze the args of my most recent call to this tool" — preferred over
   *  re-writing them, which is where the nesting and marker-pasting failures
   *  both lived (§23.2). */
  args_from?: boolean;
  refresh?: EmbedBinding['refresh'];
}

export interface RefreshedBinding {
  name: string;
  ok: boolean;
  fetched_at: string;
  error?: string;
  /** The failing tool's own message — `invalid_arguments` alone teaches nothing. */
  message?: string;
}

/** One manifest line: where a number came from, without echoing the number. */
export interface ManifestEntry {
  name: string;
  tool: string;
  args: Record<string, unknown>;
  refresh: EmbedBinding['refresh'];
  fetched_at: string | null;
  ok: boolean;
  /** sha256 of the stored value, so two servings can be compared. */
  hash: string | null;
  error?: string;
  message?: string;
}

/**
 * The binder (§23.2): deterministic replay of frozen read-only calls.
 *
 * No model is involved, by construction — there is no gateway here to involve.
 * That is the whole point of the layer: the model decided *which* data goes
 * *where* once, at bind time, and from then on the bytes move without ever
 * passing through a token stream. A number that never rides the context cannot
 * be transcribed wrong.
 *
 * Replaying a recorded read-only call is also zero new capability, which is why
 * this may run unattended — at serve time, from a background refresh, from a
 * PDF export.
 */
export class EmbedBinder {
  private readonly now: () => Date;

  constructor(private readonly deps: BinderDeps) {
    this.now = deps.now ?? (() => new Date());
  }

  /**
   * Freezes a new binding list onto an embed and executes it once (App. F.13).
   *
   * The three refusals are the whole security argument for letting the binder
   * run unattended afterwards: a bound call must be a call that *exists*, is
   * *read-only*, and was *already available to the run doing the binding*. You
   * cannot bind what you could not call — so replaying it later grants nobody
   * anything they did not already have.
   *
   * `grants` is the run's inner dispatcher (§23.2): paging decides what is
   * rendered this turn and must not decide what can be bound, and a call with
   * no run behind it can bind nothing at all.
   */
  async bind(
    embedId: string,
    requested: readonly BindRequest[],
    grants: RunGrantView | null,
    runId: string | null = null,
  ): Promise<{ embed_id: string; bound: string[]; results: RefreshedBinding[] } | BindError> {
    if (requested.length > MAX_BINDINGS) {
      return {
        error: 'too_many_bindings',
        message: `an embed holds at most ${MAX_BINDINGS} bindings (this was ${requested.length})`,
      };
    }
    // `args_from` resolution first: the server copies the args of the run's
    // own successful call from the trace. The model never re-writes them, so
    // there is nothing to nest wrong and no marker to paste (§23.2).
    const resolvedArgs = new Map<string, Record<string, unknown>>();
    for (const request of requested) {
      if (!request.args_from) continue;
      if (request.args && Object.keys(request.args).length) {
        return {
          error: 'args_conflict',
          message: `binding ${request.name}: give args OR args_from, not both`,
          tool: request.tool,
        };
      }
      const prior = runId ? (this.deps.priorArgs?.(runId, request.tool) ?? null) : null;
      if (!prior) {
        return {
          error: 'no_prior_call',
          message:
            `binding ${request.name}: args_from needs a successful ${request.tool} call ` +
            `earlier in this run — call it once first (to see the data), or pass args ` +
            `explicitly`,
          tool: request.tool,
        };
      }
      resolvedArgs.set(request.name, prior);
    }
    const available = this.deps.tools();
    // Fails closed with no run: the grant set of nothing is nothing.
    const granted = new Set(grants?.granted() ?? []);
    for (const request of requested) {
      const handle = available.find((t) => t.name === request.tool);
      if (!handle) {
        return {
          error: 'unknown_tool',
          message: `there is no tool called ${request.tool}`,
          tool: request.tool,
        };
      }
      if (handle.tier !== 'ro') {
        return {
          error: 'not_ro',
          message: `only read-only tools can be bound; ${request.tool} has side effects`,
          tool: request.tool,
        };
      }
      if (!granted.has(request.tool)) {
        return {
          error: 'not_granted',
          message: `${request.tool} is not something this run may call, so it cannot be bound`,
          tool: request.tool,
        };
      }
    }
    const bindings: EmbedBinding[] = requested.map((request) => ({
      name: request.name,
      tool: request.tool,
      args: resolvedArgs.get(request.name) ?? request.args ?? {},
      refresh: request.refresh ?? 'manual',
    }));
    // Kept so a rejected bind can put things back exactly as they were:
    // replace semantics mean all-or-nothing, and a half-applied list would
    // leave the page half-lying.
    const previousBindings = this.deps.repo.bindings(embedId);
    const previousData = this.deps.repo.boundData(embedId);

    this.deps.repo.setBindings(embedId, bindings);
    const results = await this.refresh(embedId);

    // `invalid_arguments` on the FIRST execution is deterministic — the frozen
    // args can never work, and every later refresh would fail identically.
    // Accepting it (as this once did) returns a success the model believes,
    // and the observed result is a doom loop: re-bind the same garbage ten
    // times against a result that keeps saying "bound". Reject it instead,
    // with the tool's own validation message, and restore what was there.
    // Transient failures (timeout, upstream down) are NOT grounds for
    // rejection — those bindings are fine and will succeed on a later pass.
    const broken = results.filter((r) => r.error === 'invalid_arguments');
    if (broken.length) {
      this.deps.repo.setBindings(embedId, previousBindings);
      this.deps.repo.setBoundData(embedId, previousData);
      const byName = new Map(bindings.map((b) => [b.name, b]));
      return {
        error: 'invalid_binding_args',
        message:
          'nothing was bound: some bindings failed argument validation. Binding args are ' +
          'EXACTLY the object a direct call to the tool takes — if you called the tool ' +
          'earlier, copy that args object verbatim (flat values, no extra nesting).',
        failures: broken.map((r) => ({
          name: r.name,
          tool: byName.get(r.name)?.tool ?? '',
          message: r.message ?? 'invalid arguments',
        })),
      };
    }

    l.info({ embed: embedId, bindings: bindings.map((b) => b.name) }, 'bindings frozen');
    // The execution outcomes ride the success result: a bind that "worked"
    // while its first fetches failed must say so in the same breath (App. F.13).
    return { embed_id: embedId, bound: bindings.map((b) => b.name), results };
  }

  /** The trust surface for `embed.manifest` (App. D) and the UI's "data ⓘ". */
  manifest(embedId: string): ManifestEntry[] {
    const data = this.deps.repo.boundData(embedId);
    return this.deps.repo.bindings(embedId).map((binding) => {
      const bound = data[binding.name];
      return {
        name: binding.name,
        tool: binding.tool,
        args: binding.args,
        refresh: binding.refresh,
        fetched_at: bound?.fetched_at ?? null,
        ok: bound?.ok ?? false,
        hash: bound ? hashValue(bound.value) : null,
        ...(bound?.error ? { error: bound.error } : {}),
        ...(bound?.message ? { message: bound.message } : {}),
      };
    });
  }

  /** `{name: value}` for placement — placeholders and `turminder.data` (§23.2). */
  values(embedId: string): Record<string, unknown> {
    const data = this.deps.repo.boundData(embedId);
    const out: Record<string, unknown> = {};
    for (const binding of this.deps.repo.bindings(embedId)) {
      const bound = data[binding.name];
      if (bound) out[binding.name] = bound.value;
    }
    return out;
  }

  /**
   * Re-executes bindings and stores what they returned. `names` narrows it;
   * `staleOnly` is the serve-time gate (App. A TTL) so a reload storm does not
   * become an upstream storm.
   */
  async refresh(
    embedId: string,
    opts: { names?: readonly string[]; staleOnly?: boolean } = {},
  ): Promise<RefreshedBinding[]> {
    const all = this.deps.repo.bindings(embedId);
    if (!all.length) return [];
    const data = this.deps.repo.boundData(embedId);
    const wanted = opts.names
      ? all.filter((b) => opts.names!.includes(b.name))
      : opts.staleOnly
        ? all.filter((b) => b.refresh === 'on_serve' && this.stale(data[b.name]))
        : all;
    if (!wanted.length) return [];

    // Granted exactly the frozen calls, and nothing else: the binder's
    // dispatcher is not the run's dispatcher, and it can reach precisely the
    // tools that were validated against a run's grants at bind time.
    const dispatcher = new GrantedDispatcher(
      () => this.deps.tools(),
      { tools: [...new Set(wanted.map((b) => b.tool))] },
      { runId: null, eventId: null },
    );

    // In parallel: a dead upstream then costs one timeout for the whole serve
    // rather than one per binding.
    const results = await Promise.all(
      wanted.map(async (binding): Promise<RefreshedBinding> => {
        const previous = data[binding.name];
        const outcome = await this.call(dispatcher, binding);
        if (!outcome.ok) {
          // Stale but marked (§23.2): keep the old value and its own
          // `fetched_at`, so the page shows data whose age is visible instead
          // of a blank where a number was.
          data[binding.name] = {
            value: previous?.value ?? null,
            fetched_at: previous?.fetched_at ?? nowIso(),
            ok: false,
            error: outcome.error,
            ...(outcome.message ? { message: outcome.message } : {}),
          };
          return {
            name: binding.name,
            ok: false,
            fetched_at: data[binding.name]!.fetched_at,
            error: outcome.error,
            ...(outcome.message ? { message: outcome.message } : {}),
          };
        }
        const fetchedAt = this.now().toISOString();
        data[binding.name] = { value: outcome.value, fetched_at: fetchedAt, ok: true };
        return { name: binding.name, ok: true, fetched_at: fetchedAt };
      }),
    );

    // The cap is on everything the bindings hold together (App. A). Enforced
    // after the fact rather than per value, because that is the number that
    // matters — and the offender is dropped to a marked failure rather than
    // taking the other bindings down with it.
    const capped = this.enforceCap(data, results);
    this.deps.repo.setBoundData(embedId, data);
    if (!opts.staleOnly) this.deps.onChanged?.(embedId);
    l.info(
      { embed: embedId, refreshed: capped.length, failed: capped.filter((r) => !r.ok).length },
      'bindings refreshed',
    );
    return capped;
  }

  private stale(bound: BoundValue | undefined): boolean {
    if (!bound?.ok) return true;
    const age = this.now().getTime() - Date.parse(bound.fetched_at);
    return !Number.isFinite(age) || age >= ON_SERVE_TTL_MS;
  }

  private async call(
    dispatcher: GrantedDispatcher,
    binding: EmbedBinding,
  ): Promise<{ ok: true; value: unknown } | { ok: false; error: string; message?: string }> {
    let timer: NodeJS.Timeout | undefined;
    try {
      const outcome = await Promise.race([
        dispatcher.dispatch({
          // Not a model tool call, so there is no call id to echo; the binding
          // name is the only correlation there is or needs to be.
          toolCallId: `binding:${binding.name}`,
          name: binding.tool,
          args: binding.args,
        }),
        new Promise<'timeout'>((resolve) => {
          timer = setTimeout(() => resolve('timeout'), BINDING_TIMEOUT_MS);
        }),
      ]);
      if (outcome === 'timeout') return { ok: false, error: 'timeout' };
      if (!outcome.ok) {
        const message = errorMessage(outcome.output);
        return { ok: false, error: errorCode(outcome.output), ...(message ? { message } : {}) };
      }
      // The *original* output, not the transcript-capped one: bindings feed a
      // page, not a prompt, and §20.3's cap is a context budget (`traceOutput`
      // carries what the tool actually said when the hub capped it).
      return { ok: true, value: outcome.traceOutput ?? outcome.output };
    } catch (e) {
      // A dispatcher that throws is a bug, not an upstream failure — but the
      // page still has to serve, so record it like any other bad refresh.
      l.warn({ tool: binding.tool, err: (e as Error).message }, 'binding call threw');
      return { ok: false, error: 'tool_failed' };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /** Drops the newest oversized values until the whole blob fits (App. A). */
  private enforceCap(
    data: Record<string, BoundValue>,
    results: RefreshedBinding[],
  ): RefreshedBinding[] {
    if (Buffer.byteLength(JSON.stringify(data), 'utf8') <= MAX_BOUND_BYTES) return results;
    const bySize = Object.entries(data).sort((a, b) => sizeOf(b[1].value) - sizeOf(a[1].value));
    for (const [name, bound] of bySize) {
      if (Buffer.byteLength(JSON.stringify(data), 'utf8') <= MAX_BOUND_BYTES) break;
      data[name] = {
        value: null,
        fetched_at: bound.fetched_at,
        ok: false,
        error: 'value_too_large',
      };
      const hit = results.find((r) => r.name === name);
      if (hit) {
        hit.ok = false;
        hit.error = 'value_too_large';
      }
      l.warn({ binding: name }, 'binding result dropped: bound data over the cap');
    }
    return results;
  }
}

/** A stable fingerprint of a value, for the manifest. */
export function hashValue(value: unknown): string {
  return crypto
    .createHash('sha256')
    .update(JSON.stringify(value ?? null))
    .digest('hex')
    .slice(0, 16);
}

function sizeOf(value: unknown): number {
  return JSON.stringify(value ?? null).length;
}

function errorCode(output: unknown): string {
  if (typeof output === 'object' && output !== null && 'error' in output) {
    const code = (output as { error: unknown }).error;
    if (typeof code === 'string') return code;
  }
  return 'tool_failed';
}

/**
 * The tool's own words about what went wrong. A bare code like
 * `invalid_arguments` sent a capable model into a ten-call retry loop; the
 * message ("expected string, received object at area") is what breaks it.
 */
function errorMessage(output: unknown): string | null {
  if (typeof output !== 'object' || output === null) return null;
  const o = output as { message?: unknown; detail?: unknown };
  const text = [o.message, o.detail].filter((v) => typeof v === 'string').join(' — ');
  return text ? text.slice(0, 400) : null;
}
