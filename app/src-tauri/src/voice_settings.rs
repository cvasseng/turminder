//! What this shell does with its microphone (§28.6).
//!
//! Shell state, never service config — the `mode.rs` precedent of §28.1,
//! applied to the other thing the service must never be able to flip on a
//! client machine (§33.5). A plain file in `app_config_dir` rather than a
//! vault entry: none of it is a secret, and voice has to work on a box with no
//! secrets daemon.
//!
//! Everything here defaults to **off**. A shell that starts listening because
//! it was updated is a shell nobody trusts.

use std::path::PathBuf;

use tauri::Manager;

/// The push-to-talk chord, when nobody has chosen one (§28.6).
///
/// `Ctrl+Shift+Space` because it is the least likely three-key combination to
/// already mean something: space alone is typing, `Ctrl+Space` is an input
/// method on half the desktops in the world, and adding Shift clears both.
pub const DEFAULT_HOTKEY: &str = "Ctrl+Shift+Space";

/// Wake-word sensitivity, 0..1. Rustpotter's own scale; higher accepts more.
const DEFAULT_SENSITIVITY: f32 = 0.5;

#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(default)]
pub struct VoiceSettings {
    /// Off until somebody turns it on. Push-to-talk and the wake word both
    /// hang off this; the `voice` hello capability follows it (§28.6, V8.1).
    pub enabled: bool,
    /// The wake word additionally needs a trained model on disk; this is the
    /// switch, not the enrolment (§28.6, V7).
    pub wake_word: bool,
    /// Do-not-disturb for the whole shell: no notifications, no speech, no
    /// chime. The hotkey still works — pressing it is the opposite of being
    /// disturbed.
    pub quiet: bool,
    /// Remembered **by name**, because a device index is whatever the machine
    /// enumerated last boot. `None` is the system default.
    pub input_device: Option<String>,
    pub output_device: Option<String>,
    pub hotkey: String,
    pub sensitivity: f32,
    /// The phrase the trained model listens for — the instance's own name at
    /// the moment of enrolment (§28.6). Kept here rather than read back out of
    /// the model, so the tray can say it without loading one, and so a rename
    /// after enrolment is visible as a disagreement rather than hidden.
    pub wake_phrase: Option<String>,
}

impl Default for VoiceSettings {
    fn default() -> Self {
        Self {
            enabled: false,
            wake_word: false,
            quiet: false,
            input_device: None,
            output_device: None,
            hotkey: DEFAULT_HOTKEY.to_string(),
            sensitivity: DEFAULT_SENSITIVITY,
            wake_phrase: None,
        }
    }
}

impl VoiceSettings {
    /// Is the shell allowed to make a sound right now? Quiet mode silences
    /// chimes and spoken deliveries; it does not silence a reply the user
    /// asked for by holding the hotkey.
    pub fn may_chime(&self) -> bool {
        self.enabled && !self.quiet
    }
}

fn file(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("voice.json"))
}

/// Where a trained wake-word model lives (§28.6, V7.2). Beside the settings,
/// because it is the same kind of thing: shell state this machine owns.
pub fn wakeword_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("wakeword.rpw"))
}

/// The settings as they are on disk, or the defaults.
///
/// A file that will not parse is a file from a future version, or one somebody
/// edited badly; either way the defaults are safe — everything off — and
/// refusing to start over a settings file would be the worse failure.
pub fn load(app: &tauri::AppHandle) -> VoiceSettings {
    let Ok(path) = file(app) else {
        return VoiceSettings::default();
    };
    std::fs::read_to_string(path)
        .ok()
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_default()
}

pub fn save(app: &tauri::AppHandle, settings: &VoiceSettings) -> Result<(), String> {
    let path = file(app)?;
    let raw = serde_json::to_string_pretty(settings).map_err(|e| e.to_string())?;
    std::fs::write(path, raw).map_err(|e| e.to_string())
}

/// Read, change one thing, write — the shape every tray toggle wants.
pub fn update(
    app: &tauri::AppHandle,
    change: impl FnOnce(&mut VoiceSettings),
) -> Result<VoiceSettings, String> {
    let mut settings = load(app);
    change(&mut settings);
    save(app, &settings)?;
    Ok(settings)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trips_through_json_by_name() {
        // Written by one version of the shell and read by the next, so the
        // wire form is names — the `mode.rs` rule (§28.1).
        let settings = VoiceSettings {
            enabled: true,
            wake_word: true,
            quiet: false,
            input_device: Some("Yeti Nano".into()),
            output_device: None,
            hotkey: "Ctrl+Alt+V".into(),
            sensitivity: 0.7,
            wake_phrase: Some("Sleeper Service".into()),
        };
        let raw = serde_json::to_string(&settings).unwrap();
        assert!(raw.contains(r#""input_device":"Yeti Nano""#), "{raw}");
        assert!(raw.contains(r#""output_device":null"#), "{raw}");
        assert_eq!(
            serde_json::from_str::<VoiceSettings>(&raw).unwrap(),
            settings
        );
    }

    #[test]
    fn a_file_from_an_older_shell_keeps_its_settings_and_defaults_the_rest() {
        // `#[serde(default)]` is what makes adding a field a non-event: a
        // voice.json written before `sensitivity` existed must not reset the
        // hotkey somebody chose.
        let old: VoiceSettings =
            serde_json::from_str(r#"{"enabled":true,"hotkey":"Ctrl+Alt+V"}"#).unwrap();
        assert!(old.enabled);
        assert_eq!(old.hotkey, "Ctrl+Alt+V");
        assert!(!old.wake_word);
        assert_eq!(old.sensitivity, DEFAULT_SENSITIVITY);
        assert_eq!(old.input_device, None);
    }

    #[test]
    fn everything_is_off_by_default() {
        // A shell that starts listening because it was updated is a shell
        // nobody trusts (§28.6).
        let fresh = VoiceSettings::default();
        assert!(!fresh.enabled);
        assert!(!fresh.wake_word);
        assert!(!fresh.quiet);
        assert_eq!(fresh.hotkey, DEFAULT_HOTKEY);
        assert!(!fresh.may_chime());
    }

    #[test]
    fn quiet_mode_silences_the_chime_but_voice_still_being_on_is_a_separate_fact() {
        let mut settings = VoiceSettings {
            enabled: true,
            ..Default::default()
        };
        assert!(settings.may_chime());
        settings.quiet = true;
        assert!(!settings.may_chime());
        // Still enabled: the hotkey works in quiet mode (§28.6).
        assert!(settings.enabled);
    }
}
