//! The tray's quick note box (§28.7): a line typed and left alone, filed as a
//! `note.captured` event with nothing else attached — the extension's capture
//! (§29.3) minus the page.
//!
//! This module is the pure half: where the box should open, and what one
//! `POST /api/events` looks like. The window itself and the tray wiring stay
//! in `lib.rs`, the same split `voice.rs` and `on_voice_event` already keep.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use crate::connect::Connection;
use crate::http;

/// A monitor's work area, or a tray icon's rectangle, in physical pixels.
/// Plain numbers rather than a platform type, so the placement math below
/// takes no dependency on a window, a monitor or a platform (§28.7 asks for
/// it to be tested as a pure function).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Rect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Point {
    pub x: f64,
    pub y: f64,
}

/// Top-left corner for a window of `size`, anchored to the tray icon's own
/// rectangle — what macOS and Windows report on a tray click, and the shell
/// keeps the last one it was given (§28.7). Below the rect when the tray
/// sits in the top half of the work area, above it when the tray sits in the
/// bottom half: a StatusNotifierItem on Linux never reports one at all,
/// which is what `place_at_cursor` is for.
pub fn place_below_or_above(tray: Rect, size: (f64, f64), work_area: Rect) -> Point {
    let tray_mid_y = tray.y + tray.height / 2.0;
    let work_mid_y = work_area.y + work_area.height / 2.0;
    let y = if tray_mid_y < work_mid_y {
        tray.y + tray.height
    } else {
        tray.y - size.1
    };
    clamp(Point { x: tray.x, y }, size, work_area)
}

/// Top-left corner for a window of `size`, anchored to the cursor: the
/// fallback for a Linux tray, which carries no rectangle on a menu click at
/// all — the cursor is next to the tray, because the menu was just opened
/// from it (§28.7).
pub fn place_at_cursor(cursor: Point, size: (f64, f64), work_area: Rect) -> Point {
    clamp(cursor, size, work_area)
}

/// Keep the window entirely inside the monitor's work area (§28.7) — the
/// rule both placements above end with. Written with `max`/`min` rather than
/// `f64::clamp` because a window wider or taller than the work area would
/// hand that a lower bound above its upper one, which panics; here it just
/// pins the window to the near edge instead.
fn clamp(point: Point, size: (f64, f64), work_area: Rect) -> Point {
    let max_x = (work_area.x + work_area.width - size.0).max(work_area.x);
    let max_y = (work_area.y + work_area.height - size.1).max(work_area.y);
    Point {
        x: point.x.max(work_area.x).min(max_x),
        y: point.y.max(work_area.y).min(max_y),
    }
}

/// One note in flight: the text it was sent with and the key that identifies
/// it, kept so a retry of the *same* text reuses the *same* key rather than
/// risking two todos for one note (§28.7). Cleared on success; a changed
/// text — the person edited the box before retrying — mints a fresh one.
#[derive(Default)]
pub struct Pending(Mutex<Option<(String, String)>>);

static COUNTER: AtomicU64 = AtomicU64::new(0);

/// A key unique enough to tell one note from the next. Uniqueness is the
/// whole job here, not unguessability, so process id plus wall-clock time
/// plus a counter is enough — the same reasoning `device::now_iso` uses to
/// stay off a crate for one identifier (App. J).
fn mint_key() -> String {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let n = COUNTER.fetch_add(1, Ordering::Relaxed);
    format!("quicknote-{}-{nanos}-{n}", std::process::id())
}

/// The idempotency key for this send: the one already pending if `text`
/// matches what was last tried, or a freshly minted one otherwise.
pub fn key_for(pending: &Pending, text: &str) -> String {
    let mut slot = pending.0.lock().expect("quick note pending poisoned");
    if let Some((prev_text, prev_key)) = slot.as_ref() {
        if prev_text == text {
            return prev_key.clone();
        }
    }
    let key = mint_key();
    *slot = Some((text.to_string(), key.clone()));
    key
}

/// A note landed: forget it, so the next one — even an identical sentence —
/// gets its own key.
pub fn clear(pending: &Pending) {
    *pending.0.lock().expect("quick note pending poisoned") = None;
}

const UNREACHABLE: &str = "Couldn't reach Turminder — is it running? Your note is still here.";
const ROTATED: &str =
    "This shell's connection was rotated — reconnect from the tray's \"Connect to another instance…\". Your note is still here.";
const TOO_LONG: &str = "That note is too long. Your note is still here.";

/// One note, over the wire (§28.7): the same `POST /api/events` route the
/// browser extension's capture uses, with no page attached and the shell's
/// own vault token — the page never sees it, never mints the key, and never
/// speaks to the service directly.
pub fn send(connection: &Connection, text: &str, idempotency_key: &str) -> Result<(), String> {
    let body = serde_json::json!({
        "type": "note.captured",
        "payload": { "text": text },
        "idempotency_key": idempotency_key,
        "serialization_key": "note.captured",
    })
    .to_string();
    let response = http::post(
        &format!("{}/api/events", connection.base_url),
        Some(&connection.token),
        http::Body {
            content_type: "application/json",
            bytes: body.as_bytes(),
        },
        std::time::Duration::from_secs(10),
        None,
    )
    .map_err(|_| UNREACHABLE.to_string())?;
    match response.status {
        200..=299 => Ok(()),
        403 => Err(ROTATED.to_string()),
        413 => Err(TOO_LONG.to_string()),
        other => Err(format!(
            "the service answered {other} — your note is still here"
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const WORK_AREA: Rect = Rect {
        x: 0.0,
        y: 0.0,
        width: 1920.0,
        height: 1080.0,
    };
    const SIZE: (f64, f64) = (360.0, 150.0);

    #[test]
    fn opens_below_a_tray_at_the_top_of_the_screen() {
        // Away from either edge, so the clamp (tested separately below) has
        // nothing to do and this is purely the above/below decision.
        let tray = Rect {
            x: 800.0,
            y: 4.0,
            width: 24.0,
            height: 24.0,
        };
        let point = place_below_or_above(tray, SIZE, WORK_AREA);
        assert_eq!(point.y, tray.y + tray.height);
        assert_eq!(point.x, tray.x);
    }

    #[test]
    fn opens_above_a_tray_at_the_bottom_of_the_screen() {
        let tray = Rect {
            x: 1800.0,
            y: 1050.0,
            width: 24.0,
            height: 24.0,
        };
        let point = place_below_or_above(tray, SIZE, WORK_AREA);
        assert_eq!(point.y, tray.y - SIZE.1);
    }

    #[test]
    fn a_tray_in_the_corner_still_keeps_the_window_on_screen() {
        // Flush with the right edge: opening straight down from `tray.x`
        // would put most of the window off screen without the clamp.
        let tray = Rect {
            x: 1910.0,
            y: 4.0,
            width: 24.0,
            height: 24.0,
        };
        let point = place_below_or_above(tray, SIZE, WORK_AREA);
        assert!(point.x + SIZE.0 <= WORK_AREA.x + WORK_AREA.width);
        assert!(point.x >= WORK_AREA.x);
    }

    #[test]
    fn falls_back_to_the_cursor_when_the_platform_gives_no_rect() {
        let cursor = Point { x: 900.0, y: 500.0 };
        let point = place_at_cursor(cursor, SIZE, WORK_AREA);
        assert_eq!(point, cursor);
    }

    #[test]
    fn the_cursor_fallback_clamps_too() {
        let cursor = Point {
            x: 10.0,
            y: 1075.0, // near the bottom-left corner
        };
        let point = place_at_cursor(cursor, SIZE, WORK_AREA);
        assert!(point.y + SIZE.1 <= WORK_AREA.y + WORK_AREA.height);
        assert!(point.x >= WORK_AREA.x);
    }

    #[test]
    fn the_same_text_reuses_the_key_but_a_changed_one_does_not() {
        let pending = Pending::default();
        let first = key_for(&pending, "renew the passport");
        let retry = key_for(&pending, "renew the passport");
        assert_eq!(
            first, retry,
            "a retry of the same text must not double-file it"
        );
        let edited = key_for(&pending, "renew the passport before March");
        assert_ne!(edited, first, "different text is a different note");
    }

    #[test]
    fn clearing_forgets_the_key_even_for_identical_text() {
        let pending = Pending::default();
        let first = key_for(&pending, "renew the passport");
        clear(&pending);
        let next = key_for(&pending, "renew the passport");
        assert_ne!(
            first, next,
            "a note that already landed is not the same note again"
        );
    }
}
