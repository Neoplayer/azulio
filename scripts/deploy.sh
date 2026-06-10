#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# Azul Online — one-shot deploy to the production host.
#
# What it does (idempotent, safe to re-run):
#   1. rsync the repo to the server (excludes node_modules/.git/dist via .dockerignore)
#   2. ensure the .env on the server pins WEB_PORT to localhost
#   3. install/refresh the host nginx reverse-proxy vhost (default_server -> :8088)
#   4. docker compose up -d --build  (rebuild server + web images, restart)
#   5. prune dangling images, then run an external health check
#
# Usage:
#   ./scripts/deploy.sh                # deploy with defaults
#   DEPLOY_HOST=1.2.3.4 ./scripts/deploy.sh
#   SKIP_NGINX=1 ./scripts/deploy.sh   # skip the nginx step (already configured)
#
# Requires: ssh + rsync locally; docker/docker-compose + nginx + sudo on the host.
# ---------------------------------------------------------------------------
set -euo pipefail

# --- configuration (override via environment) ------------------------------
DEPLOY_USER="${DEPLOY_USER:-opencode}"
DEPLOY_HOST="${DEPLOY_HOST:-188.245.178.249}"
REMOTE_DIR="${REMOTE_DIR:-/home/opencode/azul}"
WEB_PORT="${WEB_PORT:-127.0.0.1:8088}"
HEALTH_URL="${HEALTH_URL:-http://${DEPLOY_HOST}}"
SSH_TARGET="${DEPLOY_USER}@${DEPLOY_HOST}"

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

say()  { printf '\033[1;36m==>\033[0m %s\n' "$*"; }
ok()   { printf '\033[1;32m  ✓\033[0m %s\n' "$*"; }
die()  { printf '\033[1;31m  ✗ %s\033[0m\n' "$*" >&2; exit 1; }

command -v rsync >/dev/null || die "rsync not found locally"
command -v ssh   >/dev/null || die "ssh not found locally"

# Multiplex all ssh/scp/rsync over a single shared connection: with a flaky
# link, one resilient handshake beats five fragile ones. The master is opened
# once (with retries) and auto-closes 60s after the last use.
# NOTE: keep this SHORT — Unix-domain socket paths are capped at ~104 chars,
# and macOS $TMPDIR is already long. %C is a short hash of (host,port,user).
CTRL_PATH="/tmp/azul-deploy-%C"
SSH_OPTS=(
  -o StrictHostKeyChecking=no
  -o ConnectTimeout=20
  -o ConnectionAttempts=5
  -o ServerAliveInterval=15
  -o ServerAliveCountMax=4
  -o ControlMaster=auto
  -o "ControlPath=${CTRL_PATH}"
  -o ControlPersist=60
)

cleanup() { ssh "${SSH_OPTS[@]}" -O exit "$SSH_TARGET" 2>/dev/null || true; }
trap cleanup EXIT

# Open the shared master connection up front, retrying through banner timeouts.
say "Opening connection to ${SSH_TARGET}"
for i in $(seq 1 6); do
  if ssh "${SSH_OPTS[@]}" "$SSH_TARGET" true 2>/dev/null; then
    ok "connected"; break
  fi
  [[ $i == 6 ]] && die "could not establish SSH connection after 6 attempts"
  printf '  … ssh attempt %s/6 failed, retrying in 5s\n' "$i"; sleep 5
done

# --- 1. sync source --------------------------------------------------------
say "Syncing source to ${SSH_TARGET}:${REMOTE_DIR}"
ssh "${SSH_OPTS[@]}" "$SSH_TARGET" "mkdir -p '$REMOTE_DIR'"
rsync -az --delete \
  --exclude='.git' \
  --exclude='node_modules' \
  --exclude='packages/*/node_modules' \
  --exclude='dist' \
  --exclude='packages/*/dist' \
  --exclude='.omc' \
  --exclude='azul-web' \
  --exclude='*.png' \
  --exclude='.env' \
  -e "ssh ${SSH_OPTS[*]}" \
  ./ "${SSH_TARGET}:${REMOTE_DIR}/"
ok "source synced"

# --- 2. pin WEB_PORT on the server (preserve other .env keys) --------------
say "Ensuring WEB_PORT=${WEB_PORT} in ${REMOTE_DIR}/.env"
ssh "${SSH_OPTS[@]}" "$SSH_TARGET" bash -s -- "$REMOTE_DIR" "$WEB_PORT" <<'REMOTE_ENV'
set -euo pipefail
dir="$1"; port="$2"; envf="$dir/.env"
touch "$envf"
if grep -q '^WEB_PORT=' "$envf"; then
  sed -i "s|^WEB_PORT=.*|WEB_PORT=$port|" "$envf"
else
  echo "WEB_PORT=$port" >> "$envf"
fi
REMOTE_ENV
ok "WEB_PORT pinned"

# --- 3. install host nginx vhost -------------------------------------------
if [[ "${SKIP_NGINX:-0}" != "1" ]]; then
  say "Installing host nginx reverse-proxy vhost"
  scp "${SSH_OPTS[@]}" deploy/nginx/azul.conf "${SSH_TARGET}:/tmp/azul.nginx.conf"
  ssh "${SSH_OPTS[@]}" "$SSH_TARGET" bash -s <<'REMOTE_NGINX'
set -euo pipefail
sudo mv /tmp/azul.nginx.conf /etc/nginx/sites-available/azul
sudo ln -sfn /etc/nginx/sites-available/azul /etc/nginx/sites-enabled/azul
# Remove the stock default vhost so our default_server is unambiguous.
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t
sudo systemctl reload nginx
REMOTE_NGINX
  ok "nginx configured + reloaded"
else
  say "SKIP_NGINX=1 — leaving nginx untouched"
fi

# --- 4. build + restart the stack ------------------------------------------
say "Building & starting Docker stack (docker compose up -d --build)"
ssh "${SSH_OPTS[@]}" "$SSH_TARGET" bash -s -- "$REMOTE_DIR" <<'REMOTE_COMPOSE'
set -euo pipefail
cd "$1"
if docker compose version >/dev/null 2>&1; then DC="docker compose"; else DC="docker-compose"; fi
$DC up -d --build
$DC ps
docker image prune -f >/dev/null 2>&1 || true
REMOTE_COMPOSE
ok "stack up"

# --- 5. health check -------------------------------------------------------
say "Health check: ${HEALTH_URL}"
for i in $(seq 1 10); do
  code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "$HEALTH_URL" || true)"
  if [[ "$code" == "200" ]]; then
    ok "app is live (HTTP 200) at ${HEALTH_URL}"
    exit 0
  fi
  printf '  … attempt %s/10 got HTTP %s, retrying\n' "$i" "$code"
  sleep 3
done
die "health check failed — app did not return HTTP 200 at ${HEALTH_URL}"
