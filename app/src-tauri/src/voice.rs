//! Talking to the assistant from the desk (§28.6, §33).
//!
//! One state machine and one worker thread. The machine is pure — it takes an
//! event and returns what to do — so the whole of the *policy* (what a press
//! does while already speaking; whether a wake word fires in quiet mode) is
//! testable without a sound card. The plumbing underneath it owns the
//! microphone, the speaker and the one HTTP request.
//!
//! **Nothing leaves the machine before a trigger fires** (§28.6): the
//! microphone is opened when the hotkey goes down and closed when it comes up,
//! the samples live in memory, and exactly one WAV is posted.

use std::sync::{Arc, Mutex};

use crate::audio::{self, Speaker};
use crate::connect::Connection;
use crate::http;
use crate::voice_settings::{self, VoiceSettings};

/// Where a voice turn is (§28.6). `Quiet` is not a state — it is a flag on the
/// settings, because the hotkey works in quiet mode and a state would have to
/// remember what to go back to.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum State {
    Idle,
    Listening,
    Uploading,
    Speaking,
}

impl State {
    /// The tray icon variant for this state (§28.6). `quiet` wins over
    /// everything: a shell that shows "listening" while it is muted is lying
    /// about which of the two the user is looking at.
    pub fn icon(self, quiet: bool) -> &'static str {
        if quiet {
            return "quiet";
        }
        match self {
            State::Idle => "idle",
            State::Listening => "listening",
            State::Uploading => "thinking",
            State::Speaking => "speaking",
        }
    }
}

/// What happened. Everything that can move the machine, in one vocabulary.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Event {
    /// The push-to-talk key went down.
    HotkeyDown,
    /// …and came up. The release is the end of the utterance (§28.6): no
    /// silence detection, the fastest path.
    HotkeyUp,
    /// The wake word fired (V7).
    WakeWord,
    /// "Talk to it" was clicked in the tray (§28.6). Push-to-talk without the
    /// key and the wake word without the name: the same turn, started
    /// deliberately, so it answers from quiet mode and with the wake word off.
    Summoned,
    /// Stop listening and send nothing. A click has no release to hold, so it
    /// needs a way out that is not "wait thirty seconds".
    Cancelled,
    /// The utterance was sent and the reply is arriving.
    ReplyStarted,
    /// The reply finished playing, or there was none.
    Finished,
}

/// What to do about it. The caller executes these; the machine never touches a
/// device, which is what makes the transitions testable.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Action {
    /// Chime (unless quiet) and open the microphone.
    StartListening,
    /// Close the microphone and post what was heard.
    SendUtterance,
    /// Close the microphone and throw it away.
    Discard,
    /// Nothing to do — the trigger arrived at a moment that has no meaning.
    Ignore,
}

/// The transitions of §28.6, and nothing else.
#[derive(Debug, Clone)]
pub struct Machine {
    state: State,
    /// Wake word and spoken deliveries are silenced by quiet mode; the hotkey
    /// is not — pressing it is the opposite of being disturbed.
    pub quiet: bool,
    pub wake_word: bool,
}

impl Machine {
    pub fn new(settings: &VoiceSettings) -> Self {
        Self {
            state: State::Idle,
            quiet: settings.quiet,
            wake_word: settings.wake_word,
        }
    }

    pub fn state(&self) -> State {
        self.state
    }

    pub fn handle(&mut self, event: Event) -> Action {
        match (self.state, event) {
            // The hotkey works from idle and from nowhere else: pressing it
            // while a reply is playing would mean barge-in, which is §16.
            (State::Idle, Event::HotkeyDown) => {
                self.state = State::Listening;
                Action::StartListening
            }
            (State::Listening, Event::HotkeyUp) => {
                self.state = State::Uploading;
                Action::SendUtterance
            }
            // Enabled, not quiet, and idle — three conditions, because a
            // detector firing at the television while the user is asleep is
            // the failure this mode exists to prevent (§28.6).
            (State::Idle, Event::WakeWord) if self.wake_word && !self.quiet => {
                self.state = State::Listening;
                Action::StartListening
            }
            // Summoning has none of those conditions but idleness: somebody
            // reached for the tray and chose this, which is the same argument
            // that lets the hotkey work in quiet mode. It is also the only way
            // in on an install that never enrolled a wake word.
            (State::Idle, Event::Summoned) => {
                self.state = State::Listening;
                Action::StartListening
            }
            (State::Listening, Event::Cancelled) => {
                self.state = State::Idle;
                Action::Discard
            }
            (State::Uploading, Event::ReplyStarted) => {
                self.state = State::Speaking;
                Action::Ignore
            }
            (_, Event::Finished) => {
                self.state = State::Idle;
                Action::Ignore
            }
            // A key-up with no key-down (the shortcut plugin fires on both
            // edges and the app may have started with the key held), a wake
            // word mid-reply, a second press while uploading: all no-ops, and
            // deliberately not errors.
            _ => Action::Ignore,
        }
    }

    /// Quiet mode arriving mid-turn does not cancel the turn: the user asked
    /// for this one. It silences what comes *next*.
    pub fn set_quiet(&mut self, quiet: bool) {
        self.quiet = quiet;
    }
}

/* ── The worker ──────────────────────────────────────────────────────────── */

/// What one utterance came back as, for the overlay and the log.
#[derive(Debug, Clone, serde::Serialize)]
pub struct Utterance {
    /// What the service heard, from `X-Turminder-Transcript` — the thing that
    /// tells the user they were understood (§28.6).
    pub transcript: Option<String>,
    pub conversation_id: Option<String>,
    /// A human sentence when something went wrong, `None` when it did not.
    pub problem: Option<String>,
    /// Bytes of audio played.
    pub spoken_bytes: usize,
}

/// The overlay's event name — the window shows what was heard and hides itself.
pub const UTTERANCE_EVENT: &str = "voice://utterance";
/// Emitted whenever the state changes, so the tray icon and the overlay agree.
pub const STATE_EVENT: &str = "voice://state";

/// One utterance, end to end: microphone → `POST /api/voice` → speaker.
///
/// Blocking by construction, and called on a blocking thread. The reply is
/// played **as it arrives** — each decoded chunk is fed to the WAV splitter and
/// queued — because §33.2's whole latency argument is that the speaker starts
/// on the first sentence.
pub fn run_utterance(
    connection: &Connection,
    settings: &VoiceSettings,
    wav: Vec<u8>,
    // `heard` is told what was heard the moment the service says so — about a
    // fifth of a second in, against seconds for the whole reply (§33.2). The
    // point of showing a transcript is that it arrives before the answer does.
    heard: &mut dyn FnMut(&str),
) -> Utterance {
    let mut result = Utterance {
        transcript: None,
        conversation_id: None,
        problem: None,
        spoken_bytes: 0,
    };

    let speaker = match Speaker::open(settings.output_device.as_deref()) {
        Ok(speaker) => Some(speaker),
        Err(message) => {
            // No speaker is not a reason to skip the turn: the transcript and
            // the conversation still happen, and the overlay says what broke.
            result.problem = Some(message);
            None
        }
    };

    let mut assembler = ReplyAudio::default();
    let mut played = 0usize;
    let early: std::sync::Arc<std::sync::Mutex<Option<String>>> = Default::default();
    let response = {
        let mut sink = |bytes: &[u8]| {
            played += bytes.len();
            if let (Some(speaker), Some(piece)) = (speaker.as_ref(), assembler.push(bytes)) {
                let _ = speaker.play_wav(&piece);
            }
        };
        let seen = early.clone();
        let mut on_head = |r: &http::Response| {
            if !(200..300).contains(&r.status) {
                return;
            }
            if let Some(raw) = r.header("x-turminder-transcript") {
                let text = decode_rfc8187(raw);
                heard(&text);
                *seen.lock().expect("transcript slot poisoned") = Some(text);
            }
        };
        http::post_watching_head(
            &format!("{}/api/voice", connection.base_url),
            Some(&connection.token),
            http::Body {
                content_type: "audio/wav",
                bytes: &wav,
            },
            std::time::Duration::from_secs(120),
            Some(&mut sink),
            &mut on_head,
        )
    };

    let response = match response {
        Ok(response) => response,
        Err(message) => {
            result.problem = Some(message);
            return result;
        }
    };
    result.transcript = early
        .lock()
        .expect("transcript slot poisoned")
        .clone()
        .or_else(|| {
            response
                .header("x-turminder-transcript")
                .map(decode_rfc8187)
        });
    result.conversation_id = response
        .header("x-turminder-conversation")
        .map(str::to_string);
    result.spoken_bytes = played;

    if !(200..300).contains(&response.status) {
        result.problem = Some(explain(response.status, &response.text()));
        return result;
    }
    if let (Some(speaker), Some(tail)) = (speaker.as_ref(), assembler.flush()) {
        let _ = speaker.play_wav(&tail);
    }
    if let Some(speaker) = speaker.as_ref() {
        speaker.wait();
    }
    result
}

/// What a status code means to somebody standing in a room (App. E).
fn explain(status: u16, body: &str) -> String {
    match status {
        // Not an error the user needs a sentence about: the shell answers a
        // `nothing_heard` with a soft tone and no overlay text (§28.6).
        422 => String::new(),
        401 => "this shell's token was refused — reconnect it".into(),
        413 => "that was too long to send".into(),
        503 => "no speech endpoint configured — ask the assistant to connect one".into(),
        _ => {
            let detail = serde_json::from_str::<serde_json::Value>(body)
                .ok()
                .and_then(|v| {
                    v.get("message")
                        .or_else(|| v.get("error"))
                        .and_then(|m| m.as_str().map(str::to_string))
                })
                .unwrap_or_else(|| format!("the service answered {status}"));
            detail
        }
    }
}

/// `UTF-8''%C3%A5` back to `å` (RFC 8187, the header `/api/voice` sets).
pub fn decode_rfc8187(value: &str) -> String {
    let encoded = value.strip_prefix("UTF-8''").unwrap_or(value);
    let bytes = encoded.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let Ok(byte) = u8::from_str_radix(&encoded[i + 1..i + 3], 16) {
                out.push(byte);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// Cuts a streamed reply into playable pieces.
///
/// `/api/voice` answers with **one** WAV whose header declares an unknown
/// length and whose samples arrive sentence by sentence (§33.2). rodio wants
/// complete buffers, so this holds the format from the header and re-wraps each
/// arriving run of samples as its own small WAV — the speaker hears one
/// continuous reply, and the shell never waits for the last byte.
#[derive(Default)]
pub struct ReplyAudio {
    header: Option<audio::WavInfo>,
    /// Bytes not yet emitted: the header while it is still incomplete, then
    /// whatever is left of an odd-numbered sample.
    pending: Vec<u8>,
}

impl ReplyAudio {
    /// Feed decoded bytes; get back a playable WAV when there are samples.
    pub fn push(&mut self, bytes: &[u8]) -> Option<Vec<u8>> {
        self.pending.extend_from_slice(bytes);
        if self.header.is_none() {
            // Wait for the parser to actually find `data` rather than counting
            // to 44: a header carrying a `LIST` chunk is longer.
            let info = audio::read_wav_header(&self.pending)?;
            let offset = info.data_offset;
            self.header = Some(info);
            self.pending.drain(..offset);
        }
        self.emit()
    }

    /// Whatever is left when the stream ends.
    pub fn flush(&mut self) -> Option<Vec<u8>> {
        self.emit()
    }

    fn emit(&mut self) -> Option<Vec<u8>> {
        let info = self.header?;
        // 16-bit frames: an odd byte is the first half of a sample still in
        // flight, and playing it would be a click.
        let frame = 2 * info.channels as usize;
        let whole = self.pending.len() / frame * frame;
        if whole == 0 {
            return None;
        }
        let samples: Vec<i16> = self.pending[..whole]
            .chunks_exact(2)
            .map(|pair| i16::from_le_bytes([pair[0], pair[1]]))
            .collect();
        self.pending.drain(..whole);
        Some(audio::wav(&samples, info.sample_rate))
    }
}

/* ── Spoken deliveries (§33.3, §28.6, V8.2) ──────────────────────────────── */

/// Deliveries waiting to be read aloud.
///
/// A queue rather than a call per frame: a reminder that arrives mid-reply must
/// not talk over it, and two arriving together must not talk over each other.
/// Order is arrival order, which is also the order quiet mode releases them in.
#[derive(Default)]
pub struct SpokenQueue {
    pending: Mutex<std::collections::VecDeque<String>>,
    draining: std::sync::atomic::AtomicBool,
}

impl SpokenQueue {
    pub fn push(&self, delivery_id: String) {
        self.pending
            .lock()
            .expect("spoken queue poisoned")
            .push_back(delivery_id);
    }

    pub fn pop(&self) -> Option<String> {
        self.pending
            .lock()
            .expect("spoken queue poisoned")
            .pop_front()
    }

    pub fn len(&self) -> usize {
        self.pending.lock().expect("spoken queue poisoned").len()
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    /// Everything waiting, dropped — quiet mode arriving, or the shell losing
    /// its voice. What was queued was never spoken, and the notifications that
    /// went with them were already shown.
    pub fn clear(&self) {
        self.pending.lock().expect("spoken queue poisoned").clear();
    }

    /// Claim the right to drain. `false` means somebody else already has it —
    /// which is what keeps two workers from interleaving two sentences.
    pub fn claim(&self) -> bool {
        !self
            .draining
            .swap(true, std::sync::atomic::Ordering::AcqRel)
    }

    pub fn release(&self) {
        self.draining
            .store(false, std::sync::atomic::Ordering::Release);
    }
}

/* ── State shared with the tray and the overlay ──────────────────────────── */

/// The live voice state, hung off the Tauri app the way `Devices` is.
#[derive(Default)]
pub struct Voice {
    pub machine: Mutex<Option<Machine>>,
    /// The turn's claim on the microphone, held for as long as it is listening.
    pub capture: Mutex<Option<audio::Lease>>,
    /// Held so quiet mode can silence a delivery mid-sentence.
    pub speaker: Mutex<Option<Arc<Speaker>>>,
    /// The wake-word thread, when this machine is listening for its name.
    pub detector: Mutex<Option<crate::wake::DetectorThread>>,
    /// After a reply, speech starts a new turn without the wake word (§28.6).
    pub follow_up: Mutex<Option<crate::wake::FollowUp>>,
    /// Deliveries waiting to be read aloud (§33.3).
    pub spoken: SpokenQueue,
}

impl Voice {
    /// The machine, created from settings on first use — voice can be switched
    /// on without restarting the shell.
    pub fn machine_for(&self, settings: &VoiceSettings) -> Machine {
        let mut slot = self.machine.lock().expect("voice machine poisoned");
        slot.get_or_insert_with(|| Machine::new(settings)).clone()
    }

    pub fn put(&self, machine: Machine) {
        *self.machine.lock().expect("voice machine poisoned") = Some(machine);
    }
}

/// Re-read the settings and tell the machine what changed. Called from every
/// tray toggle, so the two cannot drift.
pub fn sync_settings(voice: &Voice, settings: &voice_settings::VoiceSettings) {
    let mut slot = voice.machine.lock().expect("voice machine poisoned");
    match slot.as_mut() {
        Some(machine) => {
            machine.quiet = settings.quiet;
            machine.wake_word = settings.wake_word;
        }
        None => *slot = Some(Machine::new(settings)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_spoken_queue_keeps_arrival_order_and_one_drainer() {
        let queue = SpokenQueue::default();
        queue.push("a".into());
        queue.push("b".into());
        assert_eq!(queue.len(), 2);
        // Two arriving together must not talk over each other.
        assert!(queue.claim(), "the first drainer takes it");
        assert!(!queue.claim(), "and the second is turned away");
        assert_eq!(queue.pop().as_deref(), Some("a"));
        assert_eq!(queue.pop().as_deref(), Some("b"));
        assert_eq!(queue.pop(), None);
        queue.release();
        assert!(queue.claim(), "released, so the next one can drain");
    }

    #[test]
    fn clearing_the_queue_leaves_nothing_to_say() {
        // Quiet mode arriving: the notifications were already shown, and what
        // was queued was never spoken.
        let queue = SpokenQueue::default();
        queue.push("a".into());
        queue.clear();
        assert!(queue.is_empty());
    }

    fn on() -> VoiceSettings {
        VoiceSettings {
            enabled: true,
            ..Default::default()
        }
    }

    #[test]
    fn push_to_talk_walks_idle_listening_uploading_speaking_idle() {
        let mut m = Machine::new(&on());
        assert_eq!(m.state(), State::Idle);
        assert_eq!(m.handle(Event::HotkeyDown), Action::StartListening);
        assert_eq!(m.state(), State::Listening);
        assert_eq!(m.handle(Event::HotkeyUp), Action::SendUtterance);
        assert_eq!(m.state(), State::Uploading);
        assert_eq!(m.handle(Event::ReplyStarted), Action::Ignore);
        assert_eq!(m.state(), State::Speaking);
        assert_eq!(m.handle(Event::Finished), Action::Ignore);
        assert_eq!(m.state(), State::Idle);
    }

    #[test]
    fn the_hotkey_still_works_in_quiet_mode() {
        // Pressing it is the opposite of being disturbed (§28.6).
        let mut m = Machine::new(&VoiceSettings {
            enabled: true,
            quiet: true,
            ..Default::default()
        });
        assert_eq!(m.handle(Event::HotkeyDown), Action::StartListening);
        assert_eq!(m.handle(Event::HotkeyUp), Action::SendUtterance);
    }

    #[test]
    fn the_wake_word_needs_enabling_and_silence_and_an_idle_shell() {
        let mut off = Machine::new(&on());
        assert_eq!(off.handle(Event::WakeWord), Action::Ignore);
        assert_eq!(off.state(), State::Idle);

        let mut quiet = Machine::new(&VoiceSettings {
            enabled: true,
            wake_word: true,
            quiet: true,
            ..Default::default()
        });
        assert_eq!(quiet.handle(Event::WakeWord), Action::Ignore);

        let mut live = Machine::new(&VoiceSettings {
            enabled: true,
            wake_word: true,
            ..Default::default()
        });
        assert_eq!(live.handle(Event::WakeWord), Action::StartListening);
        // And not while a reply is playing: barge-in is §16.
        live.handle(Event::HotkeyUp);
        live.handle(Event::ReplyStarted);
        assert_eq!(live.state(), State::Speaking);
        assert_eq!(live.handle(Event::WakeWord), Action::Ignore);
        assert_eq!(live.state(), State::Speaking);
    }

    #[test]
    fn summoning_works_where_the_wake_word_will_not() {
        // The point of the menu item: no name to say, nothing enrolled, and
        // quiet mode does not silence a turn somebody asked for.
        let mut quiet = Machine::new(&VoiceSettings {
            enabled: true,
            quiet: true,
            ..Default::default()
        });
        assert_eq!(quiet.handle(Event::WakeWord), Action::Ignore);
        assert_eq!(quiet.handle(Event::Summoned), Action::StartListening);
        assert_eq!(quiet.state(), State::Listening);
        // And it ends like any other turn.
        assert_eq!(quiet.handle(Event::HotkeyUp), Action::SendUtterance);
    }

    #[test]
    fn summoning_is_refused_once_something_is_already_happening() {
        // Same rule as every other trigger: one turn at a time, and no
        // barge-in (§16).
        let mut m = Machine::new(&on());
        m.handle(Event::Summoned);
        assert_eq!(m.handle(Event::Summoned), Action::Ignore);
        m.handle(Event::HotkeyUp);
        m.handle(Event::ReplyStarted);
        assert_eq!(m.state(), State::Speaking);
        assert_eq!(m.handle(Event::Summoned), Action::Ignore);
        assert_eq!(m.state(), State::Speaking);
    }

    #[test]
    fn cancelling_throws_the_utterance_away_rather_than_sending_it() {
        // A click has no release to let go of, so changing your mind has to be
        // a thing you can do — and it must not upload what was said first.
        let mut m = Machine::new(&on());
        m.handle(Event::Summoned);
        assert_eq!(m.handle(Event::Cancelled), Action::Discard);
        assert_eq!(m.state(), State::Idle);
        // Nothing to cancel is a no-op, not a state.
        assert_eq!(m.handle(Event::Cancelled), Action::Ignore);
        assert_eq!(m.state(), State::Idle);
        // And it cannot unsay a reply already in flight.
        m.handle(Event::Summoned);
        m.handle(Event::HotkeyUp);
        assert_eq!(m.handle(Event::Cancelled), Action::Ignore);
        assert_eq!(m.state(), State::Uploading);
    }

    #[test]
    fn a_stray_edge_is_a_no_op_rather_than_a_state() {
        // The shortcut plugin fires on both edges and the app may start with
        // the key already held.
        let mut m = Machine::new(&on());
        assert_eq!(m.handle(Event::HotkeyUp), Action::Ignore);
        assert_eq!(m.state(), State::Idle);
        m.handle(Event::HotkeyDown);
        // A second press while already listening changes nothing.
        assert_eq!(m.handle(Event::HotkeyDown), Action::Ignore);
        assert_eq!(m.state(), State::Listening);
    }

    #[test]
    fn quiet_mode_arriving_mid_turn_does_not_cancel_the_turn() {
        let mut m = Machine::new(&on());
        m.handle(Event::HotkeyDown);
        m.set_quiet(true);
        // The user asked for this one; quiet silences what comes next.
        assert_eq!(m.handle(Event::HotkeyUp), Action::SendUtterance);
    }

    #[test]
    fn the_icon_says_quiet_over_everything_else() {
        assert_eq!(State::Idle.icon(false), "idle");
        assert_eq!(State::Listening.icon(false), "listening");
        assert_eq!(State::Uploading.icon(false), "thinking");
        assert_eq!(State::Speaking.icon(false), "speaking");
        assert_eq!(State::Listening.icon(true), "quiet");
    }

    #[test]
    fn the_reply_splitter_plays_one_header_as_many_buffers() {
        // The service sends one WAV with an unknown length and appends samples
        // sentence by sentence (§33.2); rodio wants complete buffers.
        let first = audio::wav(&[100i16; 400], 22_050);
        let mut streamed = first.clone();
        streamed[4..8].copy_from_slice(&0xffff_ffffu32.to_le_bytes());
        streamed[40..44].copy_from_slice(&0xffff_ffffu32.to_le_bytes());

        let mut assembler = ReplyAudio::default();
        // Header split across two reads, as a socket would deliver it.
        assert!(assembler.push(&streamed[..20]).is_none());
        let piece = assembler
            .push(&streamed[20..])
            .expect("samples after the header");
        let info = audio::read_wav_header(&piece).expect("each piece is a WAV");
        assert_eq!(info.sample_rate, 22_050);
        assert_eq!(info.data_bytes, 800);

        // A second sentence arrives as bare samples — no second header.
        let more = assembler.push(&[0u8; 200]).expect("a second piece");
        assert_eq!(read_len(&more), 200);
        assert!(assembler.flush().is_none());
    }

    #[test]
    fn the_reply_splitter_holds_a_half_sample_back() {
        // An odd byte is the first half of a sample still in flight; playing it
        // is a click.
        let streamed = audio::wav(&[1i16; 2], 22_050);
        let mut assembler = ReplyAudio::default();
        assembler.push(&streamed).expect("the first samples");
        assert!(
            assembler.push(&[0x01]).is_none(),
            "half a sample is not audio"
        );
        let piece = assembler
            .push(&[0x02])
            .expect("the other half completes it");
        assert_eq!(read_len(&piece), 2);
    }

    fn read_len(wav: &[u8]) -> usize {
        audio::read_wav_header(wav).expect("a WAV").data_bytes
    }

    #[test]
    fn decodes_the_transcript_header() {
        assert_eq!(
            decode_rfc8187("UTF-8''Hei%2C%20hva%20skjer%3F"),
            "Hei, hva skjer?"
        );
        // Norwegian, which is the whole reason the header is encoded at all.
        assert_eq!(decode_rfc8187("UTF-8''Sl%C3%A5%20p%C3%A5"), "Slå på");
        assert_eq!(decode_rfc8187("plain"), "plain");
    }

    #[test]
    fn nothing_heard_says_nothing() {
        // A `422` gets a soft tone and no overlay text (§28.6) — the shell must
        // not put "unprocessable entity" in front of somebody.
        assert_eq!(explain(422, r#"{"error":"nothing_heard"}"#), "");
        assert!(explain(503, "{}").contains("speech endpoint"));
        assert!(explain(401, "{}").contains("token"));
        assert_eq!(
            explain(500, r#"{"message":"the transcriber fell over"}"#),
            "the transcriber fell over"
        );
    }
}
