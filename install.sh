#!/usr/bin/env bash
# Install or refresh Tether:
#   - (re)creates the Python venv and installs deps
#   - stamps the .desktop entry with this install location
#   - registers it in ~/.local/share/applications so it shows in your app menu

set -euo pipefail

TETHER_HOME="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APPS_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/applications"
DESKTOP_SRC="$TETHER_HOME/launcher/tether.desktop"
DESKTOP_DST="$APPS_DIR/tether.desktop"

echo "→ Installing Tether from: $TETHER_HOME"

if ! command -v python3 >/dev/null 2>&1; then
  echo "python3 is required but not found on PATH." >&2
  exit 1
fi

# Tether uses PEP 604 union types (str | None) and Pydantic v2, both of which
# need Python 3.10+. Fail fast with a clear message instead of letting the
# server crash obscurely at import time.
PY_MAJOR=$(python3 -c 'import sys; print(sys.version_info.major)')
PY_MINOR=$(python3 -c 'import sys; print(sys.version_info.minor)')
if [[ "$PY_MAJOR" -lt 3 || ( "$PY_MAJOR" -eq 3 && "$PY_MINOR" -lt 10 ) ]]; then
  echo "Tether needs Python 3.10+. Your python3 is $PY_MAJOR.$PY_MINOR." >&2
  echo "Install a newer python3 and re-run this script." >&2
  exit 1
fi

if ! command -v git >/dev/null 2>&1; then
  echo "git is required but not found on PATH." >&2
  exit 1
fi

# The venv module ships with standard CPython but some minimal distro
# packages split it out (python3-venv on Debian/Ubuntu). Detect early so
# the user gets a package name, not a cryptic ModuleNotFoundError.
if ! python3 -c 'import venv' >/dev/null 2>&1; then
  echo "python3 is installed but the 'venv' module is missing." >&2
  echo "On Debian/Ubuntu: sudo apt install python3-venv" >&2
  echo "On Fedora/RHEL:   the 'python3' rpm already includes it; reinstall if needed." >&2
  exit 1
fi

echo "→ Creating venv and installing deps…"
cd "$TETHER_HOME"
if [[ ! -d .venv ]]; then
  python3 -m venv .venv
fi
.venv/bin/pip install --quiet --upgrade pip
.venv/bin/pip install --quiet -r requirements.txt

chmod +x "$TETHER_HOME/launcher/tether.sh"

echo "→ Writing desktop entry: $DESKTOP_DST"
mkdir -p "$APPS_DIR"
# Stamp the template with the absolute path of this install.
sed "s|__TETHER_HOME__|$TETHER_HOME|g" "$DESKTOP_SRC" > "$DESKTOP_DST"
chmod +x "$DESKTOP_DST"

if command -v update-desktop-database >/dev/null 2>&1; then
  update-desktop-database "$APPS_DIR" >/dev/null 2>&1 || true
fi

if command -v gh >/dev/null 2>&1; then
  echo "→ GitHub CLI detected: $(gh --version | head -1)"
else
  echo "→ Tip: install the GitHub CLI (gh) for richer remote info."
fi

cat <<EOF

✓ Tether is installed.

  Launch it from your desktop app menu (search for "Tether"),
  or run: $TETHER_HOME/launcher/tether.sh

  Override defaults with environment variables if you want:
    TETHER_PORT=7733
    TETHER_ROOT=$HOME

  To uninstall:
    rm "$DESKTOP_DST"
    rm -rf "$TETHER_HOME"

EOF
