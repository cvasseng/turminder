import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * What the chat UI is allowed to conclude from a socket that closed (§24.4).
 *
 * This is the one client decision that can destroy a credential, and it used to
 * be a guess: the UI asked the token-less `/healthz` whether the server was up
 * and, if it was, deleted the device token. A WebSocket handshake's status is
 * not visible to script, so "the socket never opened and the server answers" was
 * standing in for "the token was refused" — and it is also what a service
 * restart and a phone waking from sleep look like, because the probe runs a
 * moment *after* the failure. Every such blink cost a re-pairing, which is how
 * one install accumulated `phone` through `phone-5`.
 *
 * `ui/` has no build step and no module system, so the file boundary is the
 * test seam and `verdict.js` exists to be this suite's subject — the same
 * argument `preview.js` and `connect.js` settled (JUDGMENT.md, 2026-08-22).
 */
const root = path.resolve(import.meta.dirname, '..');
const read = (rel: string): string => fs.readFileSync(path.join(root, rel), 'utf8');

type Verdict = 'ok' | 'rejected' | 'unknown';
type Reply = { status: number; ok?: boolean } | Error;

/** Evaluate `verdict.js` against a stub `fetch` and record what it asked. */
function load(replies: Reply | Reply[]): {
  verdict: (value: string | null) => Promise<Verdict>;
  calls: { url: string; init: { headers: Record<string, string> } }[];
} {
  const calls: { url: string; init: { headers: Record<string, string> } }[] = [];
  const scope = {
    fetch: (url: string, init: { headers: Record<string, string> }) => {
      calls.push({ url, init });
      // One reply per call, the last repeating: the second look a 401 earns
      // can be scripted to answer differently from the first.
      const list = Array.isArray(replies) ? replies : [replies];
      const reply = list[Math.min(calls.length - 1, list.length - 1)]!;
      if (reply instanceof Error) return Promise.reject(reply);
      return Promise.resolve({ status: reply.status, ok: reply.ok ?? reply.status < 400 });
    },
  };
  const body = `${read('ui/verdict.js')}; return tokenVerdict;`;
  const raw = new Function(...Object.keys(scope), body)(...Object.values(scope)) as (
    value: string | null,
    confirmDelayMs?: number,
  ) => Promise<Verdict>;
  // No real pause between the two looks: the delay is a production concern,
  // and what the suite pins is how many looks it takes.
  const verdict = (value: string | null) => raw(value, 0);
  return { verdict, calls };
}

describe('the UI asks about a token rather than inferring (§24.4)', () => {
  it('only a 401 to a request that carried the token condemns it', async () => {
    const { verdict, calls } = load({ status: 401 });
    expect(await verdict('tok-abc')).toBe('rejected');
    // Asked the probe, and asked it *with* the token — a token-less question
    // cannot produce this answer, which is the whole point of the endpoint.
    // Twice: one refusal is not enough to destroy a credential.
    expect(calls).toHaveLength(2);
    for (const call of calls) {
      expect(call.url).toBe('/api/whoami');
      expect(call.init.headers.authorization).toBe('Bearer tok-abc');
    }
  });

  it('keeps a token that was refused once and accepted on the second look', async () => {
    // The live failure: a check that read the device file mid-write, or hit a
    // service still booting, answered 401 to a working token, and the page
    // deleted it and asked to be paired again. A second look a moment later
    // gets the truth.
    const { verdict, calls } = load([{ status: 401 }, { status: 200 }]);
    expect(await verdict('tok-abc')).toBe('ok');
    expect(calls).toHaveLength(2);
  });

  it('keeps a token when the second look cannot reach the server', async () => {
    const { verdict } = load([{ status: 401 }, new TypeError('Failed to fetch')]);
    expect(await verdict('tok-abc')).toBe('unknown');
  });

  it('asks only once when the first answer is not a refusal', async () => {
    const { calls } = load({ status: 200 });
    const again = load({ status: 200 });
    await again.verdict('tok-abc');
    expect(again.calls).toHaveLength(1);
    expect(calls).toHaveLength(0);
  });

  it('clears a good token for nothing, given the chance', async () => {
    // 200: the token is provably fine, so the socket failed for its own
    // reasons. This is the regression — it used to come back "rejected".
    const { verdict } = load({ status: 200 });
    expect(await verdict('tok-abc')).toBe('ok');
  });

  it('treats an unreachable server as unknown, not as a refusal', async () => {
    // Exactly the phone-waking-from-sleep case: the socket failed and the probe
    // cannot get out either. Nothing here is evidence about the token.
    const { verdict } = load(new TypeError('Failed to fetch'));
    expect(await verdict('tok-abc')).toBe('unknown');
  });

  it('takes no server’s word on a credential while it is unhealthy', async () => {
    for (const status of [500, 502, 503, 504]) {
      const { verdict } = load({ status });
      expect(await verdict('tok-abc'), `${status} proves nothing either way`).toBe('unknown');
    }
    // 403 authenticated and was then denied something else; that is not a
    // reason to throw a token away.
    const { verdict } = load({ status: 403 });
    expect(await verdict('tok-abc')).toBe('unknown');
  });

  it('does not go asking when there is nothing to ask about', async () => {
    for (const empty of [null, '', '   ']) {
      const { verdict, calls } = load({ status: 200 });
      expect(await verdict(empty)).toBe('rejected');
      expect(calls, 'no token means no request').toHaveLength(0);
    }
  });
});

describe('and the caller cannot get back to guessing', () => {
  const app = read('ui/app.js');

  it('deletes the token only on a verdict, never on a health check', () => {
    // One removal in the reconnect path, and it is guarded by the verdict.
    expect(app).toContain("if (verdict === 'rejected') {");
    // The old instrument is gone: /healthz cannot answer this question, and a
    // second opinion that can be wrong is how the bug got in.
    expect(app).not.toContain('serverIsUp');
    // /healthz survives for the one thing it can answer without a token —
    // whether *any* device is linked, which is what the gate leads with — and
    // that is the only place it may appear.
    const health = [...app.matchAll(/\/healthz/g)];
    expect(health, 'the reconnect path must not consult /healthz').toHaveLength(2);
    expect(app.slice(app.indexOf('async function noDeviceIsLinked'))).toContain("'/healthz'");
    // And the probe is not re-implemented here.
    expect(app).not.toContain("fetch('/api/whoami'");
  });

  it('a stale close handler cannot delete the token a newer socket is using', () => {
    // `onclose` awaits the probe, and a pasted token or a claimed pairing can
    // start a new socket in that gap; the generation check is what keeps the
    // old handler from clearing the new credential.
    expect(app).toContain('const generation = ++state.generation;');
    expect(app).toContain('if (generation !== state.generation) return;');
    const guard = app.indexOf('if (generation !== state.generation) return;');
    const remove = app.indexOf('localStorage.removeItem(TOKEN_KEY);', guard);
    expect(guard, 'the guard must come before the removal it protects').toBeGreaterThan(0);
    expect(remove).toBeGreaterThan(guard);
  });

  it('is loaded by the page, before the script that calls it', () => {
    const html = read('ui/index.html');
    expect(html).toContain('<script src="/verdict.js"></script>');
    expect(html.indexOf('/verdict.js')).toBeLessThan(html.indexOf('/app.js'));
  });
});
