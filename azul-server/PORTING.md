# Azul backend — TypeScript → Rust port

This workspace (`azul-server/`) is a faithful Rust port of the TypeScript backend
in `../packages/{shared,engine,server}`. The React/Vite **web client stays
TypeScript and unchanged**; it talks to this server over the *same* WebSocket
protocol. **Protocol fidelity is the hard constraint** — every JSON frame must
match what the old TS server produced.

The TS source is the spec. When in doubt, read it and match its behaviour.

## Workspace layout (Cargo virtual workspace)

```
azul-server/
  Cargo.toml                     # [workspace] resolver=3, members, shared deps
  crates/
    shared/   -> azul-shared     # port of packages/shared  (DONE by lead)
    engine/   -> azul-engine     # port of packages/engine
    server/   -> azul-server bin # port of packages/server
```

Dependency direction: **shared ← engine ← server** (same as TS). `cargo build`
and `cargo test` already pass on the scaffold (engine/server bodies are `todo!()`).

## Source → target file mapping

| TS source | Rust target | Owner |
|---|---|---|
| shared/src/index.ts | crates/shared/src/lib.rs | **lead (done)** |
| shared/src/protocol.ts | crates/shared/src/protocol.rs | **lead (done)** |
| engine/src/rng.ts | crates/engine/src/rng.rs | **lead (done)** |
| engine/src/index.ts (createGame) | crates/engine/src/lib.rs | **lead (done)** |
| engine/src/moves.ts | crates/engine/src/moves.rs | engine-core |
| engine/src/tiling.ts | crates/engine/src/tiling.rs | engine-core |
| engine/src/nextRound.ts | crates/engine/src/next_round.rs | engine-core |
| engine/src/finalize.ts | crates/engine/src/finalize.rs | engine-core |
| engine/src/bot/types.ts | crates/engine/src/bot/mod.rs | **lead (done)** |
| engine/src/bot/evaluate.ts | crates/engine/src/bot/evaluate.rs | engine-bot |
| engine/src/bot/search.ts | crates/engine/src/bot/search.rs | engine-bot |
| engine/src/bot/selectMove.ts | crates/engine/src/bot/select_move.rs | engine-bot |
| server/src/types.ts | crates/server/src/types.rs | server |
| server/src/sessionStore.ts | crates/server/src/session_store.rs | server |
| server/src/roomRepository.ts | crates/server/src/room_repository.rs | server |
| server/src/roomManager.ts | crates/server/src/room_manager.rs | server |
| server/src/wsGateway.ts | crates/server/src/ws_gateway.rs | server |
| server/src/server.ts + main.ts | crates/server/src/{lib.rs,main.rs} | server |

Engine `*.test.ts` → `#[cfg(test)] mod tests` in the matching `.rs` file (or a
`tests/` integration test). Server `*.test.ts` → server crate tests.

## Fidelity rules (READ THESE)

1. **RNG is bit-exact and DONE.** `rng.rs` ports mulberry32 + Fisher-Yates using
   u32 wrapping arithmetic. Do **not** change it. Randomness threads through
   `&mut Mulberry32` (the TS `() => number`); call `rng.next_f64()`.
   Seeds are `u32` (`GameState.rng_seed`). `shuffle(&slice, &mut rng)` matches TS
   draw order, so seeded games/tests reproduce TS results.

2. **The protocol is DONE** in `crates/shared/src/protocol.rs` and verified
   against the wire format. Use `ServerMessage` / `ClientMessage` /
   `parse_client_message`. Do **not** change field names, renames, or tags
   without lead sign-off — the web client depends on them. Notable shapes:
   - enums → lowercase strings; struct fields → camelCase.
   - `winner_ids: Option<Vec<..>>` serializes `None → null` (NOT omitted).
   - optional `?` fields (`bot`, `room_id`) are omitted when `None`.
   - `FloorSlot::First → "FIRST"`, `FloorSlot::Tile(c) → "blue"`.
   - `PlayerBoard.pattern_lines` are capacity-sized arrays of `null`
     (`[[null],[null,null],...]`) for a fresh board — NOT empty arrays.

3. **`structuredClone(state)` → `state.clone()`** (all domain types are `Clone`).

4. **`applyMove` throws on illegal → `apply_move` PANICS on illegal.** Callers
   always guard with `is_legal_move` first, so it never panics in practice. The
   "illegal move throws" test → `#[should_panic]`.

5. **`BotLevel` is reused from `azul-shared`** in the engine bot (engine depends
   on shared, so no duplicate). The TS `bot-types.test.ts` assignability guard
   is **obsolete — do not port it**.

6. **UI text stays Russian; code/comments English** (unchanged from the repo
   convention). No UI here anyway — this is backend only.

## Server design guidance (server worker)

- Web framework: **axum (`ws` feature) on tokio**. Endpoints: `GET /api/health`,
  `POST /api/session` `{name}→{playerId,token}`, WS `GET /ws`.
  **Confirm current axum 0.8 / tokio APIs via context7 before coding.**
- Keep the **dependency-injection** shape: `build_server(deps)` takes a
  `SessionStore`, `RoomRepository`, a `RoomManager` factory, and an optional
  `Clock` — as Rust traits behind `Arc<dyn ...>`. `main.rs` wires real
  in-memory impls; tests substitute fakes + a controllable clock.
- Preserve the **`turnSeq` race-guard**: a `game:move` carries
  `expectedTurnSeq`; reject stale submissions (`error{code:"STALE_TURN_SEQ"}`).
- Preserve **timers/auto-move**: on each turn, set a deadline (`now + turnMs`,
  default 60_000ms human / ~750ms bot delay) and broadcast `game:turn`. On
  timeout, if `turnSeq` is unchanged, apply `engine::auto_move`. Cancel the
  timer atomically when any move is applied. Make timers testable via the
  injected clock (or `tokio::time` pause/advance in tests).
- The room manager is transport-agnostic (callbacks `on_state/on_turn/
  on_applied/on_over`); the gateway maps those to sockets. Per-player
  `PlayerView` via `engine::to_player_view(state, player_id)`; the gateway sets
  each player's `connected` flag.
- Error codes seen in PROTOCOL.md / server.test.ts: `ILLEGAL_MOVE`,
  `STALE_TURN_SEQ`, `NOT_HOST`, `ROOM_FULL`, etc. — match the TS strings.
- Reconnect: `hello` with the same token resends `game:state`; broadcast
  `player:connection`. Unknown token after restart → `session:invalid`.

## Verification

- `cargo build` — whole workspace.
- `cargo test` — whole workspace (or `-p azul-engine` / `-p azul-server`).
- `cargo clippy --all-targets -- -D warnings` — keep it clean.
- `cargo fmt` — format before finishing.

## Reference docs

`../docs/PROTOCOL.md` (wire protocol), `../docs/DESIGN.md` (rules, scoring spec,
autoMove spec, milestones), `../docs/BACKEND.md`, and `../CLAUDE.md`.
