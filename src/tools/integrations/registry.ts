import type { FieldSpec } from '../../chat/forms.js';

/**
 * How an integration comes to life (§19.5). Core facilities are `none` — always
 * on, nothing to configure. Everything credentialed ships dormant and is turned
 * on through a form, because a credential arriving any other way means it
 * passed through a model's context on the way in.
 */
export type Activation = 'none' | 'form' | 'oauth';

export interface IntegrationManifest {
  name: string;
  description: string;
  activation: Activation;
  /** The activation form (App. D.5); `form` and `oauth` only. */
  fields?: FieldSpec[];
  provides: {
    tools: string[];
    events?: string[];
    /** Whether activating it starts a background poller (§4.3). */
    source?: boolean;
  };
}

const core = (
  name: string,
  description: string,
  tools: string[],
  events?: string[],
): IntegrationManifest => ({
  name,
  description,
  activation: 'none',
  provides: { tools, ...(events ? { events } : {}) },
});

/**
 * Compiled in, like the base prompts: the registry describes what this build
 * can do, and `config/integrations.yaml` records what the user switched on.
 */
export const MANIFESTS: IntegrationManifest[] = [
  core('memory', "The assistant's own long-term memory.", [
    'memory.query',
    'memory.save',
    'memory.update',
    'memory.forget',
  ]),
  core(
    'files',
    'The shared workspace: notes, todo lists, drafts. Watched for markers.',
    [
      'files.list',
      'files.read',
      'files.write',
      'files.append',
      'files.edit',
      'files.search',
      'files.delete',
    ],
    ['file.request', 'file.changed'],
  ),
  core(
    'schedule',
    'Reminders and recurring work on the assistant’s own clock.',
    ['schedule.create', 'schedule.list', 'schedule.cancel'],
    ['timer.fired'],
  ),
  core('deliver', 'Desktop notifications, and approve/deny requests.', ['deliver.notify']),
  core('events', 'Emitting events onto the assistant’s own loop.', ['events.emit']),
  core('web', 'Web search, reading a page, and pulling named pieces out of one.', [
    'web.search',
    'web.fetch',
    'web.query',
  ]),
  core('weather', 'Forecasts from MET Norway, and place-name geocoding.', ['weather.forecast']),
  core('time', 'The current date and time, in any timezone.', ['time.now']),
  core('config', 'Reading and writing the assistant’s own configuration.', [
    'config.read',
    'config.write',
  ]),
  core('skills', 'Fetching the full text of a skill.', ['skills.fetch']),
  core(
    'embeds',
    'Rich content and mini-apps: LLM-authored HTML rendered in chat or served on its own link.',
    [
      'embeds.create',
      'embeds.edit',
      'embeds.read',
      'embeds.list',
      'embeds.write_state',
      'embeds.bind',
      'embeds.refresh',
      'embeds.promote',
      'embeds.delete',
    ],
    ['embed.action'],
  ),
  core('docs', 'PDFs: reading long ones page by page, and exporting embeds or notes as one.', [
    'docs.outline',
    'docs.read',
    'docs.to_pdf',
  ]),
  core('history', 'Search what was said in earlier conversations.', ['history.search']),
  core(
    'project',
    'Knowledge islands: a fenced set of files, memories and past discussions, loaded into a conversation on purpose.',
    ['project.load', 'project.create'],
  ),
  core('usage', 'What the language models have cost, by period and endpoint.', [
    'usage.summary',
  ]),
  core(
    'watch',
    'Watch something whose status changes — a package, a build — without spending a turn per look.',
    ['watch.create', 'watch.list', 'watch.cancel', 'watch.poll'],
    ['watch.changed', 'watch.failed'],
  ),
  core(
    'setup',
    // "Connecting a device" earns its place in a line that is paid for in every
    // prompt (§21.2): both device tools live behind this namespace, and a user
    // reading a pairing code off a phone (§24.4) has to reach one of them.
    'Forms, connectors, connecting a new device, and turning integrations on and off.',
    [
      'setup.form',
      'setup.list_integrations',
      'setup.activate',
      'setup.deactivate',
      'setup.token_create',
      'setup.pair_approve',
      'setup.rename',
      'setup.pricing',
    ],
  ),
  {
    name: 'asana',
    description:
      'Asana: read and triage the task inbox, comment, complete, and reschedule. Announces newly assigned tasks as events.',
    activation: 'form',
    fields: [
      {
        name: 'pat',
        label:
          'Asana personal access token (app.asana.com → Settings → Apps → Manage developer apps)',
        type: 'secret',
        secret_key: 'ASANA_PAT',
      },
      {
        name: 'poll_interval_s',
        label: 'How often to check the inbox, in seconds',
        type: 'number',
        required: false,
        value: 180,
      },
      {
        name: 'inbox_section',
        label: 'Which My Tasks section is the inbox',
        type: 'text',
        required: false,
        value: 'Inbox',
      },
      {
        name: 'daily_section',
        label: 'Where triaged work goes',
        type: 'text',
        required: false,
        value: 'Do today',
      },
    ],
    provides: {
      tools: [
        'asana.list_workspaces',
        'asana.list_sections',
        'asana.inbox',
        'asana.my_tasks',
        'asana.task_detail',
        'asana.triage',
        'asana.comment',
        'asana.complete_task',
        'asana.set_due_date',
        'asana.create_task',
      ],
      events: ['asana.inbox_item', 'asana.task_scheduled'],
      source: true,
    },
  },
  {
    name: 'google-calendar',
    description:
      'Google Calendar: read the day ahead, create and change events, and get told about upcoming ones.',
    activation: 'oauth',
    fields: [
      {
        name: 'client_id',
        label:
          'Google OAuth client ID — leave blank if one is already bundled with this install',
        type: 'text',
        required: false,
      },
      {
        name: 'client_secret',
        label: 'Google OAuth client secret — leave blank if one is already bundled',
        type: 'secret',
        required: false,
        secret_key: 'GOOGLE_CLIENT_SECRET',
      },
      {
        name: 'upcoming_lead_min',
        label: 'How many minutes ahead to announce an event',
        type: 'number',
        required: false,
        value: 15,
      },
    ],
    provides: {
      tools: [
        'calendar.list_events',
        'calendar.get_event',
        'calendar.next_event',
        'calendar.list_calendars',
        'calendar.create_event',
        'calendar.update_event',
        'calendar.delete_event',
        'calendar.respond',
      ],
      events: ['calendar.event_upcoming', 'calendar.event_changed'],
      source: true,
    },
  },
];

export function manifestFor(name: string): IntegrationManifest | null {
  return MANIFESTS.find((m) => m.name === name) ?? null;
}

/** Everything that ships dormant — what "what can you connect to" is about. */
export const CREDENTIALED_INTEGRATIONS = MANIFESTS.filter((m) => m.activation !== 'none').map(
  (m) => m.name,
);

/**
 * Tool namespace of an integration, which is also its key in the tool hub:
 * `google-calendar` serves `calendar.*`, so the two names differ and the
 * mapping has to come from somewhere.
 */
export function namespaceOf(manifest: IntegrationManifest): string {
  return manifest.provides.tools[0]?.split('.')[0] ?? manifest.name;
}

/**
 * The reverse of `namespaceOf`, for callers that start from a tool's namespace
 * rather than an integration name — the paging catalog, which knows only that
 * `calendar` is closed and needs a sentence describing it (§21.2.2).
 */
export function manifestForNamespace(namespace: string): IntegrationManifest | null {
  return MANIFESTS.find((m) => namespaceOf(m) === namespace) ?? null;
}
