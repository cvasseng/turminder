 # Next

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

 * Fixed: exporting a PDF could hang until it timed out and produce nothing.
   Chromium was retrying a Google push-service registration in the
   background, which held the render open; it now does no background
   networking at all, so an export reaches your own service and nowhere else.

 * Prebuilt downloads: every release carries the desktop app for Linux (x64
   and arm64), macOS (Apple silicon) and Windows, the packaged browser
   extensions, and a `SHA256SUMS` to check them against — plus a rolling
   `nightly` prerelease built from `main`. Linux x64 comes as both a `.deb`
   and a portable AppImage that needs nothing installed.

 * Fixed: the built service (`npm run build` + `npm start`, and the systemd
   unit over it) served no interface — the chat page, setup page, styles and
   vendored browser libraries all came back as errors, while `npm run dev`
   was fine.

 # 1.0.0

 Initial public release.
