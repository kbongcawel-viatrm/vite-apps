#!/usr/bin/env bash
# deploy.sh — build the vite-apps app, start it, and bring up the
# Caddy + cloudflared tunnel stack in detached mode.
#
#   ./workspace/ide/scripts/deploy.sh          # full deploy
#   ./workspace/ide/scripts/deploy.sh --app-only    # build + start app, skip containers
#   ./workspace/ide/scripts/deploy.sh --containers  # containers only (app must be running)
#   (or: npm run deploy from the repo root)
#
# What it does:
#   1. `npm run build`            -> workspace/mgmt-dashboard/dist/
#   2. `npm run server`           -> serves dist/ on :5173 (manager UI) and
#      owns the hardened edge proxy on 127.0.0.1:8080 + code-server :18080
#   3. `podman-compose -f "$COMPOSE_FILE" up -d`     -> Caddy (127.0.0.1:8443 TLS) + cloudflared tunnel
#
# Public URL after deploy: https://ide.home-security.uk  (TLS at Cloudflare edge)
set -euo pipefail

# scripts/ -> ide/ -> workspace/ -> repo root
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
COMPOSE_FILE="$ROOT/workspace/ide/compose.yaml"
cd "$ROOT"

APP_ONLY=0
CONTAINERS_ONLY=0
for arg in "$@"; do
  case "$arg" in
    --app-only)    APP_ONLY=1 ;;
    --containers)  CONTAINERS_ONLY=1 ;;
    -h|--help)     sed -n '2,20p' "$0"; exit 0 ;;
    *) echo "unknown flag: $arg" >&2; exit 2 ;;
  esac
done

# --- node/npm ---------------------------------------------------------------
if ! command -v npm >/dev/null 2>&1; then
  for d in "$HOME"/.nvm/versions/node/*/bin; do
    [ -x "$d/npm" ] && export PATH="$d:$PATH" && break
  done
fi
command -v npm >/dev/null 2>&1 || { echo "error: npm not found" >&2; exit 1; }

wait_for() { # wait_for <name> <curl-url> <timeout-s>
  local name="$1" url="$2" timeout="${3:-30}" i=0
  until curl -sf -o /dev/null -m 2 "$url"; do
    i=$((i+1)); [ "$i" -ge "$timeout" ] && { echo "error: $name not ready at $url" >&2; exit 1; }
    sleep 1
  done
  echo "  ✓ $name ready ($url)"
}

# --- 1+2: build & start the vite app ----------------------------------------
if [ "$CONTAINERS_ONLY" -eq 0 ]; then
  [ -f .env ] || { echo "error: .env missing — cp .env.example .env and set PASSWORD" >&2; exit 1; }
  grep -q '^PASSWORD=.' .env || { echo "error: PASSWORD not set in .env" >&2; exit 1; }

  echo "==> npm run build"
  npm run build

  # Start the standalone server detached if not already listening on :5173.
  if curl -sf -o /dev/null -m 2 http://127.0.0.1:5173/api/code-server/status; then
    echo "==> app already running on :5173 — skipping start"
  else
    echo "==> starting app (npm run server) detached"
    mkdir -p .code-server-data/logs
    setsid nohup npm run server >> .code-server-data/logs/app.log 2>&1 < /dev/null &
  fi

  echo "==> waiting for edge proxy on 127.0.0.1:8080"
  wait_for "edge proxy" http://127.0.0.1:8080/login 45
  echo "==> waiting for manager UI on :5173"
  wait_for "manager UI" http://127.0.0.1:5173/ 15
fi

[ "$APP_ONLY" -eq 1 ] && { echo "Done (app only)."; exit 0; }

# --- 3: containers ------------------------------------------------------------
command -v podman-compose >/dev/null 2>&1 || {
  echo "error: podman-compose not found (dnf install podman-compose)" >&2; exit 1; }

# Rootless-only: refuse to run containers as root. podman is rootless when
# invoked by an unprivileged user; `sudo podman-compose` would be rootful.
if [ "$(id -u)" -eq 0 ]; then
  echo "error: refusing to run as root — podman must stay rootless." >&2
  echo "       Re-run as your normal user (no sudo)." >&2
  exit 1
fi
if [ "$(podman info --format '{{.Host.Security.Rootless}}' 2>/dev/null)" != "true" ]; then
  echo "error: podman is not in rootless mode — fix storage/graphroot config first." >&2
  exit 1
fi
echo "==> podman rootless confirmed (uid $(id -u))"

echo "==> podman-compose up -d (caddy + cloudflared)"
podman-compose -f "$COMPOSE_FILE" up -d

echo "==> podman-compose ps"
podman-compose -f "$COMPOSE_FILE" ps

echo
echo "Deployed."
echo "  Manager UI (local):  http://localhost:5173"
echo "  Editor (local):      http://localhost:8080"
echo "  Editor (public):     https://ide.home-security.uk"
echo "  Manager (public):    https://manager.home-security.uk  (no auth — use Access or remove ingress)"
echo "  Logs:                podman-compose -f compose.yaml logs -f (from workspace/ide)"
echo "  Stop containers:     podman-compose -f compose.yaml down (from workspace/ide)"
