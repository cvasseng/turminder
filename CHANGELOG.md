 # Next

 * Prebuilt downloads: every release carries the desktop app for Linux (x64
   and arm64), macOS (Apple silicon) and Windows, the packaged browser
   extensions, and a `SHA256SUMS` to check them against — plus a rolling
   `nightly` prerelease built from `main`.

 * Fixed: the built service (`npm run build` + `npm start`, and the systemd
   unit over it) served no interface — the chat page, setup page, styles and
   vendored browser libraries all came back as errors, while `npm run dev`
   was fine.

 # 1.0.0

 Initial public release.
