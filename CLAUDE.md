# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

Online multiplayer **Azul** (the tile-laying board game): a TypeScript npm-workspaces monorepo with a pure game engine, a Fastify + WebSocket server, and a React/Vite PWA client. The UI text is in **Russian**; code, comments, and identifiers are in English.

## Commands

All commands run from the repo root unless noted.

```bash
npm install                  # installs all workspaces in one shot

# Tests (vitest, root config picks up packages/*/src/**/*.test.ts)
npx vitest run                                              # whole suite
npx vitest                                                  # watch mode
npx vitest run packages/engine/src/createGame.test.ts      # single file
npx vitest run -t "applies a factory move"                 # single test by name

# Typecheck (project references; build=false in tsconfigs, so use -b or --noEmit)
npm run typecheck                                  # tsc -b across all packages
npx tsc --noEmit -p packages/engine/tsconfig.json  # one package

# Run locally (no build step — tsx/vite consume TS source directly)
npm run dev -w @azul/server      # Fastify + ws on PORT (default 8080)
npm run dev -w @azul/web         # Vite dev server; proxies /api + /ws → :8080

# Production build + run
npm run build -w @azul/shared && npm run build -w @azul/engine && npm run build -w @azul/server
npm run start -w @azul/server    # node --conditions=azulprod dist/main.js
npm run build -w @azul/web       # tsc -b && vite build → static SPA

docker compose up --build        # full stack: server + nginx(web) on host :80
./scripts/deploy.sh              # rsync + docker compose up on the prod host
```

## The `azulprod` export condition (important)

`@azul/shared` and `@azul/engine` `package.json` export maps point `default`/`types` at **`src/*.ts`** and only the `azulprod` condition at **`dist/*.js`**. Consequences:

- **Dev, tests, and typecheck consume the TypeScript source of sibling packages directly** — there is no build step in the inner loop, and editing `shared`/`engine` is immediately visible to `server`/`web`.
- **Production must build first** and run with `node --conditions=azulprod` (the server `start` script and Dockerfiles do this) so the compiled `dist/` is resolved instead of raw `.ts`.

## Architecture

Dependency direction: **shared ← engine ← server**, and **shared, engine ← web**. Nothing depends on `server` or `web`.

### `packages/shared` — domain model + wire protocol
Single source of truth for game types (`GameState`, `PlayerBoard`, `Move`, `Color`, `WALL_PATTERN`, …) and the WebSocket protocol. `protocol.ts` defines **Zod schemas** for every client→server message; `parseClientMessage` validates frames at the gateway boundary. `PlayerView` is the **redacted** per-player projection broadcast over the wire — the bag contents are hidden (only `bagCount` is exposed) to prevent draw-probability cheating.

### `packages/engine` — pure game logic (no I/O)
Deterministic and side-effect-free; all randomness flows through a seeded RNG (`rng.ts` / `makeRng(seed)`) so games are replayable. `applyMove` returns a new state and bumps `turnSeq` (monotonic move counter used for idempotency/race-guarding upstream). The round is a state machine over `GameState.phase`:

- `offer` — players draft tiles (`legalMoves`, `applyMove`); `isOfferPhaseOver` detects the end.
- `tiling` — `resolveTiling` / `scorePlacement` wall-tiles pattern lines and scores.
- then either `startNextRound` (refill from bag, reshuffle discard via RNG) or, if `isGameOver`, `finalizeScores` (end-game bonuses) → `finished`.

`autoMove` is the timeout/forfeit fallback move. `bot/` is a self-contained AI: `BOT_PRESETS` map `easy|medium|hard` → `BotConfig` (search depth, epsilon-greedy randomness, endgame/denial heuristics); `selectMove` (greedy → minimax via `search.ts`) drives it; `evaluate.ts` is the board heuristic.

> **Gotcha:** `BotLevel` is defined twice — `engine/src/bot/types.ts` and `shared/src/protocol.ts` — deliberately, to avoid a shared↔engine dependency cycle. A compile-time mutual-assignability guard in `bot/bot-types.test.ts` keeps them in sync; change both together.

### `packages/server` — Fastify + WebSocket gateway
Fully **dependency-injected** for testability. `buildServer(deps)` (`server.ts`) takes a `SessionStore`, `RoomRepository`, `RoomManagerFactory`, and an optional `Clock`; `main.ts` wires the real in-memory implementations. Tests substitute fakes and a controllable clock. Three layers:

- **`wsGateway.ts`** — transport only. Validates frames with `parseClientMessage`, authenticates via `hello` (the only message allowed pre-auth), maps sockets↔players↔rooms, and forwards `RoomManager` callback events to the right sockets. Handles reconnect (resends `game:state`), lobby broadcasts, bot id minting, and tears a game down when the last connected human leaves.
- **`roomManager.ts`** — orchestrates one game over the pure engine: turn timers (60 s human timeout → `autoMove`; ~750 ms delay → `selectMove` for bots), the **`turnSeq` race-guard** (a move carries `expectedTurnSeq`; stale submissions are rejected), phase progression, and emitting per-player `PlayerView`s. Transport-agnostic — communicates only through `onState/onTurn/onApplied/onOver` callbacks, never touches sockets.
- **`sessionStore.ts` / `roomRepository.ts`** — in-memory persistence behind interfaces (a `RedisRoomRepository` is the intended future swap; see `docs/DESIGN.md §6`).

### `packages/web` — React + Zustand PWA
Single Zustand store (`store.ts`) holds **all** app + game state and owns the one WebSocket. The socket auto-reconnects (with stored guest token + last `roomId` from `localStorage`) and pings every 20 s; `dispatch()` maps each `ServerMessage` to a state update. Screen routing is a plain `screen` enum (`login|lobby|room|game|results`) switched in `App.tsx`. REST is only `POST /api/session`; everything else is WebSocket. Vite proxies `/api` and `/ws` to the server in dev (override target with `VITE_API_TARGET`). Ships as an installable PWA (`vite-plugin-pwa`) that precaches static assets only — game state is always live over WS.

## Conventions

- **TypeScript is strict** with `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, and `verbatimModuleSyntax` on (see `tsconfig.base.json`). Use `import type` for type-only imports; array/record indexing yields `T | undefined`, so non-null assertions on known-valid indices are common in the engine.
- **ESM throughout** — relative imports use explicit `.js` extensions even though sources are `.ts`.
- Tests live next to sources as `*.test.ts`. Engine has full game/scoring/bot coverage; server tests drive the gateway through a real ws round-trip (`testClient.ts`).
- Reference docs in `docs/`: `DESIGN.md` (architecture + roadmap), `PROTOCOL.md` (wire protocol), `BACKEND.md` (backend dev guide).
