//! Where the shell keeps its connection (§28.2).
//!
//! The token goes in the OS vault, not a config file — the same argument §27
//! makes for the service's own secrets, applied to the one credential the
//! shell holds. On Linux that is the Secret Service; the `keyring` crate picks
//! the platform's own store, so macOS and Windows need no code here when they
//! land.
//!
//! The base URL and device name are not secrets, but they live in the same
//! entry: one JSON blob is one thing to write, one thing to clear, and one
//! thing that cannot half-exist.

use crate::connect::Connection;

const SERVICE: &str = "turminder-app";
const ACCOUNT: &str = "connection";
/// The bundled sidecar's own device token, kept apart from the connection blob
/// because the two have different lifetimes: a connection is a URL somebody
/// typed once, while a sidecar token is minted against a data dir this machine
/// owns and has to survive the port changing under it on every launch (§28.2).
const SIDECAR_ACCOUNT: &str = "sidecar-token";

pub fn load() -> Option<Connection> {
    let entry = keyring::Entry::new(SERVICE, ACCOUNT).ok()?;
    let raw = entry.get_password().ok()?;
    serde_json::from_str(&raw).ok()
}

pub fn save(connection: &Connection) -> Result<(), String> {
    let entry = keyring::Entry::new(SERVICE, ACCOUNT).map_err(|e| e.to_string())?;
    let raw = serde_json::to_string(connection).map_err(|e| e.to_string())?;
    entry.set_password(&raw).map_err(|e| e.to_string())
}

pub fn clear() {
    if let Ok(entry) = keyring::Entry::new(SERVICE, ACCOUNT) {
        // Already gone is the outcome we wanted either way.
        let _ = entry.delete_credential();
    }
}

/// The sidecar's token, if this box has a vault and something was put in it.
///
/// `None` covers both "no vault here" and "nothing stored yet", and the caller
/// treats them the same way: mint a fresh one (§28.2). Bundled mode must work
/// on a machine with no secrets daemon, so a missing vault is a degradation
/// rather than the refusal connect mode gives.
pub fn load_sidecar_token() -> Option<String> {
    let entry = keyring::Entry::new(SERVICE, SIDECAR_ACCOUNT).ok()?;
    entry.get_password().ok().filter(|t| !t.is_empty())
}

/// Best-effort: the error is worth reporting once, never worth failing on.
pub fn save_sidecar_token(token: &str) -> Result<(), String> {
    let entry = keyring::Entry::new(SERVICE, SIDECAR_ACCOUNT).map_err(|e| e.to_string())?;
    entry.set_password(token).map_err(|e| e.to_string())
}

pub fn clear_sidecar_token() {
    if let Ok(entry) = keyring::Entry::new(SERVICE, SIDECAR_ACCOUNT) {
        let _ = entry.delete_credential();
    }
}
