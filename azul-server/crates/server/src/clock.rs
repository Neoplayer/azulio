// ---------------------------------------------------------------------------
// clock.rs — the injectable `Clock` (port of the TS `realClock` in types.ts).
//
// `RealClock` reads wall-clock time and sleeps on the tokio runtime. Because the
// timers in `room_manager` sleep via `Clock::sleep` (a tokio sleep), tests can
// drive them deterministically with `tokio::time::pause()` + `advance()` — no
// real waiting. `TokioClock` is the test-facing alias whose `now_ms` advances
// with the paused tokio clock so turn deadlines are predictable in tests.
// ---------------------------------------------------------------------------

use std::time::{SystemTime, UNIX_EPOCH};

use futures::future::BoxFuture;

use crate::types::Clock;

/// Production clock: wall-clock `now_ms`, real (advanceable) tokio sleeps.
pub struct RealClock;

impl Clock for RealClock {
    fn now_ms(&self) -> i64 {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_millis() as i64)
            .unwrap_or(0)
    }

    fn sleep(&self, ms: u64) -> BoxFuture<'static, ()> {
        Box::pin(tokio::time::sleep(std::time::Duration::from_millis(ms)))
    }
}

/// Test clock: `now_ms` is a fixed base plus the tokio runtime's elapsed time,
/// so under `tokio::time::pause()` advancing the runtime clock also advances
/// `now_ms` — giving deterministic, asserted turn deadlines. `sleep` is a tokio
/// sleep, fired by `tokio::time::advance(..)`.
#[cfg(test)]
pub struct TokioClock {
    base_ms: i64,
    start: tokio::time::Instant,
}

#[cfg(test)]
impl TokioClock {
    /// Anchor `now_ms` at `base_ms` (epoch-ms) for the runtime's current instant.
    pub fn new(base_ms: i64) -> Self {
        Self {
            base_ms,
            start: tokio::time::Instant::now(),
        }
    }
}

#[cfg(test)]
impl Clock for TokioClock {
    fn now_ms(&self) -> i64 {
        let elapsed = tokio::time::Instant::now().duration_since(self.start);
        self.base_ms + elapsed.as_millis() as i64
    }

    fn sleep(&self, ms: u64) -> BoxFuture<'static, ()> {
        Box::pin(tokio::time::sleep(std::time::Duration::from_millis(ms)))
    }
}
