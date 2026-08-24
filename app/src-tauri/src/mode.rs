//! Which of §28.1's two modes this install runs in.
//!
//! Mode is **shell state, not service config**: it says how this machine
//! reaches an assistant, and the service must never learn the answer. So it
//! lives in the app's own config dir — and as a plain file rather than a vault
//! entry, because it is not a secret and because bundled mode has to work on a
//! box with no vault at all (§28.2).

use std::path::PathBuf;

use tauri::Manager;

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Mode {
    /// The shell runs the service itself, as a supervised sidecar.
    Bundled,
    /// The shell points at a service running somewhere else.
    Connect,
}

#[derive(serde::Serialize, serde::Deserialize)]
struct Stored {
    mode: Mode,
}

fn file(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("mode.json"))
}

/// `None` means first run: nobody has chosen yet, and the chooser is what the
/// window shows.
pub fn load(app: &tauri::AppHandle) -> Option<Mode> {
    let raw = std::fs::read_to_string(file(app).ok()?).ok()?;
    serde_json::from_str::<Stored>(&raw).ok().map(|s| s.mode)
}

pub fn save(app: &tauri::AppHandle, mode: Mode) -> Result<(), String> {
    let path = file(app)?;
    let raw = serde_json::to_string(&Stored { mode }).map_err(|e| e.to_string())?;
    std::fs::write(path, raw).map_err(|e| e.to_string())
}

pub fn clear(app: &tauri::AppHandle) {
    if let Ok(path) = file(app) {
        let _ = std::fs::remove_file(path);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trips_through_json_by_name() {
        // The file is written by one version of the shell and read by the next,
        // so the wire form is a name rather than a tuple index.
        assert_eq!(
            serde_json::to_string(&Stored {
                mode: Mode::Bundled
            })
            .unwrap(),
            r#"{"mode":"bundled"}"#
        );
        let parsed: Stored = serde_json::from_str(r#"{"mode":"connect"}"#).unwrap();
        assert_eq!(parsed.mode, Mode::Connect);
    }
}
