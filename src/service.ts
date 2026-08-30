import os from 'node:os';
import path from 'node:path';
import type { App } from './app.js';
import { BackgroundTasks } from './core/background.js';
import { GitRepo } from './core/git.js';
import { nowIso } from './core/time.js';
import { log } from './core/logger.js';
import { createRepos, type Repos } from './db/repos/index.js';
import { EventIntake } from './ingress/intake.js';
import { WorkQueue, type EventProcessor } from './ingress/queue.js';
import { createPipeline } from './ingress/pipeline.js';
import { createModelStack, type ModelStack } from './model/index.js';
import { InferenceScheduler } from './model/scheduler.js';
import type { GatewayOptions } from './model/gateway.js';
import { ToolHub } from './tools/hub.js';
import { SkillLoader } from './tools/skills.js';
import { MemoryStore } from './memory/store.js';
import { MemoryAgent } from './memory/agent.js';
import { DistillExecutor } from './memory/distill.js';
import { HandlerLoader } from './exec/handlers.js';
import { HandlerExecutor } from './exec/executor.js';
import { IngressAgent } from './ingress/agent.js';
import { SchedulerLoop } from './scheduler/loop.js';
import { createSourceStack, type SourceStack } from './tools/integrations/external.js';
import { ChannelRouter } from './egress/channels.js';
import { Outbox } from './egress/outbox.js';
import { ConfirmBroker } from './exec/confirm.js';
import { BundledDaemon, type BundledDaemonOptions } from './egress/bundled-daemon.js';
import { deliverTools } from './tools/integrations/deliver.js';
import { EmbeddingClient } from './rag/embeddings.js';
import { RagIndex } from './rag/index-store.js';
import { FilesIndex } from './rag/files-index.js';
import { TurnsIndex } from './rag/turns-index.js';
import { UploadStore } from './uploads/store.js';
import { UploadReaper } from './uploads/reaper.js';
import { WatcherEngine } from './watchers/engine.js';
import { MemoryWatcher } from './rag/watcher.js';
import { FileStore } from './files/store.js';
import { FileEvents } from './files/events.js';
import { EventFeed } from './ingress/feed.js';
import { CallFeed } from './model/feed.js';
import { SnapshotStore } from './files/snapshots.js';
import { FileWatcher } from './files/watcher.js';
import { filesTools } from './tools/integrations/files.js';
import { historyTools } from './tools/integrations/history.js';
import { projectTools } from './tools/integrations/project.js';
import { ProjectStore } from './projects/store.js';
import { ProjectScope } from './projects/scope.js';
import { watchTools } from './tools/integrations/watch.js';
import { EmbedStore } from './embeds/store.js';
import { EmbedBinder } from './embeds/binder.js';
import { EmbedEvents } from './embeds/events.js';
import { EmbedReaper } from './embeds/reaper.js';
import { embedsTools } from './tools/integrations/embeds.js';
import { docsTools } from './tools/integrations/docs.js';
import { ChromiumPrinter, TransientDocs } from './docs/print.js';
import { ChatExecutor } from './chat/executor.js';
import { FormBroker } from './chat/forms.js';
import { RevealBroker } from './chat/reveals.js';
import { PairingBroker, type PairKind, type PairRequest } from './core/pairing.js';
import { GrantStore } from './tools/grants.js';
import { RunGrants } from './tools/run-grants.js';
import { ChatStops } from './chat/stop.js';
import { setupTools } from './tools/integrations/setup/tools.js';
import { ChatService } from './chat/service.js';
import { ChatStreamHub } from './chat/stream.js';

const l = log('service');

export interface ServiceOptions {
  /** Override the event processor (tests, replay, dry runs). */
  processor?: EventProcessor;
  maxConcurrent?: number;
  pollMs?: number;
  /** Injected into the model gateway (test fetch, cache settings). */
  gateway?: GatewayOptions;
  /** Injected into tools that reach the network, e.g. web.search. */
  fetch?: typeof globalThis.fetch;
  /** Idle-conversation distillation sweep interval; 0 disables it. */
  sweepMs?: number;
  /** Rebuild the RAG index from scratch on start (`--rebuild-index`, §8.3). */
  rebuildIndex?: boolean;
  /** Watch memory files for hand edits; on by default. */
  watchMemory?: boolean;
  /** Watch the file store (§18.4); on by default. */
  watchFiles?: boolean;
  /** Longest the scheduler sleeps between checks. */
  schedulerMaxSleepMs?: number;
  /** Start the timer loop; on by default. */
  runScheduler?: boolean;
  /** Overrides for the bundled daemon (tests inject a renderer). */
  bundledDaemon?: BundledDaemonOptions & { enabled?: boolean };
  /** Start configured external sources (Asana, Calendar); on by default. */
  runSources?: boolean;
  /**
   * Ask for the §3c greeting at start when this install still needs onboarding;
   * on by default. Off is for tests that drive onboarding themselves — an
   * unannounced model call during `start()` would otherwise eat the response
   * they scripted for their own turn.
   */
  greetOnStart?: boolean;
}

/**
 * The running assembly. Built so that "models not configured yet" is a normal
 * state, not a crash: setup runs against a live service and turns it on.
 */
export class Service {
  readonly repos: Repos;
  readonly intake: EventIntake;
  readonly queue: WorkQueue;
  readonly skills: SkillLoader;
  readonly stream = new ChatStreamHub();
  readonly chat: ChatService;
  readonly memoryStore: MemoryStore;
  /** Work nobody waits for; drained before the database closes. */
  readonly background = new BackgroundTasks();
  readonly handlers: HandlerLoader;
  readonly channels: ChannelRouter;
  readonly outbox: Outbox;
  readonly confirm: ConfirmBroker;
  readonly forms: FormBroker;
  /** One-time token reveals to chat-capable devices (§24.2). */
  readonly reveals = new RevealBroker();
  /** Devices waiting at their own gate to be approved (§24.4). */
  readonly pairing: PairingBroker;
  /** Tool access the user granted at runtime, on top of the configured set. */
  readonly grants: GrantStore;
  /** The shared workspace (§18). Built eagerly: the UI panel needs it before start(). */
  readonly files: FileStore;
  /** Project islands (§31): what exists, and what each conversation loaded. */
  readonly projects: ProjectStore;
  readonly projectScope: ProjectScope;
  readonly fileEvents = new FileEvents();
  /** Embeds (§22). Eager for the same reason: the HTTP routes serve them. */
  readonly embeds: EmbedStore;
  /** Data bindings (§23.2). Serving an embed executes them; no model involved. */
  readonly binder: EmbedBinder;
  /** "What you are looking at is out of date" (§22.6), for open chat pages. */
  readonly embedEvents = new EmbedEvents();
  /** Where every event is in its lifecycle, for the activity panel (§4.2.1). */
  readonly eventFeed = new EventFeed();
  /** One row per model call, live, for the request log (§10.8). */
  readonly callFeed = new CallFeed();
  /** Print-only documents, alive for one chromium navigation (§23.4). */
  readonly transient = new TransientDocs();
  /** Chat attachments (§26.1). Eager: the HTTP routes serve them. */
  readonly uploads: UploadStore;
  /** The deterministic state layer (§30). Built with the tool hub. */
  private watcherEngine: WatcherEngine | null = null;
  private readonly uploadReaper: UploadReaper;
  /**
   * Grant sets of runs in flight (§23.2). Registered by whichever executor
   * built the run's dispatcher, so "what may this run call" has one answer.
   */
  readonly runGrants = new RunGrants();
  /** In-flight chat runs, so `chat.stop` (App. D) has a handle to pull. */
  readonly chatStops = new ChatStops();

  private models: ModelStack | null = null;
  private toolHub: ToolHub | null = null;
  private chatExecutor: ChatExecutor | null = null;
  private distillExecutor: DistillExecutor | null = null;
  private ingressAgent: IngressAgent | null = null;
  private handlerExecutor: HandlerExecutor | null = null;
  private memoryAgent: MemoryAgent | null = null;
  /** Reconfigured, not rebuilt, on a models.yaml reload (§10.6, §8.3) — the
   *  indexes below hold this same instance for the life of the process. */
  private embeddingClient: EmbeddingClient | null = null;
  private ragIndex: RagIndex | null = null;
  private filesIndex: FilesIndex | null = null;
  private turnsIndex: TurnsIndex | null = null;
  private snapshots: SnapshotStore | null = null;
  private fileWatcher: FileWatcher | null = null;
  private watcher: MemoryWatcher | null = null;
  private sweepTimer: NodeJS.Timeout | null = null;
  private bundled: BundledDaemon | null = null;
  private sourceStack: SourceStack | null = null;
  private listeningOrigin: string | null = null;
  readonly reaper: EmbedReaper;
  readonly scheduler: SchedulerLoop;

  constructor(
    readonly app: App,
    private readonly opts: ServiceOptions = {},
  ) {
    this.repos = createRepos(app.db);
    // Every arrival and every transition, from the one place they are written
    // (§4.2.1). The panel is a read surface over state the loop already keeps;
    // nothing about the loop changes because somebody is watching.
    this.repos.events.observe((event) => this.eventFeed.moved(event));
    // Every model call, for the request log (§10.8) — same shape of wiring.
    this.repos.trace.observe((row) => this.callFeed.made(row));
    const settings = app.config.settings;
    this.intake = new EventIntake(this.repos, settings);
    this.skills = new SkillLoader(app.home);
    this.uploads = new UploadStore({
      home: app.home,
      repo: this.repos.uploads,
      maxMb: () => this.app.config.settings.uploadMaxMb,
    });
    this.chat = new ChatService(this.repos, app.config, this.intake, this.stream, this.uploads);
    this.memoryStore = new MemoryStore(app.home);
    this.handlers = new HandlerLoader(app.home);
    this.channels = new ChannelRouter(this.repos.deliveries);
    this.outbox = new Outbox(this.repos, this.channels, app.config);
    this.confirm = new ConfirmBroker(this.outbox, app.config);
    this.forms = new FormBroker(app.home, app.config);
    this.grants = new GrantStore(app.home, app.config);
    this.pairing = new PairingBroker(app.tokens);
    this.files = createFileStore(app, (rel, content, change) =>
      this.onFileWrite(rel, content, change),
    );
    this.projects = new ProjectStore(this.files);
    this.projectScope = new ProjectScope(this.repos.conversations);
    this.embeds = new EmbedStore({
      home: app.home,
      config: app.config,
      repo: this.repos.embeds,
      // A cascade that deletes handler files must also stop them being offered.
      onHandlersChanged: () => this.handlers.reload(),
      onChanged: (id) => this.embedEvents.changed({ embedId: id, reason: 'edited' }),
    });
    this.binder = new EmbedBinder({
      repo: this.repos.embeds,
      // Late-bound: the hub is built in start(), and an integration activated
      // later still has to be replayable (§19.3).
      tools: () => this.toolHub?.handles() ?? [],
      onChanged: (id) => this.embedEvents.changed({ embedId: id, reason: 'data' }),
      // args_from (§23.2): the trace keeps original args, immune to elision.
      priorArgs: (runId, tool) => this.repos.trace.lastToolCallArgs(runId, tool),
    });
    this.reaper = new EmbedReaper({
      store: this.embeds,
      ttlDays: () => this.app.config.settings.embedTtlDays,
    });
    this.uploadReaper = new UploadReaper({
      store: this.uploads,
      ttlDays: () => this.app.config.settings.uploadTtlDays,
    });
    this.models = createModelStack(app.config, opts.gateway ?? {});

    const pipeline: EventProcessor =
      opts.processor ??
      createPipeline({
        repos: this.repos,
        chat: () => this.chatExecutorOrNull(),
        distill: () => this.distillExecutorOrNull(),
        ingress: () => this.ingressAgentOrNull(),
        handlers: () => this.handlerStackOrNull(),
        watchers: () => this.watcherEngine,
        confirm: this.confirm,
      });

    this.queue = new WorkQueue(this.repos, pipeline, {
      retryAttempts: settings.retryAttempts,
      retryBackoffS: settings.retryBackoffS,
      ...(opts.maxConcurrent ? { maxConcurrent: opts.maxConcurrent } : {}),
      ...(opts.pollMs ? { pollMs: opts.pollMs } : {}),
      onDeadLetter: (event, error, attempts) => {
        // §13.2: dead letters report themselves as events, like everything
        // else — except when the dead letter *is* a system event. A failing
        // failure report would otherwise spawn the next one forever.
        if (event.type.startsWith('system.')) {
          l.error(
            { id: event.id, type: event.type, attempts, error },
            'system event dead-lettered; not reporting it as a new event',
          );
          return;
        }
        this.intake.submit({
          type: 'system.handler_failed',
          source: 'system',
          payload: { event_id: event.id, handler: null, error, attempts },
          // Provenance, so a cascade runs into the depth limit rather than free.
          caused_by: event.id,
        });
      },
    });
    this.scheduler = new SchedulerLoop(this.repos, this.intake, {
      ...(opts.schedulerMaxSleepMs ? { maxSleepMs: opts.schedulerMaxSleepMs } : {}),
    });
    this.intake.onEvent(() => this.queue.notify());
  }

  /**
   * The configured chat grant (App. F.7), before anything granted at runtime.
   * One definition, used by the executor that builds the dispatcher and by the
   * setup integration that reports what is reachable — those two disagreeing is
   * exactly the bug where a connected MCP server looks usable and is not.
   */
  chatGrants(): { tools: string[]; confirm: string[] } {
    const settings = this.app.config.settings;
    return { tools: settings.chatTools, confirm: settings.chatConfirm };
  }

  /**
   * A device at its own gate asks to be let in (§24.4). The request is taken
   * first and answered immediately — the page has a code to show either way —
   * and the approval is then put in front of whoever is at a screen.
   *
   * Both halves live here rather than in the route because their order is the
   * contract: no dialog is raised for a request that was refused, and the page
   * never waits on a human to get its code.
   */
  requestPairing(kind?: PairKind): PairRequest {
    const asked = this.pairing.request();
    if (!('error' in asked)) {
      this.background.run('pairing approval', () => this.offerPairing(asked.code, kind));
    }
    return asked;
  }

  /**
   * Put the pairing in front of the user as a form (§19.1, §24.4) rather than
   * making them dictate a code to the assistant: the dialog carries the code to
   * check against the device's own screen, and the one thing the server cannot
   * know — what to call the thing.
   *
   * The form is the existing primitive and behaves like every other one: it is
   * re-sent on reconnect, the first submit wins, and no forms-capable device
   * connected means `no_channel` — which is not a refusal. Only a human
   * cancelling is, so that is the only outcome that declines the request; a
   * timeout or a missing screen leaves it standing and `setup.pair_approve`
   * still works.
   */
  private async offerPairing(code: string, kind?: PairKind): Promise<void> {
    let taken: string | null = null;
    // Bounded: a naming clash is worth re-asking about, a loop is not.
    for (let attempt = 0; attempt < 3; attempt++) {
      const outcome = await this.forms.request({
        runId: '',
        // No conversation: this belongs to a device, not to something said.
        conversationId: '',
        title: `A device wants to connect — code ${code}`,
        description: taken
          ? `${taken} Pick another name.`
          : "Check that this code is the one on that device's own screen before you name it. If it is not — if you did not just ask for this — cancel: the request is somebody else's.",
        fields: [
          {
            name: 'device',
            label: 'Call this device',
            type: 'text',
            required: true,
            value: this.freeDeviceName(kind),
          },
        ],
      });
      if (!outcome.submitted) {
        if (outcome.reason === 'cancelled') this.pairing.decline(code);
        return;
      }
      const device = String(outcome.values.device ?? '').trim();
      const approved = this.pairing.approve(code, device);
      if (!('error' in approved)) return;
      // Anything else — expired, already approved — is not a thing re-asking
      // fixes, and the device's own screen will say so.
      if (approved.error !== 'device_exists' && approved.error !== 'bad_device_name') return;
      taken =
        approved.error === 'device_exists'
          ? `There is already a device called ${device}.`
          : approved.message;
    }
  }

  /**
   * The name the dialog offers: the word for what asked, or the first free
   * `<word>-N` after it. A prefill, not a rule — the person answering is the
   * one who decides, and the broker validates whatever they decide on.
   */
  private freeDeviceName(kind?: PairKind): string {
    const base = kind ?? 'device';
    if (!this.app.tokens.has(base)) return base;
    for (let n = 2; n < 100; n++) {
      if (!this.app.tokens.has(`${base}-${n}`)) return `${base}-${n}`;
    }
    return '';
  }

  /**
   * Told by the HTTP server once it has actually bound (§23.4): a configured
   * port can be 0, and chromium needs a URL it can really fetch. Null until
   * then, which `docs.to_pdf` reports rather than guessing.
   */
  setListening(host: string, port: number): void {
    // A wildcard bind is not an address anything can connect to.
    const reachable = host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host;
    this.listeningOrigin = `http://${reachable}:${port}`;
  }

  get origin(): string | null {
    return this.listeningOrigin;
  }

  /** Whether an LLM endpoint is configured (drives setup vs chat, plan §3b). */
  get configured(): boolean {
    return this.models !== null;
  }

  get modelStack(): ModelStack | null {
    return this.models;
  }

  /** Available after start(). */
  get sources(): SourceStack {
    if (!this.sourceStack) throw new Error('sources are not built yet — call start() first');
    return this.sourceStack;
  }

  /** Available after start(). */
  get memory(): MemoryAgent {
    if (!this.memoryAgent)
      throw new Error('memory agent is not built yet — call start() first');
    return this.memoryAgent;
  }

  /** Available after start(). */
  get fileIndex(): FilesIndex {
    if (!this.filesIndex) throw new Error('files index is not built yet — call start() first');
    return this.filesIndex;
  }

  /** Available after start(). */
  get rag(): RagIndex {
    if (!this.ragIndex) throw new Error('rag index is not built yet — call start() first');
    return this.ragIndex;
  }

  /** The watcher engine (§30). Available after start(). */
  get watchers(): WatcherEngine {
    if (!this.watcherEngine) throw new Error('watchers are not built yet — call start() first');
    return this.watcherEngine;
  }

  /** The conversation-history corpus (§25). Available after start(). */
  get history(): TurnsIndex {
    if (!this.turnsIndex) throw new Error('turns index is not built yet — call start() first');
    return this.turnsIndex;
  }

  /** Available after start(). */
  get tools(): ToolHub {
    if (!this.toolHub) throw new Error('tool hub is not built yet — call start() first');
    return this.toolHub;
  }

  /** Rebuild the model stack after setup writes config/models.yaml. */
  loadModels(): boolean {
    this.app.config.reload();
    this.models = createModelStack(this.app.config, this.opts.gateway ?? {});
    this.chatExecutor = null;
    this.distillExecutor = null;
    this.ingressAgent = null;
    this.handlerExecutor = null;
    if (this.memoryAgent && this.ragIndex) {
      this.memoryAgent = new MemoryAgent(
        this.memoryStore,
        this.ragIndex,
        this.models?.gateway ?? null,
      );
    }
    if (this.models) {
      l.info(
        { endpoints: this.models.router.list().map((e) => e.name) },
        'model endpoints loaded',
      );
    } else {
      l.warn('no usable config/models.yaml — setup required before chat works');
    }
    // Same client instance, new endpoint (§10.6, §8.3): the RAG/files/turns
    // indexes hold this reference and must not be rebuilt for a config reload.
    this.embeddingClient?.reconfigure(this.models?.router.embedding() ?? null);
    return this.configured;
  }

  private chatExecutorOrNull(): ChatExecutor | null {
    if (!this.models || !this.toolHub) return null;
    if (!this.chatExecutor) {
      this.chatExecutor = new ChatExecutor({
        repos: this.repos,
        config: this.app.config,
        gateway: this.models.gateway,
        tools: this.toolHub,
        stream: this.stream,
        confirm: this.confirm,
        grants: this.grants,
        runGrants: this.runGrants,
        stops: this.chatStops,
        background: this.background,
        projects: this.projects,
        ...(this.ragIndex ? { rag: this.ragIndex } : {}),
        ...(this.turnsIndex ? { history: this.turnsIndex } : {}),
        uploads: this.uploads,
      });
    }
    return this.chatExecutor;
  }

  private ingressAgentOrNull(): IngressAgent | null {
    if (!this.models) return null;
    if (!this.ingressAgent) {
      this.ingressAgent = new IngressAgent({
        repos: this.repos,
        config: this.app.config,
        gateway: this.models.gateway,
      });
    }
    return this.ingressAgent;
  }

  private handlerStackOrNull(): { loader: HandlerLoader; executor: HandlerExecutor } | null {
    if (!this.models || !this.toolHub) return null;
    if (!this.handlerExecutor) {
      this.handlerExecutor = new HandlerExecutor({
        repos: this.repos,
        config: this.app.config,
        gateway: this.models.gateway,
        tools: this.toolHub,
        confirm: this.confirm,
        runGrants: this.runGrants,
        ...(this.ragIndex ? { rag: this.ragIndex } : {}),
      });
    }
    // Handlers are re-read per event: authoring one through chat should take
    // effect on the next event, not the next restart.
    this.handlers.reload();
    return { loader: this.handlers, executor: this.handlerExecutor };
  }

  private distillExecutorOrNull(): DistillExecutor | null {
    if (!this.models || !this.memoryAgent) return null;
    if (!this.distillExecutor) {
      this.distillExecutor = new DistillExecutor({
        repos: this.repos,
        config: this.app.config,
        gateway: this.models.gateway,
        memory: this.memoryAgent,
        stream: this.stream,
      });
    }
    return this.distillExecutor;
  }

  async start(): Promise<void> {
    // RAG and memory come up before the tool hub, because the memory
    // integration is one of the tools it serves.
    const embeddingCfg = this.models?.router.embedding() ?? null;
    // `null` is a normal state (§10.6: no `kind: embedding` endpoint
    // configured) — `EmbeddingClient` degrades to lexical fallback rather
    // than being handed a guessed URL that was never in models.yaml.
    const embeddings = new EmbeddingClient(
      embeddingCfg,
      this.models?.scheduler ?? new InferenceScheduler(1),
      { ...(this.opts.fetch ? { fetch: this.opts.fetch } : {}) },
    );
    this.embeddingClient = embeddings;
    this.ragIndex = new RagIndex(this.app.home, this.memoryStore, embeddings);
    this.filesIndex = new FilesIndex(this.app.home, this.files, embeddings);
    this.turnsIndex = new TurnsIndex(this.app.home, this.repos.conversations, embeddings);
    this.memoryAgent = new MemoryAgent(
      this.memoryStore,
      this.ragIndex,
      this.models?.gateway ?? null,
    );
    if (this.opts.rebuildIndex) {
      l.info(await this.ragIndex.rebuild(), 'rag index rebuilt');
      l.info(await this.filesIndex.rebuild(), 'files index rebuilt');
      l.info(await this.turnsIndex.rebuild(), 'turns index rebuilt');
    } else {
      await this.ragIndex.sync();
      await this.filesIndex.sync();
      await this.turnsIndex.sync();
    }
    // A deleted conversation must leave the corpus with it: a ghost turn in a
    // search result is a correctness bug, not staleness (§25).
    this.chat.onStream({
      deleted: (e) =>
        this.background.run('history:forget', async () =>
          this.turnsIndex?.forgetConversation(e.conversationId),
        ),
    });

    // The watcher engine before the hub: its tools close over it, and the
    // pipeline's `watch.due` route asks for it by the time anything fires.
    this.watcherEngine = new WatcherEngine({
      repos: this.repos,
      intake: this.intake,
      files: this.files,
      tools: () => this.toolHub?.handles() ?? [],
      priorArgs: (runId, tool) => this.repos.trace.lastToolCallArgs(runId, tool),
    });

    // Sources first: they contribute tools (calendar.*, asana.*) to the hub.
    this.sourceStack = createSourceStack({
      home: this.app.home,
      config: this.app.config,
      intake: this.intake,
      meta: this.repos.meta,
      ...(this.opts.fetch ? { fetch: this.opts.fetch } : {}),
    });

    this.toolHub = await ToolHub.create({
      home: this.app.home,
      config: this.app.config,
      intake: this.intake,
      repos: this.repos,
      skills: this.skills,
      forms: this.forms,
      router: () => this.models?.router ?? null,
      memory: this.memoryAgent,
      projectScope: this.projectScope,
      extra: {
        deliver: deliverTools(this.outbox, () => this.app.config.settings.spokenMaxChars),
        files: filesTools({
          store: this.files,
          index: this.filesIndex,
          scope: this.projectScope,
        }),
        history: historyTools({ index: this.turnsIndex, scope: this.projectScope }),
        project: projectTools({
          projects: this.projects,
          conversations: this.repos.conversations,
        }),
        watch: watchTools({
          engine: this.watchers,
          repo: this.repos.watchers,
          runGrants: this.runGrants,
          nextPollAt: (scheduleId) => this.repos.schedules.get(scheduleId)?.fire_at ?? null,
        }),
        embeds: embedsTools({
          store: this.embeds,
          binder: this.binder,
          runGrants: this.runGrants,
        }),
        docs: docsTools({
          files: this.files,
          embeds: this.embeds,
          binder: this.binder,
          printer: new ChromiumPrinter({ systools: this.app.systools }),
          transient: this.transient,
          origin: () => this.origin,
        }),
        setup: setupTools({
          home: this.app.home,
          config: this.app.config,
          router: () => this.models?.router ?? null,
          intake: this.intake,
          forms: this.forms,
          reveals: this.reveals,
          pairing: this.pairing,
          tokens: this.app.tokens,
          grants: this.grants,
          baseGrants: () => this.chatGrants(),
          // Late-bound: the hub is what this integration is being built for.
          tools: () => this.toolHub,
          reloadModels: () => this.loadModels(),
          reloadIntegrations: () => this.reloadIntegrations(),
          rebuildIndexes: async () => ({
            memory: await this.rag.rebuild(),
            files: await this.fileIndex.rebuild(),
            history: await this.history.rebuild(),
          }),
          ...(this.opts.fetch ? { fetch: this.opts.fetch } : {}),
        }),
        ...this.sourceStack.tools,
      },
      ...(this.opts.fetch ? { fetch: this.opts.fetch } : {}),
    });

    if (this.opts.watchMemory !== false) {
      this.watcher = new MemoryWatcher(this.app.home, this.ragIndex);
      this.watcher.start();
    }
    // The file watcher comes up after the handler loader is usable, because
    // `watch:` subscriptions are read from it per change (§18.4 tier 3).
    this.snapshots = new SnapshotStore(this.app.home.path('cache', 'files-watch.db'));
    this.fileWatcher = new FileWatcher({
      store: this.files,
      snapshots: this.snapshots,
      index: this.filesIndex,
      intake: this.intake,
      watchPatterns: () => {
        this.handlers.reload();
        return this.handlers.watchPatterns();
      },
      settings: () => {
        const s = this.app.config.settings;
        return {
          quiescenceS: s.filesQuiescenceS,
          markers: s.filesMarkers,
          watchRateLimitS: s.filesWatchRateLimitS,
        };
      },
      background: this.background,
      onChange: (path, change) => this.fileEvents.changed({ path, change }),
    });
    if (this.opts.watchFiles !== false) await this.fileWatcher.start();
    const orphanedRuns = this.repos.runs.failOrphaned();
    if (orphanedRuns) l.warn({ orphanedRuns }, 'failed runs left over from a previous process');
    this.queue.start();
    this.outbox.startSweep();
    if (this.opts.runScheduler !== false) this.scheduler.start();
    if (this.opts.runSources !== false) {
      for (const source of this.sourceStack.sources) await source.start();
    }

    const daemonOpts = this.opts.bundledDaemon ?? {};
    const bundledWanted = daemonOpts.enabled ?? this.app.config.settings.daemonBundled;
    if (bundledWanted) {
      // Honest degradation for the one systool with no tool result to carry it
      // (§23.1): notifications would silently go nowhere, so say it once here.
      const missing = daemonOpts.renderer ? null : this.app.systools.missing('notify-send');
      if (missing) l.warn({ hint: missing.hint }, missing.message);
      const { enabled: _enabled, ...rest } = daemonOpts;
      this.bundled = new BundledDaemon(this, {
        device: this.app.config.settings.daemonDevice,
        notifyCommand: this.app.config.settings.daemonNotifyCommand,
        ...rest,
      });
      await this.bundled.start();
    }

    const sweepMs = this.opts.sweepMs ?? 60_000;
    if (sweepMs > 0) {
      this.sweepTimer = setInterval(() => {
        try {
          const distilled = this.chat.distillIdle();
          if (distilled) l.info({ distilled }, 'distilled idle conversations');
        } catch (e) {
          l.warn({ err: e }, 'idle sweep failed');
        }
      }, sweepMs);
      this.sweepTimer.unref?.();
    }
    this.reaper.start();
    this.uploadReaper.start();
    // Once now, too: a service restarted every day would otherwise never reach
    // the 24h mark, and the reaper is the only thing that bounds the store.
    this.background.run('embeds:reap', async () => this.reaper.sweep());
    this.background.run('uploads:reap', async () => this.uploadReaper.sweep());

    // A model but no identity means onboarding never happened — most often
    // because setup was done before there was anything to start it. Asking here
    // as well as at commit time is what makes an install that has been sitting
    // half-finished pick up where it stopped (§3c).
    if (this.opts.greetOnStart !== false && this.configured && this.chat.requestOnboarding()) {
      l.info('onboarding has not run yet — greeting requested');
    }
  }

  async stop(): Promise<void> {
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    this.sweepTimer = null;
    this.reaper.stop();
    this.uploadReaper.stop();
    this.scheduler.stop();
    for (const source of this.sourceStack?.sources ?? []) source.stop();
    this.confirm.denyAll('service shutting down');
    this.forms.interruptAll();
    // Before anything is torn down: a title run still writing to the database
    // would otherwise fail on a closed connection.
    await this.background.stop();
    await this.bundled?.stop();
    this.bundled = null;
    this.outbox.stopSweep();
    await this.queue.stop();
    await this.watcher?.stop();
    this.watcher = null;
    await this.fileWatcher?.stop();
    this.fileWatcher = null;
    await this.toolHub?.close();
    this.toolHub = null;
    this.ragIndex?.close();
    this.ragIndex = null;
    this.filesIndex?.close();
    this.filesIndex = null;
    this.turnsIndex?.close();
    this.turnsIndex = null;
    this.snapshots?.close();
    this.snapshots = null;
  }

  /**
   * Rebuild the credentialed integrations from `config/integrations.yaml`
   * (§19.5). Activation is supposed to take effect in the conversation that
   * asked for it, so this replaces the tool hub's entries and restarts the
   * pollers in place rather than asking for a restart.
   */
  async reloadIntegrations(): Promise<string[]> {
    for (const source of this.sourceStack?.sources ?? []) source.stop();
    this.app.config.reload();
    const previous = this.sourceStack?.runtimes ?? [];
    this.sourceStack = createSourceStack({
      home: this.app.home,
      config: this.app.config,
      intake: this.intake,
      meta: this.repos.meta,
      ...(this.opts.fetch ? { fetch: this.opts.fetch } : {}),
    });

    const hub = this.toolHub;
    if (hub) {
      // Every namespace that was or is present, so a deactivated integration's
      // tools actually go away rather than lingering until a restart.
      const namespaces = new Set([
        ...previous.map((r) => r.namespace),
        ...this.sourceStack.runtimes.map((r) => r.namespace),
      ]);
      for (const namespace of namespaces) {
        const defs = this.sourceStack.tools[namespace];
        if (defs?.length) await hub.setIntegration(namespace, defs);
        else await hub.removeIntegration(namespace);
      }
    }

    if (this.opts.runSources !== false) {
      for (const source of this.sourceStack.sources) await source.start();
    }
    const names = this.sourceStack.runtimes.filter((r) => r.active).map((r) => r.name);
    l.info({ active: names }, 'integrations reloaded');
    return hub?.handles().map((t) => t.name) ?? [];
  }

  /** Test seam: run the watcher's settle step now instead of after quiescence. */
  async settleFile(rel: string): Promise<void> {
    await this.fileWatcher?.settle(rel);
  }

  /**
   * Self-write suppression (§18.4): the store's own writes become the snapshot
   * immediately, so the watcher never sees them as a change — and the index is
   * brought up to date here rather than by a watch event that will not come.
   */
  private onFileWrite(
    rel: string,
    content: string | null,
    change: 'created' | 'modified' | 'deleted',
  ): void {
    this.snapshots?.record(rel, content ?? '', nowIso());
    if (content === null) this.snapshots?.forget(rel);
    const index = this.filesIndex;
    if (index) this.background.run('files:index', () => index.indexOne(rel, content));
    this.fileEvents.changed({ path: rel, change });
  }
}

/**
 * The store root and its git repo (§18.2). Inside the data dir by default, so
 * every write is a commit in the data repo; pointed elsewhere by `files.dir`,
 * where git applies only if that directory happens to be a repo — the user
 * opted out of the portability guarantee knowingly.
 */
function createFileStore(
  app: App,
  onWrite: (
    rel: string,
    content: string | null,
    change: 'created' | 'modified' | 'deleted',
  ) => void,
): FileStore {
  const configured = app.config.settings.filesDir;
  if (!configured) {
    return new FileStore({
      root: app.home.filesDir,
      git: { repo: app.home.git, prefix: 'files' },
      onWrite,
    });
  }
  const root = path.resolve(configured.replace(/^~(?=$|[/\\])/, os.homedir()));
  const repo = new GitRepo(root);
  if (!repo.isRepo()) {
    l.info(
      { dir: root },
      'external file store is not a git repo; writes will not be committed',
    );
  }
  return new FileStore({
    root,
    git: repo.isRepo() ? { repo, prefix: '' } : null,
    onWrite,
  });
}
