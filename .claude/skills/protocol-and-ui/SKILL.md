---
name: protocol-and-ui
description: Rules for the WS frame protocol, HTTP API, channel sessions, daemon transport, and the chat UI. Read before touching src/net/, daemon/, ui/, adding or changing a frame type, an HTTP route, a delivery shape, or any UI feature. The protocol has a spec catalog (App. D/E) — frames are added there first, never invented in code.
---

# Protocol & UI (spec App. D, App. E, §7, §9, §19)

The WS protocol is a **cataloged contract** shared by three consumers: the
chat UI, the desktop daemon (over WS *and* over the in-process transport),
and tests. The failure mode this skill exists to stop: inventing frame
variants in code ("I'll just add a `chat.info` frame") that two of the
three consumers don't know about.

## Frames

1. **App. D is written first.** A new frame type or payload field gets its
   row in D.1/D.2 (or D.3/D.5 shapes) in the same commit as the code. No
   spec row, no frame.
2. Envelope is always `{id, type, payload}` — ULID per frame, sender-
   assigned. Unknown frame types are answered with `error` and ignored
   (forward compatibility) — never crash, never silently drop.
3. **Know your frame's durability class before writing it.** Outboxed
   deliveries (`delivery` — replayed via `last_seen` cursor, TTL'd,
   acked) vs transient stream frames (`chat.delta`, `chat.activity`,
   `form.request` — never persisted; reconnect re-derives:
   `chat.history` for turns, pending-form re-send for forms). Putting
   state the client can't re-fetch into a transient frame is a bug; so is
   outboxing high-frequency stream data.
4. Frame handling lives in `ChannelSession` (`net/session.ts`), which both
   transports drive — `ws.ts` owns only sockets, upgrade auth, and
   heartbeats; the in-process daemon pipe (D.4) is the same session code.
   A feature that works over WS but not bundled mode means you put logic
   in the wrong layer.
5. Capabilities gate frames: send `form.request` only to `forms`-capable
   devices, notifications to `notify.actions`, etc. Check the `hello`
   capability set; don't broadcast everything to everyone.
6. Secrets flow (§19.2): secret-typed form values are split server-side in
   the session/forms layer — they never reach tool results or traces. Any
   new input path for credentials must route through the same split; if
   you're handling a token anywhere else in `net/`, stop.

## HTTP

- Routes are cataloged in App. E. Auth: bearer device token for `/api/*`;
  `/healthz` and the static UI are open. New routes get an App. E row and
  a token check — there is no third auth model.
- `POST /api/events` is the generic ingress — before adding a bespoke
  endpoint for some new input, check whether it's just an event.

## UI (ui/)

- **It's a terminal, not a product** (plan, phase 3): vanilla JS/HTML/CSS,
  zero build step, served by the service. No frameworks, no bundlers, no
  npm UI deps — that's a spec-level decision, not a style preference.
- The UI talks WS only (plus the one-time token entry); it re-derives on
  reconnect (`chat.history`, `conversation.list`, `last_seen` replay) —
  never treat the DOM as the source of truth across reconnects.
- Render `turns.text` (display transcript). Never render `context_text` —
  that artifact belongs to the model (§20.2).
- Streamed activity lines (`chat.activity`) are dim/inline and transient;
  tool-call lines stick. Match the existing rendering in `ui/app.js`
  rather than inventing a parallel presentation.

## Daemon

- The daemon is display-and-ack only (§14.3) — no execute capability, and
  the server must never be able to grant itself one. Anything that smells
  like "run this on the client" is a spec change, not a feature.
- Same frames both transports (D.4); if you need transport-specific
  behavior, you've drawn the layer boundary wrong.

## Tests

`test/net.test.ts`, `test/egress.test.ts`, `test/forms.test.ts` drive real
`ChannelSession`s over fake transports. New frames get: a happy-path test,
an unknown-payload rejection test, and — for anything durable — a
reconnect/replay test. The forms secret-split has sentinel coverage;
extend it for any new secret-bearing frame.
