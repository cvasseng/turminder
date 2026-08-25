# Running it

Beyond the quick start in the [README](../README.md): keeping the service
alive, reaching it from other machines, and building the clients yourself.

## Prerequisites

Node 22 or newer, and any OpenAI-compatible endpoint, which can be a locally
served model or a hosted provider whose key you paste into setup. Handling
tool calls well matters more than parameter count: development and testing
run against a locally served Qwen3.8-27B, which is what the context rules are
tuned against. Git is optional; without it everything works except the change
history over your files.

## The data directory

Everything the assistant knows lives in `~/.turminder`, overridable with
`--data-dir` or `TURMINDER_DATA_DIR`. It is a git repo of markdown plus
`events.db`. Back it up by copying the folder, and move installs the same
way.

## Optional commands

```sh
npm run daemon             # desktop notifications on another machine (WS, token auth)
npm run app:build          # the Linux desktop app (needs nix; see app/README.md)
npm run build:extensions   # the browser extension, per browser under dist/extension/
npm test                   # 54 test files
npm run typecheck
npm run lint
```

## Prebuilt downloads

Desktop apps and packaged browser extensions are attached to the rolling
[`nightly` prerelease](https://github.com/cvasseng/turminder/releases) built
from `main`, with a `SHA256SUMS` file to check them against. Linux gets a
`.deb` and a portable AppImage, macOS a `.dmg`, and Windows an installer. The
macOS artifact is unsigned and says so.

## Staying up across reboots

A systemd user unit ships in `contrib/systemd/`. Run `npm run build`, copy
the unit to `~/.config/systemd/user/`, point its `WorkingDirectory` at your
clone, and:

```sh
systemctl --user enable --now turminder
```

The header comments in the unit cover starting at boot and the headless
secret backends.

## Connecting another device

Open the chat on the phone, or the extension's options page, and press
**connect this device**. It shows a short code, and a dialog appears on a
device that is already linked carrying the same code and a field for what to
call the new one. Check that the codes match, name it, approve. Nothing to
type or scan, and the assistant never sees the token.

Two other directions work:

- Ask the assistant to connect a device and it answers with a one-time link
  and QR code.
- If no screen is free to show a prompt, say "connect this device, the code
  is K7M-P42" and it approves that way.

The CLI is for a headless first run, before anything is connected, which is
the one moment there is nobody to ask:

```sh
npx tsx src/index.ts token create phone --qr
```

## Reaching it over a LAN

Set `bind: 0.0.0.0:7787` in `~/.turminder/config/turminder.yaml` and put it
behind Tailscale or WireGuard. Device tokens are the only gate and traffic is
plain HTTP. Set `gateway.public_url` to the address other devices should use,
or the QR codes guess it from your interfaces.
