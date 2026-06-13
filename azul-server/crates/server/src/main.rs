// ---------------------------------------------------------------------------
// main.rs — binary entry point (port of packages/server/src/main.ts).
// Wires the real in-memory dependencies and starts the axum server, binding
// `PORT` (default 8080) on 0.0.0.0.
// ---------------------------------------------------------------------------

use std::sync::Arc;

use azul_server::room_manager::InMemoryRoomManager;
use azul_server::room_repository::InMemoryRoomRepository;
use azul_server::session_store::InMemorySessionStore;
use azul_server::types::{
    Clock, RoomEvents, RoomManager, RoomManagerFactory, RoomRepository, SessionStore,
};
use azul_server::{ServerDeps, build_server};

#[tokio::main]
async fn main() {
    let port: u16 = std::env::var("PORT")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(8080);

    let session_store: Arc<dyn SessionStore> = Arc::new(InMemorySessionStore::new());
    let room_repository: Arc<dyn RoomRepository> = Arc::new(InMemoryRoomRepository::new());
    let room_manager_factory: RoomManagerFactory = Arc::new(
        |clock: Arc<dyn Clock>, events: Arc<dyn RoomEvents>| -> Arc<dyn RoomManager> {
            InMemoryRoomManager::new(clock, events)
        },
    );

    let server = build_server(ServerDeps {
        session_store,
        room_repository,
        room_manager_factory,
        clock: None,
    });

    let addr = std::net::SocketAddr::from(([0, 0, 0, 0], port));
    let listener = match tokio::net::TcpListener::bind(addr).await {
        Ok(l) => l,
        Err(e) => {
            eprintln!("Failed to bind port {port}: {e}");
            std::process::exit(1);
        }
    };

    println!("Azul server listening on port {port}");
    if let Err(e) = axum::serve(listener, server.router).await {
        eprintln!("Server error: {e}");
        std::process::exit(1);
    }
}
