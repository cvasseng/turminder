//! Saying the assistant's name (§28.6, V7).
//!
//! On-device and opt-in: `rustpotter`, trained from a handful of the user's own
//! recordings of the phrase — pure Rust, no runtime, no model download, no
//! language, which is what lets a Norwegian instance name work as well as an
//! English one. Nothing about the microphone stream leaves this process before
//! the detector fires; before that, samples are looked at and discarded.
//!
//! Two halves, both here: the **detector** (a thread over the capture stream)
//! and **end-pointing** (deciding the speaker stopped). The second is pure
//! arithmetic over frames and is tested; the first needs a microphone.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use rustpotter::{
    Rustpotter, RustpotterConfig, WakewordLoad, WakewordRef, WakewordRefBuildFromBuffers,
    WakewordSave,
};

use crate::audio::{self, CAPTURE_RATE};

/// How many takes enrolment asks for before it trains (§28.6). Five is what a
/// person will actually do; the sixth is the verification, not a sample.
pub const ENROLMENT_TAKES: usize = 5;

/// The MFCC width rustpotter's own tooling uses. Not a knob worth exposing:
/// changing it invalidates every trained model on disk.
const MFCC_SIZE: u16 = 16;

/// Silence this long ends an utterance (App. A `voice_endpoint_silence_ms`).
pub const ENDPOINT_SILENCE_MS: u32 = 700;
/// And nothing runs longer than this (App. A `voice_max_utterance_s`).
pub const MAX_UTTERANCE_S: u32 = 30;
/// After a reply, speech starts a new turn without the wake word (App. A
/// `voice_followup_s`).
pub const FOLLOWUP_S: u32 = 8;

/* ── Enrolment ───────────────────────────────────────────────────────────── */

/// Train a wake word from the user's own recordings and write it to `path`.
///
/// Nothing recorded is written except the trained model (§28.6): the takes are
/// WAV buffers in memory, they become MFCC features, and the buffers go out of
/// scope. What lands on disk is a template, not a recording of anybody.
pub fn train(name: &str, takes: Vec<Vec<u8>>, path: &str) -> Result<(), String> {
    if takes.len() < ENROLMENT_TAKES {
        return Err(format!(
            "{} takes is not enough — say it {ENROLMENT_TAKES} times",
            takes.len()
        ));
    }
    let samples: HashMap<String, Vec<u8>> = takes
        .into_iter()
        .enumerate()
        .map(|(i, wav)| (format!("take-{}", i + 1), wav))
        .collect();
    let wakeword = WakewordRef::new_from_sample_buffers(
        name.to_string(),
        // Thresholds left to the detector's own config, so the sensitivity
        // slider is the one place a person tunes this.
        None,
        None,
        samples,
        MFCC_SIZE,
    )?;
    wakeword.save_to_file(path)
}

/// Does this trained model recognise one more take? The sixth recording of
/// enrolment (§28.6) — a model that cannot hear the voice that trained it is
/// worse than no model, because the tray would say it was ready.
pub fn verify(path: &str, take: &[i16], sensitivity: f32) -> Result<bool, String> {
    let mut detector = Detector::load(path, sensitivity)?;
    Ok(detector.feed(take).is_some())
}

/* ── Detection ───────────────────────────────────────────────────────────── */

/// A loaded wake word, fed 16 kHz mono frames.
pub struct Detector {
    inner: Rustpotter,
    /// Rustpotter takes exactly one frame at a time; this holds the remainder.
    pending: Vec<i16>,
    frame: usize,
}

impl Detector {
    pub fn load(path: &str, sensitivity: f32) -> Result<Self, String> {
        let mut config = RustpotterConfig::default();
        config.fmt.sample_rate = CAPTURE_RATE as usize;
        config.fmt.sample_format = rustpotter::SampleFormat::I16;
        config.fmt.channels = 1;
        // Sensitivity is one number to a person and two thresholds to the
        // detector; higher accepts more, which is the direction a slider
        // labelled "sensitivity" has to move.
        let (threshold, avg) = thresholds(sensitivity);
        config.detector.threshold = threshold;
        config.detector.avg_threshold = avg;

        let mut inner = Rustpotter::new(&config)?;
        let wakeword = WakewordRef::load_from_file(path)?;
        inner.add_wakeword_ref("wake", wakeword)?;
        let frame = inner.get_samples_per_frame();
        Ok(Self {
            inner,
            pending: Vec::new(),
            frame,
        })
    }

    /// Feed samples; `Some(score)` the moment the phrase is heard.
    ///
    /// Buffered to the detector's own frame size because `process_samples`
    /// silently returns `None` for a wrong-sized batch — a detector fed
    /// whatever the sound card's buffer happened to be never fires at all, and
    /// says nothing about why.
    pub fn feed(&mut self, samples: &[i16]) -> Option<f32> {
        self.pending.extend_from_slice(samples);
        let mut hit = None;
        while self.pending.len() >= self.frame {
            let frame: Vec<i16> = self.pending.drain(..self.frame).collect();
            if let Some(detection) = self.inner.process_samples(frame) {
                hit = Some(detection.score);
            }
        }
        hit
    }
}

/// One sensitivity, two thresholds. Rustpotter's defaults (0.5 / 0.2) sit at
/// the midpoint, so the slider's centre is the tuning its author chose.
pub fn thresholds(sensitivity: f32) -> (f32, f32) {
    let s = sensitivity.clamp(0.0, 1.0);
    // More sensitive means a *lower* bar to clear.
    (1.0 - s * 0.8 - 0.1, 0.4 - s * 0.4)
}

/// The detector thread: capture → frames → `Detected`.
///
/// Its own thread because it must keep up with the microphone while the app
/// does everything else, and stopping it has to be immediate — a detector still
/// listening after the user switched voice off is exactly the thing §28.6's
/// containment paragraph promises does not happen.
pub struct DetectorThread {
    running: Arc<AtomicBool>,
    handle: Option<std::thread::JoinHandle<()>>,
}

impl DetectorThread {
    /// Start listening. `on_detected` runs on the detector thread, so it should
    /// hand off rather than work.
    pub fn start(
        path: String,
        sensitivity: f32,
        input_device: Option<String>,
        mut on_detected: impl FnMut() + Send + 'static,
    ) -> Result<Self, String> {
        let mut detector = Detector::load(&path, sensitivity)?;
        let running = Arc::new(AtomicBool::new(true));
        let flag = running.clone();
        let handle = std::thread::Builder::new()
            .name("wake-word".into())
            .spawn(move || {
                // A claim on the one open microphone (§28.6). It used to open
                // its own, which meant the detector and a turn fighting over
                // one ALSA device — the failure that produced
                // `pcm_dsnoop.c: unable to open slave` and a detector that
                // could not listen at all (Christer, 2026-08-30).
                let mut lease = match audio::listen(input_device.as_deref()) {
                    Ok(lease) => lease,
                    Err(message) => {
                        eprintln!("wake word cannot listen: {message}");
                        return;
                    }
                };
                let started = std::time::Instant::now();
                let mut heard = 0usize;
                let mut reported = false;
                while flag.load(Ordering::Relaxed) {
                    std::thread::sleep(std::time::Duration::from_millis(60));
                    // Only the new samples: a detector that reconverted the
                    // whole buffer would grow slower the longer it listened,
                    // and this one listens all day.
                    let fresh = lease.since();
                    if fresh.is_empty() {
                        continue;
                    }
                    heard += fresh.len();
                    if detector.feed(&fresh).is_some() {
                        on_detected();
                    }
                    // The CPU figure §28.6 asks to be measured, reported once
                    // rather than every frame: a log line per 60 ms is a log
                    // nobody can read.
                    if !reported && started.elapsed().as_secs() >= 30 {
                        reported = true;
                        eprintln!(
                            "wake word: {heard} samples in {:?} of wall clock",
                            started.elapsed()
                        );
                    }
                }
            })
            .map_err(|e| e.to_string())?;
        Ok(Self {
            running,
            handle: Some(handle),
        })
    }

    /// Stop and wait: returning while the thread still owns the microphone is
    /// how the next capture fails to open it.
    pub fn stop(mut self) {
        self.running.store(false, Ordering::Relaxed);
        if let Some(handle) = self.handle.take() {
            let _ = handle.join();
        }
    }
}

impl Drop for DetectorThread {
    fn drop(&mut self) {
        self.running.store(false, Ordering::Relaxed);
    }
}

/* ── End-pointing ────────────────────────────────────────────────────────── */

/// Deciding the speaker stopped (§28.6).
///
/// Push-to-talk needs none of this — the release *is* the end. The wake word
/// does: nobody says "hey Sleeper Service" and then presses a key.
///
/// The floor is calibrated from the first 300 ms of the utterance rather than
/// fixed, because the noise floor of a kitchen and of an office differ by more
/// than any constant would survive. Speech has to clear it before silence can
/// end anything — otherwise a detector that fired on a cough would upload
/// 700 ms of room tone.
#[derive(Debug, Clone)]
pub struct EndPointer {
    sample_rate: u32,
    calibration_samples: usize,
    silence_samples: usize,
    max_samples: usize,
    seen: usize,
    /// Sum of squares over the calibration window, for the floor.
    calibration_energy: f64,
    floor: Option<f32>,
    heard_speech: bool,
    silent_run: usize,
}

/// Why an utterance ended.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Ending {
    /// `voice_endpoint_silence_ms` of quiet after speech.
    Silence,
    /// `voice_max_utterance_s` — a microphone left open by a television.
    TooLong,
}

impl EndPointer {
    pub fn new(sample_rate: u32) -> Self {
        Self {
            sample_rate,
            calibration_samples: (sample_rate as usize * 300) / 1000,
            silence_samples: (sample_rate as usize * ENDPOINT_SILENCE_MS as usize) / 1000,
            max_samples: sample_rate as usize * MAX_UTTERANCE_S as usize,
            seen: 0,
            calibration_energy: 0.0,
            floor: None,
            heard_speech: false,
            silent_run: 0,
        }
    }

    /// Feed the newest samples; `Some` when the utterance is over.
    pub fn push(&mut self, samples: &[i16]) -> Option<Ending> {
        for chunk in samples.chunks(160) {
            // 10 ms at 16 kHz: fine enough that 700 ms of silence is not
            // rounded to half a second, coarse enough that RMS means something.
            let rms = rms(chunk);
            self.seen += chunk.len();

            if self.floor.is_none() {
                self.calibration_energy += (rms as f64) * (rms as f64) * chunk.len() as f64;
                if self.seen >= self.calibration_samples {
                    let mean = self.calibration_energy / self.seen.max(1) as f64;
                    // Three times the room, and never below a floor of its own:
                    // a perfectly silent input would otherwise make every
                    // sample "speech".
                    self.floor = Some(((mean.sqrt() as f32) * 3.0).max(0.01));
                }
                continue;
            }
            let floor = self.floor.unwrap_or(0.01);
            if rms > floor {
                self.heard_speech = true;
                self.silent_run = 0;
            } else if self.heard_speech {
                self.silent_run += chunk.len();
                if self.silent_run >= self.silence_samples {
                    return Some(Ending::Silence);
                }
            }
            if self.seen >= self.max_samples {
                return Some(Ending::TooLong);
            }
        }
        None
    }

    /// Did anything above the floor ever arrive? A `false` here means the
    /// upload would be room tone, and the shell answers with a soft tone
    /// instead of a `422` round trip.
    pub fn heard_speech(&self) -> bool {
        self.heard_speech
    }

    pub fn seconds(&self) -> f32 {
        self.seen as f32 / self.sample_rate as f32
    }
}

fn rms(samples: &[i16]) -> f32 {
    if samples.is_empty() {
        return 0.0;
    }
    let sum: f64 = samples
        .iter()
        .map(|s| {
            let v = *s as f64 / i16::MAX as f64;
            v * v
        })
        .sum();
    (sum / samples.len() as f64).sqrt() as f32
}

/// The window after a reply in which speech starts a new turn without the wake
/// word (§28.6). A timestamp comparison, kept here so the rule has one home.
#[derive(Debug, Clone, Copy)]
pub struct FollowUp {
    until: std::time::Instant,
}

impl FollowUp {
    pub fn opening_now() -> Self {
        Self {
            until: std::time::Instant::now() + std::time::Duration::from_secs(FOLLOWUP_S as u64),
        }
    }

    pub fn open(&self) -> bool {
        std::time::Instant::now() < self.until
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// `ms` of a 300 Hz tone at `amplitude`, and of silence.
    fn speech(ms: usize, amplitude: i16) -> Vec<i16> {
        (0..(CAPTURE_RATE as usize * ms / 1000))
            .map(|i| {
                let t = i as f32 / CAPTURE_RATE as f32;
                ((2.0 * std::f32::consts::PI * 300.0 * t).sin() * amplitude as f32) as i16
            })
            .collect()
    }

    fn quiet(ms: usize) -> Vec<i16> {
        vec![0i16; CAPTURE_RATE as usize * ms / 1000]
    }

    #[test]
    fn silence_after_speech_ends_the_utterance() {
        let mut pointer = EndPointer::new(CAPTURE_RATE);
        // 300 ms of room tone calibrates the floor…
        assert_eq!(pointer.push(&quiet(300)), None);
        // …then a sentence…
        assert_eq!(pointer.push(&speech(900, 9_000)), None);
        assert!(pointer.heard_speech());
        // …and 700 ms of quiet ends it. Not 600.
        assert_eq!(pointer.push(&quiet(600)), None);
        assert_eq!(pointer.push(&quiet(200)), Some(Ending::Silence));
    }

    #[test]
    fn silence_before_any_speech_ends_nothing() {
        // A detector that fired on a cough must not upload room tone: the
        // silence counter only runs once something was actually said.
        let mut pointer = EndPointer::new(CAPTURE_RATE);
        pointer.push(&quiet(300));
        assert_eq!(pointer.push(&quiet(3_000)), None);
        assert!(!pointer.heard_speech());
    }

    #[test]
    fn a_microphone_left_open_stops_at_the_cap() {
        let mut pointer = EndPointer::new(CAPTURE_RATE);
        pointer.push(&quiet(300));
        // Unbroken speech: nothing else would ever end this.
        let mut ended = None;
        for _ in 0..40 {
            if let Some(end) = pointer.push(&speech(1_000, 9_000)) {
                ended = Some(end);
                break;
            }
        }
        assert_eq!(ended, Some(Ending::TooLong));
        assert!(pointer.seconds() >= MAX_UTTERANCE_S as f32);
    }

    #[test]
    fn the_floor_comes_from_the_room_rather_than_a_constant() {
        // A noisy room: the same speech has to clear a higher bar, and the
        // room's own hiss must not read as talking.
        let mut noisy = EndPointer::new(CAPTURE_RATE);
        noisy.push(&speech(300, 4_000)); // calibrate against a loud room
        noisy.push(&speech(500, 4_000)); // more of the same room
        assert!(
            !noisy.heard_speech(),
            "room tone at the calibration level is not speech"
        );
        // Something three times louder is.
        noisy.push(&speech(300, 20_000));
        assert!(noisy.heard_speech());
    }

    #[test]
    fn sensitivity_moves_the_bar_the_way_a_slider_should() {
        let (loose_t, loose_a) = thresholds(1.0);
        let (tight_t, tight_a) = thresholds(0.0);
        // Higher sensitivity accepts more, so its thresholds are lower.
        assert!(loose_t < tight_t, "{loose_t} vs {tight_t}");
        assert!(loose_a < tight_a, "{loose_a} vs {tight_a}");
        // The midpoint is rustpotter's own default tuning.
        let (mid_t, mid_a) = thresholds(0.5);
        assert!((mid_t - 0.5).abs() < 0.01, "{mid_t}");
        assert!((mid_a - 0.2).abs() < 0.01, "{mid_a}");
        // And nothing outside 0..1 escapes the clamp.
        assert_eq!(thresholds(-5.0), thresholds(0.0));
        assert_eq!(thresholds(5.0), thresholds(1.0));
    }

    #[test]
    fn the_follow_up_window_is_open_now_and_shut_later() {
        let window = FollowUp::opening_now();
        assert!(window.open());
        // The far side of it, without waiting eight seconds for the test.
        let past = FollowUp {
            until: std::time::Instant::now() - std::time::Duration::from_millis(1),
        };
        assert!(!past.open());
    }

    #[test]
    fn enrolment_refuses_to_train_on_too_few_takes() {
        // A model trained on two mumbles is a model that fires at the kettle.
        let error = train("Sleeper Service", vec![vec![], vec![]], "/dev/null").unwrap_err();
        assert!(error.contains("not enough"), "{error}");
        assert!(error.contains(&ENROLMENT_TAKES.to_string()), "{error}");
    }

    #[test]
    fn trains_a_wakeword_from_recordings_and_loads_it_back() {
        // Synthetic takes: the point is the round trip through rustpotter's own
        // file format, not whether a sine wave sounds like a name.
        let dir = std::env::temp_dir().join(format!("turminder-wake-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("wakeword.rpw");
        let takes: Vec<Vec<u8>> = (0..ENROLMENT_TAKES)
            .map(|i| audio::wav(&speech(600, 8_000 + i as i16 * 200), CAPTURE_RATE))
            .collect();
        train("Sleeper Service", takes, path.to_str().unwrap()).expect("training");
        assert!(path.exists(), "the trained model must be on disk");
        // Nothing recorded is written except the model (§28.6).
        let written: Vec<_> = std::fs::read_dir(&dir).unwrap().flatten().collect();
        assert_eq!(written.len(), 1, "only the model may be written");

        Detector::load(path.to_str().unwrap(), 0.5).expect("loading it back");
        std::fs::remove_dir_all(&dir).ok();
    }
}
