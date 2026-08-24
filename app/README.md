# The Turminder desktop shell (§28)

A Tauri window around a Turminder service. To the service it is just another
App. D device holding a device token (§24); to the person using it, it is the
whole product.

**Linux first.** Only the Linux bundle is built and run. The shell's
OS-specific code — where data lives, what the runtime is called, how a child is
made to die with its parent — is confined to `src/platform.rs`, and the macOS
and Windows arms of it have **never been compiled**: a nix box carries the
Linux `std` and no other, so `cargo check --target` cannot reach them. Treat
those arms as a reviewed first draft that the first CI run on each platform
will correct. The signing and notarization story of §28.4 belongs with the
macOS build and lands with it.

## Building

The toolchain is nix (`shell.nix` here), not npm — the service's
`package.json` never learns this directory exists (§28.3):

```sh
npm run build              # in the repo root: the app bundles built artifacts
cd app
nix-shell                  # rust, the tauri CLI, node, webkitgtk, gtk, dbus…
node stage-service.mjs     # assemble the sidecar, and smoke-test it
cargo tauri dev            # a window, either mode
cargo tauri build          # a .deb in src-tauri/target/release/bundle
cd src-tauri && cargo test # the pure logic: URLs, layout, supervision
```

A machine without nix builds the service fine and skips the app.

`stage-service.mjs` is what makes bundled mode possible: it unpacks the
hash-pinned Node runtime named in `node-runtime.json`, copies `dist/` and
`ui/`, installs production dependencies from the repo lockfile into its own
tree — never the repo's — and then refuses to finish unless the assembled
service answers both `/healthz` and `/`. That last probe earns its keep: `ui/`
is outside the tsc output, so a bundle built from `dist/` alone is healthy and
completely blank. The result lands in `src-tauri/service/` (~280MB, gitignored)
and `tauri.conf.json` ships it as a bundle resource.

It is Node rather than a shell script so that one implementation covers all
three platforms. `--target darwin-arm64` (or `darwin-x64`, `win32-x64`)
cross-stages: the archive is downloaded and checksummed, and `npm ci` is told
which platform's optional native packages to resolve, so you can confirm the
packaging works for another OS from here. It will not smoke-test what it cannot
run, and says so — a shipped artifact is staged on its own platform.

**Windows on ARM is not buildable** as things stand: `sqlite-vec` publishes no
`windows-arm64` package, so `x64` is the only Windows target.

To drive bundled mode without building a `.deb`, point the shell at the
staging tree directly: `TURMINDER_APP_SERVICE_DIR=$PWD/src-tauri/service`.
Nothing in a shipped app sets that variable.

**No AppImage.** Tauri builds one by shelling out to `linuxdeploy`, which
downloads its own binaries and expects an FHS system; on nix it chokes on the
store paths in the linker flags before it starts. The `.deb` is the artifact,
and a nix user runs `nix-shell` + `cargo tauri dev` anyway.

## Modes

Both live. Which one this install is lives in
`<app_config_dir>/mode.json` — shell state, never service config — and no
choice yet is what makes the first screen a chooser.

- **Bundled mode**: the shell runs the service itself. It mints its own
  device token with `token create app`, claims a free localhost port, spawns
  the pinned runtime against `$XDG_DATA_HOME/turminder`, waits for
  `/healthz`, and supervises it from there — `supervisor.rs` decides
  restart-vs-backoff-vs-give-up, `sidecar.rs` does it. The child cannot
  outlive the shell by any exit path: `PR_SET_PDEATHSIG` covers the signals
  and crashes that never reach a Quit handler, which is why every spawn is
  made from the one long-lived supervisor thread — the kernel ties that
  guarantee to the forking *thread*, not the process. Quit escalates
  SIGTERM to SIGKILL so SQLite closes cleanly.
- **Connect mode**: point it at a service that is already running — ask
  the assistant to connect this computer, paste the link it answers with
  (or mint one with `turminder token create <device> --qr` on a server not
  yet onboarded) and the window becomes the chat UI. The token is stored in the OS vault (the
  Secret Service on Linux), never in a file — so the box needs a secrets
  daemon: gnome-keyring, kwallet or the like. Without one, Connect reports
  a D-Bus error rather than storing a token that would not survive the next
  reboot. Connect links must be `http://` for now; the whoami probe is
  hand-written and does not speak TLS.

Bundled mode is the one place the shell degrades rather than refusing: with
no vault it mints a fresh token each launch instead of failing, because a
bundled install is somebody's only copy of their assistant and has to open
(§28.2).

## What the shell itself does

Everything else is the service's own UI, loaded over HTTP:

- keeps the connection (`store.rs`) and proves it with `/api/whoami` before
  saving it;
- holds its own WS connection as a `notify.actions` device, so a reminder
  arrives natively with the window closed (`device.rs`);
- a tray icon, and close ≠ quit;
- an autostart toggle, off by default.
