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

pub mod audio;
pub mod connect;
pub mod device;
pub mod http;
pub mod mode;
pub mod platform;
pub mod sidecar;
pub mod store;
pub mod supervisor;
pub mod tray;
pub mod voice;
pub mod voice_settings;
pub mod wake;

use std::sync::Mutex;

use tauri::{tray::TrayIconBuilder, Emitter, Manager, WindowEvent};
use tauri_plugin_autostart::MacosLauncher;
use tauri_plugin_global_shortcut::{Shortcut, ShortcutState};

use connect::{parse_connect_url, window_url, Connection};
use mode::Mode;
use sidecar::Sidecar;
use voice::{Action, Event as VoiceEvent, Voice};

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
    /// Can this shell actually reach an assistant (§28.1)?
    ///
    /// A mode on its own is not enough: connect mode whose stored connection
    /// is gone — a cleared vault, a `forget`, an app closed before the link was
    /// pasted — is as unconfigured as a fresh install, and the honest screen is
    /// the welcome, not a paste box for the half that was picked once.
    configured: bool,
}

/// The URL the window started on — the shell's **own** asset origin.
///
/// Captured at setup because after `open_service_window` the document is the
/// service's, and a relative `index.html` from there resolves to the service's
/// chat page: the tray's "Connect to another instance…" then looks exactly like
/// a menu item that does nothing (§28.1). Absolute navigation is the fix, and
/// this is the only place the address is knowable — it is `tauri://localhost`
/// on macOS and `http://tauri.localhost` on Linux and Windows.
#[derive(Default)]
struct HomeUrl(Mutex<Option<url::Url>>);

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
    let mode = mode::load(&app);
    Status {
        configured: is_configured(mode, stored.is_some(), bundled_data_dir_exists()),
        mode,
        connected: stored.is_some(),
        base_url: stored.as_ref().map(|c| c.base_url.clone()),
        device: stored.map(|c| c.device),
    }
}

/// Has the bundled install got a data dir? Checked rather than assumed, because
/// deleting it is what a person does to start over (§28.1).
fn bundled_data_dir_exists() -> bool {
    platform::data_dir().map(|d| d.exists()).unwrap_or(false)
}

/// §28.1: a mode with nothing behind it is not a configured install.
///
/// Connect mode is a URL somebody typed, and without it there is nothing to
/// point at. Bundled mode's "behind it" is the data dir — and deleting that is
/// exactly what somebody does to start over, so a bundled shell whose data dir
/// is gone is a shell asking to be set up again, not one that should quietly
/// scaffold a fresh empty install and drop the user on a model form.
///
/// Note the asymmetry with a *first* run, where the dir is also absent: there
/// the mode is absent too, so both roads lead to the welcome.
fn is_configured(mode: Option<Mode>, has_connection: bool, has_data_dir: bool) -> bool {
    match mode {
        Some(Mode::Bundled) => has_data_dir,
        Some(Mode::Connect) => has_connection,
        None => false,
    }
}

/// Run the service on this computer (§28.1, bundled mode).
///
/// Returns as soon as the choice is recorded; booting a service is slow enough
/// to need progress, so the work happens on a background thread and reports
/// through `sidecar::STATE_EVENT`.
#[tauri::command]
fn choose_bundled(app: tauri::AppHandle) -> Result<(), String> {
    // Already here, with a service up: this is somebody who opened the tray's
    // connect screen, changed their mind, and pressed "Run it here instead".
    // Restarting a healthy assistant to answer that would be a bounce nobody
    // asked for — put the window back on it instead.
    if mode::load(&app) == Some(Mode::Bundled) {
        if let Some(connection) = current_connection(&app) {
            return open_service_window(&app, &connection);
        }
    }
    // Whatever was running stops first (§28.1, V6.1). Switching from connect
    // mode leaves the vault entry alone — `forget` is what wipes it, and coming
    // back to a server you already paired with should not mean pasting the QR
    // again — but the live socket has to go, or the shell holds two.
    stop_sidecar(&app);
    set_device(&app, None);
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
/// What connecting produced — the device it authenticated as, and whether the
/// connection will still be here tomorrow (§28.2).
#[derive(serde::Serialize)]
pub struct Connected {
    device: String,
    /// `false` when the vault would not take it and this run is holding it in
    /// memory instead. Not an error — the app works — but the user has to be
    /// told, or they will be surprised at the next launch.
    persisted: bool,
    /// The sentence explaining that, when there is one.
    warning: Option<String>,
}

#[tauri::command]
async fn connect_to(app: tauri::AppHandle, url: String) -> Result<Connected, String> {
    let connection = parse_connect_url(&url).map_err(|e| e.to_string())?;
    let device = verify(&connection).await?;
    // Never fails: a machine with no password store keeps the connection for
    // this run rather than refusing to connect at all (§28.2).
    let saved = store::save(&connection);
    mode::save(&app, Mode::Connect)?;
    set_device(&app, Some(&connection));
    open_service_window(&app, &connection)?;
    Ok(Connected {
        device,
        persisted: saved.persisted,
        warning: saved.problem.as_deref().map(store::explain),
    })
}

/// Back to the first screen: forget the connection, the mode, and the sidecar.
#[tauri::command]
fn forget(app: tauri::AppHandle) -> Result<(), String> {
    store::clear();
    mode::clear(&app);
    set_device(&app, None);
    stop_sidecar(&app);
    go_home(&app, None);
    Ok(())
}

/// Put the window back on the shell's own welcome screen (§28.1).
///
/// `pane` names which one to open on arrival, as a fragment the page reads —
/// no new command for what is a routing hint. Absolute, from `HomeUrl`: a
/// relative navigation from a loaded service page goes to the *service's*
/// index.html, which is the bug this function exists to not have.
fn go_home(app: &tauri::AppHandle, pane: Option<&str>) {
    let Some(window) = app.get_webview_window("main") else {
        return;
    };
    let home = app
        .state::<HomeUrl>()
        .0
        .lock()
        .expect("home url poisoned")
        .clone();
    let Some(mut url) = home else {
        // Nothing was captured, which means the window never loaded the app's
        // own page. Relative is wrong but it is all there is, and it is right
        // in the one case that can produce this.
        let _ = window.eval("window.location.replace('index.html')");
        return;
    };
    url.set_fragment(pane);
    let _ = window.navigate(url);
    let _ = window.show();
    let _ = window.set_focus();
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

/* ── Voice (§28.6) ───────────────────────────────────────────────────────── */

/// The connection whichever mode this shell is in gives it.
///
/// Voice works identically in bundled and connect mode (§28.6): the routes are
/// the service's and the token is the shell's, and neither half cares which
/// box the service is on.
fn current_connection(app: &tauri::AppHandle) -> Option<Connection> {
    // Mode decides, not "whichever exists" (V6.1): an install that used to be
    // in connect mode still has the old URL in its vault, and preferring it
    // would send this shell's voice to a service it is no longer showing.
    let sidecar = || {
        let sidecars = app.state::<Sidecars>();
        let slot = sidecars.0.lock().expect("sidecar slot poisoned");
        slot.as_ref().map(|s| Connection {
            base_url: s.base_url(),
            token: s.token.clone(),
            device: BUNDLED_DEVICE.to_string(),
        })
    };
    match mode::load(app) {
        Some(Mode::Bundled) => sidecar(),
        Some(Mode::Connect) => store::load(),
        // Before anyone has chosen there is nothing to talk to; after `forget`
        // the same. Falling through to either would be a guess.
        None => None,
    }
}

/// Redraw the tray and tell the window what the shell is doing.
fn announce_voice(app: &tauri::AppHandle, note: Option<&str>) {
    let settings = voice_settings::load(app);
    let state = app
        .state::<Voice>()
        .machine
        .lock()
        .expect("voice machine poisoned")
        .as_ref()
        .map(|m| m.state())
        .unwrap_or(voice::State::Idle);
    tray::refresh(app, state, &settings, note);
    let _ = app.emit(
        voice::STATE_EVENT,
        serde_json::json!({ "state": format!("{state:?}").to_lowercase(), "quiet": settings.quiet }),
    );
}

/// Make a sound on the chosen speaker without waiting for it (§28.6): a chime
/// that blocks the hotkey is a chime that costs the first word.
fn play_cue(app: &tauri::AppHandle, wav: Vec<u8>) {
    let settings = voice_settings::load(app);
    if !settings.may_chime() {
        return;
    }
    tauri::async_runtime::spawn_blocking(move || {
        if let Ok(speaker) = audio::Speaker::open(settings.output_device.as_deref()) {
            if speaker.play_wav(&wav).is_ok() {
                speaker.wait();
            }
        }
    });
}

/// One trigger, whichever edge or detector produced it.
fn on_voice_event(app: &tauri::AppHandle, event: VoiceEvent) {
    let settings = voice_settings::load(app);
    if !settings.enabled {
        return;
    }
    let voice = app.state::<Voice>();
    let mut machine = voice.machine_for(&settings);
    let action = machine.handle(event);
    voice.put(machine);
    announce_voice(app, None);

    match action {
        Action::StartListening => {
            // A hotkey turn ends when the key comes up; one with no key to let
            // go of has to be end-pointed (§28.6). The trigger decides, and it
            // decides here because this is the only place that knows which one
            // it was.
            let end_point = matches!(event, VoiceEvent::WakeWord | VoiceEvent::Summoned);
            play_cue(app, audio::chime());
            // A claim on the one open microphone, not a second capture: the
            // detector may already be holding it and two opens on one ALSA
            // device is an argument nobody wins (§28.6).
            match audio::listen(settings.input_device.as_deref()) {
                Ok(lease) => {
                    let note = lease.fell_back.then(|| {
                        format!(
                            "{} is not available — listening on {} instead",
                            settings.input_device.as_deref().unwrap_or("that device"),
                            lease.opened
                        )
                    });
                    *voice.capture.lock().expect("capture slot poisoned") = Some(lease);
                    announce_voice(app, note.as_deref());
                    // Up the moment the microphone is, not at the end: the
                    // whole job of this window is telling somebody the machine
                    // is listening to them right now (§28.6).
                    overlay(app, |state| {
                        state.phase = "listening".into();
                        state.transcript = None;
                        state.problem = note.clone();
                    });
                    if end_point {
                        listen_until_done(app);
                    }
                }
                Err(message) => {
                    // Back to idle rather than stuck listening to a microphone
                    // that never opened — and said out loud, because the tray
                    // tooltip is not somewhere anybody looks (Christer,
                    // 2026-08-30: "listening is not working").
                    let mut machine = voice.machine_for(&settings);
                    machine.handle(VoiceEvent::Finished);
                    voice.put(machine);
                    announce_voice(app, Some(&message));
                    tell(app, &message);
                }
            }
        }
        Action::SendUtterance => {
            let Some(lease) = voice.capture.lock().expect("capture slot poisoned").take() else {
                return;
            };
            // Read before the lease drops; dropping it is what closes the
            // microphone when nothing else is listening.
            let wav = lease.wav();
            drop(lease);
            let Some(connection) = current_connection(app) else {
                announce_voice(app, Some("this shell is not connected to a service"));
                return;
            };
            let handle = app.clone();
            tauri::async_runtime::spawn_blocking(move || {
                let settings = voice_settings::load(&handle);
                let voice = handle.state::<Voice>();
                let mut machine = voice.machine_for(&settings);
                machine.handle(VoiceEvent::ReplyStarted);
                voice.put(machine);
                announce_voice(&handle, None);
                overlay(&handle, |state| state.phase = "thinking".into());

                let heard_handle = handle.clone();
                let mut heard = |text: &str| {
                    // The transcript lands about a fifth of a second in, and
                    // the answer takes seconds: this is the "I heard you" that
                    // makes the wait bearable (Christer, 2026-08-30).
                    let text = text.to_string();
                    overlay(&heard_handle, |state| {
                        state.transcript = Some(text);
                        state.phase = "speaking".into();
                    });
                };
                let outcome = voice::run_utterance(&connection, &settings, wav, &mut heard);
                let quiet_answer = outcome.spoken_bytes == 0
                    && outcome.problem.as_deref().is_some_and(str::is_empty);
                if quiet_answer {
                    // `422 nothing_heard`: a soft tone and nothing to read.
                    play_cue(&handle, audio::soft_tone());
                }
                overlay(&handle, |state| {
                    state.phase = "idle".into();
                    state.problem = outcome.problem.clone().filter(|p| !p.is_empty());
                    if outcome.transcript.is_some() {
                        state.transcript = outcome.transcript.clone();
                    }
                });
                let voice = handle.state::<Voice>();
                let mut machine = voice.machine_for(&settings);
                machine.handle(VoiceEvent::Finished);
                voice.put(machine);
                announce_voice(&handle, None);
                // The follow-up window, then the detector back on its feet
                // (§28.6). Both are no-ops unless the wake word is in use.
                after_reply(&handle);
            });
        }
        Action::Discard => {
            // The microphone closes with the capture; nothing is sent and
            // nothing is written. The detector comes back, because this turn
            // is over as surely as a completed one is.
            voice.capture.lock().expect("capture slot poisoned").take();
            overlay(app, |state| {
                state.phase = "idle".into();
                state.transcript = None;
                state.problem = None;
            });
            announce_voice(app, None);
            sync_wake_word(app);
        }
        Action::Ignore => {}
    }
}

/// Read a delivery aloud, when this shell can and when it is not busy (§33.3).
///
/// An id, never text: the words are the server's composition, and a shell that
/// composed its own would be a second implementation of D.3. Queued rather than
/// spoken on the spot, because a reminder arriving mid-reply must not talk over
/// it — and the ack has already gone, on display, exactly as before.
pub fn speak_delivery(app: &tauri::AppHandle, delivery_id: &str) {
    let settings = voice_settings::load(app);
    if !settings.may_chime() {
        return;
    }
    app.state::<Voice>().spoken.push(delivery_id.to_string());
    drain_spoken(app);
}

/// One drainer at a time, waiting for the shell to stop talking first.
fn drain_spoken(app: &tauri::AppHandle) {
    if !app.state::<Voice>().spoken.claim() {
        return;
    }
    let handle = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        loop {
            let settings = voice_settings::load(&handle);
            let voice = handle.state::<Voice>();
            // Quiet mode arriving mid-queue silences the rest: the
            // notifications were shown, and nothing was spoken over.
            if !settings.may_chime() {
                voice.spoken.clear();
                break;
            }
            // A turn in flight owns the speaker. Wait it out rather than
            // interleaving two voices (§28.6).
            let busy = voice
                .machine
                .lock()
                .expect("voice machine poisoned")
                .as_ref()
                .is_some_and(|m| m.state() != voice::State::Idle);
            if busy {
                std::thread::sleep(std::time::Duration::from_millis(200));
                continue;
            }
            let Some(delivery_id) = voice.spoken.pop() else {
                break;
            };
            let Some(connection) = current_connection(&handle) else {
                voice.spoken.clear();
                break;
            };
            let body = serde_json::json!({ "delivery_id": delivery_id }).to_string();
            let response = http::post(
                &format!("{}/api/speak", connection.base_url),
                Some(&connection.token),
                http::Body {
                    content_type: "application/json",
                    bytes: body.as_bytes(),
                },
                std::time::Duration::from_secs(60),
                None,
            );
            match response {
                // 404 and 410 are ordinary — the delivery was reaped or its
                // moment passed while it sat in the queue (App. E).
                Ok(r) if (200..300).contains(&r.status) => {
                    if let Ok(speaker) = audio::Speaker::open(settings.output_device.as_deref()) {
                        if speaker.play_wav(&r.body).is_ok() {
                            speaker.wait();
                        }
                    }
                }
                Ok(r) => eprintln!(
                    "not speaking {delivery_id}: the service answered {}",
                    r.status
                ),
                Err(message) => eprintln!("not speaking {delivery_id}: {message}"),
            }
        }
        handle.state::<Voice>().spoken.release();
    });
}

/// Stop the detector thread, if one is running. Returns whether there was one.
fn stop_detector(app: &tauri::AppHandle) -> bool {
    let voice = app.state::<Voice>();
    let taken = voice
        .detector
        .lock()
        .expect("detector slot poisoned")
        .take();
    match taken {
        Some(thread) => {
            thread.stop();
            true
        }
        None => false,
    }
}

/// The window after a reply in which speech starts a new turn without the wake
/// word (§28.6, `voice_followup_s`).
///
/// Only for wake-word installs: a push-to-talk user has a key, and a shell that
/// listened for eight seconds after every answer would be listening most of the
/// time — which is the thing §28.6's containment paragraph exists to bound.
fn after_reply(app: &tauri::AppHandle) {
    let settings = voice_settings::load(app);
    let enrolled = voice_settings::wakeword_path(app)
        .map(|p| p.exists())
        .unwrap_or(false);
    if !(settings.enabled && settings.wake_word && enrolled) || settings.quiet {
        sync_wake_word(app);
        return;
    }
    let handle = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let window = wake::FollowUp::opening_now();
        *handle
            .state::<Voice>()
            .follow_up
            .lock()
            .expect("follow-up poisoned") = Some(window);
        let spoke = listen_for_speech(&handle, &settings, &window);
        handle
            .state::<Voice>()
            .follow_up
            .lock()
            .expect("follow-up poisoned")
            .take();
        if spoke {
            // Straight into a turn, no chime and no name: the point of the
            // window is that the second question needs neither.
            on_voice_event(&handle, VoiceEvent::WakeWord);
        } else {
            sync_wake_word(&handle);
        }
    });
}

/// Watch the microphone for the length of the window; `true` if somebody spoke.
fn listen_for_speech(
    app: &tauri::AppHandle,
    settings: &voice_settings::VoiceSettings,
    window: &wake::FollowUp,
) -> bool {
    let Ok(mut lease) = audio::listen(settings.input_device.as_deref()) else {
        return false;
    };
    let mut pointer = wake::EndPointer::new(audio::CAPTURE_RATE);
    while window.open() {
        std::thread::sleep(std::time::Duration::from_millis(50));
        let fresh = lease.since();
        if fresh.is_empty() {
            continue;
        }
        pointer.push(&fresh);
        if pointer.heard_speech() {
            let _ = app;
            return true;
        }
    }
    false
}

/// What the overlay is showing (§28.6).
///
/// Held in state as well as pushed, because a window that is created and
/// emitted to in the same breath has no page yet to hear it — the exact race
/// `sidecar::LastState` exists for, and the reason the overlay used to sit on
/// "…" forever (Christer, 2026-08-30).
#[derive(Default, Clone, serde::Serialize)]
pub struct OverlayState {
    /// `listening` | `thinking` | `speaking` | `idle`.
    phase: String,
    /// What was heard, as soon as the service says so — long before the reply.
    transcript: Option<String>,
    problem: Option<String>,
}

#[derive(Default)]
struct Overlay(Mutex<OverlayState>);

/// What the overlay should be showing right now. Asked for on load, because
/// the events that got it here were emitted before there was a page.
#[tauri::command]
fn overlay_state(app: tauri::AppHandle) -> OverlayState {
    app.state::<Overlay>()
        .0
        .lock()
        .expect("overlay poisoned")
        .clone()
}

/// Update what the overlay shows, and make sure it is up.
fn overlay(app: &tauri::AppHandle, change: impl FnOnce(&mut OverlayState)) {
    let next = {
        let state = app.state::<Overlay>();
        let mut held = state.0.lock().expect("overlay poisoned");
        change(&mut held);
        held.clone()
    };
    let hide = next.phase == "idle" && next.problem.is_none();
    ensure_overlay(app);
    if let Some(window) = app.get_webview_window("overlay") {
        let _ = window.emit(voice::UTTERANCE_EVENT, &next);
        if hide {
            // Nothing to say and nothing went wrong: the page hides itself
            // after a beat so the last thing said stays readable.
        } else {
            let _ = window.show();
        }
    }
}

/// Create the overlay window if it is not there. Hidden until something shows
/// it, so building it costs nothing visible.
fn ensure_overlay(app: &tauri::AppHandle) {
    if app.get_webview_window("overlay").is_some() {
        return;
    }
    let _ = tauri::WebviewWindowBuilder::new(
        app,
        "overlay",
        tauri::WebviewUrl::App("overlay.html".into()),
    )
    .title("Turminder")
    .inner_size(460.0, 172.0)
    .resizable(false)
    .decorations(false)
    .always_on_top(true)
    .skip_taskbar(true)
    .focused(false)
    .visible(false)
    .build();
}

/// Say something to whoever is at the machine (§28.6).
///
/// The tray tooltip is not somewhere anybody looks, and stderr is somewhere
/// only a developer looks — a microphone that will not open has to say so on
/// the screen, which is what the overlay is for.
fn tell(app: &tauri::AppHandle, problem: &str) {
    overlay(app, |state| {
        state.phase = "idle".into();
        state.problem = Some(problem.to_string());
    });
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
    let taken = sidecars.0.lock().expect("sidecar slot poisoned").take();
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
    Ok(serde_json::from_str::<serde_json::Value>(&response.text())
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

/// One tray click. Every voice switch lives here (§33.5: shell settings are
/// not reachable from chat), so the list is the whole control surface.
fn on_tray_click(app: &tauri::AppHandle, id: &str) {
    match id {
        tray::ID_SHOW => {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.set_focus();
            }
        }
        // Quit is the one exit that stops the service too: a sidecar outliving
        // its shell is an orphan holding the data dir's lock (§28.2).
        tray::ID_QUIT => {
            stop_sidecar(app);
            app.exit(0);
        }
        // Straight into a turn, or straight out of one (§28.6). Which of the
        // two is decided by the machine's state, not by the label that was
        // drawn — a menu left open across a state change would otherwise send
        // the wrong one.
        tray::ID_TALK => {
            let listening = app
                .state::<Voice>()
                .machine
                .lock()
                .expect("voice machine poisoned")
                .as_ref()
                .is_some_and(|m| m.state() == voice::State::Listening);
            on_voice_event(
                app,
                if listening {
                    VoiceEvent::Cancelled
                } else {
                    VoiceEvent::Summoned
                },
            );
        }
        tray::ID_CONNECT => open_connect_screen(app),
        // Forget the mode and go back to the welcome — the discoverable reset
        // (§28.1). It stops the sidecar and drops the socket but **never
        // touches the data dir**: "where should this run" is not "throw my
        // assistant away", and the two must not be one button.
        tray::ID_RESET => {
            let _ = forget(app.clone());
        }
        tray::ID_ENROL => open_enrolment(app),
        tray::ID_VOICE => {
            let Ok(settings) = voice_settings::update(app, |s| s.enabled = !s.enabled) else {
                return;
            };
            if settings.enabled {
                register_hotkey(app, &settings.hotkey);
            } else {
                unregister_hotkey(app, &settings.hotkey);
            }
            // The `voice` hello capability follows the switch, so the socket
            // is rebuilt rather than left claiming the old answer (§28.6).
            reconnect_device(app);
            voice::sync_settings(&app.state::<Voice>(), &settings);
            sync_wake_word(app);
            announce_voice(app, None);
        }
        tray::ID_WAKE => {
            let Ok(settings) = voice_settings::update(app, |s| s.wake_word = !s.wake_word) else {
                return;
            };
            voice::sync_settings(&app.state::<Voice>(), &settings);
            sync_wake_word(app);
            announce_voice(app, None);
        }
        tray::ID_QUIET => {
            let Ok(settings) = voice_settings::update(app, |s| s.quiet = !s.quiet) else {
                return;
            };
            voice::sync_settings(&app.state::<Voice>(), &settings);
            if settings.quiet {
                app.state::<Voice>().spoken.clear();
            }
            // Leaving quiet mode releases everything that was held (§28.6).
            if !settings.quiet {
                release_held(app);
            }
            // The wake word is inert in quiet mode (§28.6), so the detector
            // goes down with it rather than listening to a muted room.
            sync_wake_word(app);
            announce_voice(app, None);
        }
        other => {
            if let Some(choice) = tray::device_choice(other, tray::INPUT_PREFIX) {
                let _ = voice_settings::update(app, |s| s.input_device = choice);
            } else if let Some(choice) = tray::device_choice(other, tray::OUTPUT_PREFIX) {
                let _ = voice_settings::update(app, |s| s.output_device = choice);
            } else {
                return;
            }
            // Take effect now rather than "next time": the detector holds the
            // microphone open all day when the wake word is on, so without a
            // restart the new device would never be reached (§28.6).
            stop_detector(app);
            sync_wake_word(app);
            announce_voice(app, None);
        }
    }
}

/// Back to the first screen without forgetting anything (§28.1).
///
/// The chooser and the connect form live in `dist/index.html`, which is what
/// the window shows before a mode is picked. Reaching it from the tray is what
/// makes connect mode findable on an install that chose bundled on day one —
/// the mode and the stored connection are left alone until something is
/// actually chosen.
fn open_connect_screen(app: &tauri::AppHandle) {
    go_home(app, Some("connect"));
}

/// The "say it five times" screen (§28.6, V7.2), in its own small window so it
/// does not replace whatever the main one is showing.
fn open_enrolment(app: &tauri::AppHandle) {
    // The detector owns the microphone; enrolment needs it.
    stop_detector(app);
    if app.get_webview_window("enroll").is_none() {
        let built = tauri::WebviewWindowBuilder::new(
            app,
            "enroll",
            tauri::WebviewUrl::App("enroll.html".into()),
        )
        .title("Teach Turminder its name")
        .inner_size(460.0, 420.0)
        .resizable(false)
        .build();
        if built.is_err() {
            return;
        }
    }
    if let Some(window) = app.get_webview_window("enroll") {
        let _ = window.show();
        let _ = window.set_focus();
    }
}

/// Rebuild the device socket so its `hello` carries the current capabilities.
fn reconnect_device(app: &tauri::AppHandle) {
    let connection = current_connection(app);
    set_device(app, connection.as_ref());
}

/// Render everything quiet mode held back (§28.6).
fn release_held(app: &tauri::AppHandle) {
    let devices = app.state::<Devices>();
    let slot = devices.0.lock().expect("device slot poisoned");
    if let Some(client) = slot.as_ref() {
        client.release_held();
    }
}

fn register_hotkey(app: &tauri::AppHandle, chord: &str) {
    use tauri_plugin_global_shortcut::GlobalShortcutExt;
    match chord.parse::<Shortcut>() {
        Ok(shortcut) => {
            if let Err(e) = app.global_shortcut().register(shortcut) {
                // A chord another app already owns is a real, common outcome —
                // and it must not stop the shell from starting.
                eprintln!("cannot register {chord}: {e}");
            }
        }
        Err(e) => eprintln!("{chord} is not a shortcut: {e}"),
    }
}

fn unregister_hotkey(app: &tauri::AppHandle, chord: &str) {
    use tauri_plugin_global_shortcut::GlobalShortcutExt;
    if let Ok(shortcut) = chord.parse::<Shortcut>() {
        let _ = app.global_shortcut().unregister(shortcut);
    }
}

/// What the window asks about voice — the overlay and the connect screen both
/// want to know whether the microphone is on.
#[tauri::command]
fn voice_status(app: tauri::AppHandle) -> voice_settings::VoiceSettings {
    voice_settings::load(&app)
}

#[tauri::command]
fn set_voice_enabled(app: tauri::AppHandle, enabled: bool) -> Result<(), String> {
    let settings = voice_settings::update(&app, |s| s.enabled = enabled)?;
    if settings.enabled {
        register_hotkey(&app, &settings.hotkey);
    } else {
        unregister_hotkey(&app, &settings.hotkey);
    }
    reconnect_device(&app);
    voice::sync_settings(&app.state::<Voice>(), &settings);
    sync_wake_word(&app);
    announce_voice(&app, None);
    Ok(())
}

/* ── The wake word (§28.6, V7) ───────────────────────────────────────────── */

/// Start or stop the detector to match the settings.
///
/// Called from every switch that could change the answer, and idempotent, so
/// there is one place that decides whether this machine is listening — a
/// detector nobody remembered to stop is exactly what §28.6's containment
/// paragraph promises cannot happen.
fn sync_wake_word(app: &tauri::AppHandle) {
    let settings = voice_settings::load(app);
    let enrolled = voice_settings::wakeword_path(app)
        .map(|p| p.exists())
        .unwrap_or(false);
    let want = settings.enabled && settings.wake_word && enrolled;
    let voice = app.state::<Voice>();
    let mut slot = voice.detector.lock().expect("detector slot poisoned");

    if !want {
        if let Some(thread) = slot.take() {
            thread.stop();
        }
        return;
    }
    if slot.is_some() {
        return;
    }
    let Ok(path) = voice_settings::wakeword_path(app) else {
        return;
    };
    let handle = app.clone();
    match wake::DetectorThread::start(
        path.to_string_lossy().into_owned(),
        settings.sensitivity,
        settings.input_device.clone(),
        move || on_voice_event(&handle, VoiceEvent::WakeWord),
    ) {
        Ok(thread) => *slot = Some(thread),
        Err(message) => eprintln!("wake word off: {message}"),
    }
}

/// Listen until the speaker stops, then send it (§28.6).
///
/// The wake word's half of push-to-talk: nobody says the assistant's name and
/// then presses a key, so something has to decide the sentence ended. Runs on
/// a blocking thread and finishes by feeding the machine the same `HotkeyUp`
/// a released key would.
fn listen_until_done(app: &tauri::AppHandle) {
    let handle = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let mut pointer = wake::EndPointer::new(audio::CAPTURE_RATE);
        loop {
            std::thread::sleep(std::time::Duration::from_millis(50));
            let voice = handle.state::<Voice>();
            let fresh = {
                let mut slot = voice.capture.lock().expect("capture slot poisoned");
                let Some(lease) = slot.as_mut() else {
                    return; // the turn was cancelled, or taken over
                };
                lease.since()
            };
            if fresh.is_empty() {
                continue;
            }
            if let Some(ending) = pointer.push(&fresh) {
                if ending == wake::Ending::Silence && !pointer.heard_speech() {
                    // Room tone: drop the turn without a round trip. Taking the
                    // lease out is what releases the microphone.
                    let settings = voice_settings::load(&handle);
                    let voice = handle.state::<Voice>();
                    voice.capture.lock().expect("capture slot poisoned").take();
                    let mut machine = voice.machine_for(&settings);
                    machine.handle(VoiceEvent::Finished);
                    voice.put(machine);
                    announce_voice(&handle, None);
                    return;
                }
                on_voice_event(&handle, VoiceEvent::HotkeyUp);
                return;
            }
        }
    });
}

/// Enrolment state: the takes, held in memory until they are trained (§28.6).
#[derive(Default)]
struct Enrolment(std::sync::Mutex<Vec<Vec<u8>>>);

/// The name to say. From `welcome` (D.2) when the socket has had one, and the
/// drone's own name before that (§12.1).
#[tauri::command]
fn instance_name(app: tauri::AppHandle) -> String {
    let devices = app.state::<Devices>();
    let slot = devices.0.lock().expect("device slot poisoned");
    slot.as_ref()
        .and_then(|client| client.instance_name())
        .unwrap_or_else(|| "Turminder".to_string())
}

/// Record one take of the phrase, end-pointed like a real utterance.
///
/// Returns how many takes are held. The buffer lives in memory and nothing is
/// written until `enrol_train` — the takes are recordings of a person, and only
/// the derived template ever reaches the disk (§28.6).
#[tauri::command]
async fn enrol_record(app: tauri::AppHandle) -> Result<usize, String> {
    let settings = voice_settings::load(&app);
    let wav = tauri::async_runtime::spawn_blocking(move || -> Result<Vec<u8>, String> {
        let mut lease = audio::listen(settings.input_device.as_deref())?;
        let mut pointer = wake::EndPointer::new(audio::CAPTURE_RATE);
        let deadline = std::time::Instant::now()
            + std::time::Duration::from_secs(wake::MAX_UTTERANCE_S as u64);
        loop {
            std::thread::sleep(std::time::Duration::from_millis(40));
            let fresh = lease.since();
            if !fresh.is_empty() && pointer.push(&fresh).is_some() {
                break;
            }
            if std::time::Instant::now() >= deadline {
                break;
            }
        }
        if !pointer.heard_speech() {
            return Err("nothing was said — try again, a little louder".into());
        }
        Ok(lease.wav())
    })
    .await
    .map_err(|e| e.to_string())??;

    let takes = app.state::<Enrolment>();
    let mut held = takes.0.lock().expect("enrolment poisoned");
    held.push(wav);
    Ok(held.len())
}

/// Train from the takes and keep the model. The takes go out of scope here.
#[tauri::command]
fn enrol_train(app: tauri::AppHandle) -> Result<(), String> {
    let name = instance_name(app.clone());
    let takes = {
        let state = app.state::<Enrolment>();
        let mut held = state.0.lock().expect("enrolment poisoned");
        std::mem::take(&mut *held)
    };
    let path = voice_settings::wakeword_path(&app)?;
    wake::train(&name, takes, &path.to_string_lossy())?;
    // Trained is not the same as on: the tray's checkbox is the switch, and
    // enrolling is what makes it clickable. The phrase is remembered so the
    // tray can say what it is listening for (§28.6, V7.4).
    voice_settings::update(&app, |s| {
        s.wake_word = true;
        s.wake_phrase = Some(name.clone());
    })?;
    sync_wake_word(&app);
    announce_voice(&app, None);
    Ok(())
}

/// One more take, checked against the model that was just written (§28.6).
///
/// A model that cannot hear the voice that trained it is worse than no model,
/// because the tray would say it was ready.
#[tauri::command]
async fn enrol_verify(app: tauri::AppHandle) -> Result<bool, String> {
    let settings = voice_settings::load(&app);
    let path = voice_settings::wakeword_path(&app)?;
    tauri::async_runtime::spawn_blocking(move || -> Result<bool, String> {
        let mut lease = audio::listen(settings.input_device.as_deref())?;
        let mut pointer = wake::EndPointer::new(audio::CAPTURE_RATE);
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
        loop {
            std::thread::sleep(std::time::Duration::from_millis(40));
            let fresh = lease.since();
            if !fresh.is_empty() && pointer.push(&fresh).is_some() {
                break;
            }
            if std::time::Instant::now() >= deadline {
                break;
            }
        }
        // The whole take, not the tail: the detector scores a phrase, and
        // handing it the last frame would score half a word.
        let heard = audio::wav_samples_of(&lease.wav());
        wake::verify(&path.to_string_lossy(), &heard, settings.sensitivity)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Throw the takes away and start over.
#[tauri::command]
fn enrol_reset(app: tauri::AppHandle) {
    app.state::<Enrolment>()
        .0
        .lock()
        .expect("enrolment poisoned")
        .clear();
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(Devices::default())
        .manage(Sidecars::default())
        .manage(sidecar::LastState::default())
        .manage(Voice::default())
        .manage(Enrolment::default())
        .manage(HomeUrl::default())
        .manage(Overlay::default())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_autostart::init(
            MacosLauncher::LaunchAgent,
            None,
        ))
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                // Both edges: press starts listening, release ends the
                // utterance (§28.6). The plugin reports them separately, which
                // is exactly the shape push-to-talk wants.
                .with_handler(|app, _shortcut, event| {
                    let voice_event = match event.state() {
                        ShortcutState::Pressed => VoiceEvent::HotkeyDown,
                        ShortcutState::Released => VoiceEvent::HotkeyUp,
                    };
                    on_voice_event(app, voice_event);
                })
                .build(),
        )
        .invoke_handler(tauri::generate_handler![
            status,
            boot_state,
            choose_bundled,
            choose_connect,
            connect_to,
            forget,
            set_autostart,
            autostart_enabled,
            voice_status,
            set_voice_enabled,
            instance_name,
            enrol_record,
            enrol_train,
            enrol_verify,
            enrol_reset,
            overlay_state
        ])
        .setup(|app| {
            let handle = app.handle().clone();
            // Before anything navigates away: this is the only moment the
            // shell's own origin is on the window to be read (§28.1).
            if let Some(window) = app.get_webview_window("main") {
                if let Ok(url) = window.url() {
                    *app.state::<HomeUrl>().0.lock().expect("home url poisoned") = Some(url);
                }
            }
            // Tray first: closing the window must leave something to come back
            // to, and a shell with no tray and no window is a process nobody
            // can reach (§28.2).
            let settings = voice_settings::load(&handle);
            let menu = tray::build(&handle, &settings, voice::State::Idle)?;
            TrayIconBuilder::with_id(tray::TRAY_ID)
                .icon(app.default_window_icon().unwrap().clone())
                .tooltip("Turminder")
                .menu(&menu)
                .on_menu_event(move |app, event| on_tray_click(app, event.id.as_ref()))
                .build(app)?;
            // Registered only when voice is on: a global hotkey an install is
            // not using is a chord stolen from whatever else wanted it.
            if settings.enabled {
                register_hotkey(&handle, &settings.hotkey);
            }
            sync_wake_word(&handle);

            match mode::load(&handle) {
                // Checked here, before anything can recreate it: the sidecar
                // scaffolds a data dir on boot (§12.1), so asking later would
                // race with the very thing that hides the answer.
                Some(Mode::Bundled) if !bundled_data_dir_exists() => {
                    mode::clear(&handle);
                }
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
    use super::is_configured;

    /// §28.1: the welcome screen is for a shell that cannot reach an assistant,
    /// and "has a mode" is not the same question.
    #[test]
    fn a_mode_with_nothing_behind_it_is_not_configured() {
        use crate::mode::Mode;
        // Fresh install: no mode, no anything.
        assert!(!is_configured(None, false, false));
        // Bundled is configured by its data dir. Deleting that is what somebody
        // does to start over — and mode.json lives somewhere else entirely, so
        // without this the reset silently half-works and lands them on the
        // service's model form (Christer, 2026-08-30).
        assert!(is_configured(Some(Mode::Bundled), false, true));
        assert!(!is_configured(Some(Mode::Bundled), false, false));
        // Connect is a URL somebody typed. Without it there is nothing to point
        // at, however emphatically mode.json says "connect" — a cleared vault,
        // a `forget`, or an app closed before the link was pasted. Its data dir
        // is somebody else's machine and says nothing either way.
        assert!(!is_configured(Some(Mode::Connect), false, true));
        assert!(is_configured(Some(Mode::Connect), true, false));
    }

    /// The tray sends the window home with a pane name in the fragment, and the
    /// page has to know all of them. A renamed pane would route to nothing and
    /// show a blank window — the same silent-nothing failure as an unregistered
    /// command, which is why it is a test rather than a convention.
    #[test]
    fn every_pane_the_shell_asks_for_is_one_the_page_has() {
        let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"));
        let screen = std::fs::read_to_string(root.join("../dist/index.html")).unwrap();
        let source = std::fs::read_to_string(root.join("src/lib.rs")).unwrap();
        let panes = screen
            .split("const PANES = [")
            .nth(1)
            .and_then(|rest| rest.split(']').next())
            .expect("the page's PANES list moved");
        for asked in source.split("go_home(app, Some(\"").skip(1) {
            let name = asked.split('"').next().expect("unterminated pane name");
            assert!(
                panes.contains(&format!("'{name}'")),
                "the shell asks for pane `{name}`, which index.html does not have ({panes})"
            );
        }
    }

    /// Every menu id the tray defines is handled in `on_tray_click`.
    ///
    /// Twice now the reported bug has been "this menu item does nothing"
    /// (Christer, 2026-08-30) — once because a navigation resolved against the
    /// wrong origin, once because an item was added to the menu and never
    /// wired to the dispatch. The second kind is catchable from the source and
    /// this catches it. Device submenu entries are excluded: their ids carry a
    /// device name and are matched by prefix in the fallthrough arm.
    #[test]
    fn every_tray_item_is_wired_to_something() {
        let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"));
        let tray = std::fs::read_to_string(root.join("src/tray.rs")).unwrap();
        let dispatch = std::fs::read_to_string(root.join("src/lib.rs")).unwrap();
        let mut checked = 0;
        for line in tray.lines() {
            let Some(rest) = line.trim().strip_prefix("pub const ID_") else {
                continue;
            };
            let name = rest.split(':').next().expect("a const name").trim();
            checked += 1;
            assert!(
                dispatch.contains(&format!("tray::ID_{name} =>")),
                "tray::ID_{name} is in the menu and in no match arm — clicking it does nothing"
            );
        }
        assert!(
            checked >= 6,
            "only found {checked} menu ids; did the naming change?"
        );
    }

    /// The shell's own pages reach it through `window.__TAURI__`, which Tauri
    /// injects **only** when `app.withGlobalTauri` is set — and it defaults to
    /// off. Without it a page's very first statement throws, every handler
    /// below it goes unbound, and the buttons do nothing whatsoever, with no
    /// error anywhere a user can see. Two files have to agree and nothing at
    /// runtime says so, which is exactly the shape of bug a test is for.
    #[test]
    fn the_global_tauri_bridge_is_switched_on() {
        let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"));
        let config = std::fs::read_to_string(root.join("tauri.conf.json")).unwrap();
        assert!(
            config.contains("\"withGlobalTauri\": true"),
            "every page in dist/ uses window.__TAURI__, so tauri.conf.json must set \
             app.withGlobalTauri — without it they are all inert"
        );
    }

    /// Every `invoke` name any of the shell's own pages calls must be a
    /// command the shell registered. A typo here is the same silent-nothing
    /// failure as above, one layer down — and the enrolment screen (§28.6) is
    /// a page nobody opens by accident, so a broken one could sit for months.
    #[test]
    fn every_command_the_screens_call_exists() {
        let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"));
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
        let mut total = 0;
        for page in ["index.html", "enroll.html", "overlay.html"] {
            let screen = std::fs::read_to_string(root.join("../dist").join(page)).unwrap();
            for piece in screen.split("invoke('").skip(1) {
                let name = piece.split('\'').next().expect("unterminated invoke name");
                total += 1;
                assert!(
                    registered.contains(&name),
                    "{page} invokes `{name}`, which is not in generate_handler! ({registered:?})"
                );
            }
        }
        assert!(total > 0, "the screens invoke nothing at all");
    }

    /// The overlay and the enrolment screen reach the shell the same way the
    /// first screen does, and break the same way without it.
    #[test]
    fn every_screen_can_reach_the_shell() {
        let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"));
        for page in ["index.html", "enroll.html", "overlay.html"] {
            let screen = std::fs::read_to_string(root.join("../dist").join(page)).unwrap();
            assert!(
                screen.contains("__TAURI__"),
                "{page} must talk to the shell; if that changed, change this test"
            );
        }
    }
}
