# Azul Online

Online multiplayer **[Azul](https://en.wikipedia.org/wiki/Azul_(board_game))** — the tile-laying board game — playable in the browser. Create a room, invite friends over a shared link or fill seats with AI bots, and play in real time over WebSockets. Ships as an installable PWA. (The player-facing UI is in Russian; code and docs are in English.)

## Features

- **Real-time multiplayer** for 2–4 players over a single WebSocket connection.
- **AI bots** at three difficulties (`easy` / `medium` / `hard`) — fill empty seats or play solo.
- **Reconnect-safe** — refresh or drop offline and rejoin the game in progress; per-turn timer auto-plays on timeout.
- **Authoritative server** — all game logic runs server-side on a pure, deterministic engine; clients only ever see a redacted view (the tile bag is hidden to prevent draw-probability cheating).
- **Installable PWA** with a portrait-first, hand-tuned board UI.

## Tech stack

| Layer    | Stack |
|----------|-------|
| Engine   | TypeScript, pure & deterministic (seeded RNG), zero I/O |
| Server   | Fastify + `ws`, dependency-injected, in-memory stores |
| Client   | React 18, Zustand, Vite, `vite-plugin-pwa` |
| Protocol | Zod-validated WebSocket messages |
| Tests    | Vitest |
| Deploy   | Docker Compose (server + nginx), one-shot `deploy.sh` |

## Monorepo layout

npm workspaces; dependency direction is `shared ← engine ← server` and `shared, engine ← web`.

```
packages/
  shared/   @azul/shared — domain types + Zod WebSocket protocol (single source of truth)
  engine/   @azul/engine — pure game logic: rules, scoring, round flow, and the AI bot
  server/   @azul/server — Fastify HTTP + WebSocket gateway, rooms, sessions, turn timers
  web/      @azul/web    — React + Zustand PWA client
docs/       DESIGN.md (architecture), PROTOCOL.md (wire protocol), BACKEND.md (backend guide)
```

## Quick start

Requires **Node.js 22+** and **npm 10+**.

```bash
npm install                    # installs all workspaces at once

# Run the two dev servers in separate terminals:
npm run dev -w @azul/server    # Fastify + ws on http://localhost:8080
npm run dev -w @azul/web       # Vite on http://localhost:5173 (proxies /api + /ws → :8080)
```

Open <http://localhost:5173>, enter a nickname, create a room, add a bot or share the room with a second tab, and start the game. No build step is needed in development — the server (`tsx`) and client (Vite) consume the TypeScript source of the shared packages directly.

## Testing & typechecking

```bash
npx vitest run                                           # whole suite
npx vitest                                               # watch mode
npx vitest run packages/engine/src/createGame.test.ts    # a single file
npx vitest run -t "applies a factory move"               # a single test by name

npm run typecheck                                        # tsc -b across all packages
```

## Production build & Docker

In production the compiled `dist/` output is resolved via the `azulprod` package-export condition (the server `start` script and Dockerfiles set `node --conditions=azulprod`).

```bash
# Manual build
npm run build -w @azul/shared && npm run build -w @azul/engine && npm run build -w @azul/server
npm run start -w @azul/server    # serves on PORT (default 8080)
npm run build -w @azul/web       # static SPA → packages/web/dist

# Or the whole stack via Docker (server + nginx serving the SPA and proxying /api + /ws)
docker compose up --build        # public entry point on host port 80
```

## Deployment

`scripts/deploy.sh` does an idempotent one-shot deploy to a host: rsync the repo, install/refresh the nginx reverse-proxy vhost, and `docker compose up -d --build`, then run a health check.

```bash
DEPLOY_HOST=1.2.3.4 ./scripts/deploy.sh
```

## Documentation

- [`docs/DESIGN.md`](docs/DESIGN.md) — architecture and roadmap
- [`docs/PROTOCOL.md`](docs/PROTOCOL.md) — WebSocket wire protocol
- [`docs/BACKEND.md`](docs/BACKEND.md) — backend developer guide
- [`CLAUDE.md`](CLAUDE.md) — orientation for AI coding agents
