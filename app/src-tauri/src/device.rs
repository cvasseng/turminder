//! The shell as an App. D device (§28.2).
//!
//! The window shows the chat UI, which handles its own frames — but a closed
//! window shows nothing, and a scheduled reminder that only arrives when you
//! are already looking is not a reminder. So the shell holds its own WS
//! connection: it says hello as a `notify.actions` device, raises a native
//! notification per `delivery` frame, and sends the click back as a
//! `notification.action` event.
//!
//! Same frames as every other transport (App. D.4): there is no shell-specific
//! protocol, and the service never learns it is talking to a desktop app.

use std::sync::{Arc, Mutex};

use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use tauri::AppHandle;
use tauri_plugin_notification::NotificationExt;
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::Message;

use crate::connect::Connection;
use crate::voice_settings;

/// One outbound frame, from a notification click back to the service.
pub type Outbound = Value;

/// A delivery quiet mode kept back (§28.6).
///
/// Held, **not acked**: §7.1 says a delivery nobody could see stays unacked, so
/// it is still the outbox's problem and still replays if the shell restarts.
/// The expiry rides along because a reminder released an hour late is worse
/// than one that was never shown.
#[derive(Debug, Clone)]
pub struct Held {
    pub delivery_id: String,
    pub title: String,
    pub body: String,
    pub expires_at: String,
}

pub struct DeviceClient {
    pub sender: mpsc::UnboundedSender<Outbound>,
    held: Arc<Mutex<Vec<Held>>>,
    /// From `welcome` (D.2): what this instance calls itself. The enrolment
    /// screen asks the user to say it (§28.6), so it has to come from the
    /// service rather than be guessed.
    instance_name: Arc<Mutex<Option<String>>>,
    app: AppHandle,
    task: tauri::async_runtime::JoinHandle<()>,
}

impl DeviceClient {
    /// Drop the socket and stop reconnecting.
    ///
    /// Reconnecting forever is the right default for a shell whose service
    /// reboots — but it is wrong across a *change of service*, and the shell
    /// changes service on `connect_to` and `forget`. Two live clients would
    /// mean two notifications per delivery, each acking the other's, so the
    /// old one is aborted before the new one exists.
    pub fn stop(&self) {
        self.task.abort();
    }

    /// Quiet mode ended: show everything that was held and has not expired,
    /// in the order it arrived, acking each after display exactly as a live
    /// delivery is (§28.6). Expired ones are dropped silently and logged —
    /// they were held, not lost, and their moment has passed.
    pub fn release_held(&self) {
        let taken: Vec<Held> = std::mem::take(&mut *self.held.lock().expect("held poisoned"));
        let (live, expired) = partition_held(taken, &now_iso());
        for delivery in expired {
            eprintln!("dropped an expired held delivery: {}", delivery.delivery_id);
        }
        for delivery in live {
            render(&self.app, &delivery.title, &delivery.body);
            let _ = self.sender.send(ack(&delivery.delivery_id));
            // Spoken in the order they arrived (§28.6), through the same queue
            // a live delivery uses — so a burst released at once is a sequence
            // rather than a chorus.
            crate::speak_delivery(&self.app, &delivery.delivery_id);
        }
    }

    /// What is being held right now — the count the tray could show, and what
    /// the tests assert on.
    pub fn held(&self) -> Vec<Held> {
        self.held.lock().expect("held poisoned").clone()
    }

    /// The name the service answers to, once it has said hello.
    pub fn instance_name(&self) -> Option<String> {
        self.instance_name.lock().expect("name poisoned").clone()
    }
}

/// Split what was held into what is still worth showing and what is not,
/// keeping arrival order (§28.6).
///
/// Its own function because it is the whole of the policy and the only part a
/// test can reach: everything around it needs a live notification daemon.
pub fn partition_held(held: Vec<Held>, now: &str) -> (Vec<Held>, Vec<Held>) {
    held.into_iter()
        .partition(|d| d.expires_at.is_empty() || d.expires_at.as_str() > now)
}

/// ISO 8601 UTC to the second, for comparing against a delivery's `expires_at`.
///
/// String comparison rather than a date type: ISO 8601 UTC sorts
/// lexicographically by construction, and the alternative is a date crate for
/// one comparison (App. J).
pub fn now_iso() -> String {
    let seconds = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let days = seconds / 86_400;
    let time = seconds % 86_400;
    let (year, month, day) = civil_from_days(days as i64);
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}.000Z",
        time / 3600,
        (time % 3600) / 60,
        time % 60
    )
}

/// Howard Hinnant's `civil_from_days`, the standard branchless conversion.
fn civil_from_days(days: i64) -> (i64, u32, u32) {
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = (z - era * 146_097) as u64;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if m <= 2 { y + 1 } else { y }, m, d)
}

/// The websocket URL for a connection — `http` becomes `ws`, and the token
/// rides the query because browsers cannot set headers on an upgrade (App. D).
pub fn ws_url(connection: &Connection) -> String {
    let base = connection
        .base_url
        .replacen("https://", "wss://", 1)
        .replacen("http://", "ws://", 1);
    format!("{base}/ws?token={}", urlencode(&connection.token))
}

fn urlencode(value: &str) -> String {
    value
        .bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                (b as char).to_string()
            }
            other => format!("%{other:02X}"),
        })
        .collect()
}

/// Connect, greet, and keep reconnecting. Runs until the process exits.
pub fn spawn(app: AppHandle, connection: Connection) -> DeviceClient {
    let (tx, mut rx) = mpsc::unbounded_channel::<Outbound>();
    let sender = tx.clone();
    let held: Arc<Mutex<Vec<Held>>> = Arc::new(Mutex::new(Vec::new()));
    let held_for_task = held.clone();
    let instance_name: Arc<Mutex<Option<String>>> = Arc::new(Mutex::new(None));
    let name_for_task = instance_name.clone();
    let app_for_client = app.clone();
    // Read once, at connect: the capability set travels in `hello`, so
    // toggling voice reconnects rather than lying about what this device does.
    let voice_on = voice_settings::load(&app).enabled;
    let task = tauri::async_runtime::spawn(async move {
        let connection = Arc::new(connection);
        let mut backoff = 1u64;
        loop {
            match tokio_tungstenite::connect_async(ws_url(&connection)).await {
                Ok((stream, _)) => {
                    backoff = 1;
                    let (mut write, mut read) = stream.split();
                    let hello = json!({
                        "id": "shell-hello",
                        "type": "hello",
                        "payload": {
                            "device": connection.device,
                            // Notifications only: the window does chat, and a
                            // second chat consumer would double every delta.
                            // `voice` joins it when the microphone is on
                            // (§28.6, D.1) — it changes nothing about what the
                            // service sends, only what this device says it can
                            // do with it.
                            "capabilities": if voice_on {
                                json!(["notify.actions", "voice"])
                            } else {
                                json!(["notify.actions"])
                            },
                            "last_seen": 0,
                        }
                    });
                    if write.send(Message::Text(hello.to_string())).await.is_err() {
                        continue;
                    }
                    loop {
                        tokio::select! {
                            outbound = rx.recv() => {
                                match outbound {
                                    Some(frame) => {
                                        if write.send(Message::Text(frame.to_string())).await.is_err() {
                                            break;
                                        }
                                    }
                                    None => return,
                                }
                            }
                            incoming = read.next() => {
                                match incoming {
                                    Some(Ok(Message::Text(text))) => {
                                        handle_frame(&app, &tx, &held_for_task, &name_for_task, &text);
                                    }
                                    Some(Ok(_)) => {}
                                    _ => break,
                                }
                            }
                        }
                    }
                }
                Err(_) => {
                    // The service is not up yet, or the token was revoked. Either
                    // way the window says so; the shell just keeps trying, slower.
                    tokio::time::sleep(std::time::Duration::from_secs(backoff)).await;
                    backoff = (backoff * 2).min(60);
                }
            }
        }
    });
    DeviceClient {
        sender,
        held,
        instance_name,
        app: app_for_client,
        task,
    }
}

/// A `delivery` frame becomes a notification; everything else is the window's.
fn handle_frame(
    app: &AppHandle,
    tx: &mpsc::UnboundedSender<Outbound>,
    held: &Arc<Mutex<Vec<Held>>>,
    instance_name: &Arc<Mutex<Option<String>>>,
    text: &str,
) {
    let frame: Value = match serde_json::from_str(text) {
        Ok(value) => value,
        Err(_) => return,
    };
    match frame.get("type").and_then(Value::as_str) {
        Some("welcome") => {
            // Kept because the enrolment screen has to ask the user to say the
            // right name (§28.6) and the shell has no other source for it.
            let name = frame
                .get("payload")
                .and_then(|p| p.get("instance_name"))
                .and_then(Value::as_str)
                .map(str::to_string);
            *instance_name.lock().expect("name poisoned") = name;
            return;
        }
        Some("delivery") => {}
        _ => return,
    }
    let payload = frame.get("payload").cloned().unwrap_or(Value::Null);
    let body = payload.get("payload").cloned().unwrap_or(Value::Null);
    let title = body
        .get("title")
        .and_then(Value::as_str)
        .unwrap_or("Turminder")
        .to_string();
    let text_body = body
        .get("body")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let delivery_id = payload
        .get("delivery_id")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();

    let settings = voice_settings::load(app);
    if settings.quiet {
        // Held, not acked, not rendered, not spoken (§28.6): a delivery nobody
        // could see must come back when the room is listening again.
        held.lock().expect("held poisoned").push(Held {
            delivery_id,
            title,
            body: text_body,
            expires_at: payload
                .get("expires_at")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string(),
        });
        return;
    }

    render(app, &title, &text_body);

    // Acking on display is honest for a desktop notification: it has been
    // delivered to a human's screen, which is what the outbox is asking about
    // (§7.1). The action round-trip is separate, and only happens if clicked.
    if !delivery_id.is_empty() {
        let _ = tx.send(ack(&delivery_id));
        // …and then it is read aloud, if this shell has a voice (§33.3, V8.2).
        crate::speak_delivery(app, &delivery_id);
    }
}

fn render(app: &AppHandle, title: &str, body: &str) {
    let _ = app.notification().builder().title(title).body(body).show();
}

fn ack(delivery_id: &str) -> Outbound {
    json!({
        "id": format!("ack-{delivery_id}"),
        "type": "ack",
        "payload": { "delivery_id": delivery_id }
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn held(id: &str, expires_at: &str) -> Held {
        Held {
            delivery_id: id.into(),
            title: "Bin day".into(),
            body: "tomorrow".into(),
            expires_at: expires_at.into(),
        }
    }

    #[test]
    fn quiet_mode_releases_what_is_still_worth_showing_in_order() {
        // Nothing is lost and nothing is faked (§28.6): what has not expired
        // comes back in the order it arrived, and what has is dropped.
        let (live, expired) = partition_held(
            vec![
                held("a", "2026-08-30T10:00:00.000Z"),
                held("b", "2026-08-30T08:00:00.000Z"),
                held("c", "2026-08-30T12:00:00.000Z"),
            ],
            "2026-08-30T09:00:00.000Z",
        );
        assert_eq!(
            live.iter()
                .map(|d| d.delivery_id.as_str())
                .collect::<Vec<_>>(),
            vec!["a", "c"]
        );
        assert_eq!(
            expired
                .iter()
                .map(|d| d.delivery_id.as_str())
                .collect::<Vec<_>>(),
            vec!["b"]
        );
    }

    #[test]
    fn a_delivery_with_no_expiry_is_never_dropped() {
        // A frame that carried no `expires_at` is a frame this shell cannot
        // date; showing it late beats binning something the user never saw.
        let (live, expired) = partition_held(vec![held("a", "")], "2999-01-01T00:00:00.000Z");
        assert_eq!(live.len(), 1);
        assert!(expired.is_empty());
    }

    #[test]
    fn the_clock_reads_as_an_iso_timestamp_that_sorts() {
        // Compared against `expires_at` as a *string*, so the format has to be
        // exactly the service's (App. C: ISO 8601 UTC with milliseconds).
        let now = now_iso();
        assert_eq!(now.len(), 24, "{now}");
        assert!(now.ends_with("Z") && now.contains('T'), "{now}");
        assert!(
            now.as_str() > "2026-01-01T00:00:00.000Z",
            "the clock is wrong: {now}"
        );
        assert!(
            now.as_str() < "2100-01-01T00:00:00.000Z",
            "the clock is wrong: {now}"
        );
        // The one property the comparison depends on: later sorts later.
        assert!(now_iso() >= now);
    }

    #[test]
    fn the_civil_calendar_agrees_with_known_dates() {
        // Hand-rolled because a date crate for one comparison is a dependency
        // (App. J) — so the arithmetic is pinned against dates anybody can check.
        assert_eq!(civil_from_days(0), (1970, 1, 1));
        assert_eq!(civil_from_days(19_723), (2024, 1, 1)); // a leap year
        assert_eq!(civil_from_days(19_782), (2024, 2, 29)); // and its extra day
        assert_eq!(civil_from_days(20_696), (2026, 8, 31));
        assert_eq!(civil_from_days(20_697), (2026, 9, 1)); // and over the month boundary
    }

    #[test]
    fn builds_a_ws_url_from_either_scheme() {
        let http = Connection {
            base_url: "http://box:7787".into(),
            token: "a b".into(),
            device: "desktop".into(),
        };
        assert_eq!(ws_url(&http), "ws://box:7787/ws?token=a%20b");
        let https = Connection {
            base_url: "https://turminder.example.net".into(),
            token: "t".into(),
            device: "desktop".into(),
        };
        assert_eq!(ws_url(&https), "wss://turminder.example.net/ws?token=t");
    }
}
