#!/usr/bin/env bash
# start.sh — resolve node via nvm (default alias; keep it current with the
# `getnvm` shell function) and exec the standalone production server.
# Used by vite-apps.service (systemd --user).
set -euo pipefail

# scripts/ -> ide/ -> workspace/ -> repo root
cd "$(dirname "${BASH_SOURCE[0]}")/../../.."

export NVM_DIR="$HOME/.nvm"
# shellcheck disable=SC1091
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh" >/dev/null 2>&1

# Falls back to PATH node when nvm is absent.
exec node workspace/ide/server/standalone.mjs
