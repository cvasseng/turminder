//! Sidecar supervision (§28.1), as a state machine with no process in it.
//!
//! Bundled mode spawns the service as a child; when it dies the shell has to
//! decide between restarting it and giving up. That decision is the part worth
//! testing, and a state machine that owns no handles can be tested without
//! spawning anything — so the policy lives here and the plumbing lives with
//! the runtime.
//!
//! The rule that matters: **a fast crash backs off, a long run resets**. A
//! service that dies in 200ms will die again in 200ms, and restarting it in a
//! tight loop turns one bad config into a busy CPU and a log nobody reads.

use std::time::Duration;

/// A run shorter than this counts as "it did not really start".
pub const FAST_CRASH: Duration = Duration::from_secs(5);
/// Backoff schedule for consecutive fast crashes, then give up.
pub const BACKOFF: [Duration; 4] = [
    Duration::from_secs(1),
    Duration::from_secs(5),
    Duration::from_secs(15),
    Duration::from_secs(60),
];

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Decision {
    /// Restart after waiting this long.
    Restart { after: Duration },
    /// Stop trying and tell the user; the message is shown verbatim.
    GiveUp { message: String },
    /// The shell asked for this exit; nothing to do.
    Stay,
}

#[derive(Debug, Default)]
pub struct Supervisor {
    consecutive_fast_crashes: usize,
    stopping: bool,
}

impl Supervisor {
    pub fn new() -> Self {
        Self::default()
    }

    /// The shell is quitting: the next exit is expected, not a crash.
    pub fn stopping(&mut self) {
        self.stopping = true;
    }

    /// The sidecar exited after running for `uptime`.
    pub fn exited(&mut self, uptime: Duration, code: Option<i32>) -> Decision {
        if self.stopping {
            return Decision::Stay;
        }
        if uptime >= FAST_CRASH {
            // It ran. Whatever killed it, the next start deserves a clean slate.
            self.consecutive_fast_crashes = 0;
            return Decision::Restart {
                after: Duration::from_secs(0),
            };
        }
        let attempt = self.consecutive_fast_crashes;
        self.consecutive_fast_crashes += 1;
        match BACKOFF.get(attempt) {
            Some(after) => Decision::Restart { after: *after },
            None => Decision::GiveUp {
                message: format!(
                    "the bundled service exited immediately {} times in a row{} — \
                     open the log, or point the app at a service running elsewhere",
                    self.consecutive_fast_crashes,
                    code.map(|c| format!(" (last exit code {c})"))
                        .unwrap_or_default()
                ),
            },
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_long_run_restarts_immediately_and_clears_the_streak() {
        let mut s = Supervisor::new();
        s.exited(Duration::from_millis(100), Some(1));
        assert_eq!(
            s.exited(Duration::from_secs(3600), Some(0)),
            Decision::Restart {
                after: Duration::from_secs(0)
            }
        );
        // Streak cleared: the next fast crash starts the backoff over.
        assert_eq!(
            s.exited(Duration::from_millis(50), Some(1)),
            Decision::Restart {
                after: Duration::from_secs(1)
            }
        );
    }

    #[test]
    fn fast_crashes_back_off_and_then_give_up() {
        let mut s = Supervisor::new();
        let waits: Vec<Decision> = (0..5)
            .map(|_| s.exited(Duration::from_millis(10), Some(2)))
            .collect();
        assert_eq!(
            waits[..4],
            [
                Decision::Restart { after: BACKOFF[0] },
                Decision::Restart { after: BACKOFF[1] },
                Decision::Restart { after: BACKOFF[2] },
                Decision::Restart { after: BACKOFF[3] },
            ]
        );
        match &waits[4] {
            Decision::GiveUp { message } => {
                assert!(message.contains("exit code 2"), "{message}");
                assert!(message.contains("service running elsewhere"), "{message}");
            }
            other => panic!("expected GiveUp, got {other:?}"),
        }
    }

    #[test]
    fn a_requested_quit_is_not_a_crash() {
        let mut s = Supervisor::new();
        s.stopping();
        assert_eq!(
            s.exited(Duration::from_millis(1), Some(143)),
            Decision::Stay
        );
    }
}
