# Azul Backend — Developer Guide

## Prerequisites

- Rust (stable toolchain, edition 2024)
- Docker + Docker Compose (for containerised runs)

---

## Run tests

All commands run from `azul-server/`.

```bash
# All crates (116 tests: 67 engine unit + 1 full_game + 3 tournament + 25 server unit + 20 server integration)
cargo test

# Single crate
cargo test -p azul-engine
cargo test -p azul-shared    # also regenerates web TypeScript types via ts-rs
cargo test -p azul-server
```

---

## Typecheck / build

```bash
cargo build                          # debug build, all crates
cargo build --release -p azul-server # release binary
```

---

## Run the server locally (dev mode)

```bash
# from azul-server/
cargo run -p azul-server
```

The server listens on `PORT` (default `8080`). Routes: `GET /api/health`, `POST /api/session`, `GET /ws`.

---

## Regenerate web TypeScript types

The `azul-shared` crate uses **ts-rs** to export TypeScript bindings. The export directory is configured in `azul-server/.cargo/config.toml` via `TS_RS_EXPORT_DIR`, pointing at `packages/web/src/generated/`. To regenerate:

```bash
# from azul-server/
cargo test -p azul-shared
```

Never hand-edit files in `packages/web/src/generated/` — they are overwritten on every run.

---

## Build for production

```bash
# from azul-server/
cargo build --release -p azul-server   # binary at azul-server/target/release/azul-server
```

---

## Run via Docker

```bash
docker compose up --build
```

The server is exposed on `http://localhost:8080`.

To stop:

```bash
docker compose down
```

### Redis (optional)

A commented-out `redis` service stub is in `docker-compose.yml`. Uncomment it when a `RedisRoomRepository` implementation is added (see `docs/DESIGN.md §6`).

---

## Project layout

```
azul-server/          Cargo workspace
  crates/
    shared/   — domain types + serde WS protocol (azul-shared); ts-rs generates web types
    engine/   — pure game logic, no I/O (azul-engine)
    server/   — axum HTTP + WebSocket gateway (azul-server binary)
```
