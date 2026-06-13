// ---------------------------------------------------------------------------
// server.rs — integration tests for the axum WS gateway + REST server
// (port of packages/server/src/server.test.ts).
//
// Uses a REAL server on an ephemeral port, a REAL ws client (tokio-tungstenite),
// and an INJECTED `ManualClock` for deterministic turn timeouts — the analogue
// of the TS `FakeClock`: `clock.advance(ms)` fires due timers with no real wait.
// The runtime is the normal multi-thread runtime (network I/O behaves normally);
// only game timers are virtual, driven through the injected clock.
// ---------------------------------------------------------------------------

use std::collections::HashMap;
use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use futures::future::BoxFuture;
use futures::{SinkExt, StreamExt};
use serde_json::{Value, json};
use tokio::net::TcpListener;
use tokio::sync::mpsc::{self, UnboundedReceiver, UnboundedSender};
use tokio::sync::oneshot;
use tokio_tungstenite::tungstenite::Message as WsMessage;

use azul_server::room_manager::InMemoryRoomManager;
use azul_server::room_repository::InMemoryRoomRepository;
use azul_server::session_store::InMemorySessionStore;
use azul_server::types::{
    Clock, RoomEvents, RoomManager, RoomManagerFactory, RoomRepository, SessionStore,
};
use azul_server::{ServerDeps, build_server};

// ---------------------------------------------------------------------------
// ManualClock — virtual time + manually-fired timers (TS FakeClock analogue).
// ---------------------------------------------------------------------------

#[derive(Clone)]
struct ManualClock {
    now: Arc<AtomicI64>,
    timers: Arc<Mutex<Vec<Timer>>>,
}

struct Timer {
    fire_at: i64,
    tx: Option<oneshot::Sender<()>>,
}

impl ManualClock {
    fn new() -> Self {
        Self {
            now: Arc::new(AtomicI64::new(0)),
            timers: Arc::new(Mutex::new(Vec::new())),
        }
    }

    /// Advance virtual time by `ms`, firing every timer whose deadline passed
    /// (in deadline order). Mirrors the TS `FakeClock.tick`.
    fn advance(&self, ms: i64) {
        let new_now = self.now.fetch_add(ms, Ordering::SeqCst) + ms;
        let mut due: Vec<(i64, oneshot::Sender<()>)> = Vec::new();
        {
            let mut timers = self.timers.lock().unwrap();
            timers.retain_mut(|t| {
                if t.fire_at <= new_now {
                    if let Some(tx) = t.tx.take() {
                        due.push((t.fire_at, tx));
                    }
                    false
                } else {
                    true
                }
            });
        }
        due.sort_by_key(|(at, _)| *at);
        for (_, tx) in due {
            let _ = tx.send(());
        }
    }
}

impl Clock for ManualClock {
    fn now_ms(&self) -> i64 {
        self.now.load(Ordering::SeqCst)
    }

    fn sleep(&self, ms: u64) -> BoxFuture<'static, ()> {
        let (tx, rx) = oneshot::channel();
        let fire_at = self.now.load(Ordering::SeqCst) + ms as i64;
        self.timers.lock().unwrap().push(Timer {
            fire_at,
            tx: Some(tx),
        });
        Box::pin(async move {
            let _ = rx.await;
        })
    }
}

// ---------------------------------------------------------------------------
// Test server harness
// ---------------------------------------------------------------------------

struct TestServer {
    base_url: String,
    ws_url: String,
    clock: ManualClock,
    shutdown: Option<oneshot::Sender<()>>,
    handle: Option<tokio::task::JoinHandle<()>>,
}

impl TestServer {
    async fn start() -> Self {
        let clock = ManualClock::new();
        let session_store: Arc<dyn SessionStore> = Arc::new(InMemorySessionStore::new());
        let room_repository: Arc<dyn RoomRepository> = Arc::new(InMemoryRoomRepository::new());
        let factory: RoomManagerFactory = Arc::new(
            |c: Arc<dyn Clock>, e: Arc<dyn RoomEvents>| -> Arc<dyn RoomManager> {
                InMemoryRoomManager::new(c, e)
            },
        );

        let server = build_server(ServerDeps {
            session_store,
            room_repository,
            room_manager_factory: factory,
            clock: Some(Arc::new(clock.clone())),
        });

        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();

        let (shutdown_tx, shutdown_rx) = oneshot::channel::<()>();
        let router = server.router;
        let handle = tokio::spawn(async move {
            axum::serve(listener, router)
                .with_graceful_shutdown(async {
                    let _ = shutdown_rx.await;
                })
                .await
                .unwrap();
        });

        TestServer {
            base_url: format!("http://127.0.0.1:{port}"),
            ws_url: format!("ws://127.0.0.1:{port}/ws"),
            clock,
            shutdown: Some(shutdown_tx),
            handle: Some(handle),
        }
    }

    async fn close(mut self) {
        if let Some(tx) = self.shutdown.take() {
            let _ = tx.send(());
        }
        if let Some(h) = self.handle.take() {
            let _ = h.await;
        }
    }
}

/// Create a session via the REST endpoint, returning (playerId, token).
async fn create_session(base_url: &str, name: &str) -> (String, String) {
    // Minimal HTTP/1.1 POST over a raw TCP socket (avoids an HTTP-client dep).
    let url = base_url.strip_prefix("http://").unwrap();
    let (host, _) = url.split_once(':').unwrap();
    let port: u16 = url.split_once(':').unwrap().1.parse().unwrap();
    let body = json!({ "name": name }).to_string();
    let req = format!(
        "POST /api/session HTTP/1.1\r\nHost: {host}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let mut stream = tokio::net::TcpStream::connect(("127.0.0.1", port))
        .await
        .unwrap();
    stream.write_all(req.as_bytes()).await.unwrap();
    let mut buf = Vec::new();
    stream.read_to_end(&mut buf).await.unwrap();
    let text = String::from_utf8_lossy(&buf);
    let body_start = text.find("\r\n\r\n").unwrap() + 4;
    let json_body = &text[body_start..];
    let v: Value = serde_json::from_str(json_body.trim()).unwrap();
    (
        v["playerId"].as_str().unwrap().to_string(),
        v["token"].as_str().unwrap().to_string(),
    )
}

/// POST a raw JSON body to /api/session and return the HTTP status code from the
/// response status line (e.g. 200, 400). Used to assert validation rejection.
async fn post_session_status(base_url: &str, body: &str) -> u16 {
    let url = base_url.strip_prefix("http://").unwrap();
    let (host, port_s) = url.split_once(':').unwrap();
    let port: u16 = port_s.parse().unwrap();
    let req = format!(
        "POST /api/session HTTP/1.1\r\nHost: {host}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let mut stream = tokio::net::TcpStream::connect(("127.0.0.1", port))
        .await
        .unwrap();
    stream.write_all(req.as_bytes()).await.unwrap();
    let mut buf = Vec::new();
    stream.read_to_end(&mut buf).await.unwrap();
    let text = String::from_utf8_lossy(&buf);
    // Status line: "HTTP/1.1 <code> <reason>".
    let status_line = text.lines().next().unwrap();
    status_line
        .split_whitespace()
        .nth(1)
        .unwrap()
        .parse()
        .unwrap()
}

/// GET a path and return the parsed JSON body.
async fn http_get(base_url: &str, path: &str) -> Value {
    let url = base_url.strip_prefix("http://").unwrap();
    let (host, port_s) = url.split_once(':').unwrap();
    let port: u16 = port_s.parse().unwrap();
    let req = format!("GET {path} HTTP/1.1\r\nHost: {host}\r\nConnection: close\r\n\r\n");
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let mut stream = tokio::net::TcpStream::connect(("127.0.0.1", port))
        .await
        .unwrap();
    stream.write_all(req.as_bytes()).await.unwrap();
    let mut buf = Vec::new();
    stream.read_to_end(&mut buf).await.unwrap();
    let text = String::from_utf8_lossy(&buf);
    let body_start = text.find("\r\n\r\n").unwrap() + 4;
    serde_json::from_str(text[body_start..].trim()).unwrap()
}

// ---------------------------------------------------------------------------
// TestClient — ws client with a typed/wildcard await queue (port of testClient.ts).
// ---------------------------------------------------------------------------

struct TestClient {
    out_tx: UnboundedSender<WsMessage>,
    /// Parsed JSON frames received so far, in arrival order.
    queue: Arc<Mutex<Vec<Value>>>,
    /// Notifier pulsed whenever a new frame is queued.
    notify: Arc<tokio::sync::Notify>,
    reader: Option<tokio::task::JoinHandle<()>>,
    writer: Option<tokio::task::JoinHandle<()>>,
}

impl TestClient {
    async fn connect(ws_url: &str) -> Self {
        let (ws, _) = tokio_tungstenite::connect_async(ws_url).await.unwrap();
        let (mut sink, mut stream) = ws.split();

        let queue: Arc<Mutex<Vec<Value>>> = Arc::new(Mutex::new(Vec::new()));
        let notify = Arc::new(tokio::sync::Notify::new());
        let (out_tx, mut out_rx): (UnboundedSender<WsMessage>, UnboundedReceiver<WsMessage>) =
            mpsc::unbounded_channel();

        let q2 = Arc::clone(&queue);
        let n2 = Arc::clone(&notify);
        let reader = tokio::spawn(async move {
            while let Some(Ok(msg)) = stream.next().await {
                if let WsMessage::Text(txt) = msg
                    && let Ok(v) = serde_json::from_str::<Value>(&txt)
                {
                    q2.lock().unwrap().push(v);
                    n2.notify_waiters();
                }
            }
        });

        let writer = tokio::spawn(async move {
            while let Some(msg) = out_rx.recv().await {
                if sink.send(msg).await.is_err() {
                    break;
                }
            }
        });

        TestClient {
            out_tx,
            queue,
            notify,
            reader: Some(reader),
            writer: Some(writer),
        }
    }

    fn send(&self, v: Value) {
        let _ = self.out_tx.send(WsMessage::Text(v.to_string()));
    }

    /// Send a raw text frame verbatim (used to exercise malformed-JSON handling).
    fn send_raw(&self, raw: String) {
        let _ = self.out_tx.send(WsMessage::Text(raw));
    }

    /// Await the next frame of `type`, removing it from the queue. Times out.
    async fn await_message(&self, ty: &str) -> Value {
        self.await_message_to(ty, Duration::from_secs(5)).await
    }

    async fn await_message_to(&self, ty: &str, timeout: Duration) -> Value {
        let deadline = tokio::time::Instant::now() + timeout;
        loop {
            {
                let mut q = self.queue.lock().unwrap();
                if let Some(idx) = q.iter().position(|m| m["type"] == ty) {
                    return q.remove(idx);
                }
            }
            let notified = self.notify.notified();
            tokio::select! {
                _ = notified => {}
                _ = tokio::time::sleep_until(deadline) => {
                    panic!("await_message('{ty}') timed out");
                }
            }
        }
    }

    /// Try to receive the next frame of `type` within `timeout`; None on timeout.
    async fn try_message(&self, ty: &str, timeout: Duration) -> Option<Value> {
        let deadline = tokio::time::Instant::now() + timeout;
        loop {
            {
                let mut q = self.queue.lock().unwrap();
                if let Some(idx) = q.iter().position(|m| m["type"] == ty) {
                    return Some(q.remove(idx));
                }
            }
            let notified = self.notify.notified();
            tokio::select! {
                _ = notified => {}
                _ = tokio::time::sleep_until(deadline) => return None,
            }
        }
    }

    /// Await the next frame of ANY type, in arrival order.
    async fn await_any(&self, timeout: Duration) -> Option<Value> {
        let deadline = tokio::time::Instant::now() + timeout;
        loop {
            {
                let mut q = self.queue.lock().unwrap();
                if !q.is_empty() {
                    return Some(q.remove(0));
                }
            }
            let notified = self.notify.notified();
            tokio::select! {
                _ = notified => {}
                _ = tokio::time::sleep_until(deadline) => return None,
            }
        }
    }

    async fn close(mut self) {
        let _ = self.out_tx.send(WsMessage::Close(None));
        if let Some(w) = self.writer.take() {
            w.abort();
        }
        if let Some(r) = self.reader.take() {
            r.abort();
        }
    }
}

/// Connect + authenticate with `hello`, returning the client.
async fn connect_authed(ws_url: &str, token: &str, room_id: Option<&str>) -> TestClient {
    let client = TestClient::connect(ws_url).await;
    let mut hello = json!({ "type": "hello", "token": token });
    if let Some(rid) = room_id {
        hello["roomId"] = json!(rid);
    }
    client.send(hello);
    client.await_message("hello:ok").await;
    client
}

/// Reconstruct a `GameState` from a redacted `PlayerView` so we can call the
/// engine's `auto_move` to produce a legal move (mirrors TS `viewToGameState`).
fn auto_move_from_view(view: &Value) -> Value {
    use azul_shared::{Color, GamePhase, GameState, PlayerBoard, PlayerSlot};

    fn parse_color(s: &str) -> Color {
        match s {
            "blue" => Color::Blue,
            "yellow" => Color::Yellow,
            "red" => Color::Red,
            "black" => Color::Black,
            "white" => Color::White,
            other => panic!("bad color {other}"),
        }
    }
    fn parse_opt_color(v: &Value) -> Option<Color> {
        if v.is_null() {
            None
        } else {
            Some(parse_color(v.as_str().unwrap()))
        }
    }
    fn parse_board(b: &Value) -> PlayerBoard {
        let pattern_lines = b["patternLines"]
            .as_array()
            .unwrap()
            .iter()
            .map(|row| {
                row.as_array()
                    .unwrap()
                    .iter()
                    .map(parse_opt_color)
                    .collect()
            })
            .collect();
        let wall = b["wall"]
            .as_array()
            .unwrap()
            .iter()
            .map(|row| {
                row.as_array()
                    .unwrap()
                    .iter()
                    .map(parse_opt_color)
                    .collect()
            })
            .collect();
        // floor slots are irrelevant for auto_move's legality computation; keep empty.
        PlayerBoard {
            pattern_lines,
            wall,
            floor: Vec::new(),
            score: b["score"].as_i64().unwrap_or(0) as i32,
        }
    }

    let players: Vec<PlayerSlot> = view["players"]
        .as_array()
        .unwrap()
        .iter()
        .map(|p| PlayerSlot {
            id: p["id"].as_str().unwrap().to_string(),
            name: p["name"].as_str().unwrap().to_string(),
            board: parse_board(&p["board"]),
        })
        .collect();

    let factories: Vec<Vec<Color>> = view["factories"]
        .as_array()
        .unwrap()
        .iter()
        .map(|f| {
            f.as_array()
                .unwrap()
                .iter()
                .map(|c| parse_color(c.as_str().unwrap()))
                .collect()
        })
        .collect();
    let center: Vec<Color> = view["center"]
        .as_array()
        .unwrap()
        .iter()
        .map(|c| parse_color(c.as_str().unwrap()))
        .collect();

    let current_player_id = view["currentPlayerId"].as_str().unwrap();
    let first_player_id = view["firstPlayerId"].as_str().unwrap();
    let current_idx = players
        .iter()
        .position(|p| p.id == current_player_id)
        .unwrap_or(0);
    let first_idx = players
        .iter()
        .position(|p| p.id == first_player_id)
        .unwrap_or(0);
    let bag_count = view["bagCount"].as_u64().unwrap_or(0) as usize;

    let state = GameState {
        players,
        factories,
        center,
        center_has_first_token: view["centerHasFirstToken"].as_bool().unwrap(),
        bag: vec![Color::Blue; bag_count],
        discard: Vec::new(),
        current_player_index: current_idx,
        first_player_index: first_idx,
        phase: GamePhase::Offer,
        round: view["round"].as_u64().unwrap_or(1) as u32,
        winner_ids: None,
        rng_seed: 0,
        turn_seq: view["turnSeq"].as_u64().unwrap(),
    };

    let mv = azul_engine::auto_move(&state);
    serde_json::to_value(mv).unwrap()
}

// ===========================================================================
// Tests
// ===========================================================================

#[tokio::test]
async fn health_returns_ok_true() {
    let srv = TestServer::start().await;
    let body = http_get(&srv.base_url, "/api/health").await;
    assert_eq!(body["ok"], json!(true));
    srv.close().await;
}

#[tokio::test]
async fn session_returns_player_id_and_token() {
    let srv = TestServer::start().await;
    let (player_id, token) = create_session(&srv.base_url, "Alice").await;
    assert!(!player_id.is_empty());
    assert!(!token.is_empty());
    srv.close().await;
}

#[tokio::test]
async fn session_empty_or_missing_name_returns_400() {
    let srv = TestServer::start().await;
    // Empty-string name → 400 (Fastify `minLength: 1`).
    assert_eq!(
        post_session_status(&srv.base_url, r#"{"name":""}"#).await,
        400
    );
    // Missing name field → 400 (Fastify `required: ['name']`).
    assert_eq!(post_session_status(&srv.base_url, r#"{}"#).await, 400);
    // Non-empty (even whitespace) is accepted → 200.
    assert_eq!(
        post_session_status(&srv.base_url, r#"{"name":" "}"#).await,
        200
    );
    assert_eq!(
        post_session_status(&srv.base_url, r#"{"name":"Alice"}"#).await,
        200
    );
    srv.close().await;
}

#[tokio::test]
async fn ws_bad_json_is_parse_error_schema_mismatch_is_invalid_message() {
    let srv = TestServer::start().await;
    let client = TestClient::connect(&srv.ws_url).await;

    // 1. Malformed JSON → PARSE_ERROR / "Invalid JSON".
    client.send_raw("{ this is not json".into());
    let err = client.await_message("error").await;
    assert_eq!(err["code"], json!("PARSE_ERROR"));
    assert_eq!(err["message"], json!("Invalid JSON"));

    // 2. Valid JSON but not a known/valid message → INVALID_MESSAGE.
    //    (`room:create` with maxPlayers out of range passes serde shape but fails
    //    ClientMessage::validate, exercising the schema-validation branch.)
    client.send(json!({ "type": "room:create", "name": "x", "maxPlayers": 9, "isPrivate": false }));
    let err2 = client.await_message("error").await;
    assert_eq!(err2["code"], json!("INVALID_MESSAGE"));
    assert_eq!(err2["message"], json!("Message failed schema validation"));

    client.close().await;
    srv.close().await;
}

#[tokio::test]
async fn hello_valid_token_returns_hello_ok() {
    let srv = TestServer::start().await;
    let (player_id, token) = create_session(&srv.base_url, "Alice").await;
    let client = TestClient::connect(&srv.ws_url).await;
    client.send(json!({ "type": "hello", "token": token }));
    let msg = client.await_message("hello:ok").await;
    assert_eq!(msg["playerId"], json!(player_id));
    client.close().await;
    srv.close().await;
}

#[tokio::test]
async fn hello_bogus_token_returns_session_invalid() {
    let srv = TestServer::start().await;
    let client = TestClient::connect(&srv.ws_url).await;
    client.send(json!({ "type": "hello", "token": "not-a-real-token" }));
    let msg = client.await_message("session:invalid").await;
    assert_eq!(msg["type"], json!("session:invalid"));
    client.close().await;
    srv.close().await;
}

#[tokio::test]
async fn ping_returns_pong() {
    let srv = TestServer::start().await;
    let (_pid, token) = create_session(&srv.base_url, "Bob").await;
    let client = connect_authed(&srv.ws_url, &token, None).await;
    client.send(json!({ "type": "ping" }));
    let msg = client.await_message("pong").await;
    assert_eq!(msg["type"], json!("pong"));
    client.close().await;
    srv.close().await;
}

#[tokio::test]
async fn lobby_subscribe_returns_empty_room_list() {
    let srv = TestServer::start().await;
    let (_pid, token) = create_session(&srv.base_url, "Alice").await;
    let client = connect_authed(&srv.ws_url, &token, None).await;
    client.send(json!({ "type": "lobby:subscribe" }));
    let msg = client.await_message("lobby:state").await;
    assert_eq!(msg["rooms"].as_array().unwrap().len(), 0);
    client.close().await;
    srv.close().await;
}

#[tokio::test]
async fn room_create_broadcasts_lobby_update() {
    let srv = TestServer::start().await;
    let (_pid, token) = create_session(&srv.base_url, "Alice").await;
    let client = connect_authed(&srv.ws_url, &token, None).await;
    client.send(json!({ "type": "lobby:subscribe" }));
    client.await_message("lobby:state").await; // initial

    client.send(
        json!({ "type": "room:create", "name": "Test Room", "maxPlayers": 2, "isPrivate": false }),
    );
    let room_state = client.await_message("room:state").await;
    assert_eq!(room_state["room"]["name"], json!("Test Room"));
    let lobby = client.await_message("lobby:state").await;
    let names: Vec<&str> = lobby["rooms"]
        .as_array()
        .unwrap()
        .iter()
        .map(|r| r["name"].as_str().unwrap())
        .collect();
    assert!(names.contains(&"Test Room"));
    client.close().await;
    srv.close().await;
}

/// Drain the room:state + game:state + game:turn that follow room:start; return
/// the game:state view and the first current player id.
async fn drain_start(client: &TestClient) -> Value {
    let mut view: Option<Value> = None;
    for _ in 0..12 {
        let msg = client
            .await_any(Duration::from_secs(3))
            .await
            .expect("start msg");
        match msg["type"].as_str() {
            Some("game:state") => view = Some(msg["view"].clone()),
            Some("game:turn") => break,
            _ => {}
        }
    }
    view.expect("never received game:state during start")
}

#[tokio::test]
async fn full_two_player_game_to_game_over() {
    let srv = TestServer::start().await;
    let (alice_id, alice_token) = create_session(&srv.base_url, "Alice").await;
    let (bob_id, bob_token) = create_session(&srv.base_url, "Bob").await;
    let alice = connect_authed(&srv.ws_url, &alice_token, None).await;
    let bob = connect_authed(&srv.ws_url, &bob_token, None).await;

    alice.send(
        json!({ "type": "room:create", "name": "Game Room", "maxPlayers": 2, "isPrivate": false }),
    );
    let rs = alice.await_message("room:state").await;
    let room_id = rs["room"]["id"].as_str().unwrap().to_string();

    bob.send(json!({ "type": "room:join", "roomId": room_id }));
    bob.await_message("room:state").await;
    alice.await_message("room:state").await;

    alice.send(json!({ "type": "room:start", "roomId": room_id }));

    let alice_view = drain_start(&alice).await;
    let _bob_view = drain_start(&bob).await;
    assert_eq!(alice_view["phase"], json!("offer"));

    let mut current_player_id = alice_view["currentPlayerId"].as_str().unwrap().to_string();
    let client_for = |pid: &str| -> &TestClient { if pid == alice_id { &alice } else { &bob } };

    let mut latest_view = alice_view.clone();
    let mut game_over: Option<Value> = None;

    for _ in 0..600 {
        if latest_view["phase"] != json!("offer") {
            break;
        }
        let active = client_for(&current_player_id);
        let mv = auto_move_from_view(&latest_view);
        let turn_seq = latest_view["turnSeq"].clone();
        active.send(json!({ "type": "game:move", "move": mv, "expectedTurnSeq": turn_seq }));

        // Read alice's stream until game:turn or game:over.
        let mut broke = false;
        for _ in 0..20 {
            let Some(msg) = alice.await_any(Duration::from_secs(5)).await else {
                broke = true;
                break;
            };
            match msg["type"].as_str() {
                Some("game:state") => latest_view = msg["view"].clone(),
                Some("game:turn") => {
                    current_player_id = msg["currentPlayerId"].as_str().unwrap().to_string();
                    break;
                }
                Some("game:over") => {
                    game_over = Some(msg);
                    broke = true;
                    break;
                }
                _ => {}
            }
        }
        if broke {
            break;
        }
    }

    let over = game_over.expect("game never finished");
    assert!(over["winnerIds"].is_array());
    let _ = bob_id;
    alice.close().await;
    bob.close().await;
    srv.close().await;
}

#[tokio::test]
async fn double_tap_same_turn_seq_rejected() {
    let srv = TestServer::start().await;
    let (alice_id, alice_token) = create_session(&srv.base_url, "Alice").await;
    let (_bob_id, bob_token) = create_session(&srv.base_url, "Bob").await;
    let alice = connect_authed(&srv.ws_url, &alice_token, None).await;
    let bob = connect_authed(&srv.ws_url, &bob_token, None).await;

    alice.send(
        json!({ "type": "room:create", "name": "Room", "maxPlayers": 2, "isPrivate": false }),
    );
    let rs = alice.await_message("room:state").await;
    let room_id = rs["room"]["id"].as_str().unwrap().to_string();
    bob.send(json!({ "type": "room:join", "roomId": room_id }));
    bob.await_message("room:state").await;
    alice.await_message("room:state").await;

    alice.send(json!({ "type": "room:start", "roomId": room_id }));
    let view = alice.await_message("game:state").await;
    bob.await_message("game:state").await;
    alice.await_message("game:turn").await;
    bob.await_message("game:turn").await;

    let view = view["view"].clone();
    let turn_seq = view["turnSeq"].clone();
    let current = view["currentPlayerId"].as_str().unwrap().to_string();
    let mv = auto_move_from_view(&view);
    let active = if current == alice_id { &alice } else { &bob };

    active.send(json!({ "type": "game:move", "move": mv, "expectedTurnSeq": turn_seq }));
    active.send(json!({ "type": "game:move", "move": mv, "expectedTurnSeq": turn_seq }));

    // The second tap must yield exactly one error.
    let err = active.try_message("error", Duration::from_secs(3)).await;
    assert!(err.is_some(), "expected an error for the stale double-tap");

    alice.close().await;
    bob.close().await;
    srv.close().await;
}

#[tokio::test]
async fn reconnect_resends_state_and_notifies_peers() {
    let srv = TestServer::start().await;
    let (alice_id, alice_token) = create_session(&srv.base_url, "Alice").await;
    let (_bob_id, bob_token) = create_session(&srv.base_url, "Bob").await;
    let alice = connect_authed(&srv.ws_url, &alice_token, None).await;
    let bob = connect_authed(&srv.ws_url, &bob_token, None).await;

    alice.send(
        json!({ "type": "room:create", "name": "Room", "maxPlayers": 2, "isPrivate": false }),
    );
    let rs = alice.await_message("room:state").await;
    let room_id = rs["room"]["id"].as_str().unwrap().to_string();
    bob.send(json!({ "type": "room:join", "roomId": room_id }));
    bob.await_message("room:state").await;
    alice.await_message("room:state").await;

    alice.send(json!({ "type": "room:start", "roomId": room_id }));
    alice.await_message("game:state").await;
    bob.await_message("game:state").await;
    alice.await_message("game:turn").await;
    bob.await_message("game:turn").await;

    // Drop Alice.
    alice.close().await;

    let conn = bob.await_message("player:connection").await;
    assert_eq!(conn["playerId"], json!(alice_id));
    assert_eq!(conn["connected"], json!(false));

    // Reconnect Alice with token + roomId.
    let alice2 = TestClient::connect(&srv.ws_url).await;
    alice2.send(json!({ "type": "hello", "token": alice_token, "roomId": room_id }));
    alice2.await_message("hello:ok").await;
    let fresh = alice2.await_message("game:state").await;
    assert_eq!(fresh["type"], json!("game:state"));

    let reconn = bob.await_message("player:connection").await;
    assert_eq!(reconn["playerId"], json!(alice_id));
    assert_eq!(reconn["connected"], json!(true));

    alice2.close().await;
    bob.close().await;
    srv.close().await;
}

#[tokio::test]
async fn bot_auto_plays_when_it_goes_first() {
    let srv = TestServer::start().await;
    let (alice_id, alice_token) = create_session(&srv.base_url, "Alice").await;
    let alice = connect_authed(&srv.ws_url, &alice_token, None).await;

    alice.send(
        json!({ "type": "room:create", "name": "Bot Room", "maxPlayers": 2, "isPrivate": false }),
    );
    let rs = alice.await_message("room:state").await;
    let room_id = rs["room"]["id"].as_str().unwrap().to_string();

    alice.send(json!({ "type": "room:addBot", "roomId": room_id, "level": "easy" }));
    let with_bot = alice.await_message("room:state").await;
    let bot = with_bot["room"]["players"]
        .as_array()
        .unwrap()
        .iter()
        .find(|p| !p["bot"].is_null());
    assert!(bot.is_some());
    assert_eq!(bot.unwrap()["bot"]["level"], json!("easy"));

    alice.send(json!({ "type": "room:start", "roomId": room_id }));

    let mut current = String::new();
    for _ in 0..10 {
        let msg = alice
            .await_any(Duration::from_secs(3))
            .await
            .expect("start msg");
        match msg["type"].as_str() {
            Some("game:state") => {
                current = msg["view"]["currentPlayerId"].as_str().unwrap().to_string()
            }
            Some("game:turn") => break,
            _ => {}
        }
    }

    if current.starts_with("bot:") {
        srv.clock.advance(1000); // fire the bot delay
        let applied = alice.await_message("game:applied").await;
        assert_eq!(applied["type"], json!("game:applied"));
    } else {
        assert_eq!(current, alice_id);
    }

    alice.close().await;
    srv.close().await;
}

#[tokio::test]
async fn non_host_cannot_add_bot() {
    let srv = TestServer::start().await;
    let (_alice_id, alice_token) = create_session(&srv.base_url, "Alice").await;
    let (_bob_id, bob_token) = create_session(&srv.base_url, "Bob").await;
    let alice = connect_authed(&srv.ws_url, &alice_token, None).await;
    let bob = connect_authed(&srv.ws_url, &bob_token, None).await;

    alice.send(
        json!({ "type": "room:create", "name": "Room", "maxPlayers": 3, "isPrivate": false }),
    );
    let rs = alice.await_message("room:state").await;
    let room_id = rs["room"]["id"].as_str().unwrap().to_string();
    bob.send(json!({ "type": "room:join", "roomId": room_id }));
    bob.await_message("room:state").await;
    alice.await_message("room:state").await;

    bob.send(json!({ "type": "room:addBot", "roomId": room_id, "level": "easy" }));
    let err = bob.await_message("error").await;
    assert_eq!(err["code"], json!("NOT_HOST"));

    alice.close().await;
    bob.close().await;
    srv.close().await;
}

#[tokio::test]
async fn add_bot_rejected_when_room_full() {
    let srv = TestServer::start().await;
    let (_alice_id, alice_token) = create_session(&srv.base_url, "Alice").await;
    let (_bob_id, bob_token) = create_session(&srv.base_url, "Bob").await;
    let alice = connect_authed(&srv.ws_url, &alice_token, None).await;
    let bob = connect_authed(&srv.ws_url, &bob_token, None).await;

    alice.send(
        json!({ "type": "room:create", "name": "Room", "maxPlayers": 2, "isPrivate": false }),
    );
    let rs = alice.await_message("room:state").await;
    let room_id = rs["room"]["id"].as_str().unwrap().to_string();
    bob.send(json!({ "type": "room:join", "roomId": room_id }));
    bob.await_message("room:state").await;
    alice.await_message("room:state").await;

    alice.send(json!({ "type": "room:addBot", "roomId": room_id, "level": "easy" }));
    let err = alice.await_message("error").await;
    assert_eq!(err["code"], json!("ROOM_FULL"));

    alice.close().await;
    bob.close().await;
    srv.close().await;
}

#[tokio::test]
async fn timeout_triggers_auto_move_and_next_turn() {
    let srv = TestServer::start().await;
    let (_alice_id, alice_token) = create_session(&srv.base_url, "Alice").await;
    let (_bob_id, bob_token) = create_session(&srv.base_url, "Bob").await;
    let alice = connect_authed(&srv.ws_url, &alice_token, None).await;
    let bob = connect_authed(&srv.ws_url, &bob_token, None).await;

    alice.send(
        json!({ "type": "room:create", "name": "Room", "maxPlayers": 2, "isPrivate": false }),
    );
    let rs = alice.await_message("room:state").await;
    let room_id = rs["room"]["id"].as_str().unwrap().to_string();
    bob.send(json!({ "type": "room:join", "roomId": room_id }));
    bob.await_message("room:state").await;
    alice.await_message("room:state").await;

    alice.send(json!({ "type": "room:start", "roomId": room_id }));
    alice.await_message("game:state").await;
    bob.await_message("game:state").await;
    let first = alice.await_message("game:turn").await;
    bob.await_message("game:turn").await;
    let first_player = first["currentPlayerId"].as_str().unwrap().to_string();

    // Advance the injected clock past the 60s deadline.
    srv.clock.advance(65_000);

    let applied = alice.await_message("game:applied").await;
    bob.await_message("game:applied").await;
    assert_eq!(applied["type"], json!("game:applied"));

    let next = alice.await_message("game:turn").await;
    bob.await_message("game:turn").await;
    assert_ne!(next["currentPlayerId"].as_str().unwrap(), first_player);

    alice.close().await;
    bob.close().await;
    srv.close().await;
}

#[tokio::test]
async fn human_disconnect_in_bot_game_tears_down() {
    let srv = TestServer::start().await;
    let (_alice_id, alice_token) = create_session(&srv.base_url, "Alice").await;
    let alice = connect_authed(&srv.ws_url, &alice_token, None).await;

    alice.send(
        json!({ "type": "room:create", "name": "Bot Room", "maxPlayers": 2, "isPrivate": false }),
    );
    let rs = alice.await_message("room:state").await;
    let room_id = rs["room"]["id"].as_str().unwrap().to_string();
    alice.send(json!({ "type": "room:addBot", "roomId": room_id, "level": "easy" }));
    alice.await_message("room:state").await;

    alice.send(json!({ "type": "room:start", "roomId": room_id }));
    alice.await_message("game:state").await;
    alice.await_message("game:turn").await;

    // The only human disconnects → the live game must be torn down.
    alice.close().await;
    // Give the close handler a moment.
    tokio::time::sleep(Duration::from_millis(50)).await;

    // Advancing past the bot delay must NOT resurrect the game.
    srv.clock.advance(65_000);

    let alice2 = TestClient::connect(&srv.ws_url).await;
    alice2.send(json!({ "type": "hello", "token": alice_token, "roomId": room_id }));
    alice2.await_message("hello:ok").await;
    let aborted = alice2.await_message("game:aborted").await;
    assert_eq!(aborted["reason"], json!("not_found"));

    alice2.close().await;
    srv.close().await;
}

#[tokio::test]
async fn game_to_completion_then_reconnect_aborted() {
    let srv = TestServer::start().await;
    let (_alice_id, alice_token) = create_session(&srv.base_url, "Alice").await;
    let alice = connect_authed(&srv.ws_url, &alice_token, None).await;

    alice.send(json!({ "type": "room:create", "name": "Finish Room", "maxPlayers": 2, "isPrivate": false }));
    let rs = alice.await_message("room:state").await;
    let room_id = rs["room"]["id"].as_str().unwrap().to_string();
    alice.send(json!({ "type": "room:addBot", "roomId": room_id, "level": "easy" }));
    alice.await_message("room:state").await;

    alice.send(json!({ "type": "room:start", "roomId": room_id }));
    alice.await_message("game:state").await;
    alice.await_message("game:turn").await;

    // Drive the whole game by timing out every turn (human turns auto-move on the
    // 60s deadline; bot turns fire on their ~750ms delay). Each advance is large
    // enough to fire whichever timer is pending; loop until game:over arrives.
    let mut over: Option<Value> = None;
    for _ in 0..800 {
        srv.clock.advance(65_000);
        if let Some(msg) = alice
            .try_message("game:over", Duration::from_millis(50))
            .await
        {
            over = Some(msg);
            break;
        }
    }
    let over = over.expect("game never reached game:over");
    assert_eq!(over["type"], json!("game:over"));

    // After game over the manager is removed → reconnect yields not_found.
    let alice2 = TestClient::connect(&srv.ws_url).await;
    alice2.send(json!({ "type": "hello", "token": alice_token, "roomId": room_id }));
    alice2.await_message("hello:ok").await;
    let aborted = alice2.await_message("game:aborted").await;
    assert_eq!(aborted["reason"], json!("not_found"));

    alice2.close().await;
    alice.close().await;
    srv.close().await;
}

#[tokio::test]
async fn multi_human_disconnect_keeps_game_alive() {
    let srv = TestServer::start().await;
    let (alice_id, alice_token) = create_session(&srv.base_url, "Alice").await;
    let (_bob_id, bob_token) = create_session(&srv.base_url, "Bob").await;
    let alice = connect_authed(&srv.ws_url, &alice_token, None).await;
    let bob = connect_authed(&srv.ws_url, &bob_token, None).await;

    alice.send(
        json!({ "type": "room:create", "name": "Room", "maxPlayers": 2, "isPrivate": false }),
    );
    let rs = alice.await_message("room:state").await;
    let room_id = rs["room"]["id"].as_str().unwrap().to_string();
    bob.send(json!({ "type": "room:join", "roomId": room_id }));
    bob.await_message("room:state").await;
    alice.await_message("room:state").await;

    alice.send(json!({ "type": "room:start", "roomId": room_id }));
    alice.await_message("game:state").await;
    bob.await_message("game:state").await;
    alice.await_message("game:turn").await;
    bob.await_message("game:turn").await;

    // Alice disconnects but Bob stays → game must NOT be torn down.
    alice.close().await;
    let conn = bob.await_message("player:connection").await;
    assert_eq!(conn["connected"], json!(false));

    let alice2 = TestClient::connect(&srv.ws_url).await;
    alice2.send(json!({ "type": "hello", "token": alice_token, "roomId": room_id }));
    alice2.await_message("hello:ok").await;
    let fresh = alice2.await_message("game:state").await;
    assert_eq!(fresh["type"], json!("game:state"));
    let _ = alice_id;

    alice2.close().await;
    bob.close().await;
    srv.close().await;
}

#[tokio::test]
async fn multiple_bots_get_unique_ids() {
    let srv = TestServer::start().await;
    let (_alice_id, alice_token) = create_session(&srv.base_url, "Alice").await;
    let alice = connect_authed(&srv.ws_url, &alice_token, None).await;

    alice.send(
        json!({ "type": "room:create", "name": "Room", "maxPlayers": 4, "isPrivate": false }),
    );
    let rs = alice.await_message("room:state").await;
    let room_id = rs["room"]["id"].as_str().unwrap().to_string();

    let mut bot_ids: Vec<String> = Vec::new();
    for level in ["easy", "medium", "easy"] {
        alice.send(json!({ "type": "room:addBot", "roomId": room_id, "level": level }));
        let rs = alice.await_message("room:state").await;
        bot_ids = rs["room"]["players"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|p| !p["bot"].is_null())
            .map(|p| p["id"].as_str().unwrap().to_string())
            .collect();
    }
    assert_eq!(bot_ids.len(), 3);
    let uniq: HashMap<&String, ()> = bot_ids.iter().map(|id| (id, ())).collect();
    assert_eq!(uniq.len(), 3);

    alice.close().await;
    srv.close().await;
}
