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
  /** Integrations wired by the service rather than built here (deliver). */
  extra?: Record<string, ToolDefinition[]>;
  /** Injected in tests so web.search never touches the network. */
  fetch?: typeof globalThis.fetch;
}

export interface McpServerStatus {
  name: string;
  transport: 'stdio' | 'http';
  connected: boolean;
  tools: string[];
  error?: string;
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
  private tools: ToolHandle[] = [];

  private constructor(
    readonly skills: SkillLoader,
    private readonly config: Config,
  ) {}

  static async create(deps: ToolHubDeps): Promise<ToolHub> {
    const hub = new ToolHub(deps.skills, deps.config);
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
      schedule: scheduleTools(deps.repos, deps.config.settings.scheduleGraceS),
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

  /** Re-read the tool lists from every connection. */
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

  /** Configured external servers and whether they are actually up (App. F.9). */
  serverStatus(): McpServerStatus[] {
    return this.config.mcp().servers.map((cfg) => {
      const known = this.external.get(cfg.name);
      return {
        name: cfg.name,
        transport: cfg.transport,
        connected: this.connections.has(cfg.name),
        tools: this.toolsFrom(cfg.name),
        ...(known?.error ? { error: known.error } : {}),
      };
    });
  }

  async close(): Promise<void> {
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
      this.connections.set(cfg.name, await McpConnection.external(cfg));
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
    }
  }
}

export { SkillLoader };
