# ---------------------------------------------------------------------------
# @azul/web — multi-stage Dockerfile
# Stage 1: build — compiles the React/Vite frontend (bundles shared + engine
#          from source, so no separate build of those packages is required).
# Stage 2: runtime — nginx serving the static bundle and proxying /api + /ws
#          to the backend `server` service.
# ---------------------------------------------------------------------------

# ── Build stage ─────────────────────────────────────────────────────────────
FROM node:22-alpine AS build

WORKDIR /app

# Copy workspace manifests first for layer caching.
COPY package.json package-lock.json ./
COPY packages/shared/package.json   ./packages/shared/
COPY packages/engine/package.json   ./packages/engine/
COPY packages/web/package.json      ./packages/web/

# Install all workspace dependencies (includes devDeps needed for the build).
RUN npm ci

# Copy sources needed to bundle the web app. Vite resolves @azul/shared and
# @azul/engine directly from their TypeScript sources.
COPY tsconfig.base.json ./
COPY packages/shared/   ./packages/shared/
COPY packages/engine/   ./packages/engine/
COPY packages/web/      ./packages/web/

RUN npm run build -w @azul/web

# ── Runtime stage ────────────────────────────────────────────────────────────
FROM nginx:alpine AS runtime

COPY packages/web/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/packages/web/dist /usr/share/nginx/html

EXPOSE 80

CMD ["nginx", "-g", "daemon off;"]
