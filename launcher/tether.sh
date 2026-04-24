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

# Show the tail of the server log in whatever GUI dialog is available,
# so the user doesn't have to open a terminal to see what went wrong.
show_error_dialog() {
  local title="$1"
  local headline="$2"
  local log="$3"

  # Best case: a text-info dialog that shows the whole log scrollably.
  if command -v zenity >/dev/null 2>&1 && [[ -s "$log" ]]; then
    (zenity --text-info \
      --title="$title" \
      --width=720 --height=420 \
      --filename="$log" 2>/dev/null) &
    return
  fi
  if command -v kdialog >/dev/null 2>&1 && [[ -s "$log" ]]; then
    kdialog --title "$title" --textbox "$log" 720 420 2>/dev/null &
    return
  fi
  # Fallback: compact message dialog with the log path.
  local msg="$headline"$'\n\nLog: '"$log"
  if [[ -s "$log" ]]; then
    msg+=$'\n\nLast lines:\n'
    msg+="$(tail -n 10 "$log" 2>/dev/null)"
  fi
  if command -v zenity >/dev/null 2>&1; then
    zenity --error --no-wrap --title="$title" --text="$msg" 2>/dev/null &
  elif command -v kdialog >/dev/null 2>&1; then
    kdialog --title "$title" --error "$msg" 2>/dev/null &
  elif command -v notify-send >/dev/null 2>&1; then
    notify-send -u critical "$title" "$headline. See $log"
  else
    echo "$title: $headline — see $log" >&2
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
      --text="Tether isn't installed yet.\n\nRun: $TETHER_HOME/install.sh" 2>/dev/null || true
  elif command -v kdialog >/dev/null 2>&1; then
    kdialog --title "Tether" --error "Tether isn't installed yet.\n\nRun: $TETHER_HOME/install.sh" 2>/dev/null || true
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

# Wait for the port to accept connections, then open the browser.
# Cap at ~20 s: slow machines + large scan trees can take several seconds to
# bind. The actual scan now runs in the background after the server is up.
MAX_WAIT_TENTHS=200
for ((i=0; i<MAX_WAIT_TENTHS; i++)); do
  # If the server process is already gone, stop waiting — we have a log
  # tail to show and no point continuing the countdown.
  if ! pid_is_live "$SERVER_PID"; then
    break
  fi
  if (exec 3<>/dev/tcp/127.0.0.1/"$PORT") 2>/dev/null; then
    exec 3>&-
    open_browser
    exit 0
  fi
  sleep 0.1
done

rm -f "$PID_FILE"
if pid_is_live "$SERVER_PID"; then
  kill "$SERVER_PID" 2>/dev/null || true
  headline="Server started but didn't bind to port $PORT within $((MAX_WAIT_TENTHS/10)) s."
else
  headline="Server exited before binding. Last lines of the log are below."
fi

echo "$headline — see $LOG_FILE" >&2
show_error_dialog "Tether" "$headline" "$LOG_FILE"
exit 1
