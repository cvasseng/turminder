 # Next

 * Fixed: the browser extension could never pair on Firefox. **Connect this
   browser** said it could not reach the gateway and asked whether the service
   was running, about a service that was running and answering — it had asked
   Firefox for access to a URL with the port left on, which Firefox accepts and
   then matches nothing with, so the pairing calls were blocked inside the
   browser before they were ever sent. Chromium was unaffected.

 * Setup lets you choose which of an endpoint's models to use, instead of
   silently taking whichever one it listed first. Picking one re-probes it,
   so the capabilities shown are the ones that get written down.

 * Fixed: tool calling did not work against Anthropic or OpenAI at all, and
   setup reported those models as having no tool support. Both reject a dot in
   a tool name, and every Turminder tool is named `namespace.verb`; names now
   cross the wire in a form they accept and arrive back unchanged. Handlers,
   grants and anything you have already written are untouched.

 * Setup checks whether your endpoint can make embeddings and ticks the box
   for you when it can, saying how wide the vectors are (and what the endpoint
   said when it cannot) — instead of guessing
   from a built-in list of which providers have an embeddings API. The key
   now travels with that setting, so semantic search works on a hosted
   provider rather than failing on the first index build.

 * Fixed: setting up an Anthropic endpoint failed with a 401 on a valid API
   key — the model list is served from Anthropic's own API, which wants the
   key in a different header than the chat endpoint does.

 * PDF export does no background networking, so it reaches your own service
   and nowhere else. If a print does overrun its minute it now says it timed
   out, instead of reporting that chromium finished and wrote nothing —
   chromium exits cleanly when asked to stop, which made a hung export look
   like a completed one. Some chromium builds hang on any headless command,
   whatever they are asked to print; where that happens the export times out
   and tells you so, and a chromium from your distribution is the fix.

 * Prebuilt downloads: every release carries the desktop app for Linux (x64
   and arm64), macOS (Apple silicon) and Windows, the packaged browser
   extensions, and a `SHA256SUMS` to check them against — plus a rolling
   `nightly` prerelease built from `main`. Linux x64 comes as both a `.deb`
   and a portable AppImage that needs nothing installed. The macOS build is
   ad-hoc signed rather than notarized, until there is a Developer ID to sign
   it with — so macOS refuses it on first open and calls it damaged, which it
   is not. The notes beside the download say so, and give the two ways
   through: **System Settings → Privacy & Security → Open Anyway**, or
   `xattr -dr com.apple.quarantine`. Control-clicking the app and choosing
   *Open* is not one of them; Apple removed that in macOS Sequoia. The Firefox
   extension ships as a Mozilla-signed `.xpi` you can install and keep, rather
   than a zip Firefox will only hold onto until you restart it — signed for
   self-distribution, so it is not listed on addons.mozilla.org and updates
   come from here.

 * Fixed: the built service (`npm run build` + `npm start`, and the systemd
   unit over it) served no interface — the chat page, setup page, styles and
   vendored browser libraries all came back as errors, while `npm run dev`
   was fine.

 # 1.0.0

 Initial public release.
