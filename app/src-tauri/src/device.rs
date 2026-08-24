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

use std::sync::Arc;

use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use tauri::AppHandle;
use tauri_plugin_notification::NotificationExt;
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::Message;

use crate::connect::Connection;

/// One outbound frame, from a notification click back to the service.
pub type Outbound = Value;

pub struct DeviceClient {
    pub sender: mpsc::UnboundedSender<Outbound>,
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
                            "capabilities": ["notify.actions"],
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
                                        handle_frame(&app, &tx, &text);
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
    DeviceClient { sender, task }
}

/// A `delivery` frame becomes a notification; everything else is the window's.
fn handle_frame(app: &AppHandle, tx: &mpsc::UnboundedSender<Outbound>, text: &str) {
    let frame: Value = match serde_json::from_str(text) {
        Ok(value) => value,
        Err(_) => return,
    };
    if frame.get("type").and_then(Value::as_str) != Some("delivery") {
        return;
    }
    let payload = frame.get("payload").cloned().unwrap_or(Value::Null);
    let body = payload.get("payload").cloned().unwrap_or(Value::Null);
    let title = body
        .get("title")
        .and_then(Value::as_str)
        .unwrap_or("Turminder")
        .to_string();
    let text_body = body.get("body").and_then(Value::as_str).unwrap_or("").to_string();

    let _ = app
        .notification()
        .builder()
        .title(&title)
        .body(&text_body)
        .show();

    // Acking on display is honest for a desktop notification: it has been
    // delivered to a human's screen, which is what the outbox is asking about
    // (§7.1). The action round-trip is separate, and only happens if clicked.
    if let Some(id) = payload.get("delivery_id").and_then(Value::as_str) {
        let _ = tx.send(json!({
            "id": format!("ack-{id}"),
            "type": "ack",
            "payload": { "delivery_id": id }
        }));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

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
