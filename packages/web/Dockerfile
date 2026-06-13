# ---------------------------------------------------------------------------
# @azul/web — multi-stage Dockerfile
# Stage 1: build — compiles the React/Vite frontend.
# Stage 2: runtime — nginx serving the static bundle and proxying /api + /ws
#          to the backend `server` service.
# ---------------------------------------------------------------------------

# ── Build stage ─────────────────────────────────────────────────────────────
FROM node:22-alpine AS build

WORKDIR /app

# Copy workspace manifests first for layer caching.
COPY package.json package-lock.json ./
COPY packages/web/package.json      ./packages/web/

# Install all workspace dependencies (includes devDeps needed for the build).
RUN npm ci

# Copy sources needed to bundle the web app.
COPY tsconfig.base.json ./
COPY packages/web/      ./packages/web/

RUN npm run build -w @azul/web

# ── Runtime stage ────────────────────────────────────────────────────────────
FROM nginx:alpine AS runtime

COPY packages/web/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/packages/web/dist /usr/share/nginx/html

EXPOSE 80

CMD ["nginx", "-g", "daemon off;"]
