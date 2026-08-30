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
//!
//! **When there is no vault, the connection is held in memory for this run and
//! nowhere else** (§28.2). Not every desktop has a Secret Service — a minimal
//! window manager, a NixOS box nobody enabled gnome-keyring on, a machine
//! logged in over SSH — and refusing to connect at all made the app useless on
//! exactly the machines most likely to be pointed at a server elsewhere. The
//! degradation is the same shape bundled mode already has: it works now, it
//! says it will not survive a restart, and **no credential is written to
//! disk** — which is the rule the vault exists to keep, and the reason the
//! obvious alternative (a token in a config file) is not on the table.

use std::sync::Mutex;

use crate::connect::Connection;

const SERVICE: &str = "turminder-app";
const ACCOUNT: &str = "connection";
/// The bundled sidecar's own device token, kept apart from the connection blob
/// because the two have different lifetimes: a connection is a URL somebody
/// typed once, while a sidecar token is minted against a data dir this machine
/// owns and has to survive the port changing under it on every launch (§28.2).
const SIDECAR_ACCOUNT: &str = "sidecar-token";

/// This run's connection, when the vault would not take it. Process lifetime
/// and nothing longer — that is the whole of the promise.
static SESSION: Mutex<Option<Connection>> = Mutex::new(None);

/// What the vault said when it refused, for the screen that has to explain it.
static VAULT_PROBLEM: Mutex<Option<String>> = Mutex::new(None);

/// Where a saved connection ended up.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Saved {
    /// `true` when the vault took it and it will be there next launch.
    pub persisted: bool,
    /// Why it did not, in the vault's own words. `None` when it did.
    pub problem: Option<String>,
}

pub fn load() -> Option<Connection> {
    if let Some(stored) = from_vault() {
        return Some(stored);
    }
    SESSION.lock().expect("session slot poisoned").clone()
}

fn from_vault() -> Option<Connection> {
    let entry = keyring::Entry::new(SERVICE, ACCOUNT).ok()?;
    let raw = entry.get_password().ok()?;
    serde_json::from_str(&raw).ok()
}

/// Keep the connection. Never fails: a machine with no vault gets this run.
pub fn save(connection: &Connection) -> Saved {
    let raw = match serde_json::to_string(connection) {
        Ok(raw) => raw,
        // Unreachable for a struct of three strings, and not worth a Result
        // shape on every caller for it.
        Err(e) => return keep_for_session(connection, e.to_string()),
    };
    let stored = keyring::Entry::new(SERVICE, ACCOUNT)
        .and_then(|entry| entry.set_password(&raw))
        .map_err(|e| e.to_string());
    match stored {
        Ok(()) => {
            *SESSION.lock().expect("session slot poisoned") = None;
            *VAULT_PROBLEM.lock().expect("vault problem poisoned") = None;
            Saved {
                persisted: true,
                problem: None,
            }
        }
        Err(problem) => keep_for_session(connection, problem),
    }
}

fn keep_for_session(connection: &Connection, problem: String) -> Saved {
    *SESSION.lock().expect("session slot poisoned") = Some(connection.clone());
    *VAULT_PROBLEM.lock().expect("vault problem poisoned") = Some(problem.clone());
    Saved {
        persisted: false,
        problem: Some(problem),
    }
}

/// Why this run is not persisting its connection, if it is not — as a sentence.
pub fn vault_problem() -> Option<String> {
    VAULT_PROBLEM
        .lock()
        .expect("vault problem poisoned")
        .as_deref()
        .map(explain)
}

/// What a vault failure means to a person (§28.2).
///
/// `keyring` reports the transport's words, and the transport is D-Bus:
/// *"Platform secure storage failure: DBus error: The name is not
/// activatable"* is a true and completely useless thing to tell somebody who
/// wanted to connect to their server. Every branch here says what happened,
/// what the consequence is, and what would fix it — and the unmatched case
/// still carries the original text, because a message nobody anticipated is
/// worth more verbatim than paraphrased.
pub fn explain(problem: &str) -> String {
    let lower = problem.to_ascii_lowercase();
    let cause = if lower.contains("not activatable")
        || lower.contains("org.freedesktop.secrets")
        || lower.contains("no such name")
    {
        NO_STORE.to_string()
    } else if lower.contains("failed to connect to socket")
        || lower.contains("dbus_session_bus_address")
        || lower.contains("unable to autolaunch")
    {
        NO_SESSION.to_string()
    } else if lower.contains("locked")
        || lower.contains("dismissed")
        || lower.contains("cancelled")
        || lower.contains("canceled")
    {
        LOCKED.to_string()
    } else {
        format!("the password store refused: {problem}")
    };
    format!("{cause}. {CONSEQUENCE}")
}

const NO_STORE: &str = "this machine has no password store — nothing provides the \
    Secret Service that Linux desktops keep credentials in";
const NO_SESSION: &str = "there is no desktop session bus here, which is where the \
    password store lives — this usually means Turminder was started over SSH or from \
    a bare service unit";
const LOCKED: &str = "the password store is locked — it needs unlocking before \
    anything can be written to it";
/// The half that is the same whatever refused: what it means and what fixes it.
const CONSEQUENCE: &str = "The connection works for as long as Turminder is running \
    and is not written anywhere, so you will have to paste the link again after a \
    restart. To keep it, run a keyring — gnome-keyring, KWallet or KeePassXC — and \
    connect once more.";

pub fn clear() {
    if let Ok(entry) = keyring::Entry::new(SERVICE, ACCOUNT) {
        // Already gone is the outcome we wanted either way.
        let _ = entry.delete_credential();
    }
    *SESSION.lock().expect("session slot poisoned") = None;
    *VAULT_PROBLEM.lock().expect("vault problem poisoned") = None;
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

#[cfg(test)]
mod tests {
    use super::*;

    /// `SESSION` and `VAULT_PROBLEM` are process-wide on purpose — one shell,
    /// one connection — so the tests that touch them cannot run beside each
    /// other. Poison is ignored: a panicking test has already failed, and
    /// wedging the rest behind it says nothing useful.
    static SERIALISE: Mutex<()> = Mutex::new(());

    fn connection(base: &str) -> Connection {
        Connection {
            base_url: base.into(),
            token: "sekrit".into(),
            device: "desktop".into(),
        }
    }

    /// The vault is a real machine service and a unit test has no business
    /// having one, so these drive the fallback directly — which is the half
    /// that had no coverage and the half that just bit somebody.
    #[test]
    fn a_refused_vault_keeps_the_connection_for_this_run() {
        let _serial = SERIALISE.lock().unwrap_or_else(|e| e.into_inner());
        clear();
        let saved = keep_for_session(&connection("http://box:7787"), "no secret service".into());
        assert!(!saved.persisted);
        assert_eq!(saved.problem.as_deref(), Some("no secret service"));
        // …and every reader sees it, because the fallback lives behind `load`
        // rather than at one call site that remembered.
        assert_eq!(load().map(|c| c.base_url), Some("http://box:7787".into()));
        // The stored problem comes back explained, not raw — every reader of
        // it is a screen with a person in front of it.
        let told = vault_problem().expect("a problem to explain");
        assert!(
            told.contains("the password store refused: no secret service"),
            "{told}"
        );
        assert!(told.contains("gnome-keyring"), "{told}");
        clear();
        assert!(load().is_none());
        assert!(vault_problem().is_none());
    }

    #[test]
    fn a_dbus_failure_becomes_a_sentence_somebody_can_act_on() {
        // The exact string Christer got, 2026-08-30. It is true and it is
        // useless; what replaces it has to say all three things.
        let said =
            explain("Platform secure storage failure: DBus error: The name is not activatable");
        assert!(said.contains("no password store"), "{said}");
        assert!(said.contains("as long as Turminder is running"), "{said}");
        assert!(said.contains("gnome-keyring"), "{said}");
        // No jargon left over from the transport.
        assert!(!said.contains("DBus"), "{said}");
        assert!(!said.contains("activatable"), "{said}");
    }

    #[test]
    fn the_other_vault_failures_are_told_apart() {
        // A locked keyring and a missing one need opposite things done.
        assert!(explain("Cannot create an item in a locked collection").contains("locked"));
        assert!(explain("Failed to connect to socket /run/user/1000/bus")
            .contains("desktop session bus"));
        // Anything unanticipated keeps its own words rather than being
        // flattened into a guess.
        let odd = explain("the vault caught fire");
        assert!(odd.contains("the vault caught fire"), "{odd}");
        assert!(odd.contains("gnome-keyring"), "{odd}");
    }

    #[test]
    fn forgetting_clears_the_session_too() {
        let _serial = SERIALISE.lock().unwrap_or_else(|e| e.into_inner());
        // Otherwise "start over" would leave the shell still talking to the
        // service it was told to forget, until the process ended.
        clear();
        keep_for_session(&connection("http://box:7787"), "no secret service".into());
        clear();
        assert!(load().is_none());
    }
}
