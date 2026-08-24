import http from 'node:http';
import type { AddressInfo } from 'node:net';

export interface FakeGoogleEvent {
  id: string;
  summary?: string;
  description?: string;
  location?: string;
  status?: string;
  updated?: string;
  start?: { dateTime?: string; date?: string; timeZone?: string };
  end?: { dateTime?: string; date?: string; timeZone?: string };
  attendees?: { email?: string; responseStatus?: string; self?: boolean }[];
  recurringEventId?: string;
  htmlLink?: string;
}

/** Google's calendar API and token endpoint, enough of them to test against. */
export class FakeGoogle {
  private server: http.Server | null = null;
  readonly requests: {
    method: string;
    path: string;
    query: Record<string, string>;
    body: any;
  }[] = [];
  events: FakeGoogleEvent[] = [];
  calendars = [{ id: 'primary', summary: 'Alex', primary: true }];
  /** Scope string returned by the token endpoint. */
  tokenScope =
    'https://www.googleapis.com/auth/calendar.readonly https://www.googleapis.com/auth/calendar.events';
  nextId = 1;

  async start(): Promise<string> {
    this.server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c as Buffer));
      req.on('end', () => {
        const url = new URL(req.url ?? '/', 'http://localhost');
        const raw = Buffer.concat(chunks).toString('utf8');
        let body: any = raw;
        try {
          body = raw.startsWith('{')
            ? JSON.parse(raw)
            : Object.fromEntries(new URLSearchParams(raw));
        } catch {
          /* leave raw */
        }
        this.requests.push({
          method: req.method ?? 'GET',
          path: url.pathname,
          query: Object.fromEntries(url.searchParams.entries()),
          body,
        });
        const json = (status: number, payload: unknown) => {
          res.writeHead(status, { 'content-type': 'application/json' });
          res.end(JSON.stringify(payload));
        };

        if (url.pathname === '/token') {
          return json(200, {
            access_token: 'fake-access-token',
            refresh_token: 'fake-refresh-token',
            expires_in: 3600,
            scope: this.tokenScope,
          });
        }
        if (url.pathname === '/calendar/v3/users/me/calendarList') {
          return json(200, { items: this.calendars });
        }
        const eventsPath = /^\/calendar\/v3\/calendars\/([^/]+)\/events$/.exec(url.pathname);
        if (eventsPath && req.method === 'GET') {
          return json(200, { items: this.events });
        }
        if (eventsPath && req.method === 'POST') {
          const created: FakeGoogleEvent = {
            id: `created-${this.nextId++}`,
            updated: new Date().toISOString(),
            ...body,
          };
          this.events.push(created);
          return json(200, created);
        }
        const oneEvent = /^\/calendar\/v3\/calendars\/([^/]+)\/events\/([^/]+)$/.exec(
          url.pathname,
        );
        if (oneEvent && req.method === 'GET') {
          const existing = this.events.find((e) => e.id === oneEvent[2]);
          if (!existing) return json(404, { error: 'not found' });
          return json(200, existing);
        }
        if (oneEvent && req.method === 'PATCH') {
          const existing = this.events.find((e) => e.id === oneEvent[2]);
          if (!existing) return json(404, { error: 'not found' });
          Object.assign(existing, body, { updated: new Date().toISOString() });
          return json(200, existing);
        }
        if (oneEvent && req.method === 'DELETE') {
          this.events = this.events.filter((e) => e.id !== oneEvent[2]);
          res.writeHead(204).end();
          return;
        }
        return json(404, { error: 'no route' });
      });
    });
    await new Promise<void>((r) => this.server!.listen(0, '127.0.0.1', r));
    return `http://127.0.0.1:${(this.server!.address() as AddressInfo).port}`;
  }

  async stop(): Promise<void> {
    const s = this.server;
    this.server = null;
    if (s) await new Promise<void>((r) => s.close(() => r()));
  }
}

/** Rewrites googleapis.com and oauth2.googleapis.com to the fake server. */
export function googleFetch(base: string): typeof globalThis.fetch {
  return (async (input: any, init?: any) => {
    const url = new URL(String(input instanceof URL ? input : (input.url ?? input)));
    const path = url.hostname.startsWith('oauth2') ? '/token' : url.pathname;
    return globalThis.fetch(new URL(path + url.search, base), init);
  }) as unknown as typeof globalThis.fetch;
}
