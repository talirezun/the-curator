#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# The Curator — Server Runner
# Starts the Node server and auto-restarts it when it exits cleanly (code 0).
# Exit code 1 = stop for real (no restart).
# Used by The Curator.app — do not run directly unless testing.
# ─────────────────────────────────────────────────────────────────────────────

DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$DIR"

# Source shell profile for correct PATH (handles nvm/fnm)
source ~/.zprofile 2>/dev/null
source ~/.zshrc 2>/dev/null

# Find node
NODE="$(which node 2>/dev/null)"
if [[ -z "$NODE" ]]; then
  NODE="/usr/local/bin/node"
fi

while true; do
  # Kill anything on port 3333 before starting (prevents EADDRINUSE)
  lsof -ti :3333 | xargs kill -9 2>/dev/null
  sleep 0.5

  echo "[start.sh] Starting The Curator..."
  "$NODE" src/server.js 2>&1 | tee -a /tmp/the-curator.log

  EXIT_CODE=$?
  echo "[start.sh] Server exited with code $EXIT_CODE"

  if [[ $EXIT_CODE -ne 0 ]]; then
    echo "[start.sh] Non-zero exit — stopping (no restart)."
    break
  fi

  # Exit code 0 = restart requested (Stop button or Update)
  echo "[start.sh] Restarting in 1 second..."
  sleep 1
done
