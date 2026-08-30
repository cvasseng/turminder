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
On a shell that cannot reach an assistant the window opens on the **welcome
screen**: the two choices above, and nothing else. "Cannot reach" means a fresh
install, a connect-mode shell whose stored connection has gone, **or a
bundled-mode shell whose data dir has been deleted** — that last one because
deleting the data dir is what people do to start over, and the shell has to
agree that they did.

Which is worth being explicit about, because the two directories are not the
same and it is the one thing that catches everybody:

| What | Where |
|---|---|
| The assistant's data (bundled mode) | `$XDG_DATA_HOME/turminder`, i.e. `~/.local/share/turminder` |
| The shell's own state — mode, voice settings, wake word | `$XDG_CONFIG_HOME/com.turminder.app` |

Two tray items reach the welcome without touching either: **Connect to another
instance…** goes straight to the connect form, and **Change where Turminder
runs…** forgets the mode and shows both choices again. Neither deletes any
data; the connect screen offers "Run it here instead" to go back the other way,
and a stored connection survives either switch, so coming back to a server you
already paired with does not mean scanning the QR again.

Both of those navigate to the shell's **own** origin by absolute URL, captured
from the window at startup. That is not a detail: once the window has loaded
the service's UI, a relative `index.html` resolves against the *service* and
lands on its chat page — which looks precisely like a tray item that does
nothing, and was, until 2026-08-30.

- **Connect mode**: point it at a service that is already running — ask
  the assistant to connect this computer, paste the link it answers with
  (or mint one with `turminder token create <device> --qr` on a server not
  yet onboarded) and the window becomes the chat UI. The token is stored in the
  OS vault (the Secret Service on Linux), **never in a file**. On a box with no
  keyring — a minimal window manager, a NixOS install nobody enabled
  gnome-keyring on, a session over SSH — it connects anyway and holds the
  connection in memory for that run only, says so on the screen, and asks for
  the link again next launch. Run gnome-keyring, KWallet or KeePassXC to make
  it stick. Connect links must be `http://` for now; the whoami probe is
  hand-written and does not speak TLS.

Neither mode refuses over a missing vault: bundled mints a fresh token each
launch, connect keeps this run's in memory. Both write no credential to disk,
which is the rule the vault is there to keep — putting the token in a config
file is the thing these degradations exist instead of (§28.2).

## Voice

The shell is the first voice device (§28.6, §33): it has a microphone, a
speaker, a Rust core holding the device token, and it sits on the desk all
day. Everything about it is **off until you turn it on**, and everything
about it is shell state — `<app_config_dir>/voice.json`, the `mode.json`
precedent. The service cannot switch any of it: the assistant can tell you
where the tray menu is, and that is the whole of its involvement.

Turn it on with **Voice** in the tray. Then:

- **Push-to-talk**: hold `Ctrl+Shift+Space`, say something, let go. The
  release is the end of the utterance — no silence detection, the fastest
  path. A small overlay follows the turn — listening, what it heard, working,
  answering — because a reply you only hear is a reply you cannot check, and
  the transcript appears within a fraction of a second rather than at the end.
- **Talk to it** in the tray does the same thing without the key or the wake
  word — the trigger that works before you have enrolled anything, and on a
  machine where something else already owns the hotkey. It stops listening
  when you stop talking; the same item says **Stop listening** while it is,
  and clicking that sends nothing.
- **Wake word** (opt-in, on-device): **Wake word ▸ Enrol…** asks you to say
  the assistant's own name five times, then once more to check. That trains a
  small template with `rustpotter` — pure Rust, no model download, no
  language, so a Norwegian name works as well as an English one. Nothing you
  record is written down; only the template is. After it fires you get a
  chime, it listens until you stop talking, and for eight seconds after the
  reply you can ask a follow-up without saying the name again.
- **Input device ▸ / Output device ▸** list what the machine actually has and
  remember your choice by name. A device that has been unplugged falls back
  to the system default and the tray tooltip says so, rather than listening
  to nothing.
- **Quiet mode** is do-not-disturb for the whole shell: no notifications, no
  spoken deliveries, no chime. Anything that arrives while it is on is
  **held, not acked** — it comes back, in order, when you switch quiet off,
  unless it expired in the meantime. The hotkey still works: pressing it is
  the opposite of being disturbed.
- **Spoken deliveries**: with voice on and quiet off, a notification is shown
  natively *and* read aloud — the sentence is the server's composition, asked
  for by id (`POST /api/speak`), never text this shell wrote.

Containment, and it is worth being precise: audio lives in memory for the
length of one utterance and is written nowhere. Before a trigger fires
nothing leaves the machine — the detector runs here and the stream is
discarded. After it, exactly one WAV goes to `POST /api/voice` over the same
bearer connection everything else uses. The OS microphone indicator is never
suppressed.

Voice works identically in both modes. Connect mode is the interesting one:
it puts the model on the box with the GPU and the microphone on the desk.

Four crates carry it, and no others (§28.6, App. J): `cpal` (capture),
`rodio` (playback), `rustpotter` (the wake word),
`tauri-plugin-global-shortcut` (push-to-talk). On Linux they need
`alsa-lib`, which `shell.nix` provides — PipeWire and PulseAudio are reached
through ALSA's own compatibility layer.

## What the shell itself does

Everything else is the service's own UI, loaded over HTTP:

- keeps the connection (`store.rs`) and proves it with `/api/whoami` before
  saving it;
- holds its own WS connection as a `notify.actions` device — and a `voice`
  one when the microphone is on — so a reminder arrives natively with the
  window closed (`device.rs`);
- the microphone, the speaker and the wake word (`audio.rs`, `voice.rs`,
  `wake.rs`), none of which the webview ever touches;
- a tray icon that says what it is doing, and close ≠ quit;
- an autostart toggle, off by default.
