// ---------------------------------------------------------------------------
// ws_gateway.rs — WebSocket transport layer (port of packages/server/src/wsGateway.ts).
//
// Validates incoming frames, routes to business logic, forwards room events back
// to the right sockets. The TS gateway is single-threaded over the Node event
// loop with synchronous handlers mutating shared maps; we mirror that with ONE
// shared `GatewayState` behind a *std* `Mutex`. Handlers are synchronous and
// never `.await` while holding the lock — every outbound frame is a non-blocking
// push onto a per-connection `mpsc` channel. The only async happens in
// `handle_socket` (reading the stream / pumping the sink), which holds no lock.
//
// LOCK DISCIPLINE (avoids re-entrant deadlock): a `RoomManager` method that can
// emit events (`start_game`, `submit_move`) synchronously calls back into the
// gateway's `RoomEvents` impl, which re-locks `GatewayState`. Such calls are
// therefore made *after releasing* the gateway lock (see the deferred
// `StartOutcome` / `MoveOutcome` in `on_text`). Timer-fired auto/bot moves run
// in their own tasks holding no gateway lock, so their callbacks lock freely.
// Methods that do NOT emit events (`set_connected`, `get_state`, `dispose`) are
// safe to call under the lock.
// ---------------------------------------------------------------------------

use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use axum::extract::ws::{Message, WebSocket};
use futures::{SinkExt, StreamExt};
use tokio::sync::mpsc::{self, UnboundedSender};

use azul_engine::to_player_view;
use azul_shared::{
    BotLevel, ClientMessage, PlayerId, PlayerView, RoomPlayer, RoomStatus, ServerMessage,
};

use crate::types::{
    Clock, NewRoom, RoomEvents, RoomManager, RoomManagerFactory, RoomPatch, RoomRepository,
    SessionStore, StartPlayer,
};

/// Stable per-connection id (a socket handle stand-in; the TS code keyed maps by
/// the `WebSocket` object itself).
pub type ConnId = u64;

/// Per-connection context, set after a successful `hello`.
struct ConnCtx {
    player_id: PlayerId,
    /// Room the player is currently in-game for (set on game start / reconnect).
    room_id: Option<String>,
    /// Outbound frame channel for this socket.
    tx: UnboundedSender<Message>,
}

/// Shared gateway state — the single source of truth, mutated under one
/// *std* `Mutex`. Handlers are synchronous and never `.await` while holding it.
struct GatewayState {
    /// connId → connection context (only present once authenticated).
    ctx: HashMap<ConnId, ConnCtx>,
    /// playerId → connId (latest connection wins on reconnect).
    conn_by_player: HashMap<PlayerId, ConnId>,
    /// roomId → RoomManager (only for rooms that are playing).
    managers: HashMap<String, Arc<dyn RoomManager>>,
    /// connIds subscribed to lobby updates.
    lobby_subscribers: HashSet<ConnId>,
    /// roomId → next bot index (monotonic; never reused so bot ids stay unique).
    next_bot_index: HashMap<String, u32>,
}

/// Injected dependencies + shared state. Cloning shares the same `Arc`s.
#[derive(Clone)]
pub struct Gateway {
    state: Arc<Mutex<GatewayState>>,
    session_store: Arc<dyn SessionStore>,
    room_repository: Arc<dyn RoomRepository>,
    room_manager_factory: RoomManagerFactory,
    clock: Arc<dyn Clock>,
    next_conn_id: Arc<AtomicU64>,
}

/// A `game:move` decision deferred until the gateway lock is released
/// (`submit_move` emits events that re-lock the gateway).
enum MoveOutcome {
    /// Nothing to do — an error frame was already queued.
    None,
    /// Submit this move to the room's manager (run after unlocking).
    Submit {
        manager: Arc<dyn RoomManager>,
        conn_id: ConnId,
        player_id: PlayerId,
        mv: azul_shared::Move,
        expected: u64,
    },
}

/// A `room:start` decision deferred until the gateway lock is released
/// (`start_game` emits events that re-lock the gateway).
struct StartOutcome {
    manager: Arc<dyn RoomManager>,
    players: Vec<StartPlayer>,
    seed: u32,
}

impl Gateway {
    pub fn new(
        session_store: Arc<dyn SessionStore>,
        room_repository: Arc<dyn RoomRepository>,
        room_manager_factory: RoomManagerFactory,
        clock: Arc<dyn Clock>,
    ) -> Self {
        Self {
            state: Arc::new(Mutex::new(GatewayState {
                ctx: HashMap::new(),
                conn_by_player: HashMap::new(),
                managers: HashMap::new(),
                lobby_subscribers: HashSet::new(),
                next_bot_index: HashMap::new(),
            })),
            session_store,
            room_repository,
            room_manager_factory,
            clock,
            next_conn_id: Arc::new(AtomicU64::new(1)),
        }
    }

    /// Drive one accepted WebSocket: split it, pump the outbound channel to the
    /// sink, and read frames from the stream. Runs until the socket closes.
    pub async fn handle_socket(self, socket: WebSocket) {
        let conn_id = self.next_conn_id.fetch_add(1, Ordering::SeqCst);
        let (mut sink, mut stream) = socket.split();
        let (tx, mut rx) = mpsc::unbounded_channel::<Message>();

        // Outbound pump: forward queued frames to the socket sink. A `Close`
        // frame ends the pump (used to force-close a socket, e.g. bad token).
        let send_task = tokio::spawn(async move {
            while let Some(msg) = rx.recv().await {
                let is_close = matches!(msg, Message::Close(_));
                if sink.send(msg).await.is_err() {
                    break;
                }
                if is_close {
                    break;
                }
            }
            let _ = sink.close().await;
        });

        // Inbound: process frames until the socket closes. Handlers are sync and
        // hold no lock across `.await`.
        while let Some(Ok(msg)) = stream.next().await {
            match msg {
                Message::Text(text) => self.on_text(conn_id, &tx, text.as_str()),
                Message::Close(_) => break,
                // Ping/Pong/Binary: ignore (axum auto-answers protocol pings).
                _ => {}
            }
        }

        // Socket closed: run the disconnect cleanup (mirrors TS `ws.on('close')`).
        self.on_close(conn_id);
        // Dropping `tx` ends the send pump.
        drop(tx);
        let _ = send_task.await;
    }

    // -----------------------------------------------------------------------
    // Frame dispatch
    // -----------------------------------------------------------------------

    fn on_text(&self, conn_id: ConnId, tx: &UnboundedSender<Message>, raw: &str) {
        // Two-stage parse, mirroring the TS gateway's two distinct error codes:
        //   1. JSON.parse failure        → PARSE_ERROR     ("Invalid JSON")
        //   2. valid JSON, bad schema    → INVALID_MESSAGE ("Message failed schema validation")
        let value: serde_json::Value = match serde_json::from_str(raw) {
            Ok(v) => v,
            Err(_) => {
                send_now(
                    tx,
                    ServerMessage::Error {
                        code: "PARSE_ERROR".into(),
                        message: "Invalid JSON".into(),
                    },
                );
                return;
            }
        };
        // Shape + range validation (serde_json::from_value + the zod-equivalent
        // range checks in ClientMessage::validate). Kept out of azul-shared.
        let msg = match serde_json::from_value::<ClientMessage>(value)
            .map_err(|e| e.to_string())
            .and_then(|m| m.validate().map(|_| m))
        {
            Ok(m) => m,
            Err(_) => {
                send_now(
                    tx,
                    ServerMessage::Error {
                        code: "INVALID_MESSAGE".into(),
                        message: "Message failed schema validation".into(),
                    },
                );
                return;
            }
        };

        // `game:move` and `room:start` must call the manager AFTER releasing the
        // lock (their callbacks re-lock the gateway). Capture the decision under
        // the lock, then act.
        let mut move_outcome = MoveOutcome::None;
        let mut start_outcome: Option<StartOutcome> = None;

        {
            let mut st = self.state.lock().unwrap();

            // `hello` is the only message allowed before authentication.
            let authed = st.ctx.contains_key(&conn_id);
            if !authed && !matches!(msg, ClientMessage::Hello { .. }) {
                send_now(
                    tx,
                    ServerMessage::Error {
                        code: "NOT_AUTHENTICATED".into(),
                        message: "Send hello first".into(),
                    },
                );
                return;
            }

            match msg {
                ClientMessage::Hello { token, room_id } => {
                    self.handle_hello(&mut st, conn_id, tx, &token, room_id.as_deref())
                }
                ClientMessage::LobbySubscribe => self.handle_lobby_subscribe(&mut st, conn_id),
                ClientMessage::RoomCreate {
                    name,
                    max_players,
                    is_private,
                } => self.handle_room_create(&mut st, conn_id, &name, max_players, is_private),
                ClientMessage::RoomJoin { room_id } => {
                    self.handle_room_join(&mut st, conn_id, &room_id)
                }
                ClientMessage::RoomLeave { room_id } => {
                    self.handle_room_leave(&mut st, conn_id, &room_id)
                }
                ClientMessage::RoomStart { room_id } => {
                    start_outcome = self.handle_room_start(&mut st, conn_id, &room_id)
                }
                ClientMessage::RoomAddBot { room_id, level } => {
                    self.handle_room_add_bot(&mut st, conn_id, &room_id, level)
                }
                ClientMessage::GameMove {
                    mv,
                    expected_turn_seq,
                } => move_outcome = self.handle_game_move(&mut st, conn_id, mv, expected_turn_seq),
                ClientMessage::Ping => {
                    if let Some(c) = st.ctx.get(&conn_id) {
                        send_now(&c.tx, ServerMessage::Pong);
                    }
                }
            }
        } // gateway lock released here

        // Act on deferred decisions with the lock NOT held.
        if let Some(start) = start_outcome {
            start.manager.start_game(start.players, start.seed, 60_000);
        }
        if let MoveOutcome::Submit {
            manager,
            conn_id,
            player_id,
            mv,
            expected,
        } = move_outcome
            && let Err(err) = manager.submit_move(&player_id, mv, expected)
        {
            let st = self.state.lock().unwrap();
            send_err(&st, conn_id, "ILLEGAL_MOVE", &err);
        }
    }

    // -----------------------------------------------------------------------
    // Handlers (operate on a held lock; all socket sends go through channels)
    // -----------------------------------------------------------------------

    fn handle_hello(
        &self,
        st: &mut GatewayState,
        conn_id: ConnId,
        tx: &UnboundedSender<Message>,
        token: &str,
        room_id: Option<&str>,
    ) {
        let session = match self.session_store.get_by_token(token) {
            Some(s) => s,
            None => {
                send_now(tx, ServerMessage::SessionInvalid);
                // Closing the socket: drop the outbound channel by sending Close.
                let _ = tx.send(Message::Close(None));
                return;
            }
        };
        let player_id = session.player_id;

        // Disconnect any previous socket for this player.
        if let Some(&prev) = st.conn_by_player.get(&player_id)
            && prev != conn_id
            && let Some(prev_ctx) = st.ctx.get(&prev)
        {
            let _ = prev_ctx.tx.send(Message::Close(None));
        }
        st.conn_by_player.insert(player_id.clone(), conn_id);

        st.ctx.insert(
            conn_id,
            ConnCtx {
                player_id: player_id.clone(),
                room_id: None,
                tx: tx.clone(),
            },
        );

        send_now(
            tx,
            ServerMessage::HelloOk {
                player_id: player_id.clone(),
            },
        );

        // Reconnect case: client supplies a roomId they were in.
        if let Some(room_id) = room_id {
            let manager = match st.managers.get(room_id) {
                Some(m) => Arc::clone(m),
                None => {
                    send_now(
                        tx,
                        ServerMessage::GameAborted {
                            reason: "not_found".into(),
                        },
                    );
                    return;
                }
            };
            if let Some(c) = st.ctx.get_mut(&conn_id) {
                c.room_id = Some(room_id.to_string());
            }
            // Mark player reconnected, resend current state.
            manager.set_connected(&player_id, true);
            let state = manager.get_state();
            send_now(
                tx,
                ServerMessage::GameState {
                    view: to_player_view(&state, &player_id),
                },
            );
            // Notify room peers.
            self.broadcast_player_connection(st, room_id, &player_id, true, Some(conn_id));
        }
    }

    fn handle_lobby_subscribe(&self, st: &mut GatewayState, conn_id: ConnId) {
        if !st.ctx.contains_key(&conn_id) {
            return;
        }
        st.lobby_subscribers.insert(conn_id);
        let rooms = self.room_repository.list_waiting();
        if let Some(c) = st.ctx.get(&conn_id) {
            send_now(&c.tx, ServerMessage::LobbyState { rooms });
        }
    }

    fn handle_room_create(
        &self,
        st: &mut GatewayState,
        conn_id: ConnId,
        name: &str,
        max_players: u32,
        is_private: bool,
    ) {
        let Some(player_id) = st.ctx.get(&conn_id).map(|c| c.player_id.clone()) else {
            return;
        };
        let player_name = self
            .session_store
            .get_by_player_id(&player_id)
            .map(|s| s.name)
            .unwrap_or_default();

        let room = self.room_repository.create(NewRoom {
            name: name.to_string(),
            host_id: player_id.clone(),
            max_players,
            players: vec![RoomPlayer {
                id: player_id,
                name: player_name,
                bot: None,
            }],
            status: RoomStatus::Waiting,
            is_private,
            created_at: now_iso8601(),
        });

        if let Some(c) = st.ctx.get_mut(&conn_id) {
            c.room_id = Some(room.id.clone());
            send_now(&c.tx, ServerMessage::RoomState { room });
        }
        self.broadcast_lobby(st);
    }

    fn handle_room_join(&self, st: &mut GatewayState, conn_id: ConnId, room_id: &str) {
        let Some(player_id) = st.ctx.get(&conn_id).map(|c| c.player_id.clone()) else {
            return;
        };

        let room = match self.room_repository.get(room_id) {
            Some(r) => r,
            None => return send_err(st, conn_id, "ROOM_NOT_FOUND", "Room not found"),
        };
        if room.status != RoomStatus::Waiting {
            return send_err(st, conn_id, "ROOM_NOT_WAITING", "Room is not waiting");
        }
        if room.players.len() as u32 >= room.max_players {
            return send_err(st, conn_id, "ROOM_FULL", "Room is full");
        }
        if room.players.iter().any(|p| p.id == player_id) {
            return send_err(st, conn_id, "ALREADY_IN_ROOM", "Already in room");
        }

        let player_name = self
            .session_store
            .get_by_player_id(&player_id)
            .map(|s| s.name)
            .unwrap_or_else(|| "Unknown".to_string());
        let mut players = room.players.clone();
        players.push(RoomPlayer {
            id: player_id,
            name: player_name,
            bot: None,
        });
        let updated = self.room_repository.update(
            room_id,
            RoomPatch {
                players: Some(players),
                ..Default::default()
            },
        );
        if let Some(c) = st.ctx.get_mut(&conn_id) {
            c.room_id = Some(room_id.to_string());
        }
        self.broadcast_to_room(st, room_id, &ServerMessage::RoomState { room: updated });
        self.broadcast_lobby(st);
    }

    fn handle_room_leave(&self, st: &mut GatewayState, conn_id: ConnId, room_id: &str) {
        let Some(player_id) = st.ctx.get(&conn_id).map(|c| c.player_id.clone()) else {
            return;
        };
        let room = match self.room_repository.get(room_id) {
            Some(r) => r,
            None => return,
        };

        // If a live game is in progress and the leaver is the last connected
        // human, tear the game down (don't leave bots self-playing).
        if room.status == RoomStatus::Playing
            && st.managers.contains_key(room_id)
            && self.count_connected_humans(st, room_id, Some(conn_id)) == 0
        {
            self.teardown_game(st, room_id);
        }

        let new_players: Vec<RoomPlayer> = room
            .players
            .iter()
            .filter(|p| p.id != player_id)
            .cloned()
            .collect();
        if new_players.is_empty() {
            self.room_repository.delete(room_id);
        } else {
            let new_host = if room.host_id == player_id {
                new_players[0].id.clone()
            } else {
                room.host_id.clone()
            };
            let updated = self.room_repository.update(
                room_id,
                RoomPatch {
                    players: Some(new_players),
                    host_id: Some(new_host),
                    ..Default::default()
                },
            );
            self.broadcast_to_room(st, room_id, &ServerMessage::RoomState { room: updated });
        }
        if let Some(c) = st.ctx.get_mut(&conn_id) {
            c.room_id = None;
        }
        self.broadcast_lobby(st);
    }

    /// Returns a `StartOutcome` to run after the lock is released (`start_game`
    /// emits events that re-lock the gateway).
    fn handle_room_start(
        &self,
        st: &mut GatewayState,
        conn_id: ConnId,
        room_id: &str,
    ) -> Option<StartOutcome> {
        let player_id = st.ctx.get(&conn_id).map(|c| c.player_id.clone())?;
        let room = match self.room_repository.get(room_id) {
            Some(r) => r,
            None => {
                send_err(st, conn_id, "ROOM_NOT_FOUND", "Room not found");
                return None;
            }
        };
        if room.host_id != player_id {
            send_err(st, conn_id, "NOT_HOST", "Only host can start");
            return None;
        }
        if room.players.len() < 2 {
            send_err(
                st,
                conn_id,
                "NOT_ENOUGH_PLAYERS",
                "Need at least 2 players (including bots)",
            );
            return None;
        }
        if room.status != RoomStatus::Waiting {
            send_err(st, conn_id, "ALREADY_STARTED", "Game already started");
            return None;
        }

        let updated = self.room_repository.update(
            room_id,
            RoomPatch {
                status: Some(RoomStatus::Playing),
                ..Default::default()
            },
        );

        // Build the manager wired to a gateway event sink for this room.
        let events: Arc<dyn RoomEvents> = Arc::new(GatewayEvents {
            gateway: self.clone(),
            room_id: room_id.to_string(),
        });
        let manager = (self.room_manager_factory)(Arc::clone(&self.clock), events);
        st.managers
            .insert(room_id.to_string(), Arc::clone(&manager));

        // Update all players' roomId context.
        for p in &room.players {
            if let Some(&pconn) = st.conn_by_player.get(&p.id)
                && let Some(c) = st.ctx.get_mut(&pconn)
            {
                c.room_id = Some(room_id.to_string());
            }
        }

        self.broadcast_to_room(st, room_id, &ServerMessage::RoomState { room: updated });
        self.broadcast_lobby(st);

        let players: Vec<StartPlayer> = room
            .players
            .iter()
            .map(|p| StartPlayer {
                id: p.id.clone(),
                name: p.name.clone(),
                bot: p.bot.as_ref().map(|b| b.level),
            })
            .collect();
        Some(StartOutcome {
            manager,
            players,
            seed: rand_u32(),
        })
    }

    fn handle_room_add_bot(
        &self,
        st: &mut GatewayState,
        conn_id: ConnId,
        room_id: &str,
        level: BotLevel,
    ) {
        let Some(player_id) = st.ctx.get(&conn_id).map(|c| c.player_id.clone()) else {
            return;
        };
        let room = match self.room_repository.get(room_id) {
            Some(r) => r,
            None => return send_err(st, conn_id, "ROOM_NOT_FOUND", "Room not found"),
        };
        if room.host_id != player_id {
            return send_err(st, conn_id, "NOT_HOST", "Only host can add bots");
        }
        if room.status != RoomStatus::Waiting {
            return send_err(st, conn_id, "ROOM_NOT_WAITING", "Room is not waiting");
        }
        if room.players.len() as u32 >= room.max_players {
            return send_err(st, conn_id, "ROOM_FULL", "Room is full");
        }

        // Unique bot id from a monotonic per-room counter so removing and
        // re-adding a bot can never collide with a surviving one.
        let bot_index = st.next_bot_index.get(room_id).copied().unwrap_or(0) + 1;
        st.next_bot_index.insert(room_id.to_string(), bot_index);
        let level_str = bot_level_str(level);
        let bot_id = format!("bot:{level_str}:{bot_index}");
        let level_display = capitalize(level_str);
        let bot_name = format!("Bot ({level_display})");

        let mut players = room.players.clone();
        players.push(RoomPlayer {
            id: bot_id,
            name: bot_name,
            bot: Some(azul_shared::RoomPlayerBot { level }),
        });
        let updated = self.room_repository.update(
            room_id,
            RoomPatch {
                players: Some(players),
                ..Default::default()
            },
        );
        self.broadcast_to_room(st, room_id, &ServerMessage::RoomState { room: updated });
        self.broadcast_lobby(st);
    }

    /// Decide what to do with a `game:move`. The actual `submit_move` runs after
    /// the lock is released (it emits events that re-lock the gateway).
    fn handle_game_move(
        &self,
        st: &mut GatewayState,
        conn_id: ConnId,
        mv: azul_shared::Move,
        expected_turn_seq: i64,
    ) -> MoveOutcome {
        let (player_id, room_id) = match st.ctx.get(&conn_id) {
            Some(c) if c.room_id.is_some() => (c.player_id.clone(), c.room_id.clone().unwrap()),
            _ => {
                send_err(st, conn_id, "NOT_IN_GAME", "Not in a game");
                return MoveOutcome::None;
            }
        };

        let manager = match st.managers.get(&room_id) {
            Some(m) => Arc::clone(m),
            None => {
                send_err(st, conn_id, "GAME_NOT_FOUND", "No active game in this room");
                return MoveOutcome::None;
            }
        };

        // `expectedTurnSeq` is a JSON number; turnSeq is u64. A negative value is
        // never equal to the current seq → treated as a stale move.
        let expected = expected_turn_seq.max(0) as u64;
        MoveOutcome::Submit {
            manager,
            conn_id,
            player_id,
            mv,
            expected,
        }
    }

    // -----------------------------------------------------------------------
    // Socket close cleanup (mirrors TS ws.on('close'))
    // -----------------------------------------------------------------------

    fn on_close(&self, conn_id: ConnId) {
        let mut st = self.state.lock().unwrap();
        let Some(ctx) = st.ctx.get(&conn_id) else {
            return;
        };
        let player_id = ctx.player_id.clone();
        let room_id = ctx.room_id.clone();

        st.lobby_subscribers.remove(&conn_id);

        if let Some(ref room_id) = room_id {
            if let Some(manager) = st.managers.get(room_id).cloned() {
                manager.set_connected(&player_id, false);
                // If this was the last connected human in a live game, tear it
                // down. Exclude this closing socket from the count.
                if self.count_connected_humans(&st, room_id, Some(conn_id)) == 0 {
                    self.teardown_game(&mut st, room_id);
                    self.broadcast_lobby(&st);
                }
            }
            self.broadcast_player_connection(&st, room_id, &player_id, false, Some(conn_id));
        }

        // Only clear the player mapping if this is still the current socket.
        if st.conn_by_player.get(&player_id) == Some(&conn_id) {
            st.conn_by_player.remove(&player_id);
        }
        st.ctx.remove(&conn_id);
    }

    // -----------------------------------------------------------------------
    // Shared helpers
    // -----------------------------------------------------------------------

    fn broadcast_lobby(&self, st: &GatewayState) {
        let rooms = self.room_repository.list_waiting();
        let msg = ServerMessage::LobbyState { rooms };
        for &conn_id in &st.lobby_subscribers {
            if let Some(c) = st.ctx.get(&conn_id) {
                send_now(&c.tx, msg.clone());
            }
        }
    }

    fn broadcast_to_room(&self, st: &GatewayState, room_id: &str, msg: &ServerMessage) {
        let Some(room) = self.room_repository.get(room_id) else {
            return;
        };
        for p in &room.players {
            if let Some(&conn_id) = st.conn_by_player.get(&p.id)
                && let Some(c) = st.ctx.get(&conn_id)
            {
                send_now(&c.tx, msg.clone());
            }
        }
    }

    fn broadcast_player_connection(
        &self,
        st: &GatewayState,
        room_id: &str,
        player_id: &str,
        connected: bool,
        exclude: Option<ConnId>,
    ) {
        let Some(room) = self.room_repository.get(room_id) else {
            return;
        };
        let msg = ServerMessage::PlayerConnection {
            player_id: player_id.to_string(),
            connected,
        };
        for p in &room.players {
            if let Some(&conn_id) = st.conn_by_player.get(&p.id) {
                if Some(conn_id) == exclude {
                    continue;
                }
                if let Some(c) = st.ctx.get(&conn_id) {
                    send_now(&c.tx, msg.clone());
                }
            }
        }
    }

    /// Count CONNECTED HUMAN players in a room (no `bot`, socket present, not the
    /// excluded conn).
    fn count_connected_humans(
        &self,
        st: &GatewayState,
        room_id: &str,
        exclude: Option<ConnId>,
    ) -> usize {
        let Some(room) = self.room_repository.get(room_id) else {
            return 0;
        };
        let mut count = 0;
        for p in &room.players {
            if p.bot.is_some() {
                continue;
            }
            if let Some(&conn_id) = st.conn_by_player.get(&p.id)
                && Some(conn_id) != exclude
                && st.ctx.contains_key(&conn_id)
            {
                count += 1;
            }
        }
        count
    }

    /// Dispose the manager (cancelling timers), drop it, mark the room finished.
    fn teardown_game(&self, st: &mut GatewayState, room_id: &str) {
        if let Some(m) = st.managers.remove(room_id) {
            m.dispose();
        }
        st.next_bot_index.remove(room_id);
        // `update` panics if the room is gone; guard with a get first.
        if self.room_repository.get(room_id).is_some() {
            self.room_repository.update(
                room_id,
                RoomPatch {
                    status: Some(RoomStatus::Finished),
                    ..Default::default()
                },
            );
        }
    }

    /// Dispose all managers (server close).
    pub fn dispose(&self) {
        let mut st = self.state.lock().unwrap();
        for m in st.managers.values() {
            m.dispose();
        }
        st.managers.clear();
        st.next_bot_index.clear();
    }
}

// ---------------------------------------------------------------------------
// GatewayEvents — RoomManager callback sink that fans events to sockets.
// Re-locks the shared gateway state. Invoked from the manager's own lock or a
// timer task; never while the gateway lock is already held (see LOCK DISCIPLINE
// at the top of the file).
// ---------------------------------------------------------------------------

struct GatewayEvents {
    gateway: Gateway,
    room_id: String,
}

impl RoomEvents for GatewayEvents {
    fn on_state(&self, views: Vec<(PlayerId, PlayerView)>) {
        let st = self.gateway.state.lock().unwrap();
        for (player_id, view) in views {
            if let Some(&conn_id) = st.conn_by_player.get(&player_id)
                && let Some(c) = st.ctx.get(&conn_id)
            {
                send_now(&c.tx, ServerMessage::GameState { view });
            }
        }
    }

    fn on_turn(&self, current_player_id: PlayerId, deadline: i64) {
        let msg = ServerMessage::GameTurn {
            current_player_id,
            deadline,
        };
        let st = self.gateway.state.lock().unwrap();
        self.gateway.broadcast_to_room(&st, &self.room_id, &msg);
    }

    fn on_applied(&self, mv: azul_shared::Move, by_player_id: PlayerId, turn_seq: u64) {
        let msg = ServerMessage::GameApplied {
            mv,
            by: by_player_id,
            turn_seq,
        };
        let st = self.gateway.state.lock().unwrap();
        self.gateway.broadcast_to_room(&st, &self.room_id, &msg);
    }

    fn on_over(&self, scores: Vec<(PlayerId, i32)>, winner_ids: Vec<PlayerId>) {
        let score_entries = scores
            .into_iter()
            .map(|(player_id, score)| azul_shared::ScoreEntry { player_id, score })
            .collect();
        let msg = ServerMessage::GameOver {
            scores: score_entries,
            winner_ids,
        };
        // Broadcast, then tear the game down (dispose + remove) and refresh lobby.
        let mut st = self.gateway.state.lock().unwrap();
        self.gateway.broadcast_to_room(&st, &self.room_id, &msg);
        self.gateway.teardown_game(&mut st, &self.room_id);
        self.gateway.broadcast_lobby(&st);
    }
}

// ---------------------------------------------------------------------------
// Free helpers
// ---------------------------------------------------------------------------

/// Enqueue a `ServerMessage` onto a connection's outbound channel.
fn send_now(tx: &UnboundedSender<Message>, msg: ServerMessage) {
    let _ = tx.send(Message::Text(msg.to_json().into()));
}

/// Send an `error` frame to a specific connection (if it's still mapped).
fn send_err(st: &GatewayState, conn_id: ConnId, code: &str, message: &str) {
    if let Some(c) = st.ctx.get(&conn_id) {
        send_now(
            &c.tx,
            ServerMessage::Error {
                code: code.to_string(),
                message: message.to_string(),
            },
        );
    }
}

fn bot_level_str(level: BotLevel) -> &'static str {
    match level {
        BotLevel::Easy => "easy",
        BotLevel::Medium => "medium",
        BotLevel::Hard => "hard",
    }
}

fn capitalize(s: &str) -> String {
    let mut chars = s.chars();
    match chars.next() {
        Some(first) => first.to_uppercase().collect::<String>() + chars.as_str(),
        None => String::new(),
    }
}

/// A weak, dependency-free random u32 seed (matches the TS
/// `Math.floor(Math.random() * 2**31)` intent — just needs to vary per game).
fn rand_u32() -> u32 {
    use std::time::{SystemTime, UNIX_EPOCH};
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.subsec_nanos())
        .unwrap_or(0);
    // Mix with a process-unique counter so two games started in the same nanosec
    // still differ.
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let c = COUNTER.fetch_add(1, Ordering::Relaxed) as u32;
    (nanos.wrapping_mul(2_654_435_761).wrapping_add(c)) & 0x7fff_ffff
}

/// Current time as an ISO-8601 / RFC-3339 millisecond UTC string
/// (`2026-06-10T00:00:00.000Z`), matching the TS `new Date().toISOString()`.
fn now_iso8601() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let dur = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default();
    let ms_total = dur.as_millis() as i64;
    format_iso8601_utc(ms_total)
}

/// Format epoch-ms as `YYYY-MM-DDTHH:MM:SS.sssZ` (UTC, proleptic Gregorian).
fn format_iso8601_utc(ms_total: i64) -> String {
    let secs = ms_total.div_euclid(1000);
    let ms = ms_total.rem_euclid(1000);
    let days = secs.div_euclid(86_400);
    let secs_of_day = secs.rem_euclid(86_400);
    let hour = secs_of_day / 3600;
    let minute = (secs_of_day % 3600) / 60;
    let second = secs_of_day % 60;

    // Convert days since 1970-01-01 to a civil date (Howard Hinnant's algorithm).
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = if month <= 2 { y + 1 } else { y };

    format!("{year:04}-{month:02}-{day:02}T{hour:02}:{minute:02}:{second:02}.{ms:03}Z")
}
