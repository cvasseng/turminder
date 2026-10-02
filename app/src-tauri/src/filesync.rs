//! The files folder (§28.8): `~/Turminder`, kept in two-way sync with the
//! service's file store over the connection the shell already holds.
//!
//! The client half of §18.6. The server computes every hash and applies every
//! change compare-and-swap; this side only has to notice its own changes —
//! by `(mtime, size)`, never by hashing, which is what keeps a hash crate out
//! of the shell — and remember which server version each path was last synced
//! as. That memory is `filesync.json` in the shell's state dir.
//!
//! The dangerous direction is deletion, so the whole module is arranged around
//! not doing it by accident:
//!
//! - **The decision is a pure function** (`reconcile`), so every row of the
//!   §28.8 table is a test case rather than a hope.
//! - **The mass-delete guard** (`guard`) runs before it: a state file that
//!   belongs to another server, a folder that is missing, a folder that holds
//!   nothing at all, or a manifest that lists nothing at all resets the state
//!   to empty — and with an empty state the table can only download or
//!   upload, never delete. An unmounted disk on either side re-syncs; it
//!   never reads as "everything was deleted".
//! - **Nothing is overwritten that changed since it was looked at**: a download
//!   re-stats its target before the rename, and a local delete re-stats before
//!   the unlink.
//!
//! Network failure ends a cycle quietly and the next trigger retries; the shell
//! never notifies about sync — a conflict is the server's notification
//! (§18.6), and everything else heals on its own.

use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

use crate::connect::Connection;
use crate::http;

/// `files_sync_walk_s` (App. A): how often the folder is stat-walked for a
/// local change. Stat only — no file is read to find out it changed.
pub const WALK_INTERVAL: Duration = Duration::from_secs(5);

/// `files_sync_manifest_s` (App. A): the fallback cycle, for whatever no
/// frame and no walk announced.
pub const MANIFEST_INTERVAL: Duration = Duration::from_secs(60);

/// Downloads land under this prefix and are renamed into place, and the walk
/// never sees a name that starts with it — so a half-written download is
/// never uploaded as somebody's edit (§28.8).
pub const TEMP_PREFIX: &str = ".turminder-sync-";

const FOLDER_NAME: &str = "Turminder";
const STATE_FILE: &str = "filesync.json";
/// Per socket operation, not per transfer: `http.rs` timeouts are read and
/// write timeouts, so a large file on a slow link still finishes as long as it
/// keeps moving.
const TIMEOUT: Duration = Duration::from_secs(30);
const BASE_HEADER: &str = "X-Turminder-Base";

/// One cycle at a time across the whole process, not just per syncer.
///
/// The syncer is rebuilt whenever the device socket is (a voice toggle
/// reconnects to change `hello`), and the old one finishes the action it is in
/// before it notices it was stopped. Two cycles interleaving their reads and
/// writes of one state file is the overlap §28.8 forbids, so the new one waits.
/// Process-wide state for the same reason `store.rs` keeps its session slot:
/// the folder and the state file are process-wide too.
static CYCLE: Mutex<()> = Mutex::new(());

/// Per synced path: the server version last synced, and the local
/// `(mtime, size)` it was written or read as (§28.8). `sha256: None` is a file
/// the server refused — it is not retried until it changes again.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Entry {
    pub sha256: Option<String>,
    pub mtime_ms: u64,
    pub size: u64,
}

/// `filesync.json`: `{server, files: {<path>: Entry}}` (§28.8).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct SyncState {
    pub server: String,
    pub files: BTreeMap<String, Entry>,
}

/// What the walk saw of one local file. Never its bytes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Local {
    pub mtime_ms: u64,
    pub size: u64,
}

/// One manifest entry, reduced to what the table reads.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Remote {
    pub sha256: String,
    pub size: u64,
}

/// `GET /api/files/manifest`, keyed by path (§18.6).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Manifest {
    pub files: BTreeMap<String, Remote>,
    pub max_bytes: u64,
}

/// What the table decided for one path.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Action {
    /// `PUT` with this base; `None` is sent as `none` (never synced, or refused).
    Upload { path: String, base: Option<String> },
    /// `GET /api/files/raw` into place.
    Download { path: String },
    /// The server deleted it: delete the local copy, drop the state entry.
    DeleteLocal { path: String },
    /// The user deleted it: `DELETE` with this base.
    DeleteRemote { path: String, base: String },
    /// Drop the state entry and touch nothing else.
    Forget { path: String },
}

/// The §28.8 table, row by row, over every path any of the three sides knows.
///
/// Pure on purpose: this is the function that decides what gets deleted, and
/// it is tested without a socket or a disk.
pub fn reconcile(
    local: &BTreeMap<String, Local>,
    state: &BTreeMap<String, Entry>,
    manifest: &Manifest,
) -> Vec<Action> {
    let paths: BTreeSet<&String> = local
        .keys()
        .chain(state.keys())
        .chain(manifest.files.keys())
        .collect();
    paths
        .into_iter()
        .filter_map(|path| {
            decide(
                path,
                local.get(path),
                state.get(path),
                manifest.files.get(path),
                manifest.max_bytes,
            )
        })
        .collect()
}

fn decide(
    path: &str,
    l: Option<&Local>,
    s: Option<&Entry>,
    m: Option<&Remote>,
    max_bytes: u64,
) -> Option<Action> {
    // Over the limit on either side: skipped entirely — before the refused
    // rule, so a file refused as too large is not re-sent every time it grows.
    if l.is_some_and(|l| l.size > max_bytes) || m.is_some_and(|m| m.size > max_bytes) {
        return None;
    }
    let path = path.to_string();
    // *Local changed*: present, and either never synced or not as it was.
    let changed = match (l, s) {
        (Some(l), Some(s)) => l.mtime_ms != s.mtime_ms || l.size != s.size,
        (Some(_), None) => true,
        (None, _) => false,
    };

    // A refused file bypasses the table: never re-sent unchanged, never
    // deleted anywhere because of it.
    if s.is_some_and(|s| s.sha256.is_none()) {
        return match l {
            None => Some(Action::Forget { path }),
            Some(_) if changed => Some(Action::Upload { path, base: None }),
            Some(_) => None,
        };
    }

    if changed {
        let base = s.and_then(|s| s.sha256.clone());
        return Some(Action::Upload { path, base });
    }
    // From here every `S` is a synced one, so its hash is present.
    let synced = |s: &Entry| s.sha256.clone().unwrap_or_default();
    match (l, s, m) {
        (Some(_), Some(s), Some(m)) if m.sha256 != synced(s) => Some(Action::Download { path }),
        (None, None, Some(_)) => Some(Action::Download { path }),
        (Some(_), Some(_), None) => Some(Action::DeleteLocal { path }),
        (None, Some(s), Some(m)) if m.sha256 == synced(s) => Some(Action::DeleteRemote {
            path,
            base: synced(s),
        }),
        // An edit beats a delete.
        (None, Some(_), Some(_)) => Some(Action::Download { path }),
        (None, Some(_), None) => Some(Action::Forget { path }),
        _ => None,
    }
}

/// The mass-delete guard (§28.8): the state is only believed when it is about
/// this server, this folder existed when the cycle began, and the folder holds
/// something. Otherwise it is reset to empty, and an empty state can only
/// download.
///
/// The empty folder is the case that matters most and the one a literal
/// reading of "missing" misses: an unmounted disk usually leaves its mount
/// point behind, and to the table an empty directory with a full state file is
/// a user who deleted every file — a `DELETE` for each one.
///
/// The mirror guard is the same argument from the other side: a manifest with
/// no files at all is a server whose store came up empty (an unmounted disk, a
/// wrong `files.dir`), and to the table that is a server that deleted
/// everything — a local delete for each file. Reset instead, and the local
/// files go back up with base `none`, which is the recovery.
pub fn guard(
    state: SyncState,
    server: &str,
    folder_existed: bool,
    local: &BTreeMap<String, Local>,
    manifest: &Manifest,
) -> SyncState {
    if state.server != server || !folder_existed || local.is_empty() || manifest.files.is_empty() {
        SyncState {
            server: server.to_string(),
            files: BTreeMap::new(),
        }
    } else {
        state
    }
}

/// The one predicate (§28.8): does `rel` sync? Applied to the walk and to the
/// manifest alike, because a path one side can see and the other cannot reads
/// as a deletion on the side that cannot.
///
/// A plain relative path — no empty, `.` or `..` segment, no leading `/`, no
/// backslash in any name (a server would store `a\b.md` as `a/b.md`, a
/// different path from the one uploaded) — with no segment beginning the
/// download prefix and no `.git` segment at any depth: the server ignores
/// only its own top-level `.git`, so a nested repository it lists is one the
/// walk must not see either, or its files read as deleted here.
///
/// On Windows, also no `:` anywhere and no segment ending in `.` or a space: a
/// drive prefix (`C:/…`) makes `root.join` *replace* the root, and Windows
/// silently strips a trailing dot or space, which is a rename of the file.
pub fn syncable(rel: &str) -> bool {
    syncable_on(rel, cfg!(windows))
}

/// `syncable` with the platform as an argument, so the Windows clause is
/// tested on every platform rather than only on the one that needs it.
fn syncable_on(rel: &str, windows: bool) -> bool {
    !rel.is_empty()
        && !rel.contains(['\\', '\0'])
        && !(windows && rel.contains(':'))
        && rel.split('/').all(|segment| {
            !segment.is_empty()
                && segment != "."
                && segment != ".."
                && segment != ".git"
                && !segment.starts_with(TEMP_PREFIX)
                && !(windows && (segment.ends_with('.') || segment.ends_with(' ')))
        })
}

/// Is `rel`, or any directory above it inside `root`, a symlink on this disk
/// (§28.8)? Such a path is unsyncable here: the walk never sees through a
/// link, so a manifest entry beneath one would read as a local delete — every
/// file of a folder somebody moved and linked back, `DELETE`d on the server.
fn locally_linked(root: &Path, rel: &str) -> bool {
    let mut at = root.to_path_buf();
    rel.split('/').any(|segment| {
        at.push(segment);
        is_symlink(&at)
    })
}

/// `root/rel`, if every component of `rel` is a plain name and the result is
/// inside `root` — checked on the path itself, independently of `syncable`,
/// because this is the line between the folder and the rest of the disk.
fn contained(root: &Path, rel: &str) -> Option<PathBuf> {
    let relative = Path::new(rel);
    if !relative
        .components()
        .all(|c| matches!(c, std::path::Component::Normal(_)))
    {
        return None;
    }
    let joined = root.join(relative);
    joined.starts_with(root).then_some(joined)
}

/// Every syncable regular file under `root`, by `/`-separated relative path
/// (§28.8).
///
/// Symlinks are skipped, file or directory: following one would sync a part of
/// the disk the user never put in this folder. A name that is not UTF-8 has no
/// path the server could hold, and is skipped too.
///
/// `Err` for anything but an entry vanishing mid-walk: a subfolder this walk
/// could not read is not a subfolder whose files were deleted, and the cycle
/// must end rather than act on that reading. A missing `root` is an empty
/// walk — the guard's business, not an error.
pub fn walk(root: &Path) -> Result<BTreeMap<String, Local>, String> {
    let mut out = BTreeMap::new();
    match std::fs::read_dir(root) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(out),
        Err(e) => Err(walk_error(&e)),
        Ok(entries) => {
            walk_entries(entries, "", &mut out)?;
            Ok(out)
        }
    }
}

/// The walk's failure, without the path: file names are the user's (§28.8
/// logs nothing about which file).
fn walk_error(e: &std::io::Error) -> String {
    format!("the folder could not be read completely: {e}")
}

/// Ok(None) for an entry that vanished mid-walk, the one error a walk shrugs.
fn vanished<T>(result: std::io::Result<T>) -> Result<Option<T>, String> {
    match result {
        Ok(value) => Ok(Some(value)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(walk_error(&e)),
    }
}

fn walk_entries(
    entries: std::fs::ReadDir,
    prefix: &str,
    out: &mut BTreeMap<String, Local>,
) -> Result<(), String> {
    for entry in entries {
        let Some(entry) = vanished(entry)? else {
            continue;
        };
        let Some(name) = entry.file_name().to_str().map(str::to_string) else {
            continue;
        };
        let rel = if prefix.is_empty() {
            name
        } else {
            format!("{prefix}/{name}")
        };
        // A directory whose own path does not sync holds nothing that does.
        if !syncable(&rel) {
            continue;
        }
        // `DirEntry::file_type` does not follow symlinks, which is the point.
        let Some(kind) = vanished(entry.file_type())? else {
            continue;
        };
        if kind.is_dir() {
            if let Some(children) = vanished(std::fs::read_dir(entry.path()))? {
                walk_entries(children, &rel, out)?;
            }
        } else if kind.is_file() {
            if let Some(meta) = vanished(entry.metadata())? {
                out.insert(rel, local_of(&meta));
            }
        }
    }
    Ok(())
}

/// Remove everything named `.turminder-sync-*` under `root` that is a file or
/// a symlink — a download interrupted between its write and its rename
/// (§28.8). Never a directory, and never through a symlinked one: this
/// deletes, and only inside the folder. Best effort; a leftover it cannot
/// remove is still invisible to the walk.
fn sweep_temp(dir: &Path) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let Ok(kind) = entry.file_type() else {
            continue;
        };
        let leftover = entry
            .file_name()
            .to_str()
            .is_some_and(|name| name.starts_with(TEMP_PREFIX));
        if kind.is_dir() {
            sweep_temp(&entry.path());
        } else if leftover && (kind.is_file() || kind.is_symlink()) {
            let _ = std::fs::remove_file(entry.path());
        }
    }
}

fn local_of(meta: &std::fs::Metadata) -> Local {
    Local {
        mtime_ms: meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0),
        size: meta.len(),
    }
}

/// What is at a path right now, without following a symlink.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Seen {
    Absent,
    File(Local),
    /// A directory, a symlink, a device — nothing a sync may replace.
    Other,
}

fn observe(path: &Path) -> Seen {
    match std::fs::symlink_metadata(path) {
        Ok(meta) if meta.file_type().is_file() => Seen::File(local_of(&meta)),
        Ok(_) => Seen::Other,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Seen::Absent,
        Err(_) => Seen::Other,
    }
}

fn expected(walked: Option<Local>) -> Seen {
    walked.map_or(Seen::Absent, Seen::File)
}

/// `root/rel`, if it syncs and nothing between `root` and it is a symlink or a
/// file.
///
/// The walk never descends a symlinked directory, so a manifest path through
/// one would otherwise be a download *through* the link, into whatever part of
/// the disk it points at.
fn safe_target(root: &Path, rel: &str) -> Option<PathBuf> {
    if !syncable(rel) {
        return None;
    }
    let target = contained(root, rel)?;
    let segments: Vec<&str> = rel.split('/').collect();
    let mut at = root.to_path_buf();
    for segment in &segments[..segments.len() - 1] {
        at.push(segment);
        match observe(&at) {
            Seen::Absent => {}
            Seen::Other if at.is_dir() && !is_symlink(&at) => {}
            _ => return None,
        }
    }
    Some(target)
}

fn is_symlink(path: &Path) -> bool {
    std::fs::symlink_metadata(path).is_ok_and(|m| m.file_type().is_symlink())
}

/// Create the temp file fresh (§28.8): whatever already sits at its name — a
/// file, or a symlink somebody planted pointing elsewhere — is removed first,
/// and `create_new` refuses to open through anything that reappears. A
/// directory there is left alone, and the download is abandoned.
fn write_fresh(temp: &Path, bytes: &[u8]) -> Option<()> {
    use std::io::Write;
    match std::fs::symlink_metadata(temp) {
        Ok(meta) if meta.file_type().is_dir() => return None,
        Ok(_) => std::fs::remove_file(temp).ok()?,
        Err(_) => {}
    }
    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(temp)
        .ok()?;
    if file.write_all(bytes).is_err() {
        let _ = std::fs::remove_file(temp);
        return None;
    }
    Some(())
}

/// Write `bytes` over `target` through a temp file and a rename — unless the
/// target is no longer what the walk saw (§28.8). Returns the installed file's
/// own `(mtime, size)`, or `None` when it was abandoned or could not be
/// written; the temp file never outlives the call.
fn install(target: &Path, bytes: &[u8], walked: Option<Local>) -> Option<Local> {
    let parent = target.parent()?;
    let name = target.file_name()?.to_str()?;
    std::fs::create_dir_all(parent).ok()?;
    let temp = parent.join(format!("{TEMP_PREFIX}{name}"));
    let mut created = false;
    let installed = (|| {
        write_fresh(&temp, bytes)?;
        created = true;
        // The re-stat: somebody saved over this file while it downloaded, and
        // their save wins. The next cycle uploads it, and if the server moved
        // too, a conflict copy keeps both.
        if observe(target) != expected(walked) {
            return None;
        }
        std::fs::rename(&temp, target).ok()?;
        match observe(target) {
            Seen::File(local) => Some(local),
            _ => None,
        }
    })();
    if installed.is_none() && created {
        let _ = std::fs::remove_file(&temp);
    }
    installed
}

/// The folder (§28.8): the home directory plus `Turminder`, fixed.
pub fn folder() -> Result<PathBuf, String> {
    Ok(crate::platform::home_dir()?.join(FOLDER_NAME))
}

fn state_path() -> Result<PathBuf, String> {
    Ok(crate::platform::state_dir()?.join(STATE_FILE))
}

/// The state as written, or empty — a missing or unreadable file is a state
/// that re-downloads, which is the safe direction.
pub fn load_state(path: &Path) -> SyncState {
    std::fs::read_to_string(path)
        .ok()
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_default()
}

/// Temp + rename: a state file cut short by a crash would read as empty, which
/// is safe, but one cut short and still parseable would be a lie.
pub fn save_state(path: &Path, state: &SyncState) -> Result<(), String> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let raw = serde_json::to_vec(state).map_err(|e| e.to_string())?;
    let temp = path.with_extension("json.tmp");
    std::fs::write(&temp, raw).map_err(|e| e.to_string())?;
    std::fs::rename(&temp, path).map_err(|e| e.to_string())
}

#[derive(Deserialize)]
struct WireManifest {
    files: Vec<WireEntry>,
    max_bytes: u64,
}

#[derive(Deserialize)]
struct WireEntry {
    path: String,
    sha256: String,
    size: u64,
}

/// The manifest, minus any path that does not sync (`syncable`) — the same
/// filter the walk applies, so neither side sees a path the other cannot.
pub fn parse_manifest(text: &str) -> Result<Manifest, String> {
    let wire: WireManifest =
        serde_json::from_str(text).map_err(|e| format!("unreadable manifest: {e}"))?;
    Ok(Manifest {
        max_bytes: wire.max_bytes,
        files: wire
            .files
            .into_iter()
            .filter(|f| syncable(&f.path))
            .map(|f| {
                (
                    f.path,
                    Remote {
                        sha256: f.sha256,
                        size: f.size,
                    },
                )
            })
            .collect(),
    })
}

/// `<base><route>?path=<path>`, encoded by the `url` crate the shell already
/// has rather than by hand.
fn route(connection: &Connection, route: &str, path: Option<&str>) -> Result<String, String> {
    let mut url = url::Url::parse(&connection.base_url).map_err(|e| e.to_string())?;
    url.set_path(route);
    if let Some(path) = path {
        url.query_pairs_mut().append_pair("path", path);
    }
    Ok(url.to_string())
}

fn fetch_manifest(connection: &Connection) -> Result<Manifest, String> {
    let response = http::get(
        &route(connection, "/api/files/manifest", None)?,
        Some(&connection.token),
        TIMEOUT,
    )?;
    if response.status != 200 {
        return Err(format!("the manifest answered {}", response.status));
    }
    parse_manifest(&response.text())
}

/// One cycle (§28.8): manifest, walk, guard, table, and the actions in order.
///
/// `Err` is a network failure, and ends the cycle where it happened — every
/// action already applied is in the state file, because it is saved after
/// each one. A refusal is a status, not an error, and is handled per path.
pub fn run_cycle(
    connection: &Connection,
    root: &Path,
    state_file: &Path,
    stopped: &dyn Fn() -> bool,
) -> Result<(), String> {
    let folder_existed = root.is_dir();
    if !folder_existed {
        std::fs::create_dir_all(root).map_err(|e| e.to_string())?;
    }
    sweep_temp(root);
    let mut manifest = fetch_manifest(connection)?;
    // The local half of the predicate: what lies under a symlink here is as
    // invisible in the manifest as it is to the walk.
    manifest.files.retain(|path, _| !locally_linked(root, path));
    let local = walk(root)?;
    let mut state = guard(
        load_state(state_file),
        &connection.base_url,
        folder_existed,
        &local,
        &manifest,
    );
    save_state(state_file, &state)?;
    let mut cycle = Cycle {
        connection,
        root,
        local: &local,
        state: &mut state,
    };
    for action in reconcile(&local, &cycle.state.files, &manifest) {
        if stopped() {
            break;
        }
        let outcome = cycle.apply(action);
        save_state(state_file, cycle.state)?;
        outcome?;
    }
    Ok(())
}

struct Cycle<'a> {
    connection: &'a Connection,
    root: &'a Path,
    local: &'a BTreeMap<String, Local>,
    state: &'a mut SyncState,
}

impl Cycle<'_> {
    fn apply(&mut self, action: Action) -> Result<(), String> {
        match action {
            Action::Upload { path, base } => self.upload(&path, base.as_deref()),
            Action::Download { path } => {
                let walked = self.local.get(&path).copied();
                self.download(&path, walked)
            }
            Action::DeleteLocal { path } => {
                self.delete_local(&path);
                Ok(())
            }
            Action::DeleteRemote { path, base } => self.delete_remote(&path, &base),
            Action::Forget { path } => {
                self.state.files.remove(&path);
                Ok(())
            }
        }
    }

    fn record(&mut self, path: &str, sha256: Option<String>, local: Local) {
        self.state.files.insert(
            path.to_string(),
            Entry {
                sha256,
                mtime_ms: local.mtime_ms,
                size: local.size,
            },
        );
    }

    fn upload(&mut self, path: &str, base: Option<&str>) -> Result<(), String> {
        let abs = self.root.join(path);
        // Stat, read, stat: a file mid-save is left for the walk to bring
        // back once it has settled, rather than uploaded half-written.
        let Seen::File(before) = observe(&abs) else {
            return Ok(());
        };
        let Ok(bytes) = std::fs::read(&abs) else {
            return Ok(());
        };
        if observe(&abs) != Seen::File(before) {
            return Ok(());
        }
        let response = http::put(
            &route(self.connection, "/api/files/sync", Some(path))?,
            Some(&self.connection.token),
            &[(BASE_HEADER, base.unwrap_or("none"))],
            http::Body {
                content_type: "application/octet-stream",
                bytes: &bytes,
            },
            TIMEOUT,
        )?;
        match response.status {
            200 => {
                if let Some(sha) = json_field(&response, "sha256") {
                    self.record(path, Some(sha), before);
                }
                Ok(())
            }
            // The server kept its version and the upload as a conflict copy
            // (§18.6): take the original now; the copy arrives next cycle.
            409 => self.download(path, Some(before)),
            // Refused: remembered as refused, so it is neither retried until
            // it changes nor ever deleted because of it.
            403 | 413 | 422 => {
                self.record(path, None, before);
                Ok(())
            }
            _ => Ok(()),
        }
    }

    fn download(&mut self, path: &str, walked: Option<Local>) -> Result<(), String> {
        let Some(target) = safe_target(self.root, path) else {
            return Ok(());
        };
        let response = http::get(
            &route(self.connection, "/api/files/raw", Some(path))?,
            Some(&self.connection.token),
            TIMEOUT,
        )?;
        if response.status != 200 {
            // 404: gone since the manifest was read. The next one says so.
            return Ok(());
        }
        // The hash of the bytes actually served, not the manifest's, which may
        // describe a version that has moved on since (§18.6).
        let Some(sha) = response
            .header("x-turminder-sha256")
            .map(str::to_string)
            .filter(|h| !h.is_empty())
        else {
            return Ok(());
        };
        // `http.rs` keeps what arrived when a stream stalls; for a file that
        // would be a truncated copy recorded as the server's version.
        let declared = response
            .header("content-length")
            .and_then(|v| v.trim().parse::<usize>().ok());
        if declared.is_some_and(|n| n != response.body.len()) {
            return Err("a download was cut short".into());
        }
        if let Some(local) = install(&target, &response.body, walked) {
            self.record(path, Some(sha), local);
        }
        Ok(())
    }

    fn delete_local(&mut self, path: &str) {
        let abs = self.root.join(path);
        // Changed since the walk: the edit wins, and the next cycle uploads it.
        if observe(&abs) != expected(self.local.get(path).copied()) {
            return;
        }
        if std::fs::remove_file(&abs).is_ok() {
            self.state.files.remove(path);
        }
    }

    fn delete_remote(&mut self, path: &str, base: &str) -> Result<(), String> {
        let response = http::delete(
            &route(self.connection, "/api/files/sync", Some(path))?,
            Some(&self.connection.token),
            &[(BASE_HEADER, base)],
            TIMEOUT,
        )?;
        match response.status {
            200 | 404 => {
                self.state.files.remove(path);
                Ok(())
            }
            // The server kept the file — changed there while it was deleted
            // here (409: an edit beats a delete, §18.6), or its own unlink
            // failed (422 `unwritable`). Either way it is still there, so the
            // local copy comes back rather than the delete being retried
            // every cycle (§28.8).
            409 | 422 => self.download(path, None),
            _ => Ok(()),
        }
    }
}

fn json_field(response: &http::Response, field: &str) -> Option<String> {
    serde_json::from_str::<serde_json::Value>(&response.text())
        .ok()?
        .get(field)?
        .as_str()
        .map(str::to_string)
}

/// Does the folder differ from what the state says was synced? A path new,
/// gone, or with a different `(mtime, size)` — the walk trigger (§28.8).
fn differs(local: &BTreeMap<String, Local>, state: &SyncState, server: &str) -> bool {
    if state.server != server {
        return !local.is_empty();
    }
    local.len() != state.files.len()
        || local.iter().any(|(path, l)| {
            state
                .files
                .get(path)
                .map_or(true, |s| s.mtime_ms != l.mtime_ms || s.size != l.size)
        })
}

/// Does this tick run a cycle (§28.8)? A frame asked for one, the fallback is
/// due, or the walk found a difference from the state — **once per distinct
/// walk result**: `seen` is the walk the last cycle started from, so a
/// difference no cycle could settle (a server that is down, a file over the
/// limit) waits for the next trigger instead of firing every walk. A walk that
/// failed (`None`) triggers nothing on its own.
fn cycle_due(
    triggered: bool,
    since_last_cycle: Duration,
    snapshot: Option<&BTreeMap<String, Local>>,
    seen: Option<&BTreeMap<String, Local>>,
    state: &SyncState,
    server: &str,
) -> bool {
    triggered
        || since_last_cycle >= MANIFEST_INTERVAL
        || snapshot.is_some_and(|walked| seen != Some(walked) && differs(walked, state, server))
}

#[derive(Default)]
struct Signal {
    triggered: bool,
    stopped: bool,
}

#[derive(Default)]
struct Shared {
    signal: Mutex<Signal>,
    wake: Condvar,
}

/// The handle the device socket holds: `welcome` and `files.changed` fire it
/// (§28.8). Firing is a flag and a notify, so it is safe on the async runtime.
#[derive(Clone)]
pub struct Trigger(Arc<Shared>);

impl Trigger {
    /// Ask for a cycle. Any number of these during one cycle is one more cycle
    /// after it, never several.
    pub fn fire(&self) {
        self.0
            .signal
            .lock()
            .expect("sync signal poisoned")
            .triggered = true;
        self.0.wake.notify_all();
    }
}

/// A running sync for one connection. Stopping (or dropping) it ends the loop
/// after the action in flight; it never cuts a download off mid-rename.
pub struct Syncer {
    shared: Arc<Shared>,
}

impl Syncer {
    pub fn trigger(&self) -> Trigger {
        Trigger(self.shared.clone())
    }

    pub fn stop(&self) {
        self.shared
            .signal
            .lock()
            .expect("sync signal poisoned")
            .stopped = true;
        self.shared.wake.notify_all();
    }
}

impl Drop for Syncer {
    fn drop(&mut self) {
        self.stop();
    }
}

/// Start syncing `~/Turminder` against `connection` (connect mode only — the
/// caller decides that). `None` when this machine has no home directory or
/// state dir to sync with, which leaves the rest of the shell untouched.
///
/// Its own thread rather than the async runtime's blocking pool: this is a
/// loop that lives as long as the connection, and every request in it is a
/// blocking `http.rs` call that must never sit on a thread the WS loop needs.
pub fn start(connection: Connection) -> Option<Syncer> {
    let root = folder().ok()?;
    let state_file = state_path().ok()?;
    let shared = Arc::new(Shared::default());
    let looped = shared.clone();
    std::thread::Builder::new()
        .name("filesync".into())
        .spawn(move || run_loop(&looped, &connection, &root, &state_file))
        .ok()?;
    Some(Syncer { shared })
}

fn run_loop(shared: &Shared, connection: &Connection, root: &Path, state_file: &Path) {
    let stopped = || shared.signal.lock().expect("sync signal poisoned").stopped;
    let mut last_cycle = Instant::now();
    // The walk the last cycle started from (see `cycle_due`).
    let mut seen: Option<BTreeMap<String, Local>> = None;
    loop {
        let triggered = {
            let signal = shared.signal.lock().expect("sync signal poisoned");
            let (mut signal, _) = shared
                .wake
                .wait_timeout_while(signal, WALK_INTERVAL, |s| !s.triggered && !s.stopped)
                .expect("sync signal poisoned");
            if signal.stopped {
                return;
            }
            std::mem::take(&mut signal.triggered)
        };
        let snapshot = walk(root).ok();
        if !cycle_due(
            triggered,
            last_cycle.elapsed(),
            snapshot.as_ref(),
            seen.as_ref(),
            &load_state(state_file),
            &connection.base_url,
        ) {
            continue;
        }
        if snapshot.is_some() {
            seen = snapshot;
        }
        let _one_at_a_time = CYCLE.lock().unwrap_or_else(|p| p.into_inner());
        if stopped() {
            return;
        }
        if let Err(problem) = run_cycle(connection, root, state_file, &stopped) {
            // Quietly (§28.8): stderr for whoever is debugging, nothing on
            // screen. No path in the line — file names are the user's.
            eprintln!("file sync: cycle ended early: {problem}");
        }
        last_cycle = Instant::now();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};

    fn l(mtime_ms: u64, size: u64) -> Local {
        Local { mtime_ms, size }
    }

    fn s(sha: Option<&str>, mtime_ms: u64, size: u64) -> Entry {
        Entry {
            sha256: sha.map(str::to_string),
            mtime_ms,
            size,
        }
    }

    fn m(sha: &str, size: u64) -> Remote {
        Remote {
            sha256: sha.into(),
            size,
        }
    }

    /// One path through the table: `L`, `S`, `M` for `a.md`, max 1000 bytes.
    fn one(local: Option<Local>, state: Option<Entry>, remote: Option<Remote>) -> Vec<Action> {
        let path = "a.md".to_string();
        let local: BTreeMap<_, _> = local.map(|v| (path.clone(), v)).into_iter().collect();
        let state: BTreeMap<_, _> = state.map(|v| (path.clone(), v)).into_iter().collect();
        let manifest = Manifest {
            files: remote.map(|v| (path.clone(), v)).into_iter().collect(),
            max_bytes: 1000,
        };
        reconcile(&local, &state, &manifest)
    }

    fn path() -> String {
        "a.md".into()
    }

    #[test]
    fn row_local_changed_uploads_against_the_synced_base() {
        // New locally: never synced, so the base is `none`.
        assert_eq!(
            one(Some(l(1, 10)), None, None),
            vec![Action::Upload {
                path: path(),
                base: None
            }]
        );
        assert_eq!(
            one(Some(l(1, 10)), None, Some(m("srv", 10))),
            vec![Action::Upload {
                path: path(),
                base: None
            }]
        );
        // Edited locally: mtime or size moved, whatever the server did.
        for local in [l(2, 10), l(1, 11)] {
            assert_eq!(
                one(Some(local), Some(s(Some("h1"), 1, 10)), Some(m("h2", 10))),
                vec![Action::Upload {
                    path: path(),
                    base: Some("h1".into())
                }]
            );
        }
    }

    #[test]
    fn row_unchanged_here_changed_there_downloads() {
        assert_eq!(
            one(
                Some(l(1, 10)),
                Some(s(Some("h1"), 1, 10)),
                Some(m("h2", 12))
            ),
            vec![Action::Download { path: path() }]
        );
    }

    #[test]
    fn row_new_on_the_server_downloads() {
        assert_eq!(
            one(None, None, Some(m("h", 10))),
            vec![Action::Download { path: path() }]
        );
    }

    #[test]
    fn row_deleted_on_the_server_deletes_here() {
        assert_eq!(
            one(Some(l(1, 10)), Some(s(Some("h1"), 1, 10)), None),
            vec![Action::DeleteLocal { path: path() }]
        );
    }

    #[test]
    fn row_deleted_here_and_untouched_there_deletes_there() {
        assert_eq!(
            one(None, Some(s(Some("h1"), 1, 10)), Some(m("h1", 10))),
            vec![Action::DeleteRemote {
                path: path(),
                base: "h1".into()
            }]
        );
    }

    #[test]
    fn row_deleted_here_but_edited_there_comes_back() {
        // An edit beats a delete (§18.6).
        assert_eq!(
            one(None, Some(s(Some("h1"), 1, 10)), Some(m("h2", 10))),
            vec![Action::Download { path: path() }]
        );
    }

    #[test]
    fn row_deleted_on_both_sides_is_forgotten() {
        assert_eq!(
            one(None, Some(s(Some("h1"), 1, 10)), None),
            vec![Action::Forget { path: path() }]
        );
    }

    #[test]
    fn row_otherwise_nothing() {
        // In sync.
        assert!(one(
            Some(l(1, 10)),
            Some(s(Some("h1"), 1, 10)),
            Some(m("h1", 10))
        )
        .is_empty());
        // Nobody knows the path at all.
        assert!(one(None, None, None).is_empty());
    }

    #[test]
    fn a_refused_file_is_never_resent_unchanged_and_never_deleted() {
        let refused = || Some(s(None, 1, 10));
        // Unchanged: nothing, whatever the manifest says — not a download
        // over it, not a local delete because the server never had it.
        assert!(one(Some(l(1, 10)), refused(), None).is_empty());
        assert!(one(Some(l(1, 10)), refused(), Some(m("h", 10))).is_empty());
        // Changed: tried again, against `none`.
        assert_eq!(
            one(Some(l(2, 11)), refused(), Some(m("h", 10))),
            vec![Action::Upload {
                path: path(),
                base: None
            }]
        );
        // Gone locally: the entry goes, and no `DELETE` follows it.
        assert_eq!(
            one(None, refused(), Some(m("h", 10))),
            vec![Action::Forget { path: path() }]
        );
        assert_eq!(
            one(None, refused(), None),
            vec![Action::Forget { path: path() }]
        );
    }

    #[test]
    fn a_file_over_the_limit_on_either_side_is_skipped_entirely() {
        // Local too big: not uploaded, and not counted as anything else.
        assert!(one(Some(l(1, 1001)), None, None).is_empty());
        // Server too big: not downloaded — and, the case that would hurt,
        // its listing keeps a synced local copy from reading as deleted.
        assert!(one(None, None, Some(m("h", 1001))).is_empty());
        assert!(one(None, Some(s(Some("h"), 1, 10)), Some(m("h2", 1001))).is_empty());
        assert!(one(
            Some(l(1, 10)),
            Some(s(Some("h"), 1, 10)),
            Some(m("h2", 5000))
        )
        .is_empty());
    }

    fn full_state(server: &str) -> SyncState {
        SyncState {
            server: server.into(),
            files: [
                ("a.md", s(Some("ha"), 1, 1)),
                ("notes/b.md", s(Some("hb"), 1, 1)),
                ("c.pdf", s(Some("hc"), 1, 1)),
            ]
            .into_iter()
            .map(|(p, e)| (p.to_string(), e))
            .collect(),
        }
    }

    fn manifest_of(state: &SyncState) -> Manifest {
        Manifest {
            files: state
                .files
                .iter()
                .map(|(p, e)| (p.clone(), m(e.sha256.as_deref().unwrap(), e.size)))
                .collect(),
            max_bytes: 1000,
        }
    }

    #[test]
    fn an_empty_or_missing_folder_with_a_full_state_never_deletes() {
        // The guard (§28.8). Without it this is three `DELETE`s: the table
        // reads an unmounted folder as a user who deleted every file.
        let server = "http://box:7787";
        let state = full_state(server);
        let manifest = manifest_of(&state);
        let empty = BTreeMap::new();
        let unguarded = reconcile(&empty, &state.files, &manifest);
        assert_eq!(unguarded.len(), 3, "the hazard this guard exists for");
        assert!(unguarded
            .iter()
            .all(|a| matches!(a, Action::DeleteRemote { .. })));

        for folder_existed in [true, false] {
            let guarded = guard(state.clone(), server, folder_existed, &empty, &manifest);
            assert!(guarded.files.is_empty());
            let actions = reconcile(&empty, &guarded.files, &manifest);
            assert_eq!(actions.len(), 3);
            assert!(
                actions.iter().all(|a| matches!(a, Action::Download { .. })),
                "{actions:?}"
            );
        }
    }

    #[test]
    fn an_empty_manifest_with_a_full_state_never_deletes_locally() {
        // The mirror guard (§28.8). Without it, a server whose store came up
        // empty reads as one that deleted everything: a local delete per file.
        let server = "http://box:7787";
        let state = full_state(server);
        let local: BTreeMap<String, Local> = state
            .files
            .iter()
            .map(|(p, e)| (p.clone(), l(e.mtime_ms, e.size)))
            .collect();
        let empty = Manifest {
            files: BTreeMap::new(),
            max_bytes: 1000,
        };
        let unguarded = reconcile(&local, &state.files, &empty);
        assert_eq!(unguarded.len(), 3, "the hazard this guard exists for");
        assert!(unguarded
            .iter()
            .all(|a| matches!(a, Action::DeleteLocal { .. })));

        let guarded = guard(state, server, true, &local, &empty);
        assert!(guarded.files.is_empty());
        let actions = reconcile(&local, &guarded.files, &empty);
        assert_eq!(actions.len(), 3);
        assert!(
            actions
                .iter()
                .all(|a| matches!(a, Action::Upload { base: None, .. })),
            "{actions:?}"
        );
    }

    #[test]
    fn a_missing_folder_or_another_server_resets_even_with_files_present() {
        let state = full_state("http://box:7787");
        let manifest = manifest_of(&state);
        let present: BTreeMap<String, Local> = [("a.md".to_string(), l(1, 1))].into();
        assert!(
            guard(state.clone(), "http://box:7787", false, &present, &manifest)
                .files
                .is_empty()
        );
        let other = guard(
            state.clone(),
            "http://elsewhere:7787",
            true,
            &present,
            &manifest,
        );
        assert!(other.files.is_empty());
        assert_eq!(other.server, "http://elsewhere:7787");
        // And the ordinary case is left alone.
        assert_eq!(
            guard(state.clone(), "http://box:7787", true, &present, &manifest),
            state
        );
    }

    #[test]
    fn manifest_paths_that_would_escape_the_folder_are_dropped() {
        let manifest = parse_manifest(
            r#"{"max_bytes": 100, "files": [
                {"path": "ok/fine.md", "sha256": "a", "size": 1, "mtime": 0},
                {"path": "../outside", "sha256": "a", "size": 1, "mtime": 0},
                {"path": "/etc/passwd", "sha256": "a", "size": 1, "mtime": 0},
                {"path": "a//b", "sha256": "a", "size": 1, "mtime": 0},
                {"path": "x/./y", "sha256": "a", "size": 1, "mtime": 0},
                {"path": "a\\b", "sha256": "a", "size": 1, "mtime": 0},
                {"path": ".turminder-sync-x", "sha256": "a", "size": 1, "mtime": 0},
                {"path": "x/.git/HEAD", "sha256": "a", "size": 1, "mtime": 0},
                {"path": ".git/config", "sha256": "a", "size": 1, "mtime": 0}
            ]}"#,
        )
        .unwrap();
        assert_eq!(manifest.max_bytes, 100);
        assert_eq!(
            manifest.files.keys().collect::<Vec<_>>(),
            vec!["ok/fine.md"]
        );
    }

    #[test]
    fn one_predicate_decides_what_syncs_on_both_sides() {
        for ok in [
            "a.md",
            "notes/deep/b.pdf",
            ".obsidian/x",
            "git/x",
            "x.git/y",
        ] {
            assert!(syncable(ok), "{ok}");
        }
        for not in [
            "",
            "/abs",
            "a//b",
            "a/./b",
            "../a",
            "a\\b.md",
            ".git/HEAD",
            "x/.git/HEAD",
            "deep/er/.git",
            ".turminder-sync-a",
            "d/.turminder-sync-a",
        ] {
            assert!(!syncable(not), "{not}");
        }
    }

    #[test]
    fn on_windows_a_drive_or_a_stripped_trailing_character_never_syncs() {
        for windows_only in [
            "C:/Users/Public/x.md",
            "a:b.md",
            "notes./x.md",
            "x.md.",
            "x.md ",
        ] {
            assert!(!syncable_on(windows_only, true), "{windows_only}");
            // Legal names elsewhere, so the clause is Windows' alone.
            assert!(syncable_on(windows_only, false), "{windows_only}");
        }
        for fine in ["a.md", "notes/x.y.md", ".obsidian/a b.md"] {
            assert!(syncable_on(fine, true), "{fine}");
        }
        // And the shared rules hold on both.
        for windows in [true, false] {
            assert!(!syncable_on("x/.git/HEAD", windows));
            assert!(!syncable_on("a\\b", windows));
        }
    }

    #[test]
    fn containment_holds_whatever_the_predicate_said() {
        let root = Path::new("/home/someone/Turminder");
        assert_eq!(contained(root, "notes/a.md"), Some(root.join("notes/a.md")));
        // Each of these would put the write somewhere other than the folder,
        // or is not a plain name throughout.
        for escape in ["/etc/passwd", "../outside.md", "a/../../b", "a/..", "./a"] {
            assert_eq!(contained(root, escape), None, "{escape}");
        }
        // `Path` folds an interior `.` away, so this one is contained — the
        // predicate is what refuses it (`syncable` above).
        assert_eq!(contained(root, "a/./b"), Some(root.join("a/b")));
        // Off Windows `C:` is a plain name, inside the folder. On Windows it
        // is a prefix component, and refused here even before the predicate.
        if cfg!(windows) {
            assert_eq!(contained(root, "C:/x.md"), None);
        } else {
            assert_eq!(contained(root, "C:/x.md"), Some(root.join("C:/x.md")));
        }
    }

    #[test]
    fn a_nested_repository_on_the_server_is_never_downloaded_or_deleted() {
        // The server ignores only its own top-level `.git`, so it lists a
        // nested one. Seen there and not here, its files would download, then
        // vanish from the walk, then read as a local delete — and empty the
        // server's repository (§28.8).
        let manifest = parse_manifest(
            r#"{"max_bytes": 100, "files": [
                {"path": "x/.git/HEAD", "sha256": "a", "size": 1, "mtime": 0},
                {"path": "x/readme.md", "sha256": "b", "size": 1, "mtime": 0}
            ]}"#,
        )
        .unwrap();
        let state: BTreeMap<String, Entry> =
            [("x/.git/HEAD".to_string(), s(Some("a"), 1, 1))].into();
        let actions = reconcile(&BTreeMap::new(), &state, &manifest);
        assert!(
            actions.iter().all(|a| match a {
                Action::Download { path } => path == "x/readme.md",
                Action::Forget { .. } => true,
                _ => false,
            }),
            "{actions:?}"
        );
    }

    #[test]
    fn a_walk_difference_fires_once_and_frames_and_the_fallback_always_do() {
        let server = "http://box:7787";
        let state = SyncState {
            server: server.into(),
            files: [("a.md".to_string(), s(Some("h"), 1, 10))].into(),
        };
        let synced: BTreeMap<String, Local> = [("a.md".to_string(), l(1, 10))].into();
        let edited: BTreeMap<String, Local> = [("a.md".to_string(), l(2, 10))].into();
        let quiet = Duration::from_secs(5);
        let due = |triggered, since, snapshot, seen| {
            cycle_due(triggered, since, snapshot, seen, &state, server)
        };
        // In sync: nothing to do.
        assert!(!due(false, quiet, Some(&synced), None));
        // A new difference fires…
        assert!(due(false, quiet, Some(&edited), None));
        assert!(due(false, quiet, Some(&edited), Some(&synced)));
        // …once: the same walk again, after a cycle that could not settle it
        // (the server is down), does not fire every five seconds.
        assert!(!due(false, quiet, Some(&edited), Some(&edited)));
        // A failed walk triggers nothing on its own.
        assert!(!due(false, quiet, None, None));
        // A frame and the fallback fire regardless.
        assert!(due(true, quiet, Some(&edited), Some(&edited)));
        assert!(due(false, MANIFEST_INTERVAL, Some(&edited), Some(&edited)));
        assert!(due(false, MANIFEST_INTERVAL, None, None));
    }

    /* ── On disk ──────────────────────────────────────────────────────────── */

    fn scratch(name: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("turminder-filesync-{}-{name}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn the_walk_skips_temp_names_and_symlinks() {
        let root = scratch("walk");
        std::fs::create_dir_all(root.join("notes/deep")).unwrap();
        std::fs::write(root.join("todo.md"), "x").unwrap();
        std::fs::write(root.join("notes/deep/a.md"), "yy").unwrap();
        std::fs::write(root.join(".turminder-sync-todo.md"), "half").unwrap();
        std::fs::write(root.join("notes/.turminder-sync-a.md"), "half").unwrap();
        std::fs::create_dir_all(root.join(".git/objects")).unwrap();
        std::fs::write(root.join(".git/HEAD"), "ref").unwrap();
        std::fs::write(root.join(".git/objects/ab"), "blob").unwrap();
        // A nested repository is as invisible as the top-level one.
        std::fs::create_dir_all(root.join("proj/.git")).unwrap();
        std::fs::write(root.join("proj/.git/HEAD"), "ref").unwrap();
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(root.join("todo.md"), root.join("link.md")).unwrap();
            std::os::unix::fs::symlink(root.join("notes"), root.join("linked-dir")).unwrap();
            // A legal unix name the server would store as `a/b.md`.
            std::fs::write(root.join("a\\b.md"), "z").unwrap();
        }
        let walked = walk(&root).unwrap();
        assert_eq!(
            walked.keys().collect::<Vec<_>>(),
            vec!["notes/deep/a.md", "todo.md"]
        );
        assert_eq!(walked["notes/deep/a.md"].size, 2);
        // A folder that is not there is an empty walk, not an error.
        assert!(walk(&root.join("missing")).unwrap().is_empty());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn a_download_never_overwrites_a_target_that_changed_since_the_walk() {
        let root = scratch("install");
        let target = root.join("todo.md");
        std::fs::write(&target, "v1").unwrap();
        let Seen::File(walked) = observe(&target) else {
            panic!("not a file")
        };
        // The user saves while the download is in flight.
        std::fs::write(&target, "v2, typed during the download").unwrap();
        assert_eq!(install(&target, b"server", Some(walked)), None);
        assert_eq!(
            std::fs::read_to_string(&target).unwrap(),
            "v2, typed during the download"
        );
        // A file that appeared where the walk saw nothing is just as changed.
        let fresh = root.join("new.md");
        std::fs::write(&fresh, "mine").unwrap();
        assert_eq!(install(&fresh, b"server", None), None);
        assert_eq!(std::fs::read_to_string(&fresh).unwrap(), "mine");
        // And no temp file outlives either refusal.
        assert!(walk_all_names(&root)
            .iter()
            .all(|n| !n.starts_with(TEMP_PREFIX)));

        // Unchanged: installed, parents created, and the stat recorded is the
        // installed file's own.
        let Seen::File(walked) = observe(&target) else {
            panic!("not a file")
        };
        let installed = install(&target, b"server", Some(walked)).unwrap();
        assert_eq!(std::fs::read_to_string(&target).unwrap(), "server");
        assert_eq!(installed.size, 6);
        let nested = root.join("a/b/c.md");
        assert!(install(&nested, b"deep", None).is_some());
        assert_eq!(std::fs::read_to_string(&nested).unwrap(), "deep");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[cfg(unix)]
    #[test]
    fn a_planted_symlink_at_the_temp_name_is_never_written_through() {
        let root = scratch("planted");
        let outside = scratch("planted-outside");
        std::fs::write(outside.join("precious"), "untouched").unwrap();
        std::os::unix::fs::symlink(
            outside.join("precious"),
            root.join(".turminder-sync-todo.md"),
        )
        .unwrap();
        let target = root.join("todo.md");
        assert!(install(&target, b"server bytes", None).is_some());
        assert_eq!(std::fs::read_to_string(&target).unwrap(), "server bytes");
        assert_eq!(
            std::fs::read_to_string(outside.join("precious")).unwrap(),
            "untouched"
        );
        assert!(!is_symlink(&root.join(".turminder-sync-todo.md")));
        // A stale regular temp file is replaced, not appended to or reused.
        std::fs::write(root.join(".turminder-sync-b.md"), "stale and longer").unwrap();
        assert!(install(&root.join("b.md"), b"new", None).is_some());
        assert_eq!(std::fs::read_to_string(root.join("b.md")).unwrap(), "new");
        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::remove_dir_all(&outside);
    }

    fn walk_all_names(dir: &Path) -> Vec<String> {
        std::fs::read_dir(dir)
            .unwrap()
            .flatten()
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .collect()
    }

    #[cfg(unix)]
    #[test]
    fn a_download_is_never_written_through_a_symlinked_directory() {
        let root = scratch("through-link");
        let elsewhere = scratch("through-link-target");
        std::os::unix::fs::symlink(&elsewhere, root.join("link")).unwrap();
        assert_eq!(safe_target(&root, "link/x.md"), None);
        assert_eq!(safe_target(&root, "../x.md"), None);
        assert!(safe_target(&root, "fine/x.md").is_some());
        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::remove_dir_all(&elsewhere);
    }

    #[test]
    fn the_state_file_round_trips_and_a_broken_one_reads_as_empty() {
        let dir = scratch("state");
        let file = dir.join(STATE_FILE);
        let state = full_state("http://box:7787");
        save_state(&file, &state).unwrap();
        assert_eq!(load_state(&file), state);
        // The §28.8 shape, refused entries as `null`.
        let mut refused = state.clone();
        refused.files.insert("big.iso".into(), s(None, 3, 4));
        save_state(&file, &refused).unwrap();
        let raw = std::fs::read_to_string(&file).unwrap();
        assert!(raw.contains(r#""server":"http://box:7787""#), "{raw}");
        assert!(
            raw.contains(r#""big.iso":{"sha256":null,"mtime_ms":3,"size":4}"#),
            "{raw}"
        );
        // Nothing left over from the temp + rename.
        assert_eq!(walk_all_names(&dir), vec![STATE_FILE.to_string()]);
        std::fs::write(&file, "{ not json").unwrap();
        assert_eq!(load_state(&file), SyncState::default());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_walk_trigger_sees_new_gone_and_changed_paths() {
        let server = "http://box:7787";
        let state = SyncState {
            server: server.into(),
            files: [("a.md".to_string(), s(Some("h"), 1, 10))].into(),
        };
        let same: BTreeMap<String, Local> = [("a.md".to_string(), l(1, 10))].into();
        assert!(!differs(&same, &state, server));
        let edited: BTreeMap<String, Local> = [("a.md".to_string(), l(2, 10))].into();
        assert!(differs(&edited, &state, server));
        let mut added = same.clone();
        added.insert("b.md".into(), l(1, 1));
        assert!(differs(&added, &state, server));
        assert!(differs(&BTreeMap::new(), &state, server));
        // Another server's state says nothing about this folder.
        assert!(differs(&same, &state, "http://elsewhere:1"));
    }

    #[test]
    fn a_trigger_during_a_cycle_queues_exactly_one_more() {
        let shared = Arc::new(Shared::default());
        let trigger = Trigger(shared.clone());
        trigger.fire();
        trigger.fire();
        trigger.fire();
        let mut signal = shared.signal.lock().unwrap();
        assert!(std::mem::take(&mut signal.triggered));
        assert!(!signal.triggered, "three fires are one cycle, not three");
    }

    /* ── Against a fake service ───────────────────────────────────────────── */

    #[derive(Debug, Clone)]
    struct Request {
        method: String,
        target: String,
        head: String,
        body: Vec<u8>,
    }

    type Log = Arc<Mutex<Vec<Request>>>;

    /// A scripted service on a real socket, answering as many requests as it
    /// is sent — the multi-request version of `http.rs`'s one-shot listener,
    /// because a cycle is a conversation rather than a call.
    fn fake_service(answer: impl Fn(&Request) -> Vec<u8> + Send + 'static) -> (Connection, Log) {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let log: Log = Arc::default();
        let seen = log.clone();
        std::thread::spawn(move || {
            for socket in listener.incoming() {
                let Ok(mut socket) = socket else { continue };
                let mut raw = Vec::new();
                let mut buf = [0u8; 8192];
                let (head, body) = loop {
                    let n = socket.read(&mut buf).unwrap_or(0);
                    if n == 0 {
                        break (String::from_utf8_lossy(&raw).into_owned(), Vec::new());
                    }
                    raw.extend_from_slice(&buf[..n]);
                    let Some(at) = raw.windows(4).position(|w| w == b"\r\n\r\n") else {
                        continue;
                    };
                    let head = String::from_utf8_lossy(&raw[..at]).into_owned();
                    let want = head
                        .lines()
                        .find_map(|l| l.strip_prefix("Content-Length: "))
                        .and_then(|v| v.trim().parse::<usize>().ok())
                        .unwrap_or(0);
                    if raw.len() - (at + 4) >= want {
                        break (head, raw[at + 4..].to_vec());
                    }
                };
                let mut words = head.split_whitespace();
                let request = Request {
                    method: words.next().unwrap_or_default().to_string(),
                    target: words.next().unwrap_or_default().to_string(),
                    head: head.clone(),
                    body,
                };
                let reply = answer(&request);
                seen.lock().unwrap().push(request);
                let _ = socket.write_all(&reply);
            }
        });
        (
            Connection {
                base_url: format!("http://127.0.0.1:{port}"),
                token: "tok".into(),
                device: "laptop".into(),
            },
            log,
        )
    }

    fn reply(status: u16, headers: &[(&str, &str)], body: &[u8]) -> Vec<u8> {
        let mut out = format!("HTTP/1.1 {status} X\r\nContent-Length: {}\r\n", body.len());
        for (k, v) in headers {
            out.push_str(&format!("{k}: {v}\r\n"));
        }
        out.push_str("\r\n");
        let mut bytes = out.into_bytes();
        bytes.extend_from_slice(body);
        bytes
    }

    fn manifest_json(files: &[(&str, &str, usize)]) -> Vec<u8> {
        let files: Vec<_> = files
            .iter()
            .map(|(p, h, n)| serde_json::json!({"path": p, "sha256": h, "size": n, "mtime": 0}))
            .collect();
        serde_json::json!({"files": files, "max_bytes": 1000})
            .to_string()
            .into_bytes()
    }

    fn never_stopped() -> bool {
        false
    }

    fn requests(log: &Log, method: &str) -> Vec<Request> {
        log.lock()
            .unwrap()
            .iter()
            .filter(|r| r.method == method)
            .cloned()
            .collect()
    }

    #[test]
    fn a_409_on_upload_takes_the_servers_original() {
        let dir = scratch("conflict");
        let root = dir.join("Turminder");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(root.join("todo.md"), "laptop edit").unwrap();
        let (connection, log) = fake_service(|r| {
            match (r.method.as_str(), r.target.as_str()) {
            ("GET", "/api/files/manifest") => reply(200, &[], &manifest_json(&[("todo.md", "h-manifest", 14)])),
            ("PUT", _) => reply(
                409,
                &[],
                br#"{"error":"conflict","path":"todo.md","conflict_path":"todo (conflict).md","sha256":"h2"}"#,
            ),
            ("GET", t) if t.starts_with("/api/files/raw") => {
                reply(200, &[("X-Turminder-Sha256", "h-served")], b"server version")
            }
            _ => reply(500, &[], b""),
        }
        });
        let state_file = dir.join(STATE_FILE);
        // Synced once as `h1`, and edited here since (the mtime moved).
        save_state(
            &state_file,
            &SyncState {
                server: connection.base_url.clone(),
                files: [("todo.md".to_string(), s(Some("h1"), 1, 3))].into(),
            },
        )
        .unwrap();

        run_cycle(&connection, &root, &state_file, &never_stopped).unwrap();

        let puts = requests(&log, "PUT");
        assert_eq!(puts.len(), 1);
        assert!(
            puts[0].head.contains("X-Turminder-Base: h1\r\n"),
            "{}",
            puts[0].head
        );
        assert_eq!(puts[0].body, b"laptop edit");
        // The server's version is in place; the laptop's is the server's
        // conflict copy now, and arrives next cycle.
        assert_eq!(
            std::fs::read_to_string(root.join("todo.md")).unwrap(),
            "server version"
        );
        let state = load_state(&state_file);
        let entry = &state.files["todo.md"];
        // The hash of the bytes served, not the manifest's (§18.6): the two
        // differ here on purpose, as they do when the server moved between
        // the manifest and the download.
        assert_eq!(entry.sha256.as_deref(), Some("h-served"));
        assert_eq!(entry.size, 14);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn an_empty_or_missing_folder_sends_no_delete_and_downloads_instead() {
        for missing in [false, true] {
            let dir = scratch(if missing {
                "guard-missing"
            } else {
                "guard-empty"
            });
            let root = dir.join("Turminder");
            if !missing {
                std::fs::create_dir_all(&root).unwrap();
            }
            let (connection, log) = fake_service(|r| match r.method.as_str() {
                "GET" if r.target == "/api/files/manifest" => reply(
                    200,
                    &[],
                    &manifest_json(&[("a.md", "ha", 1), ("notes/b.md", "hb", 1)]),
                ),
                "GET" => reply(200, &[("X-Turminder-Sha256", "fresh")], b"x"),
                _ => reply(200, &[], br#"{"path":"?","deleted":true,"committed":true}"#),
            });
            let state_file = dir.join(STATE_FILE);
            let mut state = full_state(&connection.base_url);
            state.files.insert("notes/b.md".into(), s(Some("hb"), 1, 1));
            save_state(&state_file, &state).unwrap();

            run_cycle(&connection, &root, &state_file, &never_stopped).unwrap();

            assert!(requests(&log, "DELETE").is_empty(), "missing={missing}");
            assert!(requests(&log, "PUT").is_empty(), "missing={missing}");
            assert_eq!(
                std::fs::read_to_string(root.join("notes/b.md")).unwrap(),
                "x"
            );
            assert_eq!(std::fs::read_to_string(root.join("a.md")).unwrap(), "x");
            let _ = std::fs::remove_dir_all(&dir);
        }
    }

    #[test]
    fn temp_names_and_symlinks_are_never_uploaded() {
        let dir = scratch("never-upload");
        let root = dir.join("Turminder");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(root.join("real.md"), "mine").unwrap();
        std::fs::write(root.join(".turminder-sync-real.md"), "half a download").unwrap();
        std::fs::create_dir_all(root.join(".git/refs")).unwrap();
        std::fs::write(root.join(".git/HEAD"), "ref: refs/heads/main").unwrap();
        std::fs::write(root.join(".git/refs/main"), "abc").unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink(root.join("real.md"), root.join("link.md")).unwrap();
        let (connection, log) = fake_service(|r| match r.method.as_str() {
            "GET" => reply(200, &[], &manifest_json(&[])),
            _ => reply(
                200,
                &[],
                br#"{"path":"real.md","sha256":"h","action":"created"}"#,
            ),
        });
        run_cycle(&connection, &root, &dir.join(STATE_FILE), &never_stopped).unwrap();
        let puts = requests(&log, "PUT");
        assert_eq!(puts.len(), 1, "{puts:?}");
        assert_eq!(puts[0].target, "/api/files/sync?path=real.md");
        assert!(puts[0].head.contains("X-Turminder-Base: none\r\n"));
        // Nothing under `.git/` went anywhere, and it is all still here.
        assert!(puts.iter().all(|p| !p.target.contains(".git")));
        assert!(root.join(".git/refs/main").exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_refused_upload_is_remembered_and_never_becomes_a_delete() {
        let dir = scratch("refused");
        let root = dir.join("Turminder");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(root.join("keep.md"), "k").unwrap();
        std::fs::write(root.join(".obsidian-ish"), "ignored by the server").unwrap();
        let (connection, log) = fake_service(|r| match (r.method.as_str(), r.target.as_str()) {
            ("GET", _) => reply(200, &[], &manifest_json(&[("keep.md", "hk", 1)])),
            ("PUT", _) => reply(422, &[], br#"{"error":"ignored"}"#),
            _ => reply(500, &[], b""),
        });
        let state_file = dir.join(STATE_FILE);
        // keep.md is synced already, so only the ignored file is "changed".
        let Seen::File(kept) = observe(&root.join("keep.md")) else {
            panic!()
        };
        save_state(
            &state_file,
            &SyncState {
                server: connection.base_url.clone(),
                files: [(
                    "keep.md".to_string(),
                    s(Some("hk"), kept.mtime_ms, kept.size),
                )]
                .into(),
            },
        )
        .unwrap();

        run_cycle(&connection, &root, &state_file, &never_stopped).unwrap();
        assert_eq!(requests(&log, "PUT").len(), 1);
        assert_eq!(load_state(&state_file).files[".obsidian-ish"].sha256, None);

        // Unchanged: not sent again — and absent from the manifest, it is not
        // read as "the server deleted it" either.
        run_cycle(&connection, &root, &state_file, &never_stopped).unwrap();
        assert_eq!(requests(&log, "PUT").len(), 1);
        assert!(root.join(".obsidian-ish").exists());

        // Deleted here: forgotten, with no `DELETE` for a file the server
        // never held.
        std::fs::remove_file(root.join(".obsidian-ish")).unwrap();
        run_cycle(&connection, &root, &state_file, &never_stopped).unwrap();
        assert!(requests(&log, "DELETE").is_empty());
        assert!(!load_state(&state_file).files.contains_key(".obsidian-ish"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_delete_carries_its_base_and_a_409_brings_the_file_back() {
        let dir = scratch("delete");
        let root = dir.join("Turminder");
        std::fs::create_dir_all(&root).unwrap();
        // Something has to be here, or the guard (rightly) resets the state.
        std::fs::write(root.join("other.md"), "o").unwrap();
        let (connection, log) = fake_service(|r| match (r.method.as_str(), r.target.as_str()) {
            ("GET", "/api/files/manifest") => reply(
                200,
                &[],
                &manifest_json(&[("gone.md", "hg", 1), ("other.md", "ho", 1)]),
            ),
            ("DELETE", _) => reply(
                409,
                &[],
                br#"{"error":"conflict","path":"gone.md","sha256":"hg2"}"#,
            ),
            ("GET", _) => reply(
                200,
                &[("X-Turminder-Sha256", "hg2")],
                b"edited on the server",
            ),
            _ => reply(500, &[], b""),
        });
        let Seen::File(other) = observe(&root.join("other.md")) else {
            panic!()
        };
        let state_file = dir.join(STATE_FILE);
        save_state(
            &state_file,
            &SyncState {
                server: connection.base_url.clone(),
                files: [
                    ("gone.md".to_string(), s(Some("hg"), 1, 1)),
                    (
                        "other.md".to_string(),
                        s(Some("ho"), other.mtime_ms, other.size),
                    ),
                ]
                .into(),
            },
        )
        .unwrap();
        run_cycle(&connection, &root, &state_file, &never_stopped).unwrap();
        let deletes = requests(&log, "DELETE");
        assert_eq!(deletes.len(), 1);
        assert_eq!(deletes[0].target, "/api/files/sync?path=gone.md");
        assert!(deletes[0].head.contains("X-Turminder-Base: hg\r\n"));
        assert_eq!(
            std::fs::read_to_string(root.join("gone.md")).unwrap(),
            "edited on the server"
        );
        assert_eq!(
            load_state(&state_file).files["gone.md"].sha256.as_deref(),
            Some("hg2")
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_delete_the_server_could_not_carry_out_brings_the_file_back() {
        // 422 `unwritable`: the server's unlink failed and the file is still
        // there at the same version. Before this, the entry stayed and the
        // same doomed `DELETE` went out every cycle.
        let dir = scratch("delete-unwritable");
        let root = dir.join("Turminder");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(root.join("other.md"), "o").unwrap();
        let (connection, log) = fake_service(|r| match (r.method.as_str(), r.target.as_str()) {
            ("GET", "/api/files/manifest") => reply(
                200,
                &[],
                &manifest_json(&[("stuck.md", "hs", 5), ("other.md", "ho", 1)]),
            ),
            ("DELETE", _) => reply(
                422,
                &[],
                br#"{"error":"unwritable","message":"could not delete"}"#,
            ),
            ("GET", _) => reply(200, &[("X-Turminder-Sha256", "hs")], b"still"),
            _ => reply(500, &[], b""),
        });
        let Seen::File(other) = observe(&root.join("other.md")) else {
            panic!()
        };
        let state_file = dir.join(STATE_FILE);
        save_state(
            &state_file,
            &SyncState {
                server: connection.base_url.clone(),
                files: [
                    ("stuck.md".to_string(), s(Some("hs"), 1, 5)),
                    (
                        "other.md".to_string(),
                        s(Some("ho"), other.mtime_ms, other.size),
                    ),
                ]
                .into(),
            },
        )
        .unwrap();
        run_cycle(&connection, &root, &state_file, &never_stopped).unwrap();
        assert_eq!(requests(&log, "DELETE").len(), 1);
        assert_eq!(
            std::fs::read_to_string(root.join("stuck.md")).unwrap(),
            "still"
        );
        let state = load_state(&state_file);
        assert_eq!(state.files["stuck.md"].sha256.as_deref(), Some("hs"));

        // Back in sync: the next cycle sends no second `DELETE`.
        run_cycle(&connection, &root, &state_file, &never_stopped).unwrap();
        assert_eq!(requests(&log, "DELETE").len(), 1);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn an_empty_manifest_deletes_nothing_here_and_uploads_instead() {
        let dir = scratch("mirror-guard");
        let root = dir.join("Turminder");
        std::fs::create_dir_all(root.join("notes")).unwrap();
        std::fs::write(root.join("a.md"), "a").unwrap();
        std::fs::write(root.join("notes/b.md"), "b").unwrap();
        let (connection, log) = fake_service(|r| match r.method.as_str() {
            "GET" => reply(200, &[], &manifest_json(&[])),
            _ => reply(200, &[], br#"{"path":"?","sha256":"h","action":"created"}"#),
        });
        let state_file = dir.join(STATE_FILE);
        // Both synced, exactly as they are on disk now: to the table, a server
        // that lists neither deleted both.
        let files = walk(&root)
            .unwrap()
            .into_iter()
            .map(|(p, l)| (p, s(Some("old"), l.mtime_ms, l.size)))
            .collect();
        save_state(
            &state_file,
            &SyncState {
                server: connection.base_url.clone(),
                files,
            },
        )
        .unwrap();

        run_cycle(&connection, &root, &state_file, &never_stopped).unwrap();

        assert_eq!(std::fs::read_to_string(root.join("a.md")).unwrap(), "a");
        assert_eq!(
            std::fs::read_to_string(root.join("notes/b.md")).unwrap(),
            "b"
        );
        let puts = requests(&log, "PUT");
        assert_eq!(puts.len(), 2, "{puts:?}");
        assert!(puts
            .iter()
            .all(|p| p.head.contains("X-Turminder-Base: none\r\n")));
        assert!(requests(&log, "DELETE").is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_cycle_starts_by_sweeping_leftover_temp_files() {
        let dir = scratch("sweep");
        let root = dir.join("Turminder");
        std::fs::create_dir_all(root.join("notes/deep")).unwrap();
        std::fs::write(root.join("keep.md"), "k").unwrap();
        std::fs::write(root.join(".turminder-sync-keep.md"), "half").unwrap();
        std::fs::write(root.join("notes/deep/.turminder-sync-x.md"), "half").unwrap();
        #[cfg(unix)]
        let outside = {
            // A symlinked directory is not followed: the sweep deletes, and
            // only inside the folder.
            let outside = scratch("sweep-outside");
            std::fs::write(outside.join(".turminder-sync-not-mine"), "x").unwrap();
            std::os::unix::fs::symlink(&outside, root.join("linked")).unwrap();
            // A symlink wearing the prefix goes (the link, not its target).
            std::fs::write(outside.join("target"), "kept").unwrap();
            std::os::unix::fs::symlink(outside.join("target"), root.join(".turminder-sync-ln"))
                .unwrap();
            outside
        };
        // A directory wearing the prefix is never removed.
        std::fs::create_dir_all(root.join(".turminder-sync-dir")).unwrap();
        // The sweep runs before the manifest: even a dead service gets it.
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        drop(listener);
        let connection = Connection {
            base_url: format!("http://127.0.0.1:{port}"),
            token: "tok".into(),
            device: "laptop".into(),
        };
        let _ = run_cycle(&connection, &root, &dir.join(STATE_FILE), &never_stopped);
        assert!(!root.join(".turminder-sync-keep.md").exists());
        assert!(!root.join("notes/deep/.turminder-sync-x.md").exists());
        assert!(root.join("keep.md").exists());
        #[cfg(unix)]
        {
            assert!(outside.join(".turminder-sync-not-mine").exists());
            assert!(!is_symlink(&root.join(".turminder-sync-ln")));
            assert_eq!(
                std::fs::read_to_string(outside.join("target")).unwrap(),
                "kept"
            );
            let _ = std::fs::remove_dir_all(&outside);
        }
        assert!(root.join(".turminder-sync-dir").is_dir());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn unsyncable_paths_are_invisible_on_both_sides() {
        let dir = scratch("unsyncable");
        let root = dir.join("Turminder");
        std::fs::create_dir_all(root.join("x/.git")).unwrap();
        std::fs::write(root.join("x/.git/config"), "local repo").unwrap();
        std::fs::write(root.join("keep.md"), "k").unwrap();
        #[cfg(unix)]
        std::fs::write(root.join("a\\b.md"), "would come back as a/b.md").unwrap();
        let (connection, log) = fake_service(|r| match r.method.as_str() {
            "GET" if r.target == "/api/files/manifest" => reply(
                200,
                &[],
                &manifest_json(&[("keep.md", "hk", 1), ("x/.git/HEAD", "hh", 3)]),
            ),
            "GET" => reply(200, &[("X-Turminder-Sha256", "hh")], b"ref"),
            _ => reply(500, &[], b""),
        });
        let Seen::File(kept) = observe(&root.join("keep.md")) else {
            panic!()
        };
        let state_file = dir.join(STATE_FILE);
        save_state(
            &state_file,
            &SyncState {
                server: connection.base_url.clone(),
                files: [(
                    "keep.md".to_string(),
                    s(Some("hk"), kept.mtime_ms, kept.size),
                )]
                .into(),
            },
        )
        .unwrap();
        // Twice: the second cycle is where a one-sided filter would delete.
        run_cycle(&connection, &root, &state_file, &never_stopped).unwrap();
        run_cycle(&connection, &root, &state_file, &never_stopped).unwrap();
        let seen = log.lock().unwrap().clone();
        assert!(
            seen.iter().all(|r| r.target == "/api/files/manifest"),
            "only manifests, no download, upload or delete: {seen:?}"
        );
        assert!(!root.join("x/.git/HEAD").exists());
        assert!(root.join("x/.git/config").exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[cfg(unix)]
    #[test]
    fn an_unreadable_subfolder_ends_the_cycle_instead_of_reading_as_deleted() {
        use std::os::unix::fs::PermissionsExt;
        // Root reads everything, so it cannot make this case.
        if unsafe { libc::geteuid() } == 0 {
            return;
        }
        let dir = scratch("unreadable");
        let root = dir.join("Turminder");
        std::fs::create_dir_all(root.join("locked")).unwrap();
        std::fs::write(root.join("locked/a.md"), "a").unwrap();
        std::fs::write(root.join("other.md"), "o").unwrap();
        let (connection, log) = fake_service(|r| match r.method.as_str() {
            "GET" => reply(
                200,
                &[],
                &manifest_json(&[("locked/a.md", "ha", 1), ("other.md", "ho", 1)]),
            ),
            _ => reply(200, &[], br#"{"path":"?","deleted":true,"committed":true}"#),
        });
        let walked = walk(&root).unwrap();
        let state_file = dir.join(STATE_FILE);
        save_state(
            &state_file,
            &SyncState {
                server: connection.base_url.clone(),
                files: [
                    ("locked/a.md", "ha", walked["locked/a.md"]),
                    ("other.md", "ho", walked["other.md"]),
                ]
                .into_iter()
                .map(|(p, h, l)| (p.to_string(), s(Some(h), l.mtime_ms, l.size)))
                .collect(),
            },
        )
        .unwrap();
        std::fs::set_permissions(root.join("locked"), std::fs::Permissions::from_mode(0o000))
            .unwrap();

        let outcome = run_cycle(&connection, &root, &state_file, &never_stopped);

        std::fs::set_permissions(root.join("locked"), std::fs::Permissions::from_mode(0o755))
            .unwrap();
        assert!(outcome.is_err());
        assert!(requests(&log, "DELETE").is_empty());
        assert!(load_state(&state_file).files.contains_key("locked/a.md"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A synced folder (or file) replaced by a symlink — "move it and link
    /// it back" — reads, without the local half of the predicate, as every
    /// file under it deleted here: a `DELETE` each on the server (§28.8).
    #[cfg(unix)]
    #[test]
    fn a_synced_folder_or_file_replaced_by_a_symlink_deletes_nothing_remotely() {
        let dir = scratch("linked-back");
        let root = dir.join("Turminder");
        let moved = dir.join("moved");
        std::fs::create_dir_all(root.join("notes")).unwrap();
        std::fs::write(root.join("notes/a.md"), "a").unwrap();
        std::fs::write(root.join("notes/b.md"), "b").unwrap();
        std::fs::write(root.join("todo.md"), "t").unwrap();
        std::fs::write(root.join("other.md"), "o").unwrap();
        let walked = walk(&root).unwrap();
        let hashes = [
            ("notes/a.md", "ha"),
            ("notes/b.md", "hb"),
            ("todo.md", "ht"),
            ("other.md", "ho"),
        ];
        let (connection, log) = fake_service(move |r| match r.method.as_str() {
            "GET" if r.target == "/api/files/manifest" => {
                reply(200, &[], &manifest_json(&hashes.map(|(p, h)| (p, h, 1))))
            }
            "GET" => reply(200, &[("X-Turminder-Sha256", "x")], b"x"),
            _ => reply(200, &[], br#"{"path":"?","deleted":true,"committed":true}"#),
        });
        let state_file = dir.join(STATE_FILE);
        save_state(
            &state_file,
            &SyncState {
                server: connection.base_url.clone(),
                files: hashes
                    .iter()
                    .map(|(p, h)| {
                        let l = walked[*p];
                        (p.to_string(), s(Some(h), l.mtime_ms, l.size))
                    })
                    .collect(),
            },
        )
        .unwrap();
        // The folder moves out and is linked back; the file likewise.
        std::fs::create_dir_all(&moved).unwrap();
        std::fs::rename(root.join("notes"), moved.join("notes")).unwrap();
        std::os::unix::fs::symlink(moved.join("notes"), root.join("notes")).unwrap();
        std::fs::rename(root.join("todo.md"), moved.join("todo.md")).unwrap();
        std::os::unix::fs::symlink(moved.join("todo.md"), root.join("todo.md")).unwrap();

        run_cycle(&connection, &root, &state_file, &never_stopped).unwrap();
        run_cycle(&connection, &root, &state_file, &never_stopped).unwrap();

        assert!(requests(&log, "DELETE").is_empty());
        assert!(requests(&log, "PUT").is_empty());
        // Nothing was downloaded through, or over, the links either.
        let raws: Vec<_> = requests(&log, "GET")
            .into_iter()
            .filter(|r| r.target.starts_with("/api/files/raw"))
            .collect();
        assert!(raws.is_empty(), "{raws:?}");
        assert_eq!(
            std::fs::read_to_string(moved.join("notes/a.md")).unwrap(),
            "a"
        );
        assert_eq!(std::fs::read_to_string(moved.join("todo.md")).unwrap(), "t");
        let state = load_state(&state_file);
        assert!(state.files.contains_key("other.md"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_download_cut_short_is_an_error_and_installs_nothing() {
        let dir = scratch("short-body");
        let root = dir.join("Turminder");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(root.join("other.md"), "o").unwrap();
        let (connection, _log) = fake_service(|r| match r.method.as_str() {
            "GET" if r.target == "/api/files/manifest" => reply(
                200,
                &[],
                &manifest_json(&[("new.md", "hn", 100), ("other.md", "ho", 1)]),
            ),
            // Says 100 bytes, sends 5, hangs up.
            "GET" => {
                b"HTTP/1.1 200 OK\r\nContent-Length: 100\r\nX-Turminder-Sha256: hn\r\n\r\nshort"
                    .to_vec()
            }
            _ => reply(500, &[], b""),
        });
        let Seen::File(other) = observe(&root.join("other.md")) else {
            panic!()
        };
        let state_file = dir.join(STATE_FILE);
        save_state(
            &state_file,
            &SyncState {
                server: connection.base_url.clone(),
                files: [(
                    "other.md".to_string(),
                    s(Some("ho"), other.mtime_ms, other.size),
                )]
                .into(),
            },
        )
        .unwrap();
        assert!(run_cycle(&connection, &root, &state_file, &never_stopped).is_err());
        assert!(!root.join("new.md").exists());
        assert!(walk_all_names(&root)
            .iter()
            .all(|n| !n.starts_with(TEMP_PREFIX)));
        assert!(!load_state(&state_file).files.contains_key("new.md"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_dead_service_ends_the_cycle_without_touching_anything() {
        let dir = scratch("dead");
        let root = dir.join("Turminder");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(root.join("a.md"), "a").unwrap();
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        drop(listener);
        let connection = Connection {
            base_url: format!("http://127.0.0.1:{port}"),
            token: "tok".into(),
            device: "laptop".into(),
        };
        let state_file = dir.join(STATE_FILE);
        assert!(run_cycle(&connection, &root, &state_file, &never_stopped).is_err());
        assert_eq!(std::fs::read_to_string(root.join("a.md")).unwrap(), "a");
        assert!(!state_file.exists());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
