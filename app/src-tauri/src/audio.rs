//! The microphone and the speaker (§28.6).
//!
//! Native, in the Rust core, never the webview: `getUserMedia` inside
//! WKWebView and WebKitGTK is inconsistent about permission and device choice,
//! and control over both is the point. `cpal` in, `rodio` out — the two crates
//! §28.6 names.
//!
//! **Containment** (§28.6, §14.3): captured audio lives in a `Vec<i16>` in
//! memory for the length of one utterance and is written nowhere. Nothing
//! leaves the machine before a trigger fires; after it, exactly one WAV goes to
//! `POST /api/voice`.
//!
//! The format arithmetic — WAV headers, resampling — is pure and tested; the
//! device plumbing is not, because a unit test cannot own a sound card.

use std::sync::{Arc, Mutex};

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};

/// What the service's `stt` route wants (§33.2): 16 kHz mono 16-bit.
pub const CAPTURE_RATE: u32 = 16_000;

/// A device's human name — `description().name()`, because `name()` itself is
/// deprecated in cpal 0.17 in favour of the structured form. Still a *name*
/// and not an `id()`: §28.6 says the tray lists what cpal enumerates and the
/// settings remember the choice by name, and a name is the only one of the two
/// a person reading a menu can match to the box in front of them.
fn device_name(device: &cpal::Device) -> Option<String> {
    device.description().ok().map(|d| d.name().to_string())
}

/// Devices this machine has, by the name the tray shows and the settings
/// remember. Enumeration failures are an empty list, not an error: a box with
/// no sound card should show an empty submenu, not refuse to open a menu.
///
/// **Deduplicated**, because cpal lists the same hardware several times — four
/// entries all described "HDA Intel PCH, ALC256 Analog" on the reference box —
/// and a menu with four identical rows is a menu that cannot be used. The name
/// is a preference anyway: `candidates` tries every device that answers to it.
pub fn list_inputs() -> Vec<String> {
    device_names(true)
}

pub fn list_outputs() -> Vec<String> {
    device_names(false)
}

fn device_names(input: bool) -> Vec<String> {
    let host = cpal::default_host();
    let devices = if input {
        host.input_devices().map(|d| d.collect::<Vec<_>>())
    } else {
        host.output_devices().map(|d| d.collect::<Vec<_>>())
    };
    let mut seen: Vec<String> = Vec::new();
    for device in devices.unwrap_or_default() {
        if let Some(name) = device_name(&device) {
            if !seen.contains(&name) {
                seen.push(name);
            }
        }
    }
    seen
}

/// Devices worth trying, best first (§28.6).
///
/// cpal enumerates ALSA PCMs it cannot open — on the reference box the list
/// contains a *second* "Default Audio Device" whose config call fails outright,
/// sitting beside the working one, and four separate entries all described
/// "HDA Intel PCH, ALC256 Analog". So a name is a preference, not an address,
/// and the only honest test of a device is opening it. Order: everything
/// matching the remembered name, then the host default, then the rest.
///
/// The `bool` is "this is the device that was asked for", which is what decides
/// whether the tray says it fell back.
fn candidates(input: bool, wanted: Option<&str>) -> Vec<(cpal::Device, bool)> {
    let host = cpal::default_host();
    let all: Vec<cpal::Device> = if input {
        host.input_devices()
            .map(|d| d.collect())
            .unwrap_or_default()
    } else {
        host.output_devices()
            .map(|d| d.collect())
            .unwrap_or_default()
    };
    let mut out: Vec<(cpal::Device, bool)> = Vec::new();
    if let Some(name) = wanted {
        for device in &all {
            if device_name(device).as_deref() == Some(name) {
                out.push((device.clone(), true));
            }
        }
    }
    let fallback = if input {
        host.default_input_device()
    } else {
        host.default_output_device()
    };
    if let Some(device) = fallback {
        out.push((device, wanted.is_none()));
    }
    for device in all {
        out.push((device, false));
    }
    out
}

/// How much audio the ring keeps. Longer than the longest utterance, so a
/// reader that fell behind by a whole sentence still has it, and bounded so a
/// wake-word detector left running all day does not eat the machine — the
/// buffer used to grow forever, which is fine for a ten-second test and two
/// gigabytes by teatime.
const RING_SECONDS: usize = MAX_UTTERANCE_S as usize + 5;

/// The longest utterance anything will ask for (App. A `voice_max_utterance_s`).
/// Duplicated from `wake.rs` rather than imported, because `audio` sits below
/// it and a ring size is a property of the buffer, not of end-pointing.
const MAX_UTTERANCE_S: u32 = 30;

/// The samples heard so far, oldest evicted. Absolute counts, so a reader that
/// fell behind learns it fell behind instead of silently re-reading.
#[derive(Default)]
struct Ring {
    samples: Vec<i16>,
    /// How many samples have been evicted from the front, ever.
    dropped: usize,
}

impl Ring {
    fn push(&mut self, incoming: impl Iterator<Item = i16>, capacity: usize) {
        self.samples.extend(incoming);
        if self.samples.len() > capacity {
            let excess = self.samples.len() - capacity;
            self.samples.drain(..excess);
            self.dropped += excess;
        }
    }

    /// Everything after `cursor`, advancing it. A cursor older than the ring is
    /// moved forward: that audio is gone, and pretending otherwise would hand
    /// back the wrong seconds.
    fn since(&self, cursor: &mut usize) -> &[i16] {
        if *cursor < self.dropped {
            *cursor = self.dropped;
        }
        let from = *cursor - self.dropped;
        *cursor = self.dropped + self.samples.len();
        &self.samples[from.min(self.samples.len())..]
    }

    /// Everything from `mark` to now, without moving anything.
    fn from(&self, mark: usize) -> &[i16] {
        let from = mark.saturating_sub(self.dropped).min(self.samples.len());
        &self.samples[from..]
    }

    fn position(&self) -> usize {
        self.dropped + self.samples.len()
    }
}

/// A capture in progress. Dropping it stops the stream and frees the device.
pub struct Capture {
    /// `None` only in tests, which have no device to hold — the field exists to
    /// keep the stream alive, and dropping it is what stops the microphone.
    _stream: Option<cpal::Stream>,
    ring: Arc<Mutex<Ring>>,
    /// What the device actually gave us, which is not always what we asked for.
    source_rate: u32,
    source_channels: u16,
    /// The device this actually opened, which may not be the one asked for.
    pub opened: String,
    /// Set when the remembered device was gone and something else stood in.
    pub fell_back: bool,
}

impl Capture {
    /// Open the microphone and start filling a buffer.
    ///
    /// 16 kHz mono is requested first because it is what the transcriber wants
    /// and what every sound card can do; a device that refuses is captured at
    /// whatever it does offer and resampled on the way out — recording at the
    /// wrong rate and shipping it as 16 kHz is how a transcriber ends up
    /// hearing a chipmunk.
    /// Open the microphone, trying each candidate until one actually works.
    ///
    /// "Actually works" means the stream builds and starts — not that cpal
    /// listed it, which it will do for PCMs that cannot be opened at all.
    /// Every failure is collected so a total failure can say what it tried
    /// rather than reporting whichever device happened to be last.
    pub fn start(device_name: Option<&str>) -> Result<Self, String> {
        let mut problems: Vec<String> = Vec::new();
        for (device, wanted) in candidates(true, device_name) {
            match Self::open(&device, !wanted) {
                Ok(capture) => return Ok(capture),
                Err(e) => {
                    let name = device_name_or_unknown(&device);
                    if !problems.iter().any(|p| p.starts_with(&name)) {
                        problems.push(format!("{name}: {e}"));
                    }
                }
            }
        }
        Err(if problems.is_empty() {
            "this machine has no microphone".to_string()
        } else {
            format!("no microphone would open — {}", problems.join("; "))
        })
    }

    fn open(device: &cpal::Device, fell_back: bool) -> Result<Self, String> {
        let default = device
            .default_input_config()
            .map_err(|e| format!("no input config: {e}"))?;
        // Take what the device offers and convert, rather than asking for
        // 16 kHz mono and hoping. ALSA advertises ranges its plugins will not
        // honour, and a refused `build_input_stream` is a dead microphone,
        // where a resample is arithmetic this module already does and tests.
        let config = default.config();
        let source_rate = config.sample_rate;
        let source_channels = config.channels;

        let ring: Arc<Mutex<Ring>> = Arc::new(Mutex::new(Ring::default()));
        let sink = ring.clone();
        let capacity = source_rate as usize * source_channels.max(1) as usize * RING_SECONDS;
        let stream = match default.sample_format() {
            cpal::SampleFormat::I16 => device.build_input_stream(
                &config,
                move |data: &[i16], _| append(&sink, data.iter().copied(), capacity),
                |e| eprintln!("microphone error: {e}"),
                None,
            ),
            cpal::SampleFormat::U16 => device.build_input_stream(
                &config,
                move |data: &[u16], _| {
                    append(
                        &sink,
                        data.iter().map(|s| (*s as i32 - 32_768) as i16),
                        capacity,
                    )
                },
                |e| eprintln!("microphone error: {e}"),
                None,
            ),
            cpal::SampleFormat::I32 => device.build_input_stream(
                &config,
                move |data: &[i32], _| {
                    append(&sink, data.iter().map(|s| (*s >> 16) as i16), capacity)
                },
                |e| eprintln!("microphone error: {e}"),
                None,
            ),
            _ => device.build_input_stream(
                &config,
                move |data: &[f32], _| append(&sink, data.iter().map(|s| to_i16(*s)), capacity),
                |e| eprintln!("microphone error: {e}"),
                None,
            ),
        }
        .map_err(|e| format!("cannot open: {e}"))?;
        stream.play().map_err(|e| format!("cannot start: {e}"))?;

        Ok(Self {
            _stream: Some(stream),
            ring,
            source_rate,
            source_channels,
            opened: device_name_or_unknown(device),
            fell_back,
        })
    }

    /// Where the recording is now, as an absolute sample count — the mark a
    /// turn takes when it starts, so it can ask for its own audio later.
    pub fn position(&self) -> usize {
        self.ring.lock().expect("capture ring poisoned").position()
    }

    /// Everything from `mark` to now, as 16 kHz mono 16-bit PCM.
    ///
    /// Converts in one pass, so it is right at any length and wrong to call in
    /// a loop — `since` is what a poll wants.
    pub fn from(&self, mark: usize) -> Vec<i16> {
        let raw = self
            .ring
            .lock()
            .expect("capture ring poisoned")
            .from(mark)
            .to_vec();
        self.convert(&raw)
    }

    /// What arrived since `cursor`, converting only that.
    ///
    /// The polling loops — end-pointing, the wake-word detector, enrolment —
    /// ask twenty times a second, and converting the whole utterance each time
    /// is quadratic: at 48 kHz that is a 63-tap filter over half a million
    /// samples, twenty times a second, which pegs a core inside ten seconds of
    /// talking. The seam between chunks costs a few samples of filter warm-up,
    /// which neither an RMS window nor a wake-word score can tell from noise.
    ///
    /// `cursor` counts **raw** samples and is absolute, so a reader that fell
    /// behind the ring is moved forward rather than handed the wrong seconds.
    pub fn since(&self, cursor: &mut usize) -> Vec<i16> {
        let raw = {
            let ring = self.ring.lock().expect("capture ring poisoned");
            let mut at = *cursor;
            let fresh = ring.since(&mut at);
            // Whole frames only: half of a stereo frame would swap the channels
            // for everything after it.
            let frame = self.source_channels.max(1) as usize;
            let keep = fresh.len() / frame * frame;
            if keep == 0 {
                return Vec::new();
            }
            *cursor = at - (fresh.len() - keep);
            fresh[..keep].to_vec()
        };
        self.convert(&raw)
    }

    fn convert(&self, raw: &[i16]) -> Vec<i16> {
        let mono = to_mono(raw, self.source_channels);
        resample(&mono, self.source_rate, CAPTURE_RATE)
    }

    /// One WAV of everything since `mark`, ready to POST.
    pub fn wav_since(&self, mark: usize) -> Vec<u8> {
        wav(&self.from(mark), CAPTURE_RATE)
    }
}

fn append(sink: &Arc<Mutex<Ring>>, samples: impl Iterator<Item = i16>, capacity: usize) {
    if let Ok(mut ring) = sink.lock() {
        ring.push(samples, capacity);
    }
}

/// The 16-bit samples inside a WAV this module made — the inverse of `wav`,
/// for handing a recorded take back to something that scores samples.
pub fn wav_samples_of(bytes: &[u8]) -> Vec<i16> {
    let Some(info) = read_wav_header(bytes) else {
        return Vec::new();
    };
    let end = (info.data_offset + info.data_bytes).min(bytes.len());
    bytes[info.data_offset..end]
        .chunks_exact(2)
        .map(|pair| i16::from_le_bytes([pair[0], pair[1]]))
        .collect()
}

/// A device's name, or a placeholder — only ever used in a message.
fn device_name_or_unknown(device: &cpal::Device) -> String {
    device_name(device).unwrap_or_else(|| "an unnamed device".to_string())
}

fn to_i16(sample: f32) -> i16 {
    (sample.clamp(-1.0, 1.0) * i16::MAX as f32) as i16
}

/// Average the channels together. A stereo microphone pointed at one person is
/// two recordings of the same voice; taking the left one throws half the
/// signal away for nothing.
pub fn to_mono(samples: &[i16], channels: u16) -> Vec<i16> {
    if channels <= 1 {
        return samples.to_vec();
    }
    let n = channels as usize;
    samples
        .chunks_exact(n)
        .map(|frame| (frame.iter().map(|s| *s as i32).sum::<i32>() / n as i32) as i16)
        .collect()
}

/// Rate conversion, with an anti-alias pass on the way down.
///
/// Plain decimation would fold everything above the new Nyquist back into the
/// audible band as a metallic buzz, and a transcriber hears that as words. So:
/// a windowed-sinc low-pass at the destination's Nyquist first, then linear
/// interpolation. Cheap, and correct enough for speech — this is a microphone,
/// not a mastering chain.
pub fn resample(samples: &[i16], from: u32, to: u32) -> Vec<i16> {
    if from == to || samples.is_empty() {
        return samples.to_vec();
    }
    let filtered: Vec<f32> = if from > to {
        low_pass(samples, from, to as f32 * 0.45)
    } else {
        samples.iter().map(|s| *s as f32).collect()
    };
    let ratio = from as f64 / to as f64;
    let count = (filtered.len() as f64 / ratio).floor() as usize;
    (0..count)
        .map(|i| {
            let x = i as f64 * ratio;
            let at = x as usize;
            let frac = (x - at as f64) as f32;
            let a = filtered.get(at).copied().unwrap_or(0.0);
            let b = filtered.get(at + 1).copied().unwrap_or(a);
            (a + (b - a) * frac).clamp(i16::MIN as f32, i16::MAX as f32) as i16
        })
        .collect()
}

/// 63-tap Hamming-windowed sinc. Odd length so the delay is a whole sample and
/// the output does not drift half a sample against the input.
fn low_pass(samples: &[i16], rate: u32, cutoff: f32) -> Vec<f32> {
    const TAPS: usize = 63;
    let half = (TAPS - 1) / 2;
    let fc = cutoff / rate as f32;
    let mut kernel = [0f32; TAPS];
    let mut sum = 0f32;
    for (i, tap) in kernel.iter_mut().enumerate() {
        let n = i as f32 - half as f32;
        let sinc = if n == 0.0 {
            2.0 * fc
        } else {
            (2.0 * std::f32::consts::PI * fc * n).sin() / (std::f32::consts::PI * n)
        };
        let window =
            0.54 - 0.46 * (2.0 * std::f32::consts::PI * i as f32 / (TAPS - 1) as f32).cos();
        *tap = sinc * window;
        sum += *tap;
    }
    for tap in kernel.iter_mut() {
        *tap /= sum;
    }
    samples
        .iter()
        .enumerate()
        .map(|(i, _)| {
            kernel
                .iter()
                .enumerate()
                .map(|(k, tap)| {
                    let j = i as isize + k as isize - half as isize;
                    let s = if j < 0 || j as usize >= samples.len() {
                        0.0
                    } else {
                        samples[j as usize] as f32
                    };
                    s * tap
                })
                .sum()
        })
        .collect()
}

/* ── The one microphone ──────────────────────────────────────────────────── */

/// **Nothing in the shell opens a capture except this.**
///
/// It used to be three things — the wake-word detector, the turn itself, and
/// the follow-up watcher — each opening and closing the device around the
/// others. On PipeWire's ALSA layer that is a stream of
/// `pcm_dsnoop.c: unable to open slave` and a turn that cannot listen because
/// the watcher from the last one has not let go yet (Christer, 2026-08-30).
///
/// So: one open device, reference-counted, and readers take a `Lease` with its
/// own cursor. Two readers cost nothing extra; the device is opened when the
/// first arrives and closed when the last leaves — which keeps the promise that
/// matters, that the microphone is not held open when nothing is listening
/// (§28.6). The OS indicator therefore says exactly what is true.
static MIC: Mutex<Option<Open>> = Mutex::new(None);

struct Open {
    capture: Capture,
    users: usize,
}

/// A reader's claim on the microphone, with its own place in the stream.
/// Dropping it releases the claim, and the last one out closes the device.
pub struct Lease {
    cursor: usize,
    /// Where this lease started, for asking "everything I heard".
    start: usize,
    /// The device that actually opened, and whether it is the one asked for.
    pub opened: String,
    pub fell_back: bool,
}

/// Open the microphone if it is not already, and take a reader's claim on it.
pub fn listen(device_name: Option<&str>) -> Result<Lease, String> {
    let mut slot = MIC.lock().expect("microphone poisoned");
    // An open device is shared as it is, whatever this caller asked for: a
    // second reader must not yank the microphone out from under the first. A
    // changed device setting takes effect when the last reader leaves, which
    // `sync_wake_word` arranges by restarting the detector on the change.
    if slot.is_none() {
        let capture = Capture::start(device_name)?;
        *slot = Some(Open { capture, users: 0 });
    }
    let open = slot.as_mut().expect("just opened");
    open.users += 1;
    Ok(Lease {
        cursor: open.capture.position(),
        start: open.capture.position(),
        opened: open.capture.opened.clone(),
        fell_back: open.capture.fell_back,
    })
}

impl Lease {
    /// What has arrived since this lease last asked.
    pub fn since(&mut self) -> Vec<i16> {
        let slot = MIC.lock().expect("microphone poisoned");
        match slot.as_ref() {
            Some(open) => open.capture.since(&mut self.cursor),
            None => Vec::new(),
        }
    }

    /// One WAV of everything this lease has heard.
    pub fn wav(&self) -> Vec<u8> {
        let slot = MIC.lock().expect("microphone poisoned");
        match slot.as_ref() {
            Some(open) => open.capture.wav_since(self.start),
            None => wav(&[], CAPTURE_RATE),
        }
    }

    /// Forget everything before now — a follow-up turn starting inside a lease
    /// that has been listening for the room, not for a sentence.
    pub fn restart(&mut self) {
        let slot = MIC.lock().expect("microphone poisoned");
        if let Some(open) = slot.as_ref() {
            self.start = open.capture.position();
            self.cursor = self.start;
        }
    }
}

impl Drop for Lease {
    fn drop(&mut self) {
        let mut slot = MIC.lock().expect("microphone poisoned");
        let Some(open) = slot.as_mut() else { return };
        open.users = open.users.saturating_sub(1);
        if open.users == 0 {
            // Last one out closes the device, so the indicator goes off and
            // another application can have the microphone (§28.6).
            *slot = None;
        }
    }
}

/// How many readers the microphone has right now. For tests and the tray.
pub fn listeners() -> usize {
    MIC.lock()
        .expect("microphone poisoned")
        .as_ref()
        .map(|open| open.users)
        .unwrap_or(0)
}

/* ── WAV ─────────────────────────────────────────────────────────────────── */

/// What a RIFF header says. Mirrors `src/model/wav.ts` on the service side —
/// deliberately, because the two ends have to agree about the same bytes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct WavInfo {
    pub channels: u16,
    pub sample_rate: u32,
    pub bits_per_sample: u16,
    /// Byte offset of the first sample.
    pub data_offset: usize,
    /// Sample bytes present. A writer that declared `0xFFFFFFFF` because it was
    /// still generating gets what is actually here — the service's own voice
    /// route writes exactly that header (§33.2).
    pub data_bytes: usize,
}

const UNKNOWN_SIZE: u32 = 0xffff_ffff;

/// 16-bit mono/stereo PCM as one complete WAV.
pub fn wav(samples: &[i16], rate: u32) -> Vec<u8> {
    let data_len = samples.len() * 2;
    let mut out = Vec::with_capacity(44 + data_len);
    out.extend_from_slice(b"RIFF");
    out.extend_from_slice(&((36 + data_len) as u32).to_le_bytes());
    out.extend_from_slice(b"WAVEfmt ");
    out.extend_from_slice(&16u32.to_le_bytes());
    out.extend_from_slice(&1u16.to_le_bytes()); // PCM
    out.extend_from_slice(&1u16.to_le_bytes()); // mono
    out.extend_from_slice(&rate.to_le_bytes());
    out.extend_from_slice(&(rate * 2).to_le_bytes()); // byte rate
    out.extend_from_slice(&2u16.to_le_bytes()); // block align
    out.extend_from_slice(&16u16.to_le_bytes());
    out.extend_from_slice(b"data");
    out.extend_from_slice(&(data_len as u32).to_le_bytes());
    for sample in samples {
        out.extend_from_slice(&sample.to_le_bytes());
    }
    out
}

/// Walk a RIFF header. `None` when these bytes are not a WAV we can measure —
/// which every caller already has to handle, because "the endpoint answered
/// with something else entirely" is a real outcome.
pub fn read_wav_header(bytes: &[u8]) -> Option<WavInfo> {
    if bytes.len() < 12 || &bytes[0..4] != b"RIFF" || &bytes[8..12] != b"WAVE" {
        return None;
    }
    let mut channels = 0u16;
    let mut sample_rate = 0u32;
    let mut bits = 0u16;
    let mut have_fmt = false;
    let mut at = 12usize;
    while at + 8 <= bytes.len() {
        let id = &bytes[at..at + 4];
        let size = u32::from_le_bytes(bytes[at + 4..at + 8].try_into().ok()?);
        let body = at + 8;
        if id == b"fmt " && body + 16 <= bytes.len() {
            channels = u16::from_le_bytes(bytes[body + 2..body + 4].try_into().ok()?);
            sample_rate = u32::from_le_bytes(bytes[body + 4..body + 8].try_into().ok()?);
            bits = u16::from_le_bytes(bytes[body + 14..body + 16].try_into().ok()?);
            have_fmt = true;
        } else if id == b"data" {
            if !have_fmt || channels == 0 || sample_rate == 0 || bits == 0 {
                return None;
            }
            let available = bytes.len() - body;
            let data_bytes = if size == UNKNOWN_SIZE {
                available
            } else {
                (size as usize).min(available)
            };
            return Some(WavInfo {
                channels,
                sample_rate,
                bits_per_sample: bits,
                data_offset: body,
                data_bytes,
            });
        }
        if size == UNKNOWN_SIZE {
            return None; // unwalkable on anything but `data`
        }
        at = body + size as usize + (size as usize % 2);
    }
    None
}

/// 16-bit PCM out of a WAV body, as the floats rodio plays.
pub fn wav_samples(bytes: &[u8], info: &WavInfo) -> Vec<f32> {
    if info.bits_per_sample != 16 {
        return Vec::new();
    }
    let end = (info.data_offset + info.data_bytes).min(bytes.len());
    bytes[info.data_offset..end]
        .chunks_exact(2)
        .map(|pair| i16::from_le_bytes([pair[0], pair[1]]) as f32 / i16::MAX as f32)
        .collect()
}

/* ── Playback ────────────────────────────────────────────────────────────── */

/// A speaker, held open for as long as the shell wants to make noise.
///
/// Opened per playback rather than once at startup: an output device the user
/// switched in the tray must take effect, and a sink held open across a device
/// change is a sink pointed at the old one.
pub struct Speaker {
    _sink: rodio::MixerDeviceSink,
    player: rodio::Player,
    pub fell_back: bool,
}

impl Speaker {
    pub fn open(device_name: Option<&str>) -> Result<Self, String> {
        let mut problems: Vec<String> = Vec::new();
        for (device, wanted) in candidates(false, device_name) {
            let name = device_name_or_unknown(&device);
            match rodio::DeviceSinkBuilder::default()
                .with_device(device)
                .open_stream()
            {
                Ok(mut sink) => {
                    // rodio narrates its own drop to stderr, and this shell
                    // opens a sink per sentence — five lines of "Dropping
                    // DeviceSink" per reply is a log nobody can read past.
                    sink.log_on_drop(false);
                    let player = rodio::Player::connect_new(sink.mixer());
                    return Ok(Self {
                        _sink: sink,
                        player,
                        fell_back: !wanted,
                    });
                }
                Err(e) => {
                    if !problems.iter().any(|p: &String| p.starts_with(&name)) {
                        problems.push(format!("{name}: {e}"));
                    }
                }
            }
        }
        Err(if problems.is_empty() {
            "this machine has no speaker".to_string()
        } else {
            format!("no speaker would open — {}", problems.join("; "))
        })
    }

    /// Queue one WAV. Returns without waiting: the point of streaming speech
    /// (§33.2) is that the next piece can be queued while this one plays.
    pub fn play_wav(&self, bytes: &[u8]) -> Result<(), String> {
        let info = read_wav_header(bytes).ok_or("that is not a WAV this shell can play")?;
        let samples = wav_samples(bytes, &info);
        if samples.is_empty() {
            return Ok(());
        }
        let channels = rodio::ChannelCount::new(info.channels).ok_or("a WAV with no channels")?;
        let rate = rodio::SampleRate::new(info.sample_rate).ok_or("a WAV with no sample rate")?;
        self.player
            .append(rodio::buffer::SamplesBuffer::new(channels, rate, samples));
        Ok(())
    }

    /// Block until everything queued has been heard.
    pub fn wait(&self) {
        self.player.sleep_until_end();
    }

    /// Stop mid-sentence — quiet mode arriving, or the app quitting.
    pub fn stop(&self) {
        self.player.stop();
    }
}

/// A short rising chime: "I am listening" (§28.6). Two tones rather than one,
/// because a single beep is indistinguishable from every other notification
/// sound on a desktop.
pub fn chime() -> Vec<u8> {
    tone(&[(880.0, 70), (1320.0, 90)], CAPTURE_RATE)
}

/// A short falling one: "I heard nothing" — the `422` answer (§28.6).
pub fn soft_tone() -> Vec<u8> {
    tone(&[(660.0, 90)], CAPTURE_RATE)
}

fn tone(parts: &[(f32, u32)], rate: u32) -> Vec<u8> {
    let mut samples = Vec::new();
    for (hz, ms) in parts {
        let count = (rate as u64 * *ms as u64 / 1000) as usize;
        for i in 0..count {
            let t = i as f32 / rate as f32;
            // A raised-cosine envelope: a square-edged tone clicks, and a click
            // is the one sound a notification must not make.
            let progress = i as f32 / count as f32;
            let envelope = (progress * std::f32::consts::PI).sin();
            let value = (2.0 * std::f32::consts::PI * hz * t).sin() * envelope * 0.25;
            samples.push(to_i16(value));
        }
    }
    wav(&samples, rate)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn writes_a_wav_the_reader_reads_back() {
        let samples: Vec<i16> = (0..1600)
            .map(|i| ((i % 100) * 300 - 15_000) as i16)
            .collect();
        let bytes = wav(&samples, CAPTURE_RATE);
        let info = read_wav_header(&bytes).expect("our own WAV must parse");
        assert_eq!(
            info,
            WavInfo {
                channels: 1,
                sample_rate: CAPTURE_RATE,
                bits_per_sample: 16,
                data_offset: 44,
                data_bytes: samples.len() * 2,
            }
        );
        // And the declared RIFF size covers everything after the first eight
        // bytes — the field a player uses to decide how much to read.
        assert_eq!(
            u32::from_le_bytes(bytes[4..8].try_into().unwrap()) as usize,
            bytes.len() - 8
        );
        assert_eq!(wav_samples(&bytes, &info).len(), samples.len());
    }

    #[test]
    fn reads_a_streaming_header_as_however_much_is_here() {
        // The service's `/api/voice` writes `0xFFFFFFFF` for both lengths
        // because it does not know how long the reply is yet (§33.2). A reader
        // that trusts the field reports four gigabytes of audio.
        let mut bytes = wav(&[0i16; 800], CAPTURE_RATE);
        bytes[4..8].copy_from_slice(&UNKNOWN_SIZE.to_le_bytes());
        bytes[40..44].copy_from_slice(&UNKNOWN_SIZE.to_le_bytes());
        let info = read_wav_header(&bytes).expect("a streaming WAV is still a WAV");
        assert_eq!(info.data_bytes, 1600);
    }

    #[test]
    fn refuses_what_is_not_a_wav() {
        assert!(read_wav_header(b"").is_none());
        assert!(read_wav_header(b"{\"error\":\"nothing_heard\"}").is_none());
        // RIFF with no `data` chunk is a header and no audio.
        let mut headless = wav(&[0i16; 4], CAPTURE_RATE);
        headless.truncate(36);
        assert!(read_wav_header(&headless).is_none());
    }

    #[test]
    fn walks_past_a_chunk_it_does_not_know() {
        // A `LIST` chunk before `data` is legal and common, and it is why the
        // reader searches for `data` rather than assuming byte 44.
        let base = wav(&[1234i16; 10], CAPTURE_RATE);
        let mut with_list = Vec::new();
        with_list.extend_from_slice(&base[0..36]);
        with_list.extend_from_slice(b"LIST");
        with_list.extend_from_slice(&8u32.to_le_bytes());
        with_list.extend_from_slice(b"INFOxxxx");
        with_list.extend_from_slice(&base[36..]);
        let info = read_wav_header(&with_list).expect("a LIST chunk is not an error");
        assert_eq!(info.data_offset, 44 + 16);
        assert_eq!(info.data_bytes, 20);
    }

    #[test]
    fn averages_channels_rather_than_taking_one() {
        // Two microphones pointed at one person are two recordings of the same
        // voice; keeping the left one throws half the signal away.
        assert_eq!(to_mono(&[100, 300, -100, -300], 2), vec![200, -200]);
        assert_eq!(to_mono(&[7, 8, 9], 1), vec![7, 8, 9]);
    }

    #[test]
    fn resampling_keeps_the_duration_and_loses_the_alias() {
        // 48 kHz down to 16 kHz: a third of the samples, the same seconds.
        let rate = 48_000;
        let input: Vec<i16> = (0..rate)
            .map(|i| {
                let t = i as f32 / rate as f32;
                ((2.0 * std::f32::consts::PI * 440.0 * t).sin() * 12_000.0) as i16
            })
            .collect();
        let out = resample(&input, rate, CAPTURE_RATE);
        assert!(
            (out.len() as i32 - CAPTURE_RATE as i32).abs() <= 2,
            "one second in, one second out: {} samples",
            out.len()
        );
        // The 440 Hz tone survives: peak amplitude within a fifth of the input.
        let peak = out.iter().map(|s| s.unsigned_abs()).max().unwrap_or(0);
        assert!(peak > 9_000 && peak < 14_000, "peak {peak}");

        // And the anti-alias filter earns its place: a 15 kHz tone sampled at
        // 48 kHz would fold to 1 kHz without it. What comes out is quiet.
        let high: Vec<i16> = (0..rate)
            .map(|i| {
                let t = i as f32 / rate as f32;
                ((2.0 * std::f32::consts::PI * 15_000.0 * t).sin() * 12_000.0) as i16
            })
            .collect();
        let folded = resample(&high, rate, CAPTURE_RATE);
        let folded_peak = folded.iter().map(|s| s.unsigned_abs()).max().unwrap_or(0);
        assert!(folded_peak < 3_000, "alias got through at {folded_peak}");
    }

    /// A `Capture` with no device behind it — the format arithmetic is what
    /// these tests are about, and a unit test has no sound card.
    fn silent(channels: u16) -> Capture {
        Capture {
            _stream: None,
            ring: Arc::new(Mutex::new(Ring::default())),
            source_rate: CAPTURE_RATE,
            source_channels: channels,
            opened: "test".into(),
            fell_back: false,
        }
    }

    fn feed(capture: &Capture, samples: &[i16]) {
        let capacity = CAPTURE_RATE as usize * capture.source_channels as usize * RING_SECONDS;
        capture
            .ring
            .lock()
            .unwrap()
            .push(samples.iter().copied(), capacity);
    }

    #[test]
    fn a_cursor_walks_the_buffer_without_reconverting_it() {
        // The property the polling loops depend on: reading in pieces and
        // reading in one go describe the same audio.
        let capture = silent(1);
        let mut cursor = capture.position();
        assert!(capture.since(&mut cursor).is_empty(), "nothing yet");

        feed(&capture, &[1, 2, 3]);
        assert_eq!(capture.since(&mut cursor), vec![1, 2, 3]);
        // Read twice, get nothing the second time.
        assert!(capture.since(&mut cursor).is_empty());

        feed(&capture, &[4, 5]);
        assert_eq!(capture.since(&mut cursor), vec![4, 5]);
        assert_eq!(capture.from(0), vec![1, 2, 3, 4, 5]);
    }

    #[test]
    fn a_cursor_never_splits_a_stereo_frame() {
        // Half a frame would swap left and right for everything after it.
        let capture = silent(2);
        let mut cursor = 0usize;
        feed(&capture, &[100, 300, 50]);
        // One whole frame out, the orphan left for next time.
        assert_eq!(capture.since(&mut cursor), vec![200]);
        assert_eq!(cursor, 2);
        feed(&capture, &[150]);
        assert_eq!(capture.since(&mut cursor), vec![100]);
    }

    /// The bug this whole module was rearranged for (Christer, 2026-08-30):
    /// the wake-word detector, the turn and the follow-up watcher each opened
    /// their own capture, and on PipeWire's ALSA layer they fought — a stream
    /// of `pcm_dsnoop.c: unable to open slave` and a turn that could not
    /// listen. There is one device now and readers take a claim on it.
    ///
    /// Driven without a sound card: `listen()` needs one, so this exercises the
    /// bookkeeping through the same static it guards.
    #[test]
    fn the_microphone_has_one_owner_and_many_readers() {
        let mut slot = MIC.lock().expect("microphone poisoned");
        assert!(slot.is_none(), "nothing should be holding it");
        // Stand a device in, since a test has none.
        *slot = Some(Open {
            capture: silent(1),
            users: 0,
        });
        drop(slot);

        let take = || {
            let mut slot = MIC.lock().expect("microphone poisoned");
            let open = slot.as_mut().expect("open");
            open.users += 1;
            Lease {
                cursor: open.capture.position(),
                start: open.capture.position(),
                opened: open.capture.opened.clone(),
                fell_back: false,
            }
        };
        let first = take();
        let second = take();
        assert_eq!(listeners(), 2, "two readers, one device");

        // One leaving does not close it — the other is still listening.
        drop(second);
        assert_eq!(listeners(), 1);
        assert!(MIC.lock().unwrap().is_some(), "still open for the first");

        // The last one out closes it, so the OS indicator goes off and another
        // application can have the microphone (§28.6).
        drop(first);
        assert_eq!(listeners(), 0);
        assert!(
            MIC.lock().unwrap().is_none(),
            "nothing listening means nothing open"
        );
    }

    #[test]
    fn the_ring_forgets_the_oldest_rather_than_growing_forever() {
        // A wake-word detector holds the microphone all day. The buffer used
        // to be a `Vec` nobody trimmed, which is a gigabyte by teatime.
        let mut ring = Ring::default();
        ring.push([1i16, 2, 3, 4, 5].into_iter(), 3);
        assert_eq!(ring.samples, vec![3, 4, 5]);
        assert_eq!(ring.dropped, 2);
        assert_eq!(ring.position(), 5);
    }

    #[test]
    fn a_reader_that_fell_behind_is_moved_forward_rather_than_misled() {
        // Its audio is gone. Handing it whatever now sits at that index would
        // be the wrong seconds, silently.
        let mut ring = Ring::default();
        let mut cursor = 0usize;
        ring.push([1i16, 2].into_iter(), 100);
        assert_eq!(ring.since(&mut cursor), &[1, 2]);
        ring.push((0..200i16).map(|i| i + 10), 50);
        // Everything the cursor pointed at has been evicted…
        assert!(ring.dropped > cursor);
        let caught_up = ring.since(&mut cursor).to_vec();
        // …so it resumes at the oldest sample still held, not at nothing.
        assert_eq!(caught_up.len(), 50);
        assert_eq!(cursor, ring.position());
    }

    #[test]
    fn resampling_is_a_no_op_at_the_same_rate() {
        let input = vec![1i16, -2, 3, -4];
        assert_eq!(resample(&input, CAPTURE_RATE, CAPTURE_RATE), input);
        assert!(resample(&[], 48_000, CAPTURE_RATE).is_empty());
    }

    #[test]
    fn the_chime_is_a_playable_wav_of_real_sound() {
        for bytes in [chime(), soft_tone()] {
            let info = read_wav_header(&bytes).expect("a chime is a WAV");
            assert_eq!(info.sample_rate, CAPTURE_RATE);
            let samples = wav_samples(&bytes, &info);
            assert!(!samples.is_empty());
            let peak = samples.iter().fold(0f32, |m, s| m.max(s.abs()));
            assert!(peak > 0.1, "a silent chime is not a chime: {peak}");
            // No click: the envelope means it starts and ends at zero.
            assert!(samples[0].abs() < 0.01);
            assert!(samples.last().unwrap().abs() < 0.01);
        }
    }
}
