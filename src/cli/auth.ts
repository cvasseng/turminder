import type { Command } from 'commander';
import { bootstrap } from '../app.js';
import { UserFacingError } from '../core/errors.js';
import { writeIntegrations } from '../core/config.js';
import { nowIso } from '../core/time.js';
import {
  authorizeGoogle,
  CALENDAR_READ_SCOPE,
  CALENDAR_SCOPES,
  GoogleTokenStore,
  loadGoogleCredentials,
} from '../tools/integrations/google/auth.js';
import {
  BUNDLE_FILENAME,
  bundlePath,
  readBundledClient,
  readEnvFile,
  writeBundledClient,
} from '../tools/integrations/google/bundled-client.js';
import { AsanaClient } from '../tools/integrations/asana/client.js';
import { globalOpts } from './common.js';

const out = (s: string) => process.stdout.write(`${s}\n`);

/** Authorising third-party accounts (phase 9). Tokens land in the secret store. */
export function registerAuthCommand(program: Command): void {
  const auth = program.command('auth').description('authorise external accounts');

  auth
    .command('google-client')
    .description(`bundle an OAuth client with the app (writes ${BUNDLE_FILENAME}, gitignored)`)
    .option('--id <client-id>', 'OAuth client id')
    .option('--secret <client-secret>', 'OAuth client secret')
    .option('--from <file>', 'read GOOGLE_CLIENT_ID/_SECRET out of a .env-style file')
    .option('--show', 'report which client is currently bundled')
    .action((opts: { id?: string; secret?: string; from?: string; show?: boolean }) => {
      if (opts.show) {
        const current = readBundledClient();
        out(
          JSON.stringify(
            current
              ? { bundled: true, source: current.source, client_id: current.clientId }
              : { bundled: false, expected_at: bundlePath() },
            null,
            2,
          ),
        );
        return;
      }
      let clientId = opts.id;
      let clientSecret = opts.secret;
      if (opts.from) {
        const fromFile = readEnvFile(opts.from);
        if (!fromFile) {
          throw new UserFacingError(
            'google_client_not_found',
            `no *GOOGLE_CLIENT_ID / *GOOGLE_CLIENT_SECRET pair in ${opts.from}`,
          );
        }
        clientId ??= fromFile.clientId;
        clientSecret ??= fromFile.clientSecret;
      }
      if (!clientId || !clientSecret) {
        throw new UserFacingError(
          'bad_option',
          'need --id and --secret, or --from <.env file>',
          'this is the Node equivalent of baking the client in at build time: the ' +
            'file is gitignored and read at startup',
        );
      }
      const file = writeBundledClient(clientId, clientSecret);
      out(`bundled OAuth client written to ${file} (chmod 600, gitignored)`);
      out('`turminder auth google` will now work without any console setup');
    });

  auth
    .command('google')
    .description('run the loopback OAuth flow for Google Calendar')
    .option('--force', 're-authorise even if a token already exists')
    .option('--read-only', 'ask only for read access, no calendar writes')
    .action(async (opts: { force?: boolean; readOnly?: boolean }, cmd: Command) => {
      const app = bootstrap(globalOpts(cmd));
      try {
        const store = new GoogleTokenStore(app.config);
        if (store.load() && !opts.force) {
          out('already authorised — pass --force to replace the stored token');
          return;
        }
        const credentials = loadGoogleCredentials(app.home, app.config.secrets);
        out(`using OAuth client from ${credentials.source}`);
        const scopes = opts.readOnly ? [CALENDAR_READ_SCOPE] : CALENDAR_SCOPES;
        out(`requesting: ${scopes.join(' ')}`);
        const token = await authorizeGoogle({ credentials, scopes });
        store.save(token);
        out('\nauthorised — refresh token stored in the secret store (GOOGLE_OAUTH_TOKEN)');

        // The documented path is "set up google calendar" in chat (§19.5); this
        // command is the headless fallback, so it writes the same record.
        const doc = app.config.integrations();
        if (!doc.integrations['google-calendar']?.active) {
          writeIntegrations(
            app.home,
            {
              integrations: {
                ...doc.integrations,
                'google-calendar': {
                  active: true,
                  activated_at: nowIso(),
                  settings: doc.integrations['google-calendar']?.settings ?? {},
                },
              },
            },
            'auth: activate google calendar',
          );
          out('google-calendar marked active in config/integrations.yaml');
        }
        if (opts.readOnly) {
          out(
            'read-only: calendar writes will report missing_scope until you re-run without --read-only',
          );
        }
      } finally {
        app.close();
      }
    });

  auth
    .command('google-status')
    .description('report whether Google Calendar is authorised')
    .action((_opts, cmd: Command) => {
      const app = bootstrap(globalOpts(cmd));
      try {
        const token = new GoogleTokenStore(app.config).load();
        let credentials: string | null = null;
        try {
          credentials = loadGoogleCredentials(app.home, app.config.secrets).source;
        } catch {
          credentials = null;
        }
        const bundled = readBundledClient();
        out(
          JSON.stringify(
            {
              oauth_client: credentials,
              bundled_client: bundled?.clientId ?? null,
              authorised: token !== null,
              scope: token?.scope ?? null,
              can_write: (token?.scope ?? '').includes('/auth/calendar.events'),
              obtained_at: token?.obtained_at ?? null,
            },
            null,
            2,
          ),
        );
      } finally {
        app.close();
      }
    });

  auth
    .command('asana-check')
    .description('verify the Asana personal access token works')
    .action(async (_opts, cmd: Command) => {
      const app = bootstrap(globalOpts(cmd));
      try {
        const pat = app.config.secrets.ASANA_PAT;
        if (!pat) {
          throw new UserFacingError(
            'asana_pat_missing',
            'no ASANA_PAT in the secret store',
            'add it by connecting Asana from chat ("set up asana") — a form writes it wherever this install keeps secrets (§27)',
          );
        }
        const client = new AsanaClient({ pat });
        const me = await client.me();
        out(
          JSON.stringify(
            {
              ok: true,
              user: me.name,
              email: me.email ?? null,
              workspaces: me.workspaces?.map((w) => ({ gid: w.gid, name: w.name })) ?? [],
            },
            null,
            2,
          ),
        );
      } finally {
        app.close();
      }
    });
}
