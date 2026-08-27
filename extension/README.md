# Turminder capture (§29)

A WebExtension that sends the page you are looking at to your assistant, with
a note saying what you want done with it. It is the **deliberate** ingestion
path: you open the thing, you click, you read the exact bytes that will
travel, you say what you want, you send. No standing mail poller reads your
inbox on your behalf.

**Send-only.** It emits one event and renders nothing back — the answer
arrives wherever your deliveries already go: the chat UI, the desktop app, a
notification.

## Installing

No bundler, no store listing — but one assembly step, because the two
browsers want different `background` keys and Firefox only ever reads a file
literally named `manifest.json` (about:debugging lets you pick any file and
then ignores your choice). So:

```
npm run build:extensions
```

writes `dist/extension/chrome/` and `dist/extension/firefox/`, each with the
right manifest under the right name, plus a
`turminder-capture-<version>-<browser>.zip` of each. Then:

- **Chromium**: `chrome://extensions` → Developer mode → *Load unpacked* →
  `dist/extension/chrome` (loading `extension/` itself also works — it *is*
  the chrome layout).
- **Firefox**: `about:debugging` → This Firefox → *Load Temporary Add-on* →
  pick any file in `dist/extension/firefox` (or the firefox zip). Temporary
  add-ons go away on restart; that is the v1 install story (§29.6).

A fresh, unpaired install opens the options page for you (and the popup
points there instead of capturing until a token is stored). Say where the
assistant lives and press **Connect this browser**: the page shows a short
code, a prompt appears on a device that is already linked, and approving it
there lets this browser in — no token to carry across (§24.4). Under *other
ways in*, for the install with no second screen to approve on: paste the
connect link your assistant answers with, or fill the gateway and token in
by hand (on a server you have not onboarded yet, `turminder token create
browser --qr` in the terminal mints such a link).

Every path ends the same way: the page asks the browser for access to that
one gateway URL, proves the token against `/api/whoami`, and only then
stores it. The device is revocable on its own like any other (§24.1) — revoke it and
the next capture fails with an auth error, and nothing else does.

## What it can read

`activeTab`, `scripting`, `storage`, and an *optional* host permission for
your gateway. That is the whole security story and it is normative (§29.1):
**there is no standing access to any site.** The extension cannot read a page
until you invoke it on that page, that one time. A change that adds broad host
permissions is wrong by definition, and a test asserts the permission lists.

The gateway's host permission is declared optional over `http://*/*` and
`https://*/*` because your gateway can be anywhere; the grant actually
*requested* is the single host you configured. Chromium will not let an
extension request an origin it never declared, so the declaration is wide and
the grant is narrow.

The port is deliberately not in that grant. Ports are outside the match-pattern
grammar Chromium and Firefox share — Firefox calls such a pattern granted and
then matches nothing with it, which used to leave pairing failing as though the
service were down — so the grant is the host, every port on it.

## Matchers — and why there are none yet

Extraction is driven by JSON matchers in `matchers/` (`index.json` names them
in claim order, each one its own file). A matcher claims a page only if every
field in its `require` list extracts something; nothing claims, and the
capture falls back to the page's full text with the badge saying so.

**v1 ships zero matchers, so everything falls back to full text.** The
Gmail and Proton matchers described in §29.2 are not here yet: writing
selectors against a client whose class names are minified, without real DOM in
front of us, ships a matcher that silently mis-extracts — which is the exact
failure the claim/fallback design exists to prevent. Full text on a mail page
therefore includes the sidebar and message list along with the message. It is
noisy, the preview shows you the noise before you send it, and your note is
still the instruction.

Adding them later is data, not code: drop `gmail.json` beside `index.json` and
add its name to the list.

## Layout

| File | What it is |
|---|---|
| `engine.js` | the matcher engine — the only file with logic worth testing |
| `content.js` | injected beside the engine; reads the page, returns a payload |
| `background.js` | injects, holds the token, POSTs `/api/events` |
| `popup.*` | the preview, the note field, Send |
| `options.*` | pairing (§29.5) |
| `matchers/` | the matcher data |
| `build.mjs` | per-browser assembly + zip (`npm run build:extensions`) |

`engine.js` is a classic script with no imports or exports, because two hosts
run it and neither is a bundler: the browser injects it, and vitest reads it
off disk (`test/capture-matchers.test.ts`) — §29.6's one sanctioned
cross-boundary read, so the matchers keep a single source of truth. Two rules
follow: **`var` and `function` only** (re-injection redeclares everything), and
**no DOM beyond `querySelectorAll` / `textContent` / `getAttribute`** (cheerio
has to be able to stand in for a browser).

## Testing

`npx vitest run test/capture-matchers.test.ts` — the engine against a synthetic
DOM, plus the two agreements the boundary needs: that the extension's copy of
the App. A caps still equals the service's, and that the two manifests differ
in exactly one key. Deleting this directory skips that suite by name and
leaves the rest of the service green (§29.6).

## Known rough edges

- **No icons.** The browser draws its default puzzle piece.
- **The preview is plain text.** An HTML email's layout is gone by the time
  you see it, which is the point — you are approving what the model reads, not
  what the page renders.
