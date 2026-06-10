# Azul Backend — Developer Guide

## Prerequisites

- Node.js 22+
- npm 10+ (workspaces support)
- Docker + Docker Compose (for containerised runs)

---

## Install

```bash
npm install
```

This installs all workspace dependencies (`@azul/shared`, `@azul/engine`, `@azul/server`) in one shot from the repo root.

---

## Run tests

```bash
# All packages
npx vitest run

# Single package / file
npx vitest run packages/engine/src/createGame.test.ts
npx vitest run packages/shared/src/protocol.test.ts
```

---

## Typecheck

```bash
# Individual packages
npx tsc --noEmit -p packages/shared/tsconfig.json
npx tsc --noEmit -p packages/engine/tsconfig.json
npx tsc --noEmit -p packages/server/tsconfig.json

# All packages at once (project references)
npm run typecheck
```

---

## Run the server locally (dev mode)

Uses `tsx` for on-the-fly TypeScript execution — no build step needed.

```bash
npm run dev -w @azul/server
# or from the server package directory:
cd packages/server && npm run dev
```

The server listens on `PORT` (default `8080`).

---

## Build for production

```bash
npm run build -w @azul/shared
npm run build -w @azul/engine
npm run build -w @azul/server
# then start the compiled output:
npm run start -w @azul/server
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

A commented-out `redis` service stub is in `docker-compose.yml`. Uncomment it when `RedisRoomRepository` is implemented (see `docs/DESIGN.md §6`).

---

## Project layout

```
packages/
  shared/   — domain types + zod WS protocol schemas (@azul/shared)
  engine/   — pure game logic, no I/O (@azul/engine)
  server/   — Fastify HTTP + WebSocket gateway (@azul/server)
```
