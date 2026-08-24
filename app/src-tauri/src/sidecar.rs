//! Bundled mode: the service as a supervised child process (§28.1).
//!
//! `supervisor.rs` holds the *policy* — restart, back off, or give up — with no
//! process in it, so it can be tested without spawning anything. This module is
//! the plumbing that policy was written for: it resolves the bundled runtime,
//! mints the shell a device token, spawns the service on a free localhost port,
//! waits for it to answer, and then keeps it alive for as long as the app runs.
//!
//! Two things the shell deliberately does *not* do. It never edits the data
//! dir's config: the port arrives as `--bind`, the location as `--data-dir`,
//! both process-level (§28.1), because config files have owners. And it never
//! reads the service's source or imports anything from it — the sidecar is an
//! opaque `node dist/index.js`, exactly as a `.deb`'s user would run it
//! (§28.3).

use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use tauri::{AppHandle, Emitter, Manager};

use crate::supervisor::{Decision, Supervisor};

/// How long the service gets to answer `/healthz` before we call it a failure.
const BOOT_TIMEOUT: Duration = Duration::from_secs(45);
/// How long a SIGTERM'd service gets to close its database before SIGKILL.
const SHUTDOWN_GRACE: Duration = Duration::from_secs(8);
const POLL: Duration = Duration::from_millis(250);

/// The event the window listens on for boot progress and for bad news.
pub const STATE_EVENT: &str = "sidecar://state";

#[derive(Clone, serde::Serialize)]
pub struct State {
    /// `starting` | `ready` | `restarting` | `failed`
    pub phase: &'static str,
    pub message: String,
}

/// The last thing we said, kept so the window can *ask*.
///
/// Booting starts the instant the app does, which is before the webview exists
/// to subscribe — so a push-only channel loses exactly the events that matter
/// most, and a failure before the page loads left the screen saying
/// "preparing…" forever. Everything announced is therefore both emitted and
/// remembered, and the page reads the remembered value on load.
#[derive(Default)]
pub struct LastState(pub Mutex<Option<State>>);

/// Say something about the boot, to whoever is listening and to whoever asks.
pub fn announce(app: &AppHandle, phase: &'static str, message: impl Into<String>) {
    let state = State {
        phase,
        message: message.into(),
    };
    if let Some(slot) = app.try_state::<LastState>() {
        *slot.0.lock().expect("boot state poisoned") = Some(state.clone());
    }
    let _ = app.emit(STATE_EVENT, state);
}

/// Where the bundle keeps the service it is going to run.
#[derive(Debug, Clone)]
pub struct Layout {
    /// The pinned Node runtime (§28.4) — never the one on the user's PATH.
    pub node: PathBuf,
    /// The service's entry module. Under `dist/src/`, not `dist/`, because tsc
    /// keeps the `src/` prefix from its rootDir — a bundle that guesses `dist/`
    /// fails at spawn with a Node "cannot find module", which is a long way
    /// from the thing that is actually wrong.
    pub entry: PathBuf,
}

/// Resolve the layout inside a service directory, naming what is missing.
///
/// A pure function of a path so the bundle's shape is asserted in a unit test
/// rather than discovered on a stranger's laptop.
pub fn layout(service_dir: &Path) -> Result<Layout, String> {
    let node = service_dir.join("bin").join(crate::platform::NODE_BINARY);
    let entry = service_dir.join("dist").join("src").join("index.js");
    for (what, path) in [("the Node runtime", &node), ("the service", &entry)] {
        if !path.exists() {
            return Err(format!(
                "this build is missing {what} ({}) — the app was packaged wrong, \
                 which is not something you can fix from here",
                path.display()
            ));
        }
    }
    Ok(Layout { node, entry })
}

/// The service directory: a bundle resource, or whatever the dev override says.
///
/// The override exists so bundled mode can be driven without building a `.deb`
/// first; nothing in a shipped app sets it.
pub fn service_dir(app: &AppHandle) -> Result<PathBuf, String> {
    if let Some(dir) = std::env::var_os("TURMINDER_APP_SERVICE_DIR") {
        return Ok(PathBuf::from(dir));
    }
    Ok(app
        .path()
        .resource_dir()
        .map_err(|e| e.to_string())?
        .join("service"))
}

/// A free localhost port, claimed by binding it and letting go.
///
/// There is a race here — someone else can take the port between the drop and
/// the spawn — and it is the right trade: the alternative is the service
/// reporting its own port back up a pipe, which means parsing its log output.
/// A lost race is a fast crash, which is precisely what `supervisor.rs` exists
/// to turn into a retry.
fn free_port() -> Result<u16, String> {
    let listener = std::net::TcpListener::bind("127.0.0.1:0").map_err(|e| e.to_string())?;
    listener
        .local_addr()
        .map(|a| a.port())
        .map_err(|e| e.to_string())
}

struct Inner {
    layout: Layout,
    data_dir: PathBuf,
    port: u16,
    child: Mutex<Option<Child>>,
    supervisor: Mutex<Supervisor>,
    stopping: AtomicBool,
}

pub struct Sidecar {
    /// Fixed for the life of the app: a restart reuses the port so the window's
    /// URL — and the token fragment already handed to it — stay valid.
    pub port: u16,
    pub token: String,
    pub data_dir: PathBuf,
    inner: Arc<Inner>,
}

impl Sidecar {
    pub fn base_url(&self) -> String {
        format!("http://127.0.0.1:{}", self.port)
    }
}

/// Boot the bundled service and return once it answers.
///
/// The order is deliberate: the token is minted *before* the server starts, in
/// its own short-lived process. That scaffolds the data dir once, sequentially,
/// rather than racing two bootstraps at the same directory — and it means the
/// window has a token to be handed the moment the service is up.
pub fn start(app: &AppHandle) -> Result<Sidecar, String> {
    let say = |phase: &'static str, message: &str| announce(app, phase, message);

    let layout = layout(&service_dir(app)?)?;
    let data_dir = crate::platform::data_dir()?;
    say("starting", "preparing your assistant\u{2026}");

    let token = match crate::store::load_sidecar_token() {
        Some(token) => token,
        None => {
            let minted = mint_token(&layout, &data_dir)?;
            // Vault-first, per §28.2 — but a box with no secrets daemon gets a
            // fresh token next launch instead of a refusal, because a bundled
            // install is somebody's only copy of their assistant and it has to
            // open. Rotation in place is what `token create` already does.
            if let Err(e) = crate::store::save_sidecar_token(&minted) {
                say(
                    "starting",
                    &format!(
                        "no OS vault on this machine ({e}) — a fresh key will be made each \
                         time Turminder starts"
                    ),
                );
            }
            minted
        }
    };

    let port = free_port()?;
    let inner = Arc::new(Inner {
        layout,
        data_dir: data_dir.clone(),
        port,
        child: Mutex::new(None),
        supervisor: Mutex::new(Supervisor::new()),
        stopping: AtomicBool::new(false),
    });

    // The supervisor thread makes the first child too, not just the restarts:
    // PR_SET_PDEATHSIG binds the child's life to the *forking thread*, so a
    // first spawn from a pooled blocking thread would kill the service the
    // moment that thread retired.
    supervise(app.clone(), Arc::clone(&inner))?;
    say("starting", "starting the service\u{2026}");
    await_health(port, BOOT_TIMEOUT)?;
    say("ready", "ready");
    Ok(Sidecar {
        port,
        token,
        data_dir,
        inner,
    })
}

/// `token create app`, whose one line of stdout is the token (§24.1).
fn mint_token(layout: &Layout, data_dir: &Path) -> Result<String, String> {
    let output = Command::new(&layout.node)
        .arg(&layout.entry)
        .arg("--data-dir")
        .arg(data_dir)
        .args(["token", "create", "app", "--label", "This computer"])
        .stdin(Stdio::null())
        .output()
        .map_err(|e| format!("could not run the bundled service: {e}"))?;
    if !output.status.success() {
        // The service logs to stderr, so its own complaint is the useful half.
        let complaint = String::from_utf8_lossy(&output.stderr);
        let tail: Vec<&str> = complaint.lines().rev().take(3).collect();
        return Err(format!(
            "the bundled service could not create a key: {}",
            tail.into_iter().rev().collect::<Vec<_>>().join(" / ")
        ));
    }
    String::from_utf8_lossy(&output.stdout)
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .map(str::to_string)
        .ok_or_else(|| "the bundled service printed no key".to_string())
}

/// Spawn the service as a child that cannot outlive us.
///
/// The die-with-parent arrangement is `platform.rs`'s job and differs per OS:
/// `stop` covers the tray's Quit and Tauri's exit hook, but neither runs when
/// the shell is killed outright, and a leaked sidecar holds the data dir
/// against the next launch. A live drive on Linux found exactly that.
fn spawn_service(
    inner: &Arc<Inner>,
    keeper: &mut crate::platform::ChildKeeper,
) -> Result<(), String> {
    let mut command = Command::new(&inner.layout.node);
    command
        .arg(&inner.layout.entry)
        .arg("--data-dir")
        .arg(&inner.data_dir)
        .arg("--bind")
        .arg(format!("127.0.0.1:{}", inner.port))
        .arg("serve")
        .stdin(Stdio::null())
        // Inherited on purpose: the sidecar's log is the app's log, and a
        // bundled install with no visible log is a bug report nobody can act on.
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit());
    crate::platform::arrange_child_dies_with_us(&mut command);
    let child = command
        .spawn()
        .map_err(|e| format!("could not start the bundled service: {e}"))?;
    // Windows does its half after the fact, with a handle it has to hold.
    crate::platform::adopt_child(keeper, &child)?;
    *inner.child.lock().expect("child slot poisoned") = Some(child);
    Ok(())
}

/// Poll `/healthz` (App. E — open, no token) until it answers or time runs out.
fn await_health(port: u16, timeout: Duration) -> Result<(), String> {
    let url = format!("http://127.0.0.1:{port}/healthz");
    let deadline = Instant::now() + timeout;
    let mut last = String::from("it never answered");
    while Instant::now() < deadline {
        match crate::http::get(&url, None, Duration::from_secs(2)) {
            Ok(r) if r.status == 200 => return Ok(()),
            Ok(r) => last = format!("it answered {}", r.status),
            Err(e) => last = e,
        }
        std::thread::sleep(POLL);
    }
    Err(format!(
        "the bundled service did not come up within {}s — {last}",
        timeout.as_secs()
    ))
}

/// Own the child for the rest of the app's life, applying §28.1's policy.
///
/// Returns once the *first* spawn has succeeded or failed, so a bundle that
/// cannot start says so on the screen instead of looking slow.
fn supervise(app: AppHandle, inner: Arc<Inner>) -> Result<(), String> {
    let (first, ready) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        // Lives as long as this thread, which lives as long as the app: on
        // Windows it *is* the kill-on-close guarantee, and dropping it early
        // would take the service with it.
        let mut keeper = crate::platform::ChildKeeper::new();
        if let Err(e) = spawn_service(&inner, &mut keeper) {
            let _ = first.send(Err(e));
            return;
        }
        let _ = first.send(Ok(()));
        let mut started = Instant::now();
        loop {
            std::thread::sleep(POLL);
            // try_wait rather than wait: holding the child lock across a
            // blocking wait would make `stop` wait for the thing it is
            // stopping.
            let exit = {
                let mut slot = inner.child.lock().expect("child slot poisoned");
                match slot.as_mut() {
                    Some(child) => match child.try_wait() {
                        Ok(Some(status)) => {
                            *slot = None;
                            Some(status.code())
                        }
                        Ok(None) => None,
                        Err(_) => {
                            *slot = None;
                            Some(None)
                        }
                    },
                    None if inner.stopping.load(Ordering::SeqCst) => return,
                    None => None,
                }
            };
            let Some(code) = exit else { continue };
            if inner.stopping.load(Ordering::SeqCst) {
                return;
            }

            let decision = {
                let mut supervisor = inner.supervisor.lock().expect("supervisor poisoned");
                supervisor.exited(started.elapsed(), code)
            };
            match decision {
                Decision::Stay => return,
                Decision::GiveUp { message } => {
                    announce(&app, "failed", message);
                    return;
                }
                Decision::Restart { after } => {
                    announce(
                        &app,
                        "restarting",
                        "the service stopped — starting it again\u{2026}",
                    );
                    std::thread::sleep(after);
                    if inner.stopping.load(Ordering::SeqCst) {
                        return;
                    }
                    started = Instant::now();
                    if let Err(e) = spawn_service(&inner, &mut keeper) {
                        announce(&app, "failed", e);
                        return;
                    }
                    announce(&app, "ready", "ready");
                }
            }
        }
    });
    ready
        .recv()
        .map_err(|_| "the supervisor thread died before it started anything".to_string())?
}

impl Sidecar {
    /// Ask, then insist — the dev-runner semantics §28.1 asks for.
    ///
    /// The escalation is not politeness: the service closes SQLite and flushes
    /// the outbox when asked, and a straight kill leaves a hot journal behind.
    /// What "ask" means is `platform.rs`'s business — SIGTERM on the unixes,
    /// and nothing at all on Windows, which has no equivalent.
    pub fn stop(&self) {
        self.inner.stopping.store(true, Ordering::SeqCst);
        self.inner
            .supervisor
            .lock()
            .expect("supervisor poisoned")
            .stopping();
        let mut slot = self.inner.child.lock().expect("child slot poisoned");
        let Some(child) = slot.as_mut() else { return };
        crate::platform::request_stop(child);
        let deadline = Instant::now() + SHUTDOWN_GRACE;
        while Instant::now() < deadline {
            match child.try_wait() {
                Ok(Some(_)) => {
                    *slot = None;
                    return;
                }
                Ok(None) => std::thread::sleep(POLL),
                Err(_) => break,
            }
        }
        let _ = child.kill();
        let _ = child.wait();
        *slot = None;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_layout_names_what_the_bundle_is_missing() {
        let dir = std::env::temp_dir().join(format!("turminder-layout-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("bin")).unwrap();
        let e = layout(&dir).unwrap_err();
        assert!(e.contains("the Node runtime"), "{e}");

        // The runtime is `node.exe` on Windows, and `layout` looks for exactly
        // the name the bundle ships (§28.4). Writing a literal `node` here made
        // the test pass on the two platforms it had ever run on and describe a
        // bundle Windows would call incomplete — found by the first Windows CI
        // run, which is the whole point of having one.
        std::fs::write(dir.join("bin").join(crate::platform::NODE_BINARY), "").unwrap();
        let e = layout(&dir).unwrap_err();
        assert!(e.contains("the service"), "{e}");

        std::fs::create_dir_all(dir.join("dist").join("src")).unwrap();
        std::fs::write(dir.join("dist").join("src").join("index.js"), "").unwrap();
        let resolved = layout(&dir).unwrap();
        assert_eq!(
            resolved.node,
            dir.join("bin").join(crate::platform::NODE_BINARY)
        );
        assert_eq!(
            resolved.entry,
            dir.join("dist").join("src").join("index.js")
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_free_port_is_actually_free() {
        let port = free_port().unwrap();
        // If the claim-and-release worked, we can bind it again right now.
        let again = std::net::TcpListener::bind(("127.0.0.1", port));
        assert!(again.is_ok(), "port {port} was not released");
    }

    #[test]
    fn health_gives_up_rather_than_hanging() {
        let port = free_port().unwrap();
        let e = await_health(port, Duration::from_millis(600)).unwrap_err();
        assert!(e.contains("did not come up"), "{e}");
    }
}
