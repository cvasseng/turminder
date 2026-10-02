//! The tray menu and its icon (§28.2, §28.6).
//!
//! Everything voice can be switched from here and nowhere else: shell settings
//! are deliberately not reachable from chat (§33.5) — the daemon is
//! display-and-ack (§14.3), and the server does not flip switches on a client
//! machine. So the tray is the whole control surface, and it has to be
//! complete.

use tauri::image::Image;
use tauri::menu::{CheckMenuItem, Menu, MenuItem, Submenu};
use tauri::tray::TrayIconId;

use crate::audio;
use crate::voice::State;
use crate::voice_settings::{self, VoiceSettings};

pub const TRAY_ID: &str = "turminder";

/// Menu ids. Device submenus carry the device name after a prefix, because a
/// menu id is the only thing a click hands back.
pub const ID_QUICKNOTE: &str = "quick-note";
pub const ID_FILES: &str = "files-folder";
pub const ID_VOICE: &str = "voice";
pub const ID_TALK: &str = "talk";
pub const ID_WAKE: &str = "wake";
pub const ID_ENROL: &str = "wake-enrol";
pub const ID_QUIET: &str = "quiet";
pub const ID_CONNECT: &str = "connect-other";
pub const ID_RESET: &str = "reset-setup";
pub const ID_SHOW: &str = "show";
pub const ID_QUIT: &str = "quit";
pub const INPUT_PREFIX: &str = "input:";
pub const OUTPUT_PREFIX: &str = "output:";
/// The first entry of both device submenus: whatever the system says.
pub const SYSTEM_DEFAULT: &str = "System default";

/// Build the whole menu against the settings as they are now.
///
/// Rebuilt rather than mutated on every change: a checkbox, a device list and
/// a greyed-out item all have to agree with one file, and rebuilding is the
/// only way that cannot drift. The lists are short and this runs on a click.
pub fn build(
    app: &tauri::AppHandle,
    settings: &VoiceSettings,
    state: State,
    connected: bool,
    has_mode: bool,
) -> tauri::Result<Menu<tauri::Wry>> {
    // Heads the menu, above *Talk to it* (§28.7): a box that accepts text it
    // cannot send would lose that text, so it is greyed rather than opened
    // whenever this shell has nothing to send it to — the tray tooltip says
    // why.
    let quick_note = MenuItem::with_id(app, ID_QUICKNOTE, "Quick note…", connected, None::<&str>)?;
    // Under *Quick note…*, in both modes (§28.8): `~/Turminder` when connected
    // elsewhere, the store itself when it is on this disk. Greyed only before
    // a mode is chosen, when there is no folder to name.
    let files = MenuItem::with_id(app, ID_FILES, "Open files folder", has_mode, None::<&str>)?;
    let voice =
        CheckMenuItem::with_id(app, ID_VOICE, "Voice", true, settings.enabled, None::<&str>)?;
    // Straight into a turn, no key and no name (§28.6) — and the way out of
    // one, because a menu click has no release to let go of and nothing else
    // on screen says the microphone is open. One item, two jobs, because they
    // are the same button in every state.
    let talking = state == State::Listening;
    let talk = MenuItem::with_id(
        app,
        ID_TALK,
        if talking {
            "Stop listening"
        } else {
            "Talk to it"
        },
        // Greyed rather than silently switching the microphone on: turning
        // voice on is the checkbox directly above, and a menu item that
        // started listening from off would be doing two things, one of which
        // nobody asked for.
        settings.enabled && (talking || state == State::Idle),
        None::<&str>,
    )?;

    // Enrolment is what makes the wake word available (§28.6, V7); until then
    // the checkbox is grey and the submenu says why rather than simply not
    // working.
    let enrolled = voice_settings::wakeword_path(app)
        .map(|p| p.exists())
        .unwrap_or(false);
    let wake = Submenu::with_id(app, "wake-menu", "Wake word", true)?;
    let listen_label = match (&settings.wake_phrase, enrolled) {
        (Some(phrase), true) => format!("Listen for \"{phrase}\""),
        (_, true) => "Listen for my name".to_string(),
        _ => "Listen for my name (not enrolled)".to_string(),
    };
    wake.append(&CheckMenuItem::with_id(
        app,
        ID_WAKE,
        listen_label,
        enrolled && settings.enabled,
        settings.wake_word && enrolled,
        None::<&str>,
    )?)?;
    wake.append(&MenuItem::with_id(
        app,
        ID_ENROL,
        if enrolled { "Re-enrol…" } else { "Enrol…" },
        true,
        None::<&str>,
    )?)?;
    let quiet = CheckMenuItem::with_id(
        app,
        ID_QUIET,
        "Quiet mode",
        true,
        settings.quiet,
        None::<&str>,
    )?;

    let inputs = device_submenu(
        app,
        "Input device",
        INPUT_PREFIX,
        &audio::list_inputs(),
        settings.input_device.as_deref(),
    )?;
    let outputs = device_submenu(
        app,
        "Output device",
        OUTPUT_PREFIX,
        &audio::list_outputs(),
        settings.output_device.as_deref(),
    )?;

    let connect = MenuItem::with_id(
        app,
        ID_CONNECT,
        "Connect to another instance…",
        true,
        None::<&str>,
    )?;
    // The way back to the welcome, named for what a person is trying to do
    // (§28.1). Without it the only route was deleting the data dir, which does
    // not work — the mode lives in the app's config dir, not the data dir, so
    // the reset half-succeeds and lands on the service's model form (Christer,
    // 2026-08-30).
    let reset = MenuItem::with_id(
        app,
        ID_RESET,
        "Change where Turminder runs…",
        true,
        None::<&str>,
    )?;
    let show = MenuItem::with_id(app, ID_SHOW, "Show Turminder", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, ID_QUIT, "Quit", true, None::<&str>)?;

    Menu::with_items(
        app,
        &[
            &quick_note,
            &files,
            &voice,
            &talk,
            &wake,
            &quiet,
            &inputs,
            &outputs,
            &connect,
            &reset,
            &show,
            &quit,
        ],
    )
}

/// One submenu per direction: the system default, then what cpal enumerated,
/// with the remembered one checked (§28.6).
fn device_submenu(
    app: &tauri::AppHandle,
    label: &str,
    prefix: &str,
    devices: &[String],
    chosen: Option<&str>,
) -> tauri::Result<Submenu<tauri::Wry>> {
    let submenu = Submenu::with_id(app, format!("{prefix}menu"), label, true)?;
    let default = CheckMenuItem::with_id(
        app,
        prefix.to_string(),
        SYSTEM_DEFAULT,
        true,
        chosen.is_none(),
        None::<&str>,
    )?;
    submenu.append(&default)?;
    for name in devices {
        let item = CheckMenuItem::with_id(
            app,
            format!("{prefix}{name}"),
            name,
            true,
            chosen == Some(name.as_str()),
            None::<&str>,
        )?;
        submenu.append(&item)?;
    }
    if devices.is_empty() {
        // An empty submenu looks broken; saying so does not.
        let none = MenuItem::with_id(
            app,
            format!("{prefix}none"),
            "no devices found",
            false,
            None::<&str>,
        )?;
        submenu.append(&none)?;
    }
    Ok(submenu)
}

/// Which device a submenu click chose. `Some(None)` is "the system default";
/// `None` means the id was not a device item at all.
pub fn device_choice(id: &str, prefix: &str) -> Option<Option<String>> {
    let rest = id.strip_prefix(prefix)?;
    if rest == "menu" || rest == "none" {
        return None;
    }
    Some(if rest.is_empty() {
        None
    } else {
        Some(rest.to_string())
    })
}

/// Re-render the tray: the menu, the icon, and the tooltip that says what the
/// shell is doing and which microphone it would use.
pub fn refresh(
    app: &tauri::AppHandle,
    state: State,
    settings: &VoiceSettings,
    connected: bool,
    has_mode: bool,
    note: Option<&str>,
) {
    let Some(tray) = app.tray_by_id(&TrayIconId::new(TRAY_ID)) else {
        return;
    };
    if let Ok(menu) = build(app, settings, state, connected, has_mode) {
        let _ = tray.set_menu(Some(menu));
    }
    if let Some(icon) = state_icon(app, state, settings.quiet) {
        let _ = tray.set_icon(Some(icon));
    }
    let _ = tray.set_tooltip(Some(tooltip(state, settings, connected, note)));
}

fn tooltip(state: State, settings: &VoiceSettings, connected: bool, note: Option<&str>) -> String {
    let idle = match (settings.wake_word, settings.wake_phrase.as_deref()) {
        // The trained phrase, so "why is it not hearing me" has an answer the
        // tray can give (§28.6, V7.4).
        (true, Some(phrase)) => format!("Turminder — listening for \"{phrase}\""),
        (true, None) => "Turminder — listening for its name".to_string(),
        (false, _) => "Turminder — listening for the hotkey".to_string(),
    };
    let mut line = match (settings.enabled, settings.quiet, state) {
        (false, _, _) => "Turminder — voice off".to_string(),
        (true, true, _) => "Turminder — quiet".to_string(),
        (true, false, State::Idle) => idle,
        (true, false, State::Listening) => "Turminder — listening".to_string(),
        (true, false, State::Uploading) => "Turminder — thinking".to_string(),
        (true, false, State::Speaking) => "Turminder — speaking".to_string(),
    };
    if !connected {
        // The only way *Quick note…* explains its own greyed state (§28.7):
        // muda's `MenuItem` carries no per-item tooltip, so the reason rides
        // the tray icon's one tooltip, same as the input-device fallback note
        // below does.
        line.push('\n');
        line.push_str("Quick note needs a working connection");
    }
    if let Some(note) = note {
        line.push('\n');
        line.push_str(note);
    }
    line
}

/// The five icon variants (§28.6), tinted from the app's own icon rather than
/// checked in as five PNGs: the derived ones cannot drift from the artwork, and
/// the shell needs no image decoder to make them.
fn state_icon(app: &tauri::AppHandle, state: State, quiet: bool) -> Option<Image<'static>> {
    let base = app.default_window_icon()?;
    let tint = match state.icon(quiet) {
        // Grey: nothing is happening, and the tray should be furniture.
        "idle" => None,
        "listening" => Some((0x3B, 0xC9, 0x5A)),
        "thinking" => Some((0xF2, 0xB0, 0x2C)),
        "speaking" => Some((0x4A, 0x9E, 0xFF)),
        _ => Some((0x8A, 0x8A, 0x8A)),
    };
    Some(badge(base, tint).to_owned())
}

/// A dot in the bottom-right quarter, over a copy of the icon.
///
/// Pure pixel arithmetic on RGBA, no crate: a state badge is a filled circle,
/// and pulling in an image library to draw one would be a dependency for a
/// dozen lines (App. J).
fn badge(base: &Image<'_>, tint: Option<(u8, u8, u8)>) -> Image<'static> {
    let (w, h) = (base.width(), base.height());
    let mut rgba = base.rgba().to_vec();
    let Some((r, g, b)) = tint else {
        return Image::new(&rgba, w, h).to_owned();
    };
    // A quarter of the shorter side, in the corner, one pixel inside the edge.
    let radius = (w.min(h) as f32 * 0.22).max(3.0);
    let cx = w as f32 - radius - 1.0;
    let cy = h as f32 - radius - 1.0;
    for y in 0..h {
        for x in 0..w {
            let dx = x as f32 + 0.5 - cx;
            let dy = y as f32 + 0.5 - cy;
            let distance = (dx * dx + dy * dy).sqrt();
            if distance > radius {
                continue;
            }
            // One pixel of feathering, so the dot is not a staircase.
            let alpha = ((radius - distance).min(1.0) * 255.0) as u8;
            let at = ((y * w + x) * 4) as usize;
            if at + 3 >= rgba.len() {
                continue;
            }
            let mix = |under: u8, over: u8| {
                ((over as u16 * alpha as u16 + under as u16 * (255 - alpha) as u16) / 255) as u8
            };
            rgba[at] = mix(rgba[at], r);
            rgba[at + 1] = mix(rgba[at + 1], g);
            rgba[at + 2] = mix(rgba[at + 2], b);
            rgba[at + 3] = rgba[at + 3].max(alpha);
        }
    }
    Image::new(&rgba, w, h).to_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_device_click_says_which_device_or_the_default() {
        assert_eq!(
            device_choice("input:Yeti Nano", INPUT_PREFIX),
            Some(Some("Yeti Nano".to_string()))
        );
        // The empty tail is the "System default" row.
        assert_eq!(device_choice("input:", INPUT_PREFIX), Some(None));
        // The submenu header and the placeholder are not choices.
        assert_eq!(device_choice("input:menu", INPUT_PREFIX), None);
        assert_eq!(device_choice("input:none", INPUT_PREFIX), None);
        // And an output click is not an input click.
        assert_eq!(device_choice("output:Speakers", INPUT_PREFIX), None);
        assert_eq!(
            device_choice("output:Speakers", OUTPUT_PREFIX),
            Some(Some("Speakers".to_string()))
        );
    }

    #[test]
    fn a_device_name_with_a_colon_in_it_survives_the_round_trip() {
        // ALSA names them like `alsa_output.pci-0000_00:1f.3` — the prefix is
        // stripped once, so everything after it is the name.
        let id = format!("{OUTPUT_PREFIX}alsa_output.pci-0000_00:1f.3");
        assert_eq!(
            device_choice(&id, OUTPUT_PREFIX),
            Some(Some("alsa_output.pci-0000_00:1f.3".to_string()))
        );
    }

    #[test]
    fn the_tooltip_says_what_the_shell_is_doing() {
        let off = VoiceSettings::default();
        assert!(tooltip(State::Idle, &off, true, None).contains("voice off"));
        let on = VoiceSettings {
            enabled: true,
            ..Default::default()
        };
        assert!(tooltip(State::Listening, &on, true, None).contains("listening"));
        assert!(tooltip(State::Speaking, &on, true, None).contains("speaking"));
        let quiet = VoiceSettings {
            enabled: true,
            quiet: true,
            ..Default::default()
        };
        // Quiet wins over the state, the way the icon does.
        assert!(tooltip(State::Speaking, &quiet, true, None).contains("quiet"));

        // Enrolled: the tooltip says the phrase, so "why is it not hearing me"
        // has an answer the tray can give (§28.6, V7.4).
        let enrolled = VoiceSettings {
            enabled: true,
            wake_word: true,
            wake_phrase: Some("Sleeper Service".into()),
            ..Default::default()
        };
        let idle = tooltip(State::Idle, &enrolled, true, None);
        assert!(idle.contains("Sleeper Service"), "{idle}");
        // A note — "input device X not found, using default" (§28.6) — rides
        // on a second line rather than replacing the state.
        let noted = tooltip(State::Idle, &on, true, Some("input device Yeti not found"));
        assert!(noted.contains("listening for the hotkey"), "{noted}");
        assert!(noted.contains("Yeti"), "{noted}");
    }

    #[test]
    fn the_tooltip_explains_a_missing_connection() {
        // §28.7: *Quick note…* is greyed with no working connection, and
        // muda's `MenuItem` has no per-item tooltip — so the reason has to
        // ride the one the tray icon already has.
        let settings = VoiceSettings::default();
        let disconnected = tooltip(State::Idle, &settings, false, None);
        assert!(disconnected.contains("Quick note"), "{disconnected}");
        let connected = tooltip(State::Idle, &settings, true, None);
        assert!(!connected.contains("Quick note"), "{connected}");
    }

    #[test]
    fn the_badge_tints_a_corner_and_leaves_the_rest_alone() {
        // 32x32, the size the shell's tray icon actually is.
        let base_rgba = vec![255u8; 32 * 32 * 4];
        let base = Image::new(&base_rgba, 32, 32);
        let tinted = badge(&base, Some((255, 0, 0)));
        let out = tinted.rgba();
        // Top-left is untouched artwork…
        assert_eq!(&out[0..4], &[255, 255, 255, 255]);
        // …and the dot, whose centre is inset from the very corner so the
        // circle is not clipped by the edge, is red.
        let dot = ((24 * 32 + 24) * 4) as usize;
        assert!(
            out[dot] == 255 && out[dot + 1] < 128,
            "the badge should be reddened, got {:?}",
            &out[dot..dot + 4]
        );
        // The dot stays in its quarter: the middle of the icon is artwork.
        let middle = ((16 * 32 + 16) * 4) as usize;
        assert_eq!(&out[middle..middle + 4], &[255, 255, 255, 255]);

        // No tint is the icon, byte for byte — idle must not be a redraw.
        let plain = badge(&base, None);
        assert_eq!(plain.rgba(), base_rgba.as_slice());
    }

    #[test]
    fn the_badge_is_never_bigger_than_a_quarter_of_the_icon() {
        // Tinted pixels, counted: a dot that covers the artwork is not a badge.
        let base_rgba = vec![255u8; 32 * 32 * 4];
        let base = Image::new(&base_rgba, 32, 32);
        let tinted = badge(&base, Some((0, 0, 0)));
        let changed = tinted
            .rgba()
            .chunks_exact(4)
            .filter(|px| px[0] != 255)
            .count();
        assert!(changed > 40, "an invisible badge is not a badge: {changed}");
        assert!(
            changed < 32 * 32 / 4,
            "the badge is eating the icon: {changed}"
        );
    }
}
