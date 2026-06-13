// ---------------------------------------------------------------------------
// lib.rs — axum app factory + dependency injection
// (port of packages/server/src/server.ts).
//
// `build_server(deps)` wires the REST routes (`GET /api/health`,
// `POST /api/session`) and the WebSocket endpoint (`GET /ws`) against injected
// dependencies (`SessionStore`, `RoomRepository`, `RoomManagerFactory`, optional
// `Clock`). `main.rs` wires the real in-memory implementations; tests substitute
// fakes + a controllable clock.
// ---------------------------------------------------------------------------

pub mod clock;
pub mod room_manager;
pub mod room_repository;
pub mod session_store;
pub mod types;
pub mod ws_gateway;

use std::sync::Arc;

use axum::extract::{State, WebSocketUpgrade};
use axum::http::StatusCode;
use axum::response::Response;
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::{Deserialize, Serialize};

use crate::clock::RealClock;
use crate::types::{Clock, RoomManagerFactory, RoomRepository, SessionStore};
use crate::ws_gateway::Gateway;

/// Injected dependencies for `build_server`.
pub struct ServerDeps {
    pub session_store: Arc<dyn SessionStore>,
    pub room_repository: Arc<dyn RoomRepository>,
    pub room_manager_factory: RoomManagerFactory,
    /// Optional clock; defaults to the real `tokio::time`-backed clock.
    pub clock: Option<Arc<dyn Clock>>,
}

/// The built server: an axum `Router` plus the shared `Gateway` (exposed so
/// callers can `dispose()` managers on shutdown).
pub struct AzulServer {
    pub router: Router,
    pub gateway: Gateway,
}

/// Build the axum app from injected dependencies.
pub fn build_server(deps: ServerDeps) -> AzulServer {
    let clock: Arc<dyn Clock> = deps.clock.unwrap_or_else(|| Arc::new(RealClock));
    let gateway = Gateway::new(
        Arc::clone(&deps.session_store),
        Arc::clone(&deps.room_repository),
        Arc::clone(&deps.room_manager_factory),
        clock,
    );

    let router = Router::new()
        .route("/api/health", get(health))
        .route("/api/session", post(create_session))
        .route("/ws", get(ws_handler))
        .with_state(AppState {
            session_store: deps.session_store,
            gateway: gateway.clone(),
        });

    AzulServer { router, gateway }
}

/// Shared state injected into axum handlers.
#[derive(Clone)]
struct AppState {
    session_store: Arc<dyn SessionStore>,
    gateway: Gateway,
}

// ---------------------------------------------------------------------------
// REST endpoints
// ---------------------------------------------------------------------------

#[derive(Serialize)]
struct HealthResponse {
    ok: bool,
}

async fn health() -> Json<HealthResponse> {
    Json(HealthResponse { ok: true })
}

#[derive(Deserialize)]
struct SessionRequest {
    /// Accepted leniently so a *missing* field yields our own 400 (the TS Fastify
    /// schema is `required:['name'], minLength:1`) rather than axum's default 422.
    name: Option<String>,
}

#[derive(Serialize)]
struct SessionResponse {
    #[serde(rename = "playerId")]
    player_id: String,
    token: String,
}

async fn create_session(
    State(state): State<AppState>,
    Json(req): Json<SessionRequest>,
) -> Result<Json<SessionResponse>, StatusCode> {
    // Match Fastify's `name: { type: 'string', minLength: 1 }`: a missing or
    // empty-string name is a 400. A non-empty name (incl. whitespace) is accepted.
    let name = req.name.unwrap_or_default();
    if name.is_empty() {
        return Err(StatusCode::BAD_REQUEST);
    }
    let (player_id, token) = state.session_store.create_session(&name);
    Ok(Json(SessionResponse { player_id, token }))
}

// ---------------------------------------------------------------------------
// WebSocket endpoint
// ---------------------------------------------------------------------------

async fn ws_handler(ws: WebSocketUpgrade, State(state): State<AppState>) -> Response {
    let gateway = state.gateway.clone();
    ws.on_upgrade(move |socket| gateway.handle_socket(socket))
}
