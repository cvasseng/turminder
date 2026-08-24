import { newId } from '../core/ids.js';
import { log } from '../core/logger.js';
import { errMessage } from '../core/errors.js';
import { nowIso } from '../core/time.js';
import type { Service } from '../service.js';
import type { ResolvedEndpoint } from '../model/types.js';

const l = log('channel');

export interface Frame {
  id: string;
  type: string;
  payload: Record<string, unknown>;
}

export type ErrorCode =
  'auth_failed' | 'not_ready' | 'bad_frame' | 'unknown_type' | 'not_found' | 'internal';

/**
 * The client→server frames this build understands, advertised in `welcome`.
 * A page loaded from disk can easily be newer than the process serving it —
 * static files reload, a running service does not — so the client is told what
 * it can actually use rather than discovering it through `unknown_type`.
 */
export const SUPPORTED_FRAMES = [
  'hello',
  'ack',
  'event',
  'chat.send',
  'chat.history',
  'conversation.list',
  'conversation.close',
  'conversation.delete',
  'form.submit',
  'form.cancel',
  'files.list',
  'files.read',
  'files.save',
  'files.edit',
  'embed.resolve',
  'embed.manifest',
  'embed.list',
  'embed.promote',
  'embed.demote',
  'token.list',
  'token.create',
  'token.revoke',
  'models.list',
  'conversation.model',
] as const;

/**
 * Server→client frames this build emits. Advertised alongside the client frames
 * so a page can tell whether a feature it renders will ever arrive.
 */
export const EMITTED_FRAMES = [
  'welcome',
  'delivery',
  'chat.accepted',
  'event.accepted',
  'chat.delta',
  'chat.retract',
  'chat.activity',
  'chat.usage',
  'chat.done',
  'chat.error',
  'chat.history.result',
  'conversation.list.result',
  'conversation.closed',
  'conversation.deleted',
  'conversation.titled',
  'conversation.mode',
  'form.request',
  'form.accepted',
  'files.list.result',
  'files.read.result',
  'files.saved',
  'files.changed',
  'embed.resolve.result',
  'embed.manifest.result',
  'embed.list.result',
  'embed.promoted',
  'embed.demoted',
  'embed.changed',
  'token.list.result',
  'token.revoked',
  'token.reveal',
  'models.list.result',
  'conversation.model.set',
  'error',
] as const;

/** Whatever carries frames to the other end: a socket, or an in-process pipe. */
export interface SessionSink {
  send(frame: Frame): void;
  close(code: number, reason: string): void;
}

/**
 * The App. D frame protocol, with no idea what it is speaking over. Both the WS
 * server and the bundled daemon drive this same class, so bundling really is a
 * deployment flag rather than a second implementation (§7.3, App. D.4).
 */
export class ChannelSession {
  capabilities: string[] = [];
  lastSeen = 0;
  greeted = false;
  private unregister: (() => void) | null = null;
  private unregisterForms: (() => void) | null = null;
  private unregisterReveals: (() => void) | null = null;

  constructor(
    private readonly service: Service,
    readonly device: string,
    private readonly sink: SessionSink,
  ) {}

  send(type: string, payload: Record<string, unknown>): void {
    this.sink.send({ id: newId(), type, payload });
  }

  fail(code: ErrorCode, message: string, ref?: string): void {
    this.send('error', { code, message, ...(ref ? { ref } : {}) });
  }

  /** True when this channel declared the capability a frame needs. */
  can(capability: string): boolean {
    return this.greeted && this.capabilities.includes(capability);
  }

  /**
   * Which endpoint would serve a chat run with this override in place (§10.6):
   * the pin if there is one, else the `chat → best` kind default. Both model
   * frames ask the same question, and they must not answer it differently —
   * the selector's label and the effort validation are the same claim.
   */
  private servingEndpoint(override: string | null): ResolvedEndpoint | null {
    const router = this.service.modelStack?.router ?? null;
    if (!router) return null;
    if (override) return router.byName(override);
    try {
      return router.pick({ class: 'best' });
    } catch {
      return null;
    }
  }

  detach(): void {
    this.unregister?.();
    this.unregister = null;
    this.unregisterForms?.();
    this.unregisterForms = null;
    this.unregisterReveals?.();
    this.unregisterReveals = null;
  }

  async handleRaw(raw: string): Promise<void> {
    let frame: Frame;
    try {
      const parsed = JSON.parse(raw) as Partial<Frame>;
      if (!parsed || typeof parsed.type !== 'string') throw new Error('missing type');
      frame = {
        id: typeof parsed.id === 'string' ? parsed.id : newId(),
        type: parsed.type,
        payload: (parsed.payload ?? {}) as Record<string, unknown>,
      };
    } catch (e) {
      this.fail('bad_frame', `unparsable frame: ${errMessage(e)}`);
      return;
    }
    await this.handle(frame);
  }

  async handle(frame: Frame): Promise<void> {
    if (!this.greeted && frame.type !== 'hello') {
      this.fail('not_ready', 'the first frame must be hello', frame.id);
      this.sink.close(1002, 'hello required');
      return;
    }
    try {
      await this.route(frame);
    } catch (e) {
      l.warn({ type: frame.type, err: errMessage(e) }, 'frame handling failed');
      this.fail('internal', errMessage(e), frame.id);
    }
  }

  private async route(frame: Frame): Promise<void> {
    const p = frame.payload;
    switch (frame.type) {
      case 'hello': {
        this.capabilities = Array.isArray(p.capabilities)
          ? (p.capabilities as unknown[]).filter((c): c is string => typeof c === 'string')
          : [];
        this.lastSeen = typeof p.last_seen === 'number' ? p.last_seen : 0;
        this.greeted = true;
        const identity = this.service.app.config.identity();
        // Count before registering: registering replays, and the count is what
        // the client is told to expect (App. D).
        const replayCount = this.service.channels.replayCountFor(this.lastSeen);
        this.send('welcome', {
          server_time: nowIso(),
          frames: [...SUPPORTED_FRAMES],
          emits: [...EMITTED_FRAMES],
          instance_name: identity?.frontmatter.instance_name ?? null,
          // Who the assistant is talking to, for the UI's own chrome (§9).
          // Null until onboarding has written an identity.
          user_name: identity?.frontmatter.user_name ?? null,
          replay_count: replayCount,
          configured: this.service.configured,
          onboarding: this.service.chat.needsOnboarding(),
        });
        this.detach();
        this.unregister = this.service.channels.register({
          device: this.device,
          capabilities: this.capabilities,
          lastSeen: this.lastSeen,
          send: (delivery) =>
            this.send('delivery', {
              seq: delivery.seq,
              delivery_id: delivery.id,
              intent: delivery.intent,
              payload: delivery.payload,
              expires_at: delivery.expires_at,
            }),
        });
        // Anything still waiting for a human is re-sent now (App. D.5): a
        // reconnecting page must not lose the form a run is suspended on.
        if (this.capabilities.includes('forms')) {
          this.unregisterForms = this.service.forms.attach({
            send: (type, payload) => this.send(type, payload),
          });
        }
        // A reveal has nothing to re-send on reconnect: the value existed for
        // one frame and is gone (§24.2). Attaching only registers the audience.
        if (this.capabilities.includes('chat')) {
          this.unregisterReveals = this.service.reveals.attach({
            send: (type, payload) => this.send(type, payload),
          });
        }
        return;
      }

      case 'ack': {
        // Idempotent, and an unknown id is simply ignored (App. D).
        if (typeof p.delivery_id !== 'string') return;
        const acked = this.service.outbox.ack(p.delivery_id, this.device);
        if (acked && acked.seq > this.lastSeen) this.lastSeen = acked.seq;
        return;
      }

      case 'event': {
        if (typeof p.type !== 'string') {
          this.fail('bad_frame', 'event frames need a type', frame.id);
          return;
        }
        const result = this.service.intake.submit({
          type: p.type,
          // Set server-side: a channel cannot claim to be someone else (§7.3).
          source: this.device,
          payload: (p.payload ?? {}) as unknown,
          occurred_at: typeof p.occurred_at === 'string' ? p.occurred_at : null,
          idempotency_key: typeof p.idempotency_key === 'string' ? p.idempotency_key : null,
        });
        this.send('event.accepted', { event_id: result.event.id, status: result.status });
        return;
      }

      case 'chat.send': {
        if (typeof p.text !== 'string' || !p.text.trim()) {
          this.fail('bad_frame', 'chat.send needs text', frame.id);
          return;
        }
        if (!this.service.configured) {
          this.fail('not_ready', 'no model endpoint is configured yet', frame.id);
          return;
        }
        // An upload id that does not resolve is answered now, not swallowed
        // into a text-only message the user thinks carried a picture (§26.2).
        const ids = Array.isArray(p.attachments)
          ? p.attachments.filter((a): a is string => typeof a === 'string')
          : [];
        const attachments = this.service.chat.resolveAttachments(ids);
        if ('error' in attachments) {
          this.fail('not_found', attachments.message, frame.id);
          return;
        }
        const sent = this.service.chat.send({
          conversationId: typeof p.conversation_id === 'string' ? p.conversation_id : null,
          text: p.text,
          ...(attachments.length ? { attachments } : {}),
        });
        this.send('chat.accepted', {
          conversation_id: sent.conversationId,
          event_id: sent.eventId,
        });
        if (sent.mode === 'onboarding') {
          this.send('conversation.mode', {
            conversation_id: sent.conversationId,
            mode: 'onboarding',
          });
        }
        return;
      }

      case 'chat.history': {
        if (typeof p.conversation_id !== 'string') {
          this.fail('bad_frame', 'chat.history needs conversation_id', frame.id);
          return;
        }
        const { turns, more } = this.service.chat.history(p.conversation_id, {
          ...(typeof p.limit === 'number' ? { limit: p.limit } : {}),
          ...(typeof p.before_seq === 'number' ? { beforeSeq: p.before_seq } : {}),
        });
        this.send('chat.history.result', {
          conversation_id: p.conversation_id,
          turns: turns.map((t) => ({
            seq: t.seq,
            role: t.role,
            text: t.text,
            created_at: t.created_at,
            // Metadata only (App. D.1): the panel re-renders thumbnails from
            // `GET /api/uploads/<id>`, so bytes never ride a frame.
            ...(t.attachments.length
              ? {
                  attachments: t.attachments.map((a) => ({
                    upload_id: a.upload_id,
                    name: a.name,
                    mime: a.mime,
                  })),
                }
              : {}),
          })),
          more,
        });
        return;
      }

      case 'conversation.list': {
        this.send('conversation.list.result', {
          include_archived: p.include_archived === true,
          conversations: this.service.chat
            .list({ includeArchived: p.include_archived === true })
            .map((c) => ({
              id: c.id,
              title: c.title,
              status: c.status,
              mode: c.mode,
              last_activity_at: c.last_activity_at,
            })),
        });
        return;
      }

      case 'conversation.delete': {
        if (typeof p.conversation_id !== 'string') {
          this.fail('bad_frame', 'conversation.delete needs conversation_id', frame.id);
          return;
        }
        const result = this.service.chat.delete(p.conversation_id);
        if (!result.deleted) {
          this.fail('not_found', 'no such conversation', frame.id);
          return;
        }
        // No addressed reply: the delete is broadcast to every chat channel,
        // this one included, so a second frame would only be a duplicate.
        return;
      }

      case 'form.submit': {
        if (typeof p.form_id !== 'string') {
          this.fail('bad_frame', 'form.submit needs form_id', frame.id);
          return;
        }
        const values =
          p.values && typeof p.values === 'object' && !Array.isArray(p.values)
            ? (p.values as Record<string, unknown>)
            : {};
        // Values are never echoed back (App. D.5): the secret ones are already
        // on their way to secrets.yaml and must not travel any further.
        const result = this.service.forms.submit(p.form_id, values);
        if (!result.ok) {
          this.fail(
            result.error === 'not_found' ? 'not_found' : 'bad_frame',
            result.error === 'not_found'
              ? 'that form is no longer waiting for an answer'
              : result.error,
            frame.id,
          );
          return;
        }
        this.send('form.accepted', { form_id: p.form_id });
        return;
      }

      case 'form.cancel': {
        if (typeof p.form_id !== 'string') {
          this.fail('bad_frame', 'form.cancel needs form_id', frame.id);
          return;
        }
        const cancelled = this.service.forms.cancel(p.form_id);
        if (!cancelled.ok) {
          this.fail('not_found', 'that form is no longer waiting for an answer', frame.id);
          return;
        }
        this.send('form.accepted', { form_id: p.form_id });
        return;
      }

      /*
       * The file panel (§18.5). These frames are the *user* editing their own
       * workspace through their own authenticated UI, so they go straight to
       * the store — the tool grant layer exists to constrain the model, not the
       * person holding the device token.
       */
      case 'files.list': {
        try {
          this.send('files.list.result', {
            dir: typeof p.dir === 'string' ? p.dir : '',
            entries: this.service.files.list({
              ...(typeof p.dir === 'string' ? { dir: p.dir } : {}),
              ...(typeof p.glob === 'string' ? { glob: p.glob } : {}),
            }),
          });
        } catch (e) {
          this.fail('bad_frame', errMessage(e), frame.id);
        }
        return;
      }

      case 'files.read': {
        if (typeof p.path !== 'string') {
          this.fail('bad_frame', 'files.read needs path', frame.id);
          return;
        }
        try {
          this.send('files.read.result', { ...this.service.files.read(p.path) });
        } catch (e) {
          this.fail('not_found', errMessage(e), frame.id);
        }
        return;
      }

      case 'files.save': {
        if (typeof p.path !== 'string' || typeof p.content !== 'string') {
          this.fail('bad_frame', 'files.save needs path and content', frame.id);
          return;
        }
        try {
          const message =
            typeof p.message === 'string' && p.message.trim()
              ? p.message
              : `edit ${p.path} from the file panel`;
          this.send('files.saved', { ...this.service.files.write(p.path, p.content, message) });
        } catch (e) {
          this.fail('bad_frame', errMessage(e), frame.id);
        }
        return;
      }

      case 'files.edit': {
        if (
          typeof p.path !== 'string' ||
          typeof p.find !== 'string' ||
          typeof p.replace !== 'string'
        ) {
          this.fail('bad_frame', 'files.edit needs path, find and replace', frame.id);
          return;
        }
        try {
          const message =
            typeof p.message === 'string' && p.message.trim()
              ? p.message
              : `edit ${p.path} from the file panel`;
          const result = this.service.files.edit(p.path, p.find, p.replace, message);
          if ('error' in result) {
            this.fail('bad_frame', `${result.error} (${result.matches} matches)`, frame.id);
            return;
          }
          this.send('files.saved', { ...result });
        } catch (e) {
          this.fail('not_found', errMessage(e), frame.id);
        }
        return;
      }

      /*
       * Embeds (§22). The server computes the scoped URL so the client never
       * sees the signing secret, and the device token never travels the other
       * way into an embed context (§22.3.2/.5).
       */
      case 'embed.resolve': {
        if (typeof p.embed_id !== 'string') {
          this.fail('bad_frame', 'embed.resolve needs embed_id', frame.id);
          return;
        }
        if (!this.capabilities.includes('chat')) {
          this.fail('bad_frame', 'embed.resolve is for chat-capable devices', frame.id);
          return;
        }
        const row = this.service.embeds.repo.get(p.embed_id);
        if (!row) {
          this.fail('not_found', `no embed with id ${p.embed_id}`, frame.id);
          return;
        }
        // Resolving is using (§22.1): a marker rendered in any conversation
        // keeps the embed off the reaper's list.
        this.service.embeds.repo.markServed(row.id);
        this.send('embed.resolve.result', {
          embed_id: row.id,
          url: this.service.embeds.url(row),
          title: row.title,
          kind: row.kind,
        });
        return;
      }

      /*
       * Where the numbers on a page came from (§23.2). The values themselves
       * are deliberately not echoed: this frame answers provenance — tool,
       * arguments, when, whether it worked — and a UI that wanted the values
       * would just read the page.
       */
      case 'embed.manifest': {
        if (typeof p.embed_id !== 'string') {
          this.fail('bad_frame', 'embed.manifest needs embed_id', frame.id);
          return;
        }
        if (!this.service.embeds.repo.get(p.embed_id)) {
          this.fail('not_found', `no embed with id ${p.embed_id}`, frame.id);
          return;
        }
        this.send('embed.manifest.result', {
          embed_id: p.embed_id,
          bindings: this.service.binder.manifest(p.embed_id),
        });
        return;
      }

      case 'embed.list': {
        const kind = p.kind === 'ephemeral' || p.kind === 'persistent' ? p.kind : undefined;
        this.send('embed.list.result', {
          embeds: this.service.embeds.repo.list(kind ? { kind } : {}).map((row) => ({
            id: row.id,
            title: row.title,
            kind: row.kind,
            updated_at: row.updated_at,
            url: this.service.embeds.url(row),
          })),
        });
        return;
      }

      /*
       * The "keep" button (§22.1, §22.6). Promotion is a user act, and this is
       * the user: the confirm tier on `embeds.promote` exists to stop the
       * *model* deciding, not the person holding the device token.
       */
      case 'embed.promote': {
        if (typeof p.embed_id !== 'string') {
          this.fail('bad_frame', 'embed.promote needs embed_id', frame.id);
          return;
        }
        const promoted = this.service.embeds.promote(p.embed_id);
        if ('error' in promoted) {
          this.fail(
            promoted.error === 'not_found' ? 'not_found' : 'bad_frame',
            promoted.message,
            frame.id,
          );
          return;
        }
        this.send('embed.promoted', { ...promoted });
        return;
      }

      /*
       * Unkeeping (§22.1), the mirror of `embed.promote` and with the same
       * authorisation story: the user holding the device token *is* the
       * confirmation. It is not destructive — the view and its link survive;
       * what ends is its permanence.
       */
      case 'embed.demote': {
        if (typeof p.embed_id !== 'string') {
          this.fail('bad_frame', 'embed.demote needs embed_id', frame.id);
          return;
        }
        const demoted = this.service.embeds.demote(p.embed_id);
        if ('error' in demoted) {
          this.fail(
            demoted.error === 'not_found' ? 'not_found' : 'bad_frame',
            demoted.message,
            frame.id,
          );
          return;
        }
        this.send('embed.demoted', { ...demoted });
        return;
      }

      /*
       * The device list (§24.1). Metadata only — there is no value to leak
       * here even by accident, because nothing on the server has one. The
       * `last_seen` column is what makes a dead device recognizable.
       */
      case 'token.list': {
        const lastSeen = this.service.repos.deliveries.lastSeenByDevice();
        this.send('token.list.result', {
          devices: this.service.app.tokens.list().map((d) => ({
            ...d,
            last_seen: lastSeen[d.device] ?? 0,
          })),
        });
        return;
      }

      /*
       * "Connect a device" (§24.3): the same create-blind machinery the model
       * reaches through `setup.token_create`, with the user pressing the
       * button instead. The value goes out in the reveal and nowhere else —
       * not into this frame's answer, not into a log line.
       */
      case 'token.create': {
        if (
          typeof p.device !== 'string' ||
          !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(p.device)
        ) {
          this.fail('bad_frame', 'token.create needs a slug-shaped device name', frame.id);
          return;
        }
        // Same audience rule as the tool (§24.2): a token nobody can see is
        // not created at all. A `chat`-capable device is attached to the
        // broker, so a caller that cannot render a reveal is caught here.
        if (!this.service.reveals.audience) {
          this.fail(
            'bad_frame',
            'no chat-capable device could show the token, so none was created',
            frame.id,
          );
          return;
        }
        const label =
          typeof p.label === 'string' && p.label.trim() ? p.label.trim() : undefined;
        const created = this.service.app.tokens.create(p.device, label ? { label } : {});
        if ('error' in created) {
          this.fail('bad_frame', created.message, frame.id);
          return;
        }
        await this.service.reveals.revealToken(this.service.app.config.settings, created);
        return;
      }

      /*
       * Revocation from the UI (§24.1). Like `embed.promote`, the user holding
       * a device token *is* the confirmation — and unlike creation this is
       * deliberately not a tool, because an assistant that can revoke tokens
       * can lock the user out of their own gateway.
       */
      case 'token.revoke': {
        if (typeof p.device !== 'string') {
          this.fail('bad_frame', 'token.revoke needs device', frame.id);
          return;
        }
        if (!this.service.app.tokens.revoke(p.device)) {
          this.fail('not_found', `no device named ${p.device}`, frame.id);
          return;
        }
        // Revoking your own device is allowed — the store's change
        // notification is already closing this socket behind us.
        this.send('token.revoked', { device: p.device });
        return;
      }

      /*
       * The model selector's data (§10.6). Pricing config, never secrets: an
       * endpoint's `api_key` is resolved from the store at load and has no
       * business on a wire that renders in a browser.
       */
      case 'models.list': {
        const router = this.service.modelStack?.router ?? null;
        const conversationId = typeof p.conversation_id === 'string' ? p.conversation_id : null;
        const conversation = conversationId
          ? this.service.repos.conversations.get(conversationId)
          : null;
        const override = conversation?.model_override ?? null;
        const effort = conversation?.effort_override ?? null;
        const endpoints = router?.list() ?? [];
        // Which one would serve this conversation right now — the honest
        // answer to "what am I talking to", override or not.
        const serving = this.servingEndpoint(override)?.name ?? null;
        this.send('models.list.result', {
          endpoints: endpoints.map((e) => ({
            name: e.name,
            classes: e.classes,
            caps: e.caps,
            ...(e.contextSize ? { context_size: e.contextSize } : {}),
            ...(e.efforts ? { efforts: e.efforts } : {}),
            ...(e.cost
              ? {
                  cost: {
                    in_per_mtok: e.cost.inPerMtok,
                    out_per_mtok: e.cost.outPerMtok,
                    currency: e.cost.currency,
                  },
                }
              : {}),
            serves_this_conversation: e.name === serving,
          })),
          ...(override ? { override } : {}),
          ...(effort ? { effort } : {}),
        });
        return;
      }

      /*
       * Pin a conversation to an endpoint or a reasoning level, or clear
       * either (§10.6). The user choosing IS the confirmation, so there is no
       * gate — but an unknown name is a mistake worth naming rather than
       * storing, and so is a level the serving endpoint never claimed to
       * understand. A field that is absent is left alone; an explicit null
       * clears it.
       */
      case 'conversation.model': {
        if (typeof p.conversation_id !== 'string') {
          this.fail('bad_frame', 'conversation.model needs conversation_id', frame.id);
          return;
        }
        const setsEndpoint = 'endpoint' in p;
        const setsEffort = 'effort' in p;
        if (!setsEndpoint && !setsEffort) {
          this.fail('bad_frame', 'conversation.model needs endpoint or effort', frame.id);
          return;
        }
        const endpoint = setsEndpoint && typeof p.endpoint === 'string' ? p.endpoint : null;
        if (setsEndpoint && endpoint && !this.service.modelStack?.router.byName(endpoint)) {
          this.fail('not_found', `no endpoint named ${endpoint} in models.yaml`, frame.id);
          return;
        }
        const conversation = this.service.repos.conversations.get(p.conversation_id);
        if (!conversation) {
          this.fail('not_found', 'no such conversation', frame.id);
          return;
        }
        const pinned = setsEndpoint ? endpoint : conversation.model_override;
        const effort = setsEffort && typeof p.effort === 'string' ? p.effort : null;
        if (setsEffort && effort) {
          // Against the endpoint that would serve *after* this change: asking
          // one model for a level another one declares is how the parameter
          // ends up on a wire that never asked for it.
          const serving = this.servingEndpoint(pinned);
          const declared = serving?.efforts ?? [];
          if (!declared.includes(effort as (typeof declared)[number])) {
            this.fail(
              'not_found',
              declared.length
                ? `${serving!.name} declares efforts [${declared.join(', ')}], not "${effort}"`
                : `${serving?.name ?? 'this endpoint'} declares no reasoning efforts`,
              frame.id,
            );
            return;
          }
        }
        if (setsEndpoint) {
          this.service.repos.conversations.setModelOverride(p.conversation_id, endpoint);
        }
        if (setsEffort) {
          this.service.repos.conversations.setEffortOverride(p.conversation_id, effort);
        }
        this.send('conversation.model.set', {
          conversation_id: p.conversation_id,
          endpoint: pinned,
          effort: setsEffort ? effort : conversation.effort_override,
        });
        return;
      }

      case 'conversation.close': {
        if (typeof p.conversation_id !== 'string') {
          this.fail('bad_frame', 'conversation.close needs conversation_id', frame.id);
          return;
        }
        const { closed } = this.service.chat.close(p.conversation_id);
        if (!closed && !this.service.repos.conversations.get(p.conversation_id)) {
          this.fail('not_found', 'no such conversation', frame.id);
          return;
        }
        this.send('conversation.closed', { conversation_id: p.conversation_id });
        return;
      }

      default:
        this.fail(
          'unknown_type',
          `this server does not handle "${frame.type}" — it is probably running older ` +
            'code than the page; restart the service',
          frame.id,
        );
    }
  }
}
