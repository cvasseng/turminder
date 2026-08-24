//! The three things the shell cannot know without knowing which OS it is on.
//!
//! Everything else in this crate is portable, and deliberately so: the
//! supervision *policy* (`supervisor.rs`), the health probe, the bundle layout
//! and the device socket are the same code everywhere, and they are the parts
//! with tests. What is left here is small on purpose — where a bundled install
//! keeps its data, what the pinned runtime is called, and how a child process
//! is made to die with its parent.
//!
//! **Only the Linux path has been run.** The macOS and Windows paths are
//! written from each platform's documented behaviour and have never been
//! compiled, because a nix box carries the Linux `std` and no other. Treat
//! them as a first draft that the first CI run on each platform will correct
//! (LIMITS.md, §28.4).

use std::path::PathBuf;
use std::process::{Child, Command};

/// The pinned runtime's filename inside the bundle (§28.4).
pub const NODE_BINARY: &str = if cfg!(windows) { "node.exe" } else { "node" };

/// Where a bundled install keeps its data (§28.1).
///
/// The service's own `--data-dir` mechanism, pointed at the platform's
/// app-data location. Never `~/.turminder`: that one belongs to a dev install,
/// and a packaged app quietly adopting it would be the worst kind of surprise.
pub fn data_dir() -> Result<PathBuf, String> {
    #[cfg(target_os = "linux")]
    {
        // A relative XDG_DATA_HOME is meaningless per the spec that defines it,
        // so it is ignored rather than resolved against the cwd.
        if let Some(xdg) = std::env::var_os("XDG_DATA_HOME") {
            let path = PathBuf::from(xdg);
            if path.is_absolute() {
                return Ok(path.join("turminder"));
            }
        }
        Ok(home()?.join(".local").join("share").join("turminder"))
    }
    #[cfg(target_os = "macos")]
    {
        Ok(home()?
            .join("Library")
            .join("Application Support")
            .join("Turminder"))
    }
    #[cfg(windows)]
    {
        // Roaming, not Local: the data dir is the complete portable state of
        // §12.1, and a user with a roaming profile should keep their assistant.
        let appdata = std::env::var_os("APPDATA").ok_or("no APPDATA in the environment")?;
        Ok(PathBuf::from(appdata).join("Turminder"))
    }
}

#[cfg(unix)]
fn home() -> Result<PathBuf, String> {
    std::env::var_os("HOME")
        .map(PathBuf::from)
        .ok_or_else(|| "no HOME in the environment".to_string())
}

/// Whatever this platform needs to hold, for as long as the sidecar runs.
///
/// Unit on the unixes; on Windows it owns the job object handle, and dropping
/// it is what kills the child. The supervisor keeps one of these alive for the
/// life of the app, which is the whole reason it is a value and not a call.
#[cfg(not(windows))]
pub struct ChildKeeper;

#[cfg(windows)]
pub struct ChildKeeper {
    job: Option<windows_sys::Win32::Foundation::HANDLE>,
}

impl ChildKeeper {
    /// Nothing to hold on the unixes; on Windows the job object is created
    /// lazily, on the first child, so this stays infallible.
    pub fn new() -> Self {
        #[cfg(not(windows))]
        {
            ChildKeeper
        }
        #[cfg(windows)]
        {
            ChildKeeper { job: None }
        }
    }
}

impl Default for ChildKeeper {
    fn default() -> Self {
        Self::new()
    }
}

// SAFETY: a job object handle is just a kernel handle; it is used from the one
// supervisor thread and closed once, on drop.
#[cfg(windows)]
unsafe impl Send for ChildKeeper {}
#[cfg(windows)]
unsafe impl Sync for ChildKeeper {}

/// Arrange for the child to die when this process does, by whatever means the
/// platform offers — signals and crashes included, not just a clean quit.
///
/// This is the guarantee that stops a leaked sidecar holding the data dir
/// against the next launch, and a live drive on Linux found exactly that
/// failure before it existed.
#[cfg(target_os = "linux")]
pub fn arrange_child_dies_with_us(command: &mut Command) {
    use std::os::unix::process::CommandExt;
    // SAFETY: the closure runs in the forked child before exec, where only
    // async-signal-safe calls are allowed — prctl is one.
    //
    // The kernel ties this to the forking *thread*, not the process, which is
    // why every spawn happens on the one long-lived supervisor thread.
    unsafe {
        command.pre_exec(|| {
            libc::prctl(libc::PR_SET_PDEATHSIG, libc::SIGTERM);
            Ok(())
        });
    }
}

/// macOS has no `PR_SET_PDEATHSIG` and no equivalent.
///
/// So the guarantee is weaker here than on Linux, and honestly so: a cleanly
/// quit or exiting shell stops its sidecar through `stop`, but one that is
/// `SIGKILL`'d leaves the service running. Recorded in LIMITS.md rather than
/// papered over — the next launch's port is freshly chosen, so the symptom is a
/// stray process rather than a broken app.
#[cfg(target_os = "macos")]
pub fn arrange_child_dies_with_us(_command: &mut Command) {}

#[cfg(windows)]
pub fn arrange_child_dies_with_us(command: &mut Command) {
    use std::os::windows::process::CommandExt;
    // CREATE_SUSPENDED would let us assign the job before any code runs, but
    // it needs ResumeThread and a thread handle Command does not expose. The
    // window between spawn and assignment is microseconds, and losing that race
    // costs a stray process, not a broken install.
    const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    // No console window for a GUI app's child, and its own process group so a
    // console CTRL event aimed at us does not scatter into it.
    command.creation_flags(CREATE_NEW_PROCESS_GROUP | CREATE_NO_WINDOW);
}

/// Windows' answer to PDEATHSIG: a job object with kill-on-close, which the
/// kernel honours even if this process is terminated outright. Stronger than
/// the Linux guarantee, and the reason the Windows path needs a keeper value.
#[cfg(windows)]
pub fn adopt_child(keeper: &mut ChildKeeper, child: &Child) -> Result<(), String> {
    use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};
    use windows_sys::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, SetInformationJobObject,
        JobObjectExtendedLimitInformation, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
        JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };
    use windows_sys::Win32::System::Threading::{OpenProcess, PROCESS_SET_QUOTA, PROCESS_TERMINATE};

    // SAFETY: every call below is checked, and the handles are closed on the
    // error paths as well as on drop.
    unsafe {
        if keeper.job.is_none() {
            let job = CreateJobObjectW(std::ptr::null(), std::ptr::null());
            if job.is_null() {
                return Err("could not create a job object for the service".into());
            }
            let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
            info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            let ok = SetInformationJobObject(
                job,
                JobObjectExtendedLimitInformation,
                std::ptr::addr_of!(info).cast(),
                std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            );
            if ok == 0 {
                CloseHandle(job);
                return Err("could not set kill-on-close on the job object".into());
            }
            keeper.job = Some(job);
        }
        let job = keeper.job.expect("job created above");
        let process: HANDLE = OpenProcess(PROCESS_SET_QUOTA | PROCESS_TERMINATE, 0, child.id());
        if process.is_null() {
            return Err("could not open the service process to supervise it".into());
        }
        let assigned = AssignProcessToJobObject(job, process);
        CloseHandle(process);
        if assigned == 0 {
            return Err("could not put the service into its job object".into());
        }
    }
    Ok(())
}

#[cfg(not(windows))]
pub fn adopt_child(_keeper: &mut ChildKeeper, _child: &Child) -> Result<(), String> {
    Ok(())
}

#[cfg(windows)]
impl Drop for ChildKeeper {
    fn drop(&mut self) {
        if let Some(job) = self.job.take() {
            // Closing the last handle to a kill-on-close job terminates
            // everything in it. This is the guarantee.
            unsafe { windows_sys::Win32::Foundation::CloseHandle(job) };
        }
    }
}

/// Ask the child to shut down cleanly, the way this platform asks.
///
/// Not politeness: the service closes SQLite and flushes the outbox on the way
/// out, and a straight kill leaves a hot journal behind. The caller escalates
/// to `Child::kill` if this is ignored.
#[cfg(unix)]
pub fn request_stop(child: &Child) {
    // SAFETY: a pid from a Child we own; SIGTERM to it is the documented way to
    // ask this service to shut down.
    unsafe {
        libc::kill(child.id() as libc::pid_t, libc::SIGTERM);
    }
}

/// Windows has no SIGTERM. A GUI app has no console to send a CTRL event
/// through either, so there is nothing gentler than the job object's own
/// termination — which is what the caller's `kill` does. Stated rather than
/// silently skipped: this is a real difference in shutdown cleanliness, and
/// the service's WAL recovery is what covers it (LIMITS.md).
#[cfg(windows)]
pub fn request_stop(_child: &Child) {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_node_binary_is_named_for_the_platform() {
        assert_eq!(NODE_BINARY, if cfg!(windows) { "node.exe" } else { "node" });
    }

    /// Bundled mode must never land in `~/.turminder` — that one is the dev
    /// install's, and a packaged app adopting it would be the worst surprise
    /// available (§28.1).
    #[test]
    fn the_data_dir_is_the_platforms_own_app_data_location() {
        let saved: Vec<(&str, Option<std::ffi::OsString>)> = ["XDG_DATA_HOME", "HOME", "APPDATA"]
            .iter()
            .map(|k| (*k, std::env::var_os(k)))
            .collect();
        let set = |k: &str, v: Option<&str>| match v {
            Some(value) => std::env::set_var(k, value),
            None => std::env::remove_var(k),
        };

        #[cfg(target_os = "linux")]
        {
            set("XDG_DATA_HOME", Some("/tmp/xdg"));
            set("HOME", Some("/home/x"));
            assert_eq!(data_dir().unwrap(), PathBuf::from("/tmp/xdg/turminder"));
            set("XDG_DATA_HOME", None);
            assert_eq!(
                data_dir().unwrap(),
                PathBuf::from("/home/x/.local/share/turminder")
            );
            // Relative is ignored, not resolved against the cwd.
            set("XDG_DATA_HOME", Some("relative"));
            assert_eq!(
                data_dir().unwrap(),
                PathBuf::from("/home/x/.local/share/turminder")
            );
        }
        #[cfg(target_os = "macos")]
        {
            set("HOME", Some("/Users/x"));
            assert_eq!(
                data_dir().unwrap(),
                PathBuf::from("/Users/x/Library/Application Support/Turminder")
            );
        }
        #[cfg(windows)]
        {
            set("APPDATA", Some(r"C:\Users\x\AppData\Roaming"));
            assert_eq!(
                data_dir().unwrap(),
                PathBuf::from(r"C:\Users\x\AppData\Roaming\Turminder")
            );
        }

        for (k, v) in saved {
            set(k, v.as_deref().and_then(|s| s.to_str()));
        }
    }
}
