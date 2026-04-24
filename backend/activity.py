"""Append-only activity log.

Every mutation Tether makes on a local repo or a GitHub repo is appended to a
single JSONL file in the user's config dir. Reads / fetches / rescans are
intentionally NOT logged — the log is for irreversible side effects only.
"""
from __future__ import annotations

import json
import os
import tempfile
import threading
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


def _cfg_dir() -> Path:
    base = os.environ.get("XDG_CONFIG_HOME") or os.path.expanduser("~/.config")
    d = Path(base) / "tether"
    d.mkdir(parents=True, exist_ok=True)
    return d


_LOG_PATH = _cfg_dir() / "activity.jsonl"
_LOCK = threading.Lock()


# --- Event kinds --------------------------------------------------
# Stable string IDs — the frontend switches on these for icons / copy.

KIND_REMOTE_ADDED = "remote.added"
KIND_REMOTE_REMOVED = "remote.removed"
KIND_REMOTE_RENAMED = "remote.renamed"
KIND_REMOTE_URL_CHANGED = "remote.url_changed"
KIND_REMOTE_URL_DETECTED_CHANGE = "remote.url_detected_change"   # detected by scanner, not a direct mutation
KIND_GITHUB_REPO_CREATED = "github.repo_created"
KIND_GITHUB_VISIBILITY_CHANGED = "github.visibility_changed"
KIND_PUSH = "push"
KIND_SENSITIVE_MARKED = "sensitive.marked"
KIND_SENSITIVE_UNMARKED = "sensitive.unmarked"


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def log_event(
    kind: str,
    *,
    repo_path: str | None = None,
    repo_id: str | None = None,
    repo_name: str | None = None,
    details: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Append one event. Never raises — a broken log must not break a mutation."""
    entry: dict[str, Any] = {
        "ts": _now(),
        "kind": kind,
        "repoPath": repo_path,
        "repoId": repo_id,
        "repoName": repo_name,
        "details": details or {},
    }
    try:
        with _LOCK:
            with open(_LOG_PATH, "a", encoding="utf-8") as f:
                f.write(json.dumps(entry, separators=(",", ":"), sort_keys=True))
                f.write("\n")
    except OSError:
        # If the write fails we still want to return the entry so callers can
        # surface it in-session.
        pass
    return entry


def _read_all() -> list[dict[str, Any]]:
    if not _LOG_PATH.exists():
        return []
    out: list[dict[str, Any]] = []
    try:
        with _LOCK:
            with open(_LOG_PATH, "r", encoding="utf-8") as f:
                for line in f:
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        out.append(json.loads(line))
                    except json.JSONDecodeError:
                        continue
    except OSError:
        return []
    return out


def list_events(
    *,
    repo_id: str | None = None,
    repo_path: str | None = None,
    limit: int = 200,
    before: str | None = None,
) -> list[dict[str, Any]]:
    """Return most-recent-first. Filter by repo if supplied."""
    events = _read_all()
    if repo_id:
        events = [e for e in events if e.get("repoId") == repo_id]
    elif repo_path:
        events = [e for e in events if e.get("repoPath") == repo_path]
    events.reverse()
    if before:
        events = [e for e in events if e.get("ts", "") < before]
    return events[: max(0, limit)]


def compact(max_entries: int = 5000) -> int:
    """Keep only the most recent ``max_entries``. Returns how many were dropped."""
    events = _read_all()
    if len(events) <= max_entries:
        return 0
    kept = events[-max_entries:]
    tmp = tempfile.NamedTemporaryFile(
        mode="w",
        encoding="utf-8",
        dir=_LOG_PATH.parent,
        prefix=f".{_LOG_PATH.name}.",
        suffix=".tmp",
        delete=False,
    )
    try:
        for e in kept:
            tmp.write(json.dumps(e, separators=(",", ":"), sort_keys=True))
            tmp.write("\n")
        tmp.flush()
        os.fsync(tmp.fileno())
        tmp.close()
        os.replace(tmp.name, _LOG_PATH)
    except Exception:
        try: os.unlink(tmp.name)
        except OSError: pass
        return 0
    return len(events) - len(kept)
