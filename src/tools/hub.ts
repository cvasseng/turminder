import { log } from '../core/logger.js';
import { errMessage } from '../core/errors.js';
import type { Config } from '../core/config.js';
import type { McpYaml } from '../core/config-schemas.js';
import type { DataHome } from '../core/datadir.js';
import type { Repos } from '../db/repos/index.js';
import type { FormBroker } from '../chat/forms.js';
import type { EventIntake } from '../ingress/intake.js';
import type { MemoryAgent } from '../memory/agent.js';
import type { ModelRouter } from '../model/router.js';
import { budgeted } from './budget.js';
import { placeholderGuarded } from './placeholder.js';
import { McpConnection } from './mcp/connect.js';
import { configTools } from './integrations/config.js';
import { eventsTools } from './integrations/events.js';
import { memoryTools } from './integrations/memory.js';
import type { LoadedHandler } from '../exec/handlers.js';
import type { FileStore } from '../files/store.js';
import type { ProjectScope } from '../projects/scope.js';
import { scheduleTools } from './integrations/schedule.js';
import { webTools } from './integrations/web.js';
import { PageCache, webFetchTools } from './integrations/web-fetch.js';
import { webQueryTools } from './integrations/web-query.js';
import { timeTools } from './integrations/time.js';
import { weatherTools } from './integrations/weather.js';
import { manifestForNamespace } from './integrations/registry.js';
import { SkillLoader, skillTools } from './skills.js';
import { usageTools } from './integrations/usage.js';
import type { ToolDefinition, ToolHandle } from './types.js';

const l = log('tools');

export interface ToolHubDeps {
  home: DataHome;
  config: Config;
  intake: EventIntake;
  skills: SkillLoader;
  /** Absent only in the narrow case of a service with no model configured. */
  memory?: MemoryAgent | null;
  /** Which project islands a conversation may retrieve from (§31.3). */
  projectScope: ProjectScope;
  repos: Repos;
  /** The one form broker (§19.1) — `config.write`'s handler-routing form (F.6)
   *  raises through it, the same as `setup.*`'s forms. */
  forms: FormBroker;
  /** Live, because the model stack can be rebuilt after `ToolHub` is built
   *  (a models.yaml reload) — a snapshot taken at construction would go stale. */
  router: () => ModelRouter | null;
  /** The files store, for `web.download` (§23.6, F.5). */
  files?: FileStore;
  /** Integrations wired by the service rather than built here (deliver). */
  extra?: Record<string, ToolDefinition[]>;
  /**
   * The handlers on disk, for `schedule.*`'s `consumers` (§6.2). A function
   * because the loader is built beside the hub and its cache is invalidated on
   * every reload; absent in the few callers that build a hub with no handler
   * layer at all, where nothing consumes a schedule by definition.
   */
  handlers?: () => LoadedHandler[];
  /** Injected in tests so web.search never touches the network. */
  fetch?: typeof globalThis.fetch;
  /**
   * The clock and timer the reconnect backoff runs on. Substitutable so a test
   * can pin the schedule without sleeping through it (constitution rule 4).
   */
  clock?: HubClock;
}

export interface HubClock {
  now: () => number;
  /**
   * The callback returns the reconnect attempt it started, so a test clock can
   * await it instead of guessing how many microtasks a socket takes. The real
   * clock ignores it, exactly as `setTimeout` always has.
   */
  setTimeout: (fn: () => void | Promise<void>, ms: number) => NodeJS.Timeout;
  clearTimeout: (t: NodeJS.Timeout) => void;
}

const REAL_CLOCK: HubClock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => {
    const t = setTimeout(fn, ms);
    // A server that is gone for good must not hold the process open.
    t.unref?.();
    return t;
  },
  clearTimeout: (t) => clearTimeout(t),
};

export interface McpServerStatus {
  name: string;
  transport: 'stdio' | 'http';
  /** Alive, never "is there a map entry" (§11.6, F.9). */
  connected: boolean;
  tools: string[];
  error?: string;
  /** ISO time of the next automatic reconnect attempt, while one is pending. */
  next_retry_at?: string;
}

/** Per-server reconnect state (§11.6, App. A `mcp_reconnect_backoff`). */
interface RetryState {
  attempt: number;
  timer: NodeJS.Timeout | null;
  nextAt: number | null;
}

/**
 * Every tool in the process, bundled or external, behind one interface (§11.1).
 * Built once at startup; grants are applied per run by the dispatcher.
 *
 * Connections are keyed by name and replaceable, because two flows change the
 * tool list while the service runs: installing an MCP server through a form
 * (§19.3), and activating or deactivating a bundled integration (§19.5).
 */
export class ToolHub {
  private readonly connections = new Map<string, McpConnection>();
  private readonly external = new Map<string, McpServerStatus>();
  private readonly retries = new Map<string, RetryState>();
  private tools: ToolHandle[] = [];
  private closed = false;

  private constructor(
    readonly skills: SkillLoader,
    private readonly config: Config,
    private readonly clock: HubClock,
  ) {}

  static async create(deps: ToolHubDeps): Promise<ToolHub> {
    const hub = new ToolHub(deps.skills, deps.config, deps.clock ?? REAL_CLOCK);
    // One cache behind both page readers (App. F.5): query, look at
    // match_count, narrow the selector, query again — one download.
    const pages = new PageCache();
    const integrations: Record<string, ToolDefinition[]> = {
      config: configTools(deps.home, { forms: deps.forms, router: deps.router }),
      events: eventsTools(deps.intake),
      web: [
        ...webTools({
          settings: deps.config.settings,
          ...(deps.fetch ? { fetch: deps.fetch } : {}),
        }),
        ...webFetchTools({
          settings: deps.config.settings,
          pages,
          // `web.download` writes the user's store, so it only exists where
          // there is a store to write to (§23.6).
          ...(deps.files ? { files: deps.files } : {}),
          ...(deps.fetch ? { fetch: deps.fetch } : {}),
        }),
        ...webQueryTools({
          settings: deps.config.settings,
          pages,
          ...(deps.fetch ? { fetch: deps.fetch } : {}),
        }),
      ],
      skills: skillTools(deps.skills),
      usage: usageTools({ trace: deps.repos.trace }),
      schedule: scheduleTools({
        repos: deps.repos,
        graceS: deps.config.settings.scheduleGraceS,
        // Live, and never a snapshot: `consumers` is a fact about the files on
        // disk right now (§6.2), so a handler written during the conversation
        // counts in the very next `schedule.list`.
        handlers: () => deps.handlers?.() ?? [],
      }),
      time: timeTools({ config: deps.config }),
      weather: weatherTools({
        config: deps.config,
        meta: deps.repos.meta,
        ...(deps.fetch ? { fetch: deps.fetch } : {}),
      }),
      ...(deps.memory
        ? { memory: memoryTools(deps.memory, deps.projectScope, deps.repos.trace) }
        : {}),
      ...(deps.extra ?? {}),
    };

    for (const [name, defs] of Object.entries(integrations)) {
      hub.connections.set(name, await McpConnection.inProcess(name, defs));
    }

    for (const cfg of deps.config.mcp().servers) await hub.openExternal(cfg);

    await hub.refresh();
    return hub;
  }

  /**
   * Re-read the tool lists from every connection.
   *
   * A dropped server's tools deliberately **stay advertised** (§11.6). This is
   * the counter-intuitive rule and it is the point: withdrawing them removes
   * the model's only reason to call one, and the call is what triggers the
   * reconnect. A capability that exists but is unreachable must say so when
   * reached for — `server_unavailable`, naming the server and the next retry —
   * not vanish. Errors teach; absence does not. So a connection that fails to
   * list here keeps whatever it last advertised instead of being dropped from
   * the catalog.
   */
  async refresh(): Promise<void> {
    // Read once per refresh: the cap is a service setting, not a per-call one.
    const maxChars = this.config.settings.toolResultMaxChars;
    const all: ToolHandle[] = [];
    for (const conn of this.connections.values()) {
      try {
        // The transcript budget is applied here, at the one boundary every
        // tool result crosses (§20.3) — bundled and external alike. The
        // placeholder guard sits inside it (§20.6): a bulk-content field that
        // is itself a transcript marker never reaches the tool.
        all.push(
          ...(await conn.listTools()).map((h) => budgeted(placeholderGuarded(h), maxChars)),
        );
      } catch (e) {
        l.warn({ source: conn.name, err: errMessage(e) }, 'listing tools failed');
        // Keep what this source last advertised: see the note above. A server
        // that is down must still be *callable*, or nothing ever revives it.
        all.push(...this.tools.filter((t) => t.source === conn.name));
      }
    }
    const seen = new Set<string>();
    this.tools = all.filter((t) => {
      if (seen.has(t.name)) {
        l.warn({ tool: t.name, source: t.source }, 'duplicate tool name ignored');
        return false;
      }
      seen.add(t.name);
      return true;
    });
    l.info(
      { count: this.tools.length, tools: this.tools.map((t) => t.name) },
      'tools available',
    );
  }

  handles(): ToolHandle[] {
    return [...this.tools];
  }

  get(name: string): ToolHandle | null {
    return this.tools.find((t) => t.name === name) ?? null;
  }

  /** Tool names served by one connection, integration or external server. */
  toolsFrom(source: string): string[] {
    return this.tools.filter((t) => t.source === source).map((t) => t.name);
  }

  /**
   * One line describing a namespace, for the closed-namespace catalog
   * (§21.2.2): the bundled integration's manifest, or the optional
   * `description:` on the `mcp.yaml` entry. Undefined means the caller should
   * fall back to naming tools.
   */
  describeNamespace(namespace: string): string | undefined {
    const manifest = manifestForNamespace(namespace);
    if (manifest) return manifest.description;
    return this.config.mcp().servers.find((s) => s.name === namespace)?.description;
  }

  /**
   * Install or replace a bundled integration's tools while the service runs —
   * how activation makes a credentialed integration's tools appear (§19.5).
   */
  async setIntegration(name: string, defs: ToolDefinition[]): Promise<string[]> {
    await this.drop(name);
    this.connections.set(name, await McpConnection.inProcess(name, defs));
    await this.refresh();
    return this.toolsFrom(name);
  }

  /** Remove an integration's tools; deactivation's half of the pair. */
  async removeIntegration(name: string): Promise<void> {
    if (!this.connections.has(name)) return;
    await this.drop(name);
    await this.refresh();
  }

  /**
   * Connect (or reconnect) one external MCP server from config/mcp.yaml, and
   * report what it serves. This is the probe the form flow reports back (§19.3).
   */
  async connectExternal(name: string): Promise<McpServerStatus> {
    const cfg = this.config.mcp().servers.find((s) => s.name === name);
    if (!cfg) {
      const missing: McpServerStatus = {
        name,
        transport: 'stdio',
        connected: false,
        tools: [],
        error: `no server named "${name}" in config/mcp.yaml`,
      };
      this.external.set(name, missing);
      return missing;
    }
    await this.openExternal(cfg);
    await this.refresh();
    const status = this.external.get(name)!;
    return { ...status, tools: this.toolsFrom(name) };
  }

  /**
   * Configured external servers and whether they are actually up (App. F.9).
   *
   * `connected` means **alive** (§11.6). It used to answer
   * `this.connections.has(cfg.name)` — map membership, a different question
   * than the one it is asked — so a server whose process had exited reported
   * healthy, every call came back `tool_failed`, and the only cure was a
   * restart. The connection object outliving the server is precisely the case
   * this field has to see through.
   */
  serverStatus(): McpServerStatus[] {
    return this.config.mcp().servers.map((cfg) => {
      const conn = this.connections.get(cfg.name);
      const error = conn?.error ?? this.external.get(cfg.name)?.error;
      const nextAt = this.retries.get(cfg.name)?.nextAt ?? null;
      return {
        name: cfg.name,
        transport: cfg.transport,
        connected: conn?.alive ?? false,
        tools: this.toolsFrom(cfg.name),
        ...(error ? { error } : {}),
        ...(nextAt ? { next_retry_at: new Date(nextAt).toISOString() } : {}),
      };
    });
  }

  /**
   * A call arrived for a server that is not alive (§11.6): reconnect once,
   * now, and let the call proceed if it works. This is what makes "fix the
   * VPN and ask the same question again" true, and it is the path a user
   * actually takes.
   *
   * `mcp.yaml` is re-read for this server's **own** definition, so a URL
   * edited while the service ran is honoured — but a reconnect never adds,
   * removes or re-tiers a server. That is `setup.form`'s job and there is one
   * writer, not two (§12.2).
   */
  private async reviveServer(
    name: string,
  ): Promise<{ ok: true } | { ok: false; message: string }> {
    const cfg = this.config.mcp().servers.find((s) => s.name === name);
    if (!cfg) {
      this.stopRetrying(name);
      return { ok: false, message: `${name} is no longer configured in mcp.yaml` };
    }
    const conn = this.connections.get(name);
    // No connection object at all is the "never came up" case — a server whose
    // very first connect failed. It gets the same loop as one that dropped,
    // because from the user's side they are the same fault (§11.6).
    if (!conn) {
      await this.openExternal(cfg);
      if (!this.connections.has(name)) return { ok: false, message: this.unreachable(name) };
      await this.refresh();
      return { ok: true };
    }
    if (conn.alive) return { ok: true };
    try {
      await conn.reconnect(cfg);
    } catch (e) {
      const message = errMessage(e);
      this.external.set(name, {
        name,
        transport: cfg.transport,
        connected: false,
        tools: [],
        error: message,
      });
      this.scheduleRetry(name);
      return { ok: false, message: this.unreachable(name, message) };
    }
    this.stopRetrying(name);
    this.external.set(name, {
      name,
      transport: cfg.transport,
      connected: true,
      tools: [],
    });
    // The server may serve a different tool set than it did an hour ago, so
    // the hub re-lists rather than assuming (§11.6).
    await this.refresh();
    return { ok: true };
  }

  /** The one wording for "it is down", naming when it will next be tried. */
  private unreachable(name: string, why?: string): string {
    const nextAt = this.retries.get(name)?.nextAt ?? null;
    const cause = why ?? this.external.get(name)?.error;
    return (
      `the ${name} server is unreachable${cause ? ` (${cause})` : ''}. ` +
      (nextAt
        ? `Turminder will try again automatically at ${new Date(nextAt).toISOString()}; `
        : '') +
      `if you have just fixed the cause, ask again and it will retry immediately.`
    );
  }

  /**
   * The background half (§11.6): a fault fixed outside the conversation is
   * picked up without one. Capped exponential, per server, reset only on a
   * successful connect, and `.unref()`ed so a dead server cannot hold the
   * process open. Returns when the attempt it just booked will happen.
   */
  private scheduleRetry(name: string): number {
    const schedule = this.config.settings.mcpReconnectBackoffS;
    const state = this.retries.get(name) ?? { attempt: 0, timer: null, nextAt: null };
    if (state.timer) this.clock.clearTimeout(state.timer);
    // The last value repeats forever: a server that is gone for good settles
    // at one attempt per interval rather than spinning.
    const delayS = schedule[Math.min(state.attempt, schedule.length - 1)] ?? 300;
    state.attempt += 1;
    state.nextAt = this.clock.now() + delayS * 1000;
    state.timer = this.clock.setTimeout(async () => {
      state.timer = null;
      state.nextAt = null;
      if (this.closed) return;
      // Gone from mcp.yaml means gone: the loop stops rather than retrying a
      // server nobody asked for any more.
      if (!this.config.mcp().servers.some((s) => s.name === name)) {
        this.stopRetrying(name);
        return;
      }
      const r = await this.reviveServer(name);
      if (r.ok) l.info({ server: name }, 'external mcp server came back on its own');
    }, delayS * 1000);
    this.retries.set(name, state);
    return state.nextAt;
  }

  private stopRetrying(name: string): void {
    const state = this.retries.get(name);
    if (state?.timer) this.clock.clearTimeout(state.timer);
    this.retries.delete(name);
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const name of [...this.retries.keys()]) this.stopRetrying(name);
    for (const conn of this.connections.values()) await conn.close();
    this.connections.clear();
    this.external.clear();
    this.tools = [];
  }

  private async drop(name: string): Promise<void> {
    const existing = this.connections.get(name);
    if (!existing) return;
    this.connections.delete(name);
    await existing.close();
  }

  private async openExternal(cfg: McpYaml['servers'][number]): Promise<void> {
    await this.drop(cfg.name);
    try {
      const conn = await McpConnection.external(cfg);
      // The connection asks the hub to revive it when a call finds it dead:
      // re-reading `mcp.yaml` and re-listing the catalog are hub concerns, and
      // the connection has no business knowing about either.
      conn.revive = () => this.reviveServer(cfg.name);
      this.connections.set(cfg.name, conn);
      this.stopRetrying(cfg.name);
      this.external.set(cfg.name, {
        name: cfg.name,
        transport: cfg.transport,
        connected: true,
        tools: [],
      });
      l.info({ server: cfg.name, transport: cfg.transport }, 'connected external mcp server');
    } catch (e) {
      // A broken MCP server is a degraded assistant, not a dead one.
      this.external.set(cfg.name, {
        name: cfg.name,
        transport: cfg.transport,
        connected: false,
        tools: [],
        error: errMessage(e),
      });
      // warn, not error: the comment above is the severity policy — a log
      // that screams fatal about expected degradation reads as a crash at 2am.
      l.warn({ server: cfg.name, err: errMessage(e) }, 'external mcp server failed to connect');
      // A server that never came up is retried on the same schedule as one
      // that dropped: from the user's side they are the same fault (§11.6).
      this.scheduleRetry(cfg.name);
    }
  }
}

export { SkillLoader };
