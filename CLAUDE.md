# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

Online multiplayer **Azul** (the tile-laying board game): a monorepo with a **Rust backend** (`azul-server/` Cargo workspace) and a **TypeScript React PWA** (`packages/web`). The UI text is in **Russian**; code, comments, and identifiers are in English.

## Commands

Backend commands run from `azul-server/`; web commands run from the repo root unless noted.

```bash
# Backend — tests (116 Rust tests: 67 engine unit + 1 full_game + 3 tournament + 25 server unit + 20 server integration)
cargo test                                    # all tests
cargo test -p azul-engine                     # engine crate only
cargo test -p azul-shared                     # shared crate (also regenerates web wire types via ts-rs)

# Backend — typecheck / build
cargo build                                   # debug build of all crates
cargo build --release -p azul-server          # release binary

# Backend — run locally
cargo run -p azul-server                      # axum + WebSocket on PORT (default 8080)

# Regenerate TypeScript protocol types from the Rust source of truth
# (writes packages/web/src/generated/*.ts; never hand-edit those files)
cargo test -p azul-shared

# Web — dev server (proxies /api + /ws → :8080)
npm run dev -w @azul/web

# Web — production build
npm run build -w @azul/web                    # tsc -b && vite build → static SPA

# Web — typecheck
npm run typecheck                             # tsc -b packages/web

# Full stack
docker compose up --build                     # Rust server + nginx(web) on host :80
./scripts/deploy.sh                           # rsync + docker compose up on the prod host
```

## Architecture

Dependency direction: **shared ← engine ← server**. `packages/web` depends on neither; it gets its types from the generated files.

### `crates/shared` (`azul-shared`) — domain model + wire protocol

Single source of truth for game types (`GameState`, `PlayerBoard`, `Move`, `Color`, `WALL_PATTERN`, …) and the WebSocket protocol. `protocol.rs` defines **serde**-tagged enums for every client→server and server→client message. `BotLevel` is defined here (not in the engine) so the engine can reuse it without a circular dependency. The `#[ts(...)]` attributes on serde structs/enums drive **ts-rs** code generation; run `cargo test -p azul-shared` to export updated TypeScript bindings into `packages/web/src/generated/`. `PlayerView` is the **redacted** per-player projection broadcast over the wire — the bag contents are hidden (only `bag_count` is exposed) to prevent draw-probability cheating.

> **ts-rs gotcha:** serde `#[serde(tag = "type")]` enums and fields with `#[serde(skip_serializing_if)]` need explicit `#[ts(...)]` attributes to generate correct TypeScript. Check `protocol.rs` when adding new message variants.

### `crates/engine` (`azul-engine`) — pure game logic (no I/O)

Deterministic and side-effect-free; all randomness flows through a seeded RNG (`rng.rs` / `make_rng(seed)`) so games are replayable. `apply_move` returns a new state and bumps `turn_seq` (monotonic move counter used for idempotency/race-guarding upstream). The round is a state machine over `GameState.phase`:

- `offer` — players draft tiles (`legal_moves`, `apply_move`); `is_offer_phase_over` detects the end.
- `tiling` — `resolve_tiling` / `score_placement` wall-tiles pattern lines and scores.
- then either `start_next_round` (refill from bag, reshuffle discard via RNG) or, if `is_game_over`, `finalize_scores` (end-game bonuses) → `finished`.

`auto_move` is the timeout/forfeit fallback move. `bot/` is a self-contained AI: `BOT_PRESETS` map `easy|medium|hard` → `BotConfig` (search depth, epsilon-greedy randomness, endgame/denial heuristics); `select_move` (greedy → minimax via `search.rs`) drives it; `evaluate.rs` is the board heuristic.

### `crates/server` (`azul-server` binary) — axum + WebSocket gateway

Fully **dependency-injected** for testability. The server takes a `SessionStore`, `RoomRepository`, `RoomManagerFactory`, and an injectable `Clock`; `main.rs` wires the real in-memory implementations. Tests substitute fakes and a controllable clock. Routes: `GET /api/health`, `POST /api/session`, `GET /ws`. Three layers:

- **`ws_gateway.rs`** — transport only. Validates frames, authenticates via `hello` (the only message allowed pre-auth), maps sockets↔players↔rooms, and forwards `RoomManager` callback events to the right sockets. Handles reconnect (resends `game:state`), lobby broadcasts, bot id minting, and tears a game down when the last connected human leaves.
- **`room_manager.rs`** — orchestrates one game over the pure engine: turn timers (60 s human timeout → `auto_move`; ~750 ms delay → `select_move` for bots), the **`turn_seq` race-guard** (a move carries `expected_turn_seq`; stale submissions are rejected), phase progression, and emitting per-player `PlayerView`s. Transport-agnostic — communicates only through callbacks, never touches sockets.
- **`session_store.rs` / `room_repository.rs`** — in-memory persistence behind traits (a Redis implementation is the intended future swap; see `docs/DESIGN.md §6`).

### `packages/web` — React + Zustand PWA

Single Zustand store (`store.ts`) holds **all** app + game state and owns the one WebSocket. The socket auto-reconnects (with stored guest token + last `roomId` from `localStorage`) and pings every 20 s; `dispatch()` maps each `ServerMessage` to a state update. Screen routing is a plain `screen` enum (`login|lobby|room|game|results`) switched in `App.tsx`. REST is only `POST /api/session`; everything else is WebSocket. Vite proxies `/api` and `/ws` to the server in dev (override target with `VITE_API_TARGET`). Ships as an installable PWA (`vite-plugin-pwa`) that precaches static assets only — game state is always live over WS.

Protocol types (`ServerMessage`, `ClientMessage`, `PlayerView`, `Move`, etc.) are imported from `packages/web/src/wire.ts`, which re-exports the ts-rs-generated files in `src/generated/`. The one non-generated constant (`FLOOR_PENALTIES`) lives in `wire.ts` directly. Do not import from `src/generated/` directly or from any `@azul/*` package — those packages are gone.

## Conventions

- **Rust backend:** edition 2024, `serde`/`serde_json` for serialisation, `tokio` async runtime, `axum` for HTTP+WS. Follow standard Rust naming (`snake_case` for functions/fields, `CamelCase` for types).
- **TypeScript web client** is still strict: `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, and `verbatimModuleSyntax` on (see `tsconfig.base.json`). Use `import type` for type-only imports; array/record indexing yields `T | undefined`.
- **ESM throughout** in the web package — relative imports use explicit `.js` extensions even though sources are `.ts`.
- Backend tests live in `azul-server/crates/*/src/` as inline `#[cfg(test)]` modules and integration tests under `azul-server/crates/server/tests/`. Engine has full game/scoring/bot coverage; server integration tests drive the gateway through a real WebSocket round-trip.
- Reference docs in `docs/`: `DESIGN.md` (architecture + roadmap), `PROTOCOL.md` (wire protocol), `BACKEND.md` (backend dev guide).
