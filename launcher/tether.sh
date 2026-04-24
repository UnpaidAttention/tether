#!/usr/bin/env bash
# Launch (or focus) the Tether server and open it in a browser.
#
# Single-instance: if a previous launch is still running, reuse it.
#
# Env:
#   TETHER_PORT (default 7733) — port to bind on localhost
#   TETHER_ROOT (default $HOME) — directory to scan for repos

set -euo pipefail

TETHER_HOME="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PORT="${TETHER_PORT:-7733}"
URL="http://127.0.0.1:${PORT}/"

RUNTIME_DIR="${XDG_RUNTIME_DIR:-/tmp}"
PID_FILE="${RUNTIME_DIR}/tether-${PORT}.pid"
LOG_FILE="${RUNTIME_DIR}/tether-${PORT}.log"

pid_is_live() {
  local pid="$1"
  [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null
}

open_browser() {
  if command -v xdg-open >/dev/null 2>&1; then
    xdg-open "$URL" >/dev/null 2>&1 &
  else
    echo "xdg-open not found; visit $URL manually" >&2
  fi
}

# If already running, just focus it.
if [[ -f "$PID_FILE" ]]; then
  existing="$(cat "$PID_FILE" 2>/dev/null || true)"
  if pid_is_live "$existing"; then
    open_browser
    exit 0
  fi
  rm -f "$PID_FILE"
fi

cd "$TETHER_HOME"

if [[ ! -d .venv ]]; then
  echo "Tether isn't installed. Run: $TETHER_HOME/install.sh" >&2
  if command -v zenity >/dev/null 2>&1; then
    zenity --error --no-wrap \
      --title="Tether" \
      --text="Tether isn't installed yet.\n\nRun: $TETHER_HOME/install.sh" || true
  fi
  exit 1
fi

export TETHER_PORT="$PORT"
export TETHER_ROOT="${TETHER_ROOT:-$HOME}"

# Start the server detached so the launcher script can exit cleanly.
nohup "$TETHER_HOME/.venv/bin/python" -m backend.main \
  >"$LOG_FILE" 2>&1 &
SERVER_PID=$!
echo "$SERVER_PID" >"$PID_FILE"

# Wait (briefly) for the port to accept connections, then open the browser.
for _ in $(seq 1 40); do
  if (exec 3<>/dev/tcp/127.0.0.1/"$PORT") 2>/dev/null; then
    exec 3>&-
    open_browser
    exit 0
  fi
  sleep 0.1
done

echo "Server didn't start within 4s. See $LOG_FILE" >&2
if command -v zenity >/dev/null 2>&1; then
  zenity --error --no-wrap \
    --title="Tether" \
    --text="Tether server didn't start.\n\nSee: $LOG_FILE" || true
fi
exit 1
