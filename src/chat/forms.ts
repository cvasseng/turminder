import { log } from '../core/logger.js';
import { newId } from '../core/ids.js';
import type { Config } from '../core/config.js';
import type { DataHome } from '../core/datadir.js';

const l = log('forms');

/** App. D.5. `secret_key` names the target key in secrets/secrets.yaml. */
/**
 * D.5. `voice` is a `select` with a play button beside it (§33.5) — same
 * validation, different rendering; a surface that cannot play audio renders it
 * as a plain select and nothing breaks.
 */
export type FieldType = 'text' | 'url' | 'number' | 'select' | 'secret' | 'choice' | 'voice';

export interface FieldSpec {
  name: string;
  label: string;
  type: FieldType;
  required?: boolean;
  /** Prefill, from what the conversation already established (§19.1). */
  value?: string | number;
  /** `select` and `choice`. A `choice` renders its options as a button row —
   *  the one-click "continue or start fresh?" shape (App. D.5). */
  options?: string[];
  /** `secret` only, and mandatory there: where the value is written. */
  secret_key?: string;
}

export interface FormRequest {
  formId: string;
  runId: string;
  conversationId: string;
  title: string;
  /**
   * What this form is about, in prose, shown under the title. Some decisions
   * cannot be put in a field label — "should the assistant be allowed to use
   * these sixteen tools" needs the list in front of the person answering.
   */
  description?: string;
  template?: string;
  /**
   * Render this embed inside the form as a preview (App. D.5) — "should we
   * continue work on this?" is a different question when the *this* is in
   * front of the person answering.
   */
  embedId?: string;
  fields: FieldSpec[];
}

export type FormValues = Record<string, string | number>;

/**
 * What the suspended run gets back. `secrets` holds `${secret:KEY}` references
 * — never values (§19.2).
 */
export type FormOutcome =
  | { submitted: true; values: FormValues; secrets: Record<string, string> }
  | {
      submitted: false;
      reason: 'cancelled' | 'timeout' | 'no_channel' | 'confirm_interrupted';
    };

/** Whatever can render a form: a chat channel, in practice (App. D.5). */
export interface FormSink {
  send(type: string, payload: Record<string, unknown>): void;
}

interface Pending extends FormRequest {
  resolve(outcome: FormOutcome): void;
  timer: NodeJS.Timeout;
}

/** `KEY_SHAPED` — what a key in secrets.yaml is allowed to look like (G.6). */
export function secretKeySlug(text: string): string {
  return (
    text
      .normalize('NFKD')
      .replace(/[^A-Za-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .toUpperCase() || 'SECRET'
  );
}

export class FormRejected extends Error {
  constructor(readonly detail: string) {
    super(detail);
    this.name = 'FormRejected';
  }
}

/** The frame body for a pending form (App. D.2). Never carries a secret value. */
function frameOf(form: FormRequest): Record<string, unknown> {
  return {
    form_id: form.formId,
    run_id: form.runId,
    conversation_id: form.conversationId,
    title: form.title,
    ...(form.description ? { description: form.description } : {}),
    ...(form.template ? { template: form.template } : {}),
    ...(form.embedId ? { embed_id: form.embedId } : {}),
    fields: form.fields.map((f) => ({
      name: f.name,
      label: f.label,
      type: f.type,
      required: f.required !== false,
      ...(f.type !== 'secret' && f.value !== undefined ? { value: f.value } : {}),
      ...(f.options ? { options: f.options } : {}),
    })),
  };
}

/**
 * The form primitive (§19.1, App. D.5). A run summons a form, suspends on the
 * same machinery as the confirm round-trip, and resumes when the human submits
 * or cancels. Suspension is in-process state, like confirmations: the durable
 * record is the run row, and a restart fails whatever was waiting rather than
 * leaving it hanging (App. D.3).
 *
 * Secret-typed values stop here. They are written straight to
 * secrets/secrets.yaml and the run is handed `${secret:KEY}` references, so a
 * credential never reaches a turn, a trace, or a model prompt (§19.2).
 */
export class FormBroker {
  private readonly pending = new Map<string, Pending>();
  private readonly sinks = new Set<FormSink>();

  constructor(
    private readonly home: DataHome,
    /** Read at call time so a reload of the timeout actually takes effect. */
    private readonly config: Config,
  ) {}

  get waiting(): number {
    return this.pending.size;
  }

  /** How many devices could render a form right now. */
  get audience(): number {
    return this.sinks.size;
  }

  /**
   * Register a `forms`-capable channel. Anything already pending is re-sent to
   * it immediately — that is the "pending forms survive a reconnect" rule
   * (App. D.5), and the same code path serves a second device joining late.
   */
  attach(sink: FormSink): () => void {
    this.sinks.add(sink);
    for (const form of this.pending.values()) sink.send('form.request', frameOf(form));
    return () => this.sinks.delete(sink);
  }

  /** Summon a form and suspend until it is answered. */
  request(input: Omit<FormRequest, 'formId'>): Promise<FormOutcome> {
    if (!this.sinks.size) {
      l.warn({ run: input.runId }, 'no forms-capable channel connected');
      return Promise.resolve({ submitted: false, reason: 'no_channel' });
    }
    const formId = newId();
    const form: FormRequest = { ...input, formId };
    const frame = frameOf(form);

    return new Promise<FormOutcome>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(formId);
        l.warn({ form: formId, run: form.runId }, 'form timed out; treating as cancelled');
        resolve({ submitted: false, reason: 'timeout' });
      }, this.config.settings.formTimeoutS * 1000);
      timer.unref?.();
      this.pending.set(formId, { ...form, resolve, timer });
      for (const sink of this.sinks) sink.send('form.request', frame);
      l.info(
        { form: formId, run: form.runId, template: form.template ?? null },
        'form requested',
      );
    });
  }

  /**
   * First submit wins (App. D.5): the form is claimed before anything can
   * fail, so a slow disk cannot let a second device in.
   */
  submit(
    formId: string,
    raw: Record<string, unknown>,
  ): { ok: true } | { ok: false; error: string } {
    const form = this.pending.get(formId);
    if (!form) return { ok: false, error: 'not_found' };

    let split: { values: FormValues; secrets: Record<string, string> };
    try {
      split = this.split(form.fields, raw);
    } catch (e) {
      // Validation failures leave the form pending so the user can fix it.
      if (e instanceof FormRejected) return { ok: false, error: e.detail };
      throw e;
    }

    this.settle(formId, { submitted: true, ...split });
    l.info({ form: formId, run: form.runId }, 'form submitted');
    return { ok: true };
  }

  cancel(formId: string): { ok: true } | { ok: false; error: string } {
    const form = this.pending.get(formId);
    if (!form) return { ok: false, error: 'not_found' };
    this.settle(formId, { submitted: false, reason: 'cancelled' });
    l.info({ form: formId, run: form.runId }, 'form cancelled');
    return { ok: true };
  }

  /** Fail everything waiting — the process is going down (App. D.3). */
  interruptAll(): number {
    const count = this.pending.size;
    for (const form of this.pending.values()) {
      clearTimeout(form.timer);
      form.resolve({ submitted: false, reason: 'confirm_interrupted' });
    }
    this.pending.clear();
    if (count) l.warn({ count }, 'interrupted pending forms');
    return count;
  }

  private settle(formId: string, outcome: FormOutcome): void {
    const form = this.pending.get(formId);
    if (!form) return;
    this.pending.delete(formId);
    clearTimeout(form.timer);
    form.resolve(outcome);
  }

  /**
   * Split a submission by field type: secrets to disk, everything else to the
   * run. Validation is here rather than in the UI because the UI is not the
   * only possible client of a `form.submit` frame.
   */
  private split(
    fields: FieldSpec[],
    raw: Record<string, unknown>,
  ): { values: FormValues; secrets: Record<string, string> } {
    const values: FormValues = {};
    const secrets: Record<string, string> = {};
    const toWrite: Record<string, string> = {};

    // Two passes: a secret's target key may name another field, so everything
    // else has to be resolved first (see resolveSecretKey).
    for (const field of fields) {
      if (field.type === 'secret') continue;
      const text = this.text(field, raw);
      if (text === null) continue;

      if (field.type === 'number') {
        const n = Number(text);
        if (!Number.isFinite(n)) {
          throw new FormRejected(`${field.label || field.name} must be a number`);
        }
        values[field.name] = n;
        continue;
      }

      if (field.type === 'url') {
        try {
          new URL(text);
        } catch {
          throw new FormRejected(`${field.label || field.name} must be a URL`);
        }
      }

      if (
        (field.type === 'select' || field.type === 'choice' || field.type === 'voice') &&
        field.options?.length &&
        !field.options.includes(text)
      ) {
        throw new FormRejected(
          `${field.label || field.name} must be one of: ${field.options.join(', ')}`,
        );
      }

      values[field.name] = text;
    }

    for (const field of fields) {
      if (field.type !== 'secret') continue;
      const text = this.text(field, raw);
      if (text === null) continue;
      const key = resolveSecretKey(field, values);
      toWrite[key] = text;
      secrets[field.name] = `\${secret:${key}}`;
    }

    // Written before the run resumes, so `${secret:KEY}` resolves for whatever
    // the resumed run writes next.
    this.config.secretStore.merge(toWrite);
    if (Object.keys(toWrite).length) this.config.reload();
    return { values, secrets };
  }

  /** The submitted text, or null when an optional field was left blank. */
  private text(field: FieldSpec, raw: Record<string, unknown>): string | null {
    const supplied = raw[field.name];
    const text = supplied === undefined || supplied === null ? '' : String(supplied).trim();
    if (text) return text;
    if (field.required !== false) {
      throw new FormRejected(`${field.label || field.name} is required`);
    }
    return null;
  }
}

/**
 * Where a secret lands. `secret_key` may name other fields as `{field}`, which
 * is how a template gets a per-connector key out of a form the user can still
 * rename — resolved here, once, against what was actually submitted.
 */
function resolveSecretKey(field: FieldSpec, values: FormValues): string {
  const template = field.secret_key;
  if (!template) throw new FormRejected(`field ${field.name} has no secret_key`);
  const key = template.replace(/\{(\w+)\}/g, (_m, ref: string) => {
    const value = values[ref];
    if (value === undefined || value === '') {
      throw new FormRejected(`${field.label || field.name} needs ${ref} to be filled in first`);
    }
    return secretKeySlug(String(value));
  });
  if (!/^[A-Za-z0-9_.-]+$/.test(key)) {
    throw new FormRejected(`"${key}" is not a usable name for a stored secret`);
  }
  return key;
}
