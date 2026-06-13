use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, Weak};

use azul_engine::bot::{BotLevel, preset, select_move};
use azul_engine::{
    PlayerInfo, apply_move, auto_move, create_game, finalize_scores, is_game_over, is_legal_move,
    is_offer_phase_over, make_rng, resolve_tiling, start_next_round, to_player_view,
};
use azul_shared::{GameState, Move, PlayerId, PlayerView};

use crate::types::{Clock, RoomEvents, RoomManager, StartPlayer};

/// Short artificial delay before a bot submits its move (~750 ms).
const BOT_MOVE_DELAY_MS: u64 = 750;

/// Optional hook to override bot move selection in tests (the TS
/// `_selectMoveFn`). Signature mirrors the engine's `select_move`.
pub type SelectMoveFn = Arc<
    dyn Fn(&GameState, usize, &azul_engine::bot::BotConfig, &mut azul_engine::Mulberry32) -> Move
        + Send
        + Sync,
>;

struct Mutable {
    /// Game state — `None` until `start_game`.
    state: Option<GameState>,
    /// Per-player connected flag.
    connected: std::collections::HashMap<PlayerId, bool>,
    /// playerId → bot level (only for AI players).
    bots: std::collections::HashMap<PlayerId, BotLevel>,
    turn_ms: u64,
}

pub struct InMemoryRoomManager {
    inner: Mutex<Mutable>,
    clock: Arc<dyn Clock>,
    events: Arc<dyn RoomEvents>,
    /// Bumped whenever a new timer is scheduled; a fired timer also re-checks
    /// turnSeq, but this lets `dispose` invalidate everything at once.
    timer_epoch: AtomicU64,
    disposed: AtomicBool,
    /// Optional test override for bot move selection.
    select_move_fn: Option<SelectMoveFn>,
    /// Self-reference so timer tasks can call back into the manager. Set once,
    /// right after construction, by the factory.
    me: Mutex<Weak<InMemoryRoomManager>>,
}

impl InMemoryRoomManager {
    /// Construct and return an `Arc` with the self-reference wired up.
    pub fn new(clock: Arc<dyn Clock>, events: Arc<dyn RoomEvents>) -> Arc<Self> {
        Self::with_select_move(clock, events, None)
    }

    pub fn with_select_move(
        clock: Arc<dyn Clock>,
        events: Arc<dyn RoomEvents>,
        select_move_fn: Option<SelectMoveFn>,
    ) -> Arc<Self> {
        let mgr = Arc::new(Self {
            inner: Mutex::new(Mutable {
                state: None,
                connected: std::collections::HashMap::new(),
                bots: std::collections::HashMap::new(),
                turn_ms: 60_000,
            }),
            clock,
            events,
            timer_epoch: AtomicU64::new(0),
            disposed: AtomicBool::new(false),
            select_move_fn,
            me: Mutex::new(Weak::new()),
        });
        *mgr.me.lock().unwrap() = Arc::downgrade(&mgr);
        mgr
    }

    fn self_arc(&self) -> Option<Arc<InMemoryRoomManager>> {
        self.me.lock().unwrap().upgrade()
    }

    /// Build the per-player views with the `connected` flag overridden from the
    /// manager's connection map (engine `to_player_view` defaults all to true).
    fn emit_state(&self, m: &Mutable, s: &GameState) {
        let mut views: Vec<(PlayerId, PlayerView)> = Vec::with_capacity(s.players.len());
        for player in &s.players {
            let mut view = to_player_view(s, &player.id);
            for vp in &mut view.players {
                vp.connected = m.connected.get(&vp.id).copied().unwrap_or(false);
            }
            views.push((player.id.clone(), view));
        }
        self.events.on_state(views);
    }

    fn advance_phase(s: GameState) -> GameState {
        let mut s = s;
        if s.phase == azul_shared::GamePhase::Offer && is_offer_phase_over(&s) {
            s = resolve_tiling(&s);
            if is_game_over(&s) {
                s = finalize_scores(&s);
            } else {
                s = start_next_round(&s);
            }
        }
        s
    }

    /// Apply a validated move, emit `on_applied`, progress the phase, then emit
    /// state + either `on_turn` (next player) or `on_over` (finished).
    /// Schedules the next turn's timer.
    fn apply_and_advance(self: &Arc<Self>, m: &mut Mutable, mv: Move, by_player_id: &str) {
        // Bumping the epoch invalidates any still-pending timer for the prior
        // turn (its turnSeq guard would also reject it; this is belt-and-braces).
        self.timer_epoch.fetch_add(1, Ordering::SeqCst);

        let s = m.state.take().expect("apply_and_advance with no state");
        let s = apply_move(&s, &mv);
        let applied_seq = s.turn_seq;

        self.events
            .on_applied(mv, by_player_id.to_string(), applied_seq);

        let s = Self::advance_phase(s);

        if s.phase == azul_shared::GamePhase::Finished {
            m.state = Some(s);
            let s_ref = m.state.as_ref().unwrap();
            self.emit_state(m, s_ref);
            let scores: Vec<(PlayerId, i32)> = s_ref
                .players
                .iter()
                .map(|p| (p.id.clone(), p.board.score))
                .collect();
            let winners = s_ref.winner_ids.clone().unwrap_or_default();
            self.events.on_over(scores, winners);
        } else {
            let deadline = self.schedule_next_move(m, &s);
            let current_pid = s.players[s.current_player_index].id.clone();
            m.state = Some(s);
            let s_ref = m.state.as_ref().unwrap();
            self.emit_state(m, s_ref);
            self.events.on_turn(current_pid, deadline);
        }
    }

    /// Schedule the next move for the current player and return the turn
    /// deadline (epoch-ms) to broadcast via `on_turn`.
    /// - Human: a 60s timeout that fires `auto_move`.
    /// - Bot: a ~750ms delay that fires `select_move` (with `auto_move` fallback).
    fn schedule_next_move(self: &Arc<Self>, m: &Mutable, s: &GameState) -> i64 {
        let current_pid = s.players[s.current_player_index].id.clone();
        let captured_seq = s.turn_seq;
        let captured_idx = s.current_player_index;
        let turn_ms = m.turn_ms;
        let deadline = self.clock.now_ms() + turn_ms as i64;

        let epoch = self.timer_epoch.load(Ordering::SeqCst);

        match m.bots.get(&current_pid).copied() {
            Some(level) => {
                // Bot turn: short-delay move.
                self.spawn_timer(BOT_MOVE_DELAY_MS, epoch, move |mgr| {
                    mgr.fire_bot_move(captured_seq, captured_idx, current_pid.clone(), level);
                });
                deadline
            }
            None => {
                // Human turn: auto-move on timeout.
                self.spawn_timer(turn_ms, epoch, move |mgr| {
                    mgr.fire_human_timeout(captured_seq, current_pid.clone());
                });
                deadline
            }
        }
    }

    /// Spawn a one-shot timer that, after `ms`, runs `f` if the manager is still
    /// alive, not disposed, and the timer epoch is unchanged.
    fn spawn_timer<F>(self: &Arc<Self>, ms: u64, epoch: u64, f: F)
    where
        F: FnOnce(Arc<InMemoryRoomManager>) + Send + 'static,
    {
        let weak = Arc::downgrade(self);
        let clock = Arc::clone(&self.clock);
        tokio::spawn(async move {
            clock.sleep(ms).await;
            let Some(mgr) = weak.upgrade() else { return };
            if mgr.disposed.load(Ordering::SeqCst) {
                return;
            }
            if mgr.timer_epoch.load(Ordering::SeqCst) != epoch {
                return;
            }
            f(mgr);
        });
    }

    /// Human timeout fired: if turnSeq unchanged, apply the deterministic
    /// `auto_move` on the player's behalf.
    fn fire_human_timeout(self: &Arc<Self>, captured_seq: u64, current_pid: PlayerId) {
        let mut m = self.inner.lock().unwrap();
        match &m.state {
            Some(s) if s.turn_seq == captured_seq => {
                let mv = auto_move(s);
                let _ = self.submit_locked(&mut m, &current_pid, mv, captured_seq);
            }
            _ => {}
        }
    }

    /// Bot timer fired: if turnSeq unchanged, run `select_move` and submit it;
    /// on rejection, fall back to `auto_move` (mirrors the TS bot fallback).
    fn fire_bot_move(
        self: &Arc<Self>,
        captured_seq: u64,
        captured_idx: usize,
        current_pid: PlayerId,
        level: BotLevel,
    ) {
        let mut m = self.inner.lock().unwrap();
        let state_seq = m.state.as_ref().map(|s| s.turn_seq);
        if state_seq != Some(captured_seq) {
            return;
        }

        let mv = {
            let s = m.state.as_ref().unwrap();
            let cfg = preset(level);
            let mut rng =
                make_rng((s.rng_seed.wrapping_mul(0x9e37_79b1)).wrapping_add(s.turn_seq as u32));
            match &self.select_move_fn {
                Some(f) => f(s, captured_idx, &cfg, &mut rng),
                None => select_move(s, captured_idx, &cfg, &mut rng),
            }
        };

        if let Err(err) = self.submit_locked(&mut m, &current_pid, mv, captured_seq) {
            eprintln!(
                "[bot] select_move rejected (player={current_pid}, level={level:?}): {err}; falling back to auto_move"
            );
            // Only retry if the turn hasn't advanced.
            let still_current = m.state.as_ref().map(|s| s.turn_seq) == Some(captured_seq);
            if still_current {
                let fallback = auto_move(m.state.as_ref().unwrap());
                if let Err(e2) = self.submit_locked(&mut m, &current_pid, fallback, captured_seq) {
                    eprintln!(
                        "[bot] auto_move fallback also failed (player={current_pid}, level={level:?}): {e2}"
                    );
                }
            }
        }
    }

    /// Core of `submit_move`, operating on an already-held lock. Returns
    /// `Err(reason)` on rejection.
    fn submit_locked(
        self: &Arc<Self>,
        m: &mut Mutable,
        player_id: &str,
        mv: Move,
        expected_turn_seq: u64,
    ) -> Result<(), String> {
        let s = match &m.state {
            Some(s) => s,
            None => return Err("Game not started".into()),
        };

        if expected_turn_seq != s.turn_seq {
            return Err(format!(
                "Stale move: expected turnSeq {}, got {}",
                s.turn_seq, expected_turn_seq
            ));
        }

        let current_pid = &s.players[s.current_player_index].id;
        if player_id != current_pid {
            return Err(format!("Not your turn: current player is {current_pid}"));
        }

        if !is_legal_move(s, &mv) {
            return Err("Illegal move".into());
        }

        self.apply_and_advance(m, mv, player_id);
        Ok(())
    }
}

impl RoomManager for InMemoryRoomManager {
    fn start_game(&self, players: Vec<StartPlayer>, seed: u32, turn_ms: u64) {
        let Some(this) = self.self_arc() else { return };
        let mut m = self.inner.lock().unwrap();
        m.turn_ms = turn_ms;
        m.connected.clear();
        m.bots.clear();
        for p in &players {
            m.connected.insert(p.id.clone(), true);
            if let Some(level) = p.bot {
                m.bots.insert(p.id.clone(), level);
            }
        }

        let infos: Vec<PlayerInfo> = players
            .iter()
            .map(|p| PlayerInfo {
                id: p.id.clone(),
                name: p.name.clone(),
            })
            .collect();
        let s = create_game(&infos, seed);

        // Emit initial state, schedule the first turn, announce it.
        this.emit_state(&m, &s);
        let deadline = this.schedule_next_move(&m, &s);
        let current_pid = s.players[s.current_player_index].id.clone();
        m.state = Some(s);
        self.events.on_turn(current_pid, deadline);
    }

    fn submit_move(&self, player_id: &str, mv: Move, expected_turn_seq: u64) -> Result<(), String> {
        let Some(this) = self.self_arc() else {
            return Err("Game disposed".into());
        };
        let mut m = self.inner.lock().unwrap();
        this.submit_locked(&mut m, player_id, mv, expected_turn_seq)
    }

    fn set_connected(&self, player_id: &str, connected: bool) {
        self.inner
            .lock()
            .unwrap()
            .connected
            .insert(player_id.to_string(), connected);
    }

    fn get_state(&self) -> GameState {
        self.inner
            .lock()
            .unwrap()
            .state
            .clone()
            .expect("Game not started")
    }

    fn dispose(&self) {
        self.disposed.store(true, Ordering::SeqCst);
        // Bump the epoch so any in-flight timer that wakes after this bails.
        self.timer_epoch.fetch_add(1, Ordering::SeqCst);
    }
}

// ---------------------------------------------------------------------------
// Tests (port of packages/server/src/roomManager.test.ts).
//
// The TS tests use a synchronous fake clock. Here, timers are tokio tasks
// driven by `Clock::sleep`, so the tests run on a PAUSED tokio runtime and use
// the `TokioClock` (whose `now_ms` advances with the runtime clock) plus a small
// `advance()` helper that advances time and yields so the woken timer tasks run.
// ---------------------------------------------------------------------------
#[cfg(test)]
mod tests {
    use super::*;
    use crate::clock::TokioClock;
    use crate::types::RoomManager;
    use azul_engine::legal_moves;
    use std::sync::Mutex as StdMutex;
    use std::time::Duration;

    const TURN_MS: u64 = 60_000;
    const SEED: u32 = 42;

    /// One recorded `on_over` payload: (scores, winnerIds).
    type OverRecord = (Vec<(PlayerId, i32)>, Vec<PlayerId>);

    /// Recording event sink (the TS tests captured callbacks into arrays).
    #[derive(Default)]
    struct Recorder {
        turns: Vec<(PlayerId, i64)>,
        states: Vec<Vec<(PlayerId, PlayerView)>>,
        applied: Vec<(Move, PlayerId, u64)>,
        over: Vec<OverRecord>,
    }

    #[derive(Clone)]
    struct TestEvents(Arc<StdMutex<Recorder>>);

    impl TestEvents {
        fn new() -> Self {
            Self(Arc::new(StdMutex::new(Recorder::default())))
        }
        fn rec(&self) -> std::sync::MutexGuard<'_, Recorder> {
            self.0.lock().unwrap()
        }
    }

    impl RoomEvents for TestEvents {
        fn on_state(&self, views: Vec<(PlayerId, PlayerView)>) {
            self.rec().states.push(views);
        }
        fn on_turn(&self, current_player_id: PlayerId, deadline: i64) {
            self.rec().turns.push((current_player_id, deadline));
        }
        fn on_applied(&self, mv: Move, by_player_id: PlayerId, turn_seq: u64) {
            self.rec().applied.push((mv, by_player_id, turn_seq));
        }
        fn on_over(&self, scores: Vec<(PlayerId, i32)>, winner_ids: Vec<PlayerId>) {
            self.rec().over.push((scores, winner_ids));
        }
    }

    fn human_players() -> Vec<StartPlayer> {
        vec![
            StartPlayer {
                id: "p1".into(),
                name: "Alice".into(),
                bot: None,
            },
            StartPlayer {
                id: "p2".into(),
                name: "Bob".into(),
                bot: None,
            },
        ]
    }

    fn bot_players() -> Vec<StartPlayer> {
        vec![
            StartPlayer {
                id: "p1".into(),
                name: "Alice".into(),
                bot: None,
            },
            StartPlayer {
                id: "bot1".into(),
                name: "Bot (Easy)".into(),
                bot: Some(BotLevel::Easy),
            },
        ]
    }

    fn make_manager(base_ms: i64, events: &TestEvents) -> Arc<InMemoryRoomManager> {
        let clock: Arc<dyn Clock> = Arc::new(TokioClock::new(base_ms));
        InMemoryRoomManager::new(clock, Arc::new(events.clone()))
    }

    /// Advance the paused runtime clock and let the timer tasks run.
    ///
    /// Timers are spawned tasks that register their `sleep` only once they first
    /// poll. So we must (1) yield first, so any freshly-spawned timer task runs
    /// up to its `.await` and registers its deadline; (2) advance the clock to
    /// fire it; (3) yield again so the woken task completes (and registers any
    /// follow-on timer it schedules).
    async fn advance(ms: u64) {
        for _ in 0..8 {
            tokio::task::yield_now().await;
        }
        tokio::time::advance(Duration::from_millis(ms)).await;
        for _ in 0..8 {
            tokio::task::yield_now().await;
        }
    }

    #[tokio::test(start_paused = true)]
    async fn start_game_emits_on_turn_with_deadline() {
        let ev = TestEvents::new();
        let mgr = make_manager(1000, &ev);
        mgr.start_game(human_players(), SEED, TURN_MS);

        let rec = ev.rec();
        assert_eq!(rec.turns.len(), 1);
        assert_eq!(rec.turns[0].0, "p1");
        assert_eq!(rec.turns[0].1, 1000 + TURN_MS as i64);
    }

    #[tokio::test(start_paused = true)]
    async fn start_game_emits_state_with_bag_count_and_you() {
        let ev = TestEvents::new();
        let mgr = make_manager(0, &ev);
        mgr.start_game(human_players(), SEED, TURN_MS);

        let rec = ev.rec();
        assert_eq!(rec.states.len(), 1);
        let snap = &rec.states[0];
        assert_eq!(snap.len(), 2);
        let (_, v1) = snap.iter().find(|(id, _)| id == "p1").unwrap();
        assert_eq!(v1.you, "p1");
        // bagCount is exposed; the bag composition is not part of PlayerView.
        let (_, v2) = snap.iter().find(|(id, _)| id == "p2").unwrap();
        assert_eq!(v2.you, "p2");
    }

    #[tokio::test(start_paused = true)]
    async fn submit_legal_move_advances_turn_seq_and_emits_applied() {
        let ev = TestEvents::new();
        let mgr = make_manager(0, &ev);
        mgr.start_game(human_players(), SEED, TURN_MS);

        let mv = legal_moves(&mgr.get_state())[0];
        let res = mgr.submit_move("p1", mv, 0);
        assert!(res.is_ok());

        let rec = ev.rec();
        assert_eq!(rec.applied.len(), 1);
        assert_eq!(rec.applied[0].1, "p1");
        assert_eq!(rec.applied[0].2, 1);
        drop(rec);
        assert_eq!(mgr.get_state().turn_seq, 1);
    }

    #[tokio::test(start_paused = true)]
    async fn submit_emits_on_turn_for_next_player() {
        let ev = TestEvents::new();
        let mgr = make_manager(0, &ev);
        mgr.start_game(human_players(), SEED, TURN_MS);
        let mv = legal_moves(&mgr.get_state())[0];
        mgr.submit_move("p1", mv, 0).unwrap();

        let s = mgr.get_state();
        let next_pid = s.players[s.current_player_index].id.clone();
        let rec = ev.rec();
        assert!(rec.turns.len() >= 2);
        assert_eq!(rec.turns[0].0, "p1");
        assert_eq!(rec.turns.last().unwrap().0, next_pid);
    }

    #[tokio::test(start_paused = true)]
    async fn rejects_stale_expected_turn_seq() {
        let ev = TestEvents::new();
        let mgr = make_manager(0, &ev);
        mgr.start_game(human_players(), SEED, TURN_MS);
        let mv = legal_moves(&mgr.get_state())[0];
        mgr.submit_move("p1", mv, 0).unwrap(); // → turnSeq 1
        let res = mgr.submit_move("p1", mv, 0); // stale
        assert!(res.is_err());
        assert_eq!(mgr.get_state().turn_seq, 1);
    }

    #[tokio::test(start_paused = true)]
    async fn rejects_wrong_player() {
        let ev = TestEvents::new();
        let mgr = make_manager(0, &ev);
        mgr.start_game(human_players(), SEED, TURN_MS);
        let mv = legal_moves(&mgr.get_state())[0];
        let res = mgr.submit_move("p2", mv, 0); // p1's turn
        assert!(res.is_err());
        assert_eq!(mgr.get_state().turn_seq, 0);
    }

    #[tokio::test(start_paused = true)]
    async fn rejects_illegal_move() {
        let ev = TestEvents::new();
        let mgr = make_manager(0, &ev);
        mgr.start_game(human_players(), SEED, TURN_MS);
        let illegal = Move {
            source: azul_shared::MoveSource::Factory { index: 99 },
            color: azul_shared::Color::Blue,
            target: azul_shared::MoveTarget::Floor,
        };
        let res = mgr.submit_move("p1", illegal, 0);
        assert!(res.is_err());
        assert_eq!(mgr.get_state().turn_seq, 0);
    }

    #[tokio::test(start_paused = true)]
    async fn fires_exactly_one_auto_move_on_timeout() {
        let ev = TestEvents::new();
        let mgr = make_manager(0, &ev);
        mgr.start_game(human_players(), SEED, TURN_MS);
        assert_eq!(mgr.get_state().turn_seq, 0);

        advance(TURN_MS + 1).await;

        let rec = ev.rec();
        assert_eq!(rec.applied.len(), 1);
        assert_eq!(rec.applied[0].2, 1);
        drop(rec);
        assert_eq!(mgr.get_state().turn_seq, 1);
    }

    #[tokio::test(start_paused = true)]
    async fn stale_real_move_after_auto_move_is_rejected() {
        let ev = TestEvents::new();
        let mgr = make_manager(0, &ev);
        mgr.start_game(human_players(), SEED, TURN_MS);
        let mv = legal_moves(&mgr.get_state())[0];

        advance(TURN_MS + 1).await; // auto-move fires, turnSeq → 1

        let res = mgr.submit_move("p1", mv, 0); // old expectedTurnSeq
        assert!(res.is_err());
        assert_eq!(mgr.get_state().turn_seq, 1);
    }

    #[tokio::test(start_paused = true)]
    async fn real_move_cancels_original_timer() {
        let ev = TestEvents::new();
        let mgr = make_manager(0, &ev);
        mgr.start_game(human_players(), SEED, TURN_MS);

        // Advance halfway: the original timer is still pending.
        advance(TURN_MS / 2).await;

        let mv = legal_moves(&mgr.get_state())[0];
        mgr.submit_move("p1", mv, 0).unwrap(); // schedules a NEW timer

        // Advance just past where the ORIGINAL timer would have fired but not the
        // new one. The original must NOT fire (turnSeq guard + epoch bump).
        advance(TURN_MS / 2 + 1).await;

        let rec = ev.rec();
        assert_eq!(rec.applied.len(), 1);
        drop(rec);
        assert_eq!(mgr.get_state().turn_seq, 1);
    }

    #[tokio::test(start_paused = true)]
    async fn full_human_game_reaches_over() {
        let ev = TestEvents::new();
        let mgr = make_manager(0, &ev);
        mgr.start_game(human_players(), SEED, TURN_MS);

        let mut safety = 2000;
        loop {
            if !ev.rec().over.is_empty() {
                break;
            }
            let s = mgr.get_state();
            if s.phase == azul_shared::GamePhase::Finished {
                break;
            }
            let moves = legal_moves(&s);
            if moves.is_empty() {
                break;
            }
            let pid = s.players[s.current_player_index].id.clone();
            mgr.submit_move(&pid, moves[0], s.turn_seq).unwrap();
            safety -= 1;
            assert!(safety > 0, "game did not finish");
        }
        let rec = ev.rec();
        assert_eq!(rec.over.len(), 1);
        assert!(!rec.over[0].1.is_empty());
    }

    #[tokio::test(start_paused = true)]
    async fn bot_fires_move_after_delay() {
        let ev = TestEvents::new();
        let mgr = make_manager(0, &ev);
        mgr.start_game(bot_players(), SEED, TURN_MS);

        // p1 (human) goes first; play a legal move.
        let s0 = mgr.get_state();
        if s0.players[s0.current_player_index].id == "p1" {
            let mv = legal_moves(&s0)[0];
            mgr.submit_move("p1", mv, s0.turn_seq).unwrap();
        }

        // Now bot1's turn — advance past BOT_MOVE_DELAY_MS.
        advance(1000).await;

        let rec = ev.rec();
        assert!(rec.applied.iter().any(|(_, by, _)| by == "bot1"));
        drop(rec);
        assert!(mgr.get_state().turn_seq > 0);
    }

    #[tokio::test(start_paused = true)]
    async fn full_human_vs_bot_game_reaches_finished() {
        let ev = TestEvents::new();
        let mgr = make_manager(0, &ev);
        mgr.start_game(bot_players(), SEED, TURN_MS);

        let mut safety = 3000;
        loop {
            if !ev.rec().over.is_empty() {
                break;
            }
            let s = mgr.get_state();
            if s.phase == azul_shared::GamePhase::Finished {
                break;
            }
            let pid = s.players[s.current_player_index].id.clone();
            if pid == "p1" {
                let moves = legal_moves(&s);
                if moves.is_empty() {
                    break;
                }
                mgr.submit_move("p1", moves[0], s.turn_seq).unwrap();
            } else {
                advance(1000).await; // fire the bot's timer
            }
            safety -= 1;
            assert!(safety > 0, "game did not finish");
        }
        let rec = ev.rec();
        assert_eq!(rec.over.len(), 1);
        assert!(!rec.over[0].1.is_empty());
    }

    #[tokio::test(start_paused = true)]
    async fn set_connected_reflected_in_view() {
        let ev = TestEvents::new();
        let mgr = make_manager(0, &ev);
        mgr.start_game(human_players(), SEED, TURN_MS);

        mgr.set_connected("p2", false);
        let mv = legal_moves(&mgr.get_state())[0];
        mgr.submit_move("p1", mv, 0).unwrap();

        let rec = ev.rec();
        let last = rec.states.last().unwrap();
        let (_, v1) = last.iter().find(|(id, _)| id == "p1").unwrap();
        let p2 = v1.players.iter().find(|p| p.id == "p2").unwrap();
        assert!(!p2.connected);
    }

    #[tokio::test(start_paused = true)]
    async fn bot_rng_is_deterministic_across_managers() {
        async fn capture_bot_move() -> Option<Move> {
            let ev = TestEvents::new();
            let mgr = make_manager(0, &ev);
            mgr.start_game(bot_players(), SEED, TURN_MS);
            let s0 = mgr.get_state();
            if s0.players[s0.current_player_index].id == "p1" {
                let mv = legal_moves(&s0)[0];
                mgr.submit_move("p1", mv, s0.turn_seq).unwrap();
            }
            advance(1000).await;
            ev.rec()
                .applied
                .iter()
                .find(|(_, by, _)| by == "bot1")
                .map(|(mv, _, _)| *mv)
        }

        let m1 = capture_bot_move().await;
        let m2 = capture_bot_move().await;
        assert!(m1.is_some());
        assert_eq!(m1, m2);
    }

    #[tokio::test(start_paused = true)]
    async fn bot_falls_back_to_auto_move_on_illegal_select() {
        let ev = TestEvents::new();
        // select_move stub that always returns an illegal move.
        let bad: SelectMoveFn = Arc::new(|_s, _idx, _cfg, _rng| Move {
            source: azul_shared::MoveSource::Factory { index: 99 },
            color: azul_shared::Color::Blue,
            target: azul_shared::MoveTarget::Floor,
        });
        let clock: Arc<dyn Clock> = Arc::new(TokioClock::new(0));
        let mgr = InMemoryRoomManager::with_select_move(clock, Arc::new(ev.clone()), Some(bad));
        mgr.start_game(bot_players(), SEED, TURN_MS);

        let s0 = mgr.get_state();
        if s0.players[s0.current_player_index].id == "p1" {
            let mv = legal_moves(&s0)[0];
            mgr.submit_move("p1", mv, s0.turn_seq).unwrap();
        }
        let seq_before = mgr.get_state().turn_seq;

        advance(1000).await; // bot timer fires; select_move illegal → auto_move

        let rec = ev.rec();
        assert!(rec.applied.iter().any(|(_, by, _)| by == "bot1"));
        drop(rec);
        assert!(mgr.get_state().turn_seq > seq_before);
    }
}
