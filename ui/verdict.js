/**
 * Why a socket closed — decided by asking, never by inferring (§24.4). On its
 * own file so the one decision that can destroy a credential is directly
 * testable, the same argument that gave `greeting.js`, `preview.js` and
 * `connect.js` theirs (JUDGMENT.md, 2026-08-22).
 *
 * A WebSocket handshake's HTTP status is not exposed to script: a refused
 * upgrade, a TCP reset, a dead server and a phone with a cold radio all reach
 * `onclose` as a bare 1006. So the socket cannot say whether the token was the
 * problem, and the question has to be put over plain HTTP — where the status is
 * visible — carrying the token itself. `/api/whoami` is the pairing probe
 * (§29.5, App. E) and answers exactly this.
 *
 * Three answers, and `unknown` is the one that matters. This used to ask
 * `/healthz`, which needs no token and therefore cannot distinguish "the
 * upgrade was refused" from "the socket failed while the network was still
 * coming back" — the probe necessarily runs a moment *after* the failure, so a
 * service restart or a phone waking from sleep both look like a refusal. Every
 * such blink deleted a working token and cost a re-pairing the user could not
 * tell was not their fault. Only a 401 to a request that actually carried the
 * token is evidence against the token; everything else means keep trying.
 */
async function tokenVerdict(value) {
  const t = (value || '').trim();
  // Nothing to test is not the same as tested and refused, but both send the
  // caller to the gate, and the gate is what asks for a token.
  if (!t) return 'rejected';
  let res;
  try {
    res = await fetch('/api/whoami', {
      cache: 'no-store',
      headers: { authorization: `Bearer ${t}` },
    });
  } catch {
    // Unreachable: the most common reason a socket just failed, and the least
    // likely to be about the token.
    return 'unknown';
  }
  // The only definitive answer. 403 is deliberately not one: it would mean the
  // token authenticated and was then denied something, which is not a reason
  // to throw it away.
  if (res.status === 401) return 'rejected';
  // 200 proves the token good, so the socket failed for another reason. A 5xx
  // or anything else proves nothing either way — a server that is unhealthy
  // enough to fail this is not a server whose word to take on credentials.
  return res.ok ? 'ok' : 'unknown';
}
