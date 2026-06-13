use std::sync::Arc;

use azul_engine::bot::BotLevel;
use azul_shared::{GameState, Move, PlayerId, PlayerView, Room};

// ---------------------------------------------------------------------------
// Session store
// ---------------------------------------------------------------------------

/// A guest session created via `POST /api/session`.
#[derive(Debug, Clone)]
pub struct Session {
    pub player_id: PlayerId,
    pub token: String,
    pub name: String,
    /// Room the session is bound to (reconnect target). `None` until bound.
    pub room_id: Option<String>,
}

pub trait SessionStore: Send + Sync {
    fn create_session(&self, name: &str) -> (PlayerId, String);
    fn get_by_token(&self, token: &str) -> Option<Session>;
    fn get_by_player_id(&self, player_id: &str) -> Option<Session>;
    fn bind_room(&self, token: &str, room_id: &str);
    fn unbind_room(&self, token: &str);
}

// ---------------------------------------------------------------------------
// Room repository
// ---------------------------------------------------------------------------

/// Fields to create a room with (mirrors TS `Omit<Room, 'id'>`). The repository
/// mints the `id`.
#[derive(Debug, Clone)]
pub struct NewRoom {
    pub name: String,
    pub host_id: PlayerId,
    pub max_players: u32,
    pub players: Vec<azul_shared::RoomPlayer>,
    pub status: azul_shared::RoomStatus,
    pub is_private: bool,
    pub created_at: String,
}

/// A partial patch applied to a room (mirrors TS `Partial<Room>`). Only `Some`
/// fields are overwritten. `id` is never patched.
#[derive(Debug, Clone, Default)]
pub struct RoomPatch {
    pub name: Option<String>,
    pub host_id: Option<PlayerId>,
    pub max_players: Option<u32>,
    pub players: Option<Vec<azul_shared::RoomPlayer>>,
    pub status: Option<azul_shared::RoomStatus>,
    pub is_private: Option<bool>,
    pub created_at: Option<String>,
}

pub trait RoomRepository: Send + Sync {
    fn create(&self, room: NewRoom) -> Room;
    fn get(&self, id: &str) -> Option<Room>;
    fn list(&self) -> Vec<Room>;
    fn list_waiting(&self) -> Vec<Room>;
    /// Apply a partial patch. Panics if the room does not exist (mirrors the TS
    /// `throw`); callers always check existence first.
    fn update(&self, id: &str, patch: RoomPatch) -> Room;
    fn delete(&self, id: &str);
}

// ---------------------------------------------------------------------------
// Injected clock (for deterministic test control)
// ---------------------------------------------------------------------------

/// Abstracts "now" and one-shot timers so turn timeouts are testable. The real
/// impl uses `tokio::time`; tests use `tokio::time::pause()/advance()` against
/// the same impl (tokio's paused clock makes spawned `sleep`s deterministic).
pub trait Clock: Send + Sync {
    /// Current epoch milliseconds (server clock). Used for `game:turn` deadlines.
    fn now_ms(&self) -> i64;
    /// Sleep `ms` milliseconds, then resolve. Driven by the tokio runtime clock
    /// so paused-time tests can advance it.
    fn sleep(&self, ms: u64) -> futures::future::BoxFuture<'static, ()>;
}

// ---------------------------------------------------------------------------
// RoomManager callbacks — the transport-agnostic event surface.
//
// In TS these were mutable function-pointer fields set by the gateway after
// construction. In Rust the gateway implements one trait object and hands it to
// the manager; the manager invokes it under the gateway lock. Each callback is
// pure data (no sockets), exactly like TS.
// ---------------------------------------------------------------------------

/// Sink for room-manager events. The gateway implements this and routes each
/// event to the right sockets.
pub trait RoomEvents: Send + Sync {
    /// Full game-state update — each player gets their own private view.
    fn on_state(&self, views: Vec<(PlayerId, PlayerView)>);
    /// It's a player's turn; `deadline` is epoch-ms.
    fn on_turn(&self, current_player_id: PlayerId, deadline: i64);
    /// A move was applied (broadcast to room for animations).
    fn on_applied(&self, mv: Move, by_player_id: PlayerId, turn_seq: u64);
    /// Game finished.
    fn on_over(&self, scores: Vec<(PlayerId, i32)>, winner_ids: Vec<PlayerId>);
}

// ---------------------------------------------------------------------------
// RoomManager — orchestrates one game/room.
// ---------------------------------------------------------------------------

/// One player slot passed to `start_game`. Bots carry a `bot` descriptor.
#[derive(Debug, Clone)]
pub struct StartPlayer {
    pub id: String,
    pub name: String,
    pub bot: Option<BotLevel>,
}

pub trait RoomManager: Send + Sync {
    /// Start the game. Must be called once after events are wired and before
    /// `submit_move`. Bot players carry a `bot` level; humans set `None`.
    fn start_game(&self, players: Vec<StartPlayer>, seed: u32, turn_ms: u64);

    /// Submit a move from `player_id`. Returns `Err(reason)` on failure
    /// (illegal move, wrong turn, stale turnSeq) or `Ok(())` on success.
    fn submit_move(&self, player_id: &str, mv: Move, expected_turn_seq: u64) -> Result<(), String>;

    /// Mark a player's connection status.
    fn set_connected(&self, player_id: &str, connected: bool);

    /// Current game state (for reconnect resend). Panics if not started.
    fn get_state(&self) -> GameState;

    /// Cancel timers on teardown.
    fn dispose(&self);
}

/// Creates a `RoomManager` with an injected clock and event sink. Mirrors the TS
/// `createRoomManager(options)` + post-construction callback wiring, collapsed
/// into one call because the gateway always wires events before `start_game`.
pub type RoomManagerFactory =
    Arc<dyn Fn(Arc<dyn Clock>, Arc<dyn RoomEvents>) -> Arc<dyn RoomManager> + Send + Sync>;
