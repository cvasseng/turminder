# The Linux toolchain for the desktop shell (§28.3).
#
# The app is a packaging tier: it consumes built service artifacts and never
# the other way round, so its toolchain is recorded here rather than in the
# service's package.json — `nix-shell app/` is the whole setup step, and a
# machine without nix is a machine that builds the service just fine and skips
# the app.
{ pkgs ? import <nixpkgs> { } }:

let
  # The Node runtime that goes *into the bundle* (§28.4), and deliberately the
  # official nodejs.org build rather than nixpkgs'. A nix-built node carries its
  # ELF interpreter as a /nix/store path, so a `.deb` shipping one would run on
  # this box and nowhere else — the same trap AppImage fell into (LIMITS.md).
  # Hash-pinned, so it is as reproducible as anything else in this shell.
  bundledNodeVersion = "22.22.3";
  bundledNode = pkgs.fetchurl {
    url = "https://nodejs.org/dist/v${bundledNodeVersion}/node-v${bundledNodeVersion}-linux-x64.tar.xz";
    sha256 = "2e5d13569282d016861fae7c8f935e741693c269101a5bebcf761a5376d1f99f";
  };
in

pkgs.mkShell {
  name = "turminder-app";

  nativeBuildInputs = with pkgs; [
    cargo
    rustc
    rustfmt
    clippy
    pkg-config
    cargo-tauri
    # Staging the sidecar (§28.4) needs npm for a production-only install and
    # xz to unpack the pinned runtime. The *service* still never learns this
    # directory exists — nothing here runs in the repo root's node_modules.
    nodejs_22
    xz
    # Cross-staging the Windows bundle reads a .zip, which GNU tar refuses; the
    # Windows runner's own tar is bsdtar and needs neither of these.
    unzip
    curl
    # `tauri dev` reloads the window; without this the webview cannot find its
    # own GIO modules and every https:// request fails silently.
    wrapGAppsHook3
  ];

  buildInputs = with pkgs; [
    webkitgtk_4_1
    gtk3
    libsoup_3
    librsvg
    openssl
    glib-networking
    libayatana-appindicator # the tray icon (§28.2)
    # The token at rest (§28.2). The keyring crate talks to the Secret
    # Service over D-Bus directly rather than through libsecret, so this is
    # libdbus — the vault itself is whatever daemon owns
    # `org.freedesktop.secrets` on the machine.
    dbus
    # Microphone and speaker (§28.6). `cpal` links `alsa-sys` through
    # pkg-config on Linux; PipeWire and PulseAudio are reached through ALSA's
    # own compatibility layer, so this one library covers all three.
    alsa-lib
  ];

  # WebKit picks its rendering path from the environment; software rendering is
  # the one that works everywhere, including a VM with no GPU.
  shellHook = ''
    export WEBKIT_DISABLE_COMPOSITING_MODE=1
    export GIO_MODULE_DIR="${pkgs.glib-networking}/lib/gio/modules"
    export XDG_DATA_DIRS="${pkgs.gsettings-desktop-schemas}/share/gsettings-schemas/${pkgs.gsettings-desktop-schemas.name}:${pkgs.gtk3}/share/gsettings-schemas/${pkgs.gtk3.name}:$XDG_DATA_DIRS"
    # The tray crate dlopens libayatana-appindicator3 by soname at startup, so
    # linking against it is not enough — on nix there is no global lib dir to
    # find it in, and without this the app dies before it reaches the tray. A
    # .deb installed on a normal distro gets it from the package's Depends.
    export LD_LIBRARY_PATH="${pkgs.libayatana-appindicator}/lib:$LD_LIBRARY_PATH"
    # Where `stage-service.sh` finds the runtime it puts in the bundle.
    export TURMINDER_APP_NODE_TARBALL="${bundledNode}"
    export TURMINDER_APP_NODE_VERSION="${bundledNodeVersion}"
  '';
}
