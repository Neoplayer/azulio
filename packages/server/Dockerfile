# ---------------------------------------------------------------------------
# @azul/server — multi-stage Dockerfile
# Stage 1: build — compiles shared, engine, and server packages from source.
# Stage 2: runtime — slim Node image that runs the compiled output.
# ---------------------------------------------------------------------------

# ── Build stage ─────────────────────────────────────────────────────────────
FROM node:22-alpine AS build

WORKDIR /app

# Copy workspace manifests first for layer caching.
COPY package.json package-lock.json ./
COPY packages/shared/package.json   ./packages/shared/
COPY packages/engine/package.json   ./packages/engine/
COPY packages/server/package.json   ./packages/server/

# Install all workspace dependencies (includes devDeps needed for tsc).
RUN npm ci

# Copy the rest of the source (excluding what .dockerignore omits).
COPY tsconfig.base.json ./
COPY packages/shared/   ./packages/shared/
COPY packages/engine/   ./packages/engine/
COPY packages/server/   ./packages/server/

# Build each package in dependency order.
RUN npm run build -w @azul/shared
RUN npm run build -w @azul/engine
RUN npm run build -w @azul/server

# ── Runtime stage ────────────────────────────────────────────────────────────
FROM node:22-alpine AS runtime

ENV NODE_ENV=production
ENV PORT=8080

WORKDIR /app

# Copy workspace manifests for production install.
COPY package.json package-lock.json ./
COPY packages/shared/package.json   ./packages/shared/
COPY packages/engine/package.json   ./packages/engine/
COPY packages/server/package.json   ./packages/server/

# Install production deps only.
RUN npm ci --omit=dev

# Copy compiled output from build stage.
COPY --from=build /app/packages/shared/dist  ./packages/shared/dist
COPY --from=build /app/packages/engine/dist  ./packages/engine/dist
COPY --from=build /app/packages/server/dist  ./packages/server/dist

EXPOSE 8080

CMD ["node", "packages/server/dist/main.js"]
