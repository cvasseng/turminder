//! The Turminder desktop shell (§28).
//!
//! To the service this is just another App. D device holding a device token
//! (§24); to the person using it, it is the whole product. The shell owns a
//! window, a tray icon, a stored connection, its own notification channel —
//! and, in bundled mode, the service process itself. Everything the window
//! *shows* is the service's own UI, served over HTTP from whichever box is
//! answering, which is what keeps this tier from growing a second
//! implementation of anything (§28.3).
//!
//! §28.1's two modes, both live:
//!
//! - **Bundled** — the shell spawns the pinned Node runtime on a free
//!   localhost port against its own XDG data dir, and supervises it
//!   (`sidecar.rs` for the plumbing, `supervisor.rs` for the policy).
//! - **Connect** — no sidecar; the shell points at a service running
//!   elsewhere, given the §24.3 connect URL.
//!
//! Mode is shell state, not service config: the service is never told which
//! one it is running under.

pub mod connect;
pub mod device;
pub mod http;
pub mod mode;
pub mod platform;
pub mod sidecar;
pub mod store;
pub mod supervisor;

use std::sync::Mutex;

use tauri::{
    menu::{Menu, MenuItem},
    tray::TrayIconBuilder,
    Manager, WindowEvent,
};
use tauri_plugin_autostart::MacosLauncher;

use connect::{parse_connect_url, window_url, Connection};
use mode::Mode;
use sidecar::Sidecar;

/// The device name the bundled shell registers under (§28.2, `token create app`).
const BUNDLED_DEVICE: &str = "app";

/// What the first screen asks the shell about itself.
#[derive(serde::Serialize)]
pub struct Status {
    /// `None` is first run: nobody has picked a mode, so the chooser shows.
    mode: Option<Mode>,
    connected: bool,
    base_url: Option<String>,
    device: Option<String>,
}

/// The shell's live device socket (§28.2), if it has one.
///
/// Managed state rather than a module static: the socket belongs to this run of
/// the app, and `connect_to`, `choose_bundled` and `forget` all replace it.
#[derive(Default)]
struct Devices(Mutex<Option<device::DeviceClient>>);

/// The supervised service, in bundled mode.
#[derive(Default)]
struct Sidecars(Mutex<Option<Sidecar>>);

/// Where the boot got to, for a window that loaded after it started.
#[tauri::command]
fn boot_state(app: tauri::AppHandle) -> Option<sidecar::State> {
    app.state::<sidecar::LastState>()
        .0
        .lock()
        .expect("boot state poisoned")
        .clone()
}

/// Point the shell's notification socket at `connection` — or, with `None`, at
/// nothing — replacing whatever socket it had.
///
/// Called from every path that changes which service the shell is talking to.
/// The `connect_to` case is the one that bites: a freshly connected shell that
/// only becomes a device on the *next* launch is a shell that silently misses
/// every notification until you restart it.
fn set_device(app: &tauri::AppHandle, connection: Option<&Connection>) {
    let devices = app.state::<Devices>();
    let mut slot = devices.0.lock().expect("device slot poisoned");
    if let Some(previous) = slot.take() {
        previous.stop();
    }
    *slot = connection.map(|c| device::spawn(app.clone(), c.clone()));
}

#[tauri::command]
fn status(app: tauri::AppHandle) -> Status {
    let stored = store::load();
    Status {
        mode: mode::load(&app),
        connected: stored.is_some(),
        base_url: stored.as_ref().map(|c| c.base_url.clone()),
        device: stored.map(|c| c.device),
    }
}

/// Run the service on this computer (§28.1, bundled mode).
///
/// Returns as soon as the choice is recorded; booting a service is slow enough
/// to need progress, so the work happens on a background thread and reports
/// through `sidecar::STATE_EVENT`.
#[tauri::command]
fn choose_bundled(app: tauri::AppHandle) -> Result<(), String> {
    mode::save(&app, Mode::Bundled)?;
    start_bundled(app);
    Ok(())
}

/// Point the shell at a service running elsewhere (§28.1, connect mode).
#[tauri::command]
fn choose_connect(app: tauri::AppHandle) -> Result<(), String> {
    mode::save(&app, Mode::Connect)
}

/// Take a connect URL, prove it works, keep it, and go.
///
/// Verifying before storing is the difference between "connected" and "typed
/// something": `/api/whoami` (App. E) answers only for a token this service
/// actually knows, so a stale QR fails here rather than as a blank window.
#[tauri::command]
async fn connect_to(app: tauri::AppHandle, url: String) -> Result<String, String> {
    let connection = parse_connect_url(&url).map_err(|e| e.to_string())?;
    let device = verify(&connection).await?;
    store::save(&connection)?;
    mode::save(&app, Mode::Connect)?;
    set_device(&app, Some(&connection));
    open_service_window(&app, &connection)?;
    Ok(device)
}

/// Back to the first screen: forget the connection, the mode, and the sidecar.
#[tauri::command]
fn forget(app: tauri::AppHandle) -> Result<(), String> {
    store::clear();
    mode::clear(&app);
    set_device(&app, None);
    stop_sidecar(&app);
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.eval("window.location.replace('index.html')");
    }
    Ok(())
}

#[tauri::command]
fn set_autostart(app: tauri::AppHandle, enabled: bool) -> Result<(), String> {
    use tauri_plugin_autostart::ManagerExt;
    let manager = app.autolaunch();
    if enabled {
        manager.enable().map_err(|e| e.to_string())
    } else {
        manager.disable().map_err(|e| e.to_string())
    }
}

#[tauri::command]
fn autostart_enabled(app: tauri::AppHandle) -> bool {
    use tauri_plugin_autostart::ManagerExt;
    app.autolaunch().is_enabled().unwrap_or(false)
}

/// Boot the bundled service, then join the window and the socket to it.
///
/// Blocking work on a blocking thread: `sidecar::start` mints a token with one
/// child process and waits on `/healthz` with another, and neither belongs on
/// an async executor.
fn start_bundled(app: tauri::AppHandle) {
    tauri::async_runtime::spawn_blocking(move || match sidecar::start(&app) {
        Ok(started) => {
            let connection = Connection {
                base_url: started.base_url(),
                token: started.token.clone(),
                device: BUNDLED_DEVICE.to_string(),
            };
            set_device(&app, Some(&connection));
            let _ = open_service_window(&app, &connection);
            let sidecars = app.state::<Sidecars>();
            let mut slot = sidecars.0.lock().expect("sidecar slot poisoned");
            if let Some(previous) = slot.take() {
                previous.stop();
            }
            *slot = Some(started);
        }
        Err(message) => sidecar::announce(&app, "failed", message),
    });
}

fn stop_sidecar(app: &tauri::AppHandle) {
    let sidecars = app.state::<Sidecars>();
    let taken = sidecars
        .0
        .lock()
        .expect("sidecar slot poisoned")
        .take();
    if let Some(sidecar) = taken {
        sidecar.stop();
    }
}

/// `GET /api/whoami` — the pairing probe (§29.5), reused here for exactly what
/// it was built for: proving a token authenticates, and saying as what.
async fn verify(connection: &Connection) -> Result<String, String> {
    let url = format!("{}/api/whoami", connection.base_url);
    tauri::async_runtime::spawn_blocking({
        let token = connection.token.clone();
        move || whoami(&url, &token)
    })
    .await
    .map_err(|e| e.to_string())?
}

fn whoami(url: &str, token: &str) -> Result<String, String> {
    let response = http::get(url, Some(token), std::time::Duration::from_secs(10))?;
    if response.status == 401 {
        return Err("that token was refused — it may have been revoked".into());
    }
    if response.status != 200 {
        return Err(format!("the service answered {}", response.status));
    }
    Ok(serde_json::from_str::<serde_json::Value>(&response.body)
        .ok()
        .and_then(|v| v.get("device").and_then(|d| d.as_str().map(str::to_string)))
        .unwrap_or_else(|| "this device".to_string()))
}

fn open_service_window(app: &tauri::AppHandle, connection: &Connection) -> Result<(), String> {
    let window = app.get_webview_window("main").ok_or("no main window")?;
    // The page consumes the fragment and strips it (§24.3) — the same path a
    // scanned QR takes, so there is one flow in the UI rather than two.
    window
        .eval(format!(
            "window.location.replace({})",
            serde_json::to_string(&window_url(connection)).map_err(|e| e.to_string())?
        ))
        .map_err(|e| e.to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(Devices::default())
        .manage(Sidecars::default())
        .manage(sidecar::LastState::default())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_autostart::init(
            MacosLauncher::LaunchAgent,
            None,
        ))
        .invoke_handler(tauri::generate_handler![
            status,
            boot_state,
            choose_bundled,
            choose_connect,
            connect_to,
            forget,
            set_autostart,
            autostart_enabled
        ])
        .setup(|app| {
            let handle = app.handle().clone();
            // Tray first: closing the window must leave something to come back
            // to, and a shell with no tray and no window is a process nobody
            // can reach (§28.2).
            let show = MenuItem::with_id(app, "show", "Show Turminder", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show, &quit])?;
            TrayIconBuilder::new()
                .icon(app.default_window_icon().unwrap().clone())
                .tooltip("Turminder")
                .menu(&menu)
                .on_menu_event(move |app, event| match event.id.as_ref() {
                    "show" => {
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.show();
                            let _ = window.set_focus();
                        }
                    }
                    // Quit is the one exit that stops the service too: a
                    // sidecar outliving its shell is an orphan holding the
                    // data dir's lock (§28.2).
                    "quit" => {
                        stop_sidecar(app);
                        app.exit(0);
                    }
                    _ => {}
                })
                .build(app)?;

            match mode::load(&handle) {
                Some(Mode::Bundled) => start_bundled(handle.clone()),
                Some(Mode::Connect) => {
                    if let Some(connection) = store::load() {
                        // Notifications are the shell's own job, so they arrive
                        // with the window closed (§28.2).
                        set_device(&handle, Some(&connection));
                        let _ = open_service_window(&handle, &connection);
                    }
                }
                // First run: the window shows the chooser and nothing starts
                // until someone decides what this install is.
                None => {}
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            // Close is not quit (§28.2): a background assistant that dies when
            // you tidy your desktop is not a background assistant.
            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building the Turminder shell")
        .run(|app, event| {
            // Every other way out of the process still has to take the sidecar
            // with it — a SIGTERM'd shell that leaks a node process is a data
            // dir nobody else can open.
            if let tauri::RunEvent::Exit = event {
                stop_sidecar(app);
            }
        });
}

#[cfg(test)]
mod tests {
    /// The connect screen reaches the shell through `window.__TAURI__`, which
    /// Tauri injects **only** when `app.withGlobalTauri` is set — and it
    /// defaults to off. Without it the screen's very first statement throws,
    /// every handler below it goes unbound, and the buttons do nothing
    /// whatsoever, with no error anywhere a user can see. Two files have to
    /// agree and nothing at runtime says so, which is exactly the shape of bug
    /// a test is for.
    #[test]
    fn the_first_screen_can_reach_the_shell() {
        let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"));
        let config = std::fs::read_to_string(root.join("tauri.conf.json")).unwrap();
        let screen = std::fs::read_to_string(root.join("../dist/index.html")).unwrap();
        assert!(
            screen.contains("__TAURI__"),
            "the first screen must talk to the shell; if that changed, change this test"
        );
        assert!(
            config.contains("\"withGlobalTauri\": true"),
            "dist/index.html uses window.__TAURI__, so tauri.conf.json must set \
             app.withGlobalTauri — without it the whole screen is inert"
        );
    }

    /// Every `invoke` name the screen calls must be a command the shell
    /// registered. A typo here is the same silent-nothing failure as above,
    /// one layer down.
    #[test]
    fn every_command_the_screen_calls_exists() {
        let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"));
        let screen = std::fs::read_to_string(root.join("../dist/index.html")).unwrap();
        let source = std::fs::read_to_string(root.join("src/lib.rs")).unwrap();
        let handler = source
            .split("generate_handler![")
            .nth(1)
            .and_then(|rest| rest.split(']').next())
            .expect("the invoke_handler list moved");
        let registered: Vec<&str> = handler
            .split(',')
            .map(str::trim)
            .filter(|name| !name.is_empty())
            .collect();
        let mut called = Vec::new();
        for piece in screen.split("invoke('").skip(1) {
            called.push(piece.split('\'').next().expect("unterminated invoke name"));
        }
        assert!(!called.is_empty(), "the screen invokes nothing at all");
        for name in called {
            assert!(
                registered.contains(&name),
                "the screen invokes `{name}`, which is not in generate_handler! ({registered:?})"
            );
        }
    }
}
