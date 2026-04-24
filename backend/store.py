"""On-disk persistence for user-set repo flags and remote URL history.

Lives in ~/.config/tether/ so it survives upgrades and directory moves.
JSON is used for hand-inspectability; files are small.
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


_LOCK = threading.Lock()


def _load(name: str) -> dict[str, Any]:
    path = _cfg_dir() / name
    if not path.exists():
        return {}
    try:
        with open(path, "r", encoding="utf-8") as f:
            data = json.load(f)
            return data if isinstance(data, dict) else {}
    except (json.JSONDecodeError, OSError):
        return {}


def _save(name: str, data: dict[str, Any]) -> None:
    path = _cfg_dir() / name
    # Atomic write via temp file + rename.
    tmp = tempfile.NamedTemporaryFile(
        mode="w",
        encoding="utf-8",
        dir=path.parent,
        prefix=f".{name}.",
        suffix=".tmp",
        delete=False,
    )
    try:
        json.dump(data, tmp, indent=2, sort_keys=True)
        tmp.flush()
        os.fsync(tmp.fileno())
        tmp.close()
        os.replace(tmp.name, path)
    except Exception:
        try:
            os.unlink(tmp.name)
        except OSError:
            pass
        raise


# --- Sensitive flag ------------------------------------------------


def is_sensitive(path: str) -> bool:
    with _LOCK:
        return bool(_load("sensitive.json").get(path))


def set_sensitive(path: str, value: bool) -> bool:
    with _LOCK:
        data = _load("sensitive.json")
        if value:
            data[path] = True
        else:
            data.pop(path, None)
        _save("sensitive.json", data)
        return value


def all_sensitive() -> set[str]:
    with _LOCK:
        return {p for p, v in _load("sensitive.json").items() if v}


# --- Remote URL history -------------------------------------------
# Schema: {
#   "/abs/path": {
#     "origin": {
#       "currentUrl": "...",
#       "seenAt":      "ISO8601",
#       "history": [
#         {"url": "prev url", "seenAt": "ISO8601"}
#       ]
#     }
#   }
# }


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def record_remotes(repo_path: str, remotes: list[tuple[str, str]]) -> dict[str, dict]:
    """Update history for ``repo_path`` given current (name, fetch_url) pairs.

    Returns a map remote_name -> {"changed": bool, "previousUrl": str | None,
    "previousSeenAt": str | None} so callers can flag changed URLs.
    """
    with _LOCK:
        store = _load("remote-history.json")
        repo_record: dict[str, dict] = store.get(repo_path, {})
        diffs: dict[str, dict] = {}
        now = _now()
        current_names = {n for n, _ in remotes}

        for name, url in remotes:
            prior = repo_record.get(name)
            if prior is None:
                repo_record[name] = {"currentUrl": url, "seenAt": now, "history": []}
                diffs[name] = {"changed": False, "previousUrl": None, "previousSeenAt": None}
                continue

            if prior.get("currentUrl") != url:
                history = prior.get("history") or []
                history.insert(0, {
                    "url": prior.get("currentUrl"),
                    "seenAt": prior.get("seenAt"),
                })
                history = history[:10]
                repo_record[name] = {"currentUrl": url, "seenAt": now, "history": history}
                diffs[name] = {
                    "changed": True,
                    "previousUrl": prior.get("currentUrl"),
                    "previousSeenAt": prior.get("seenAt"),
                }
            else:
                diffs[name] = {"changed": False, "previousUrl": None, "previousSeenAt": None}

        # Prune removed remotes (keep history out of sight but not lost).
        for name in list(repo_record.keys()):
            if name == "__removed__":
                continue  # meta bucket, not a remote name
            if name not in current_names:
                removed = repo_record.pop(name)
                if not isinstance(removed, dict):
                    continue  # shouldn't happen, but defend against corrupt state
                bucket = repo_record.setdefault("__removed__", [])
                bucket.append({
                    "name": name,
                    "removedAt": now,
                    **removed,
                })
                repo_record["__removed__"] = bucket[-20:]

        store[repo_path] = repo_record
        _save("remote-history.json", store)
        return diffs


def remote_history(repo_path: str) -> dict:
    with _LOCK:
        return _load("remote-history.json").get(repo_path, {})


def all_remote_history() -> dict:
    with _LOCK:
        return _load("remote-history.json")


# --- Custom paths (outside the scan root) -------------------------
# Schema: {"paths": ["/abs/path1", ...]}


def _load_paths() -> list[str]:
    data = _load("custom-paths.json")
    paths = data.get("paths")
    return list(paths) if isinstance(paths, list) else []


def custom_paths() -> list[str]:
    with _LOCK:
        return _load_paths()


def add_custom_path(path: str) -> bool:
    """Returns True if newly added, False if already present."""
    with _LOCK:
        current = _load_paths()
        if path in current:
            return False
        current.append(path)
        _save("custom-paths.json", {"paths": current})
        return True


def remove_custom_path(path: str) -> bool:
    with _LOCK:
        current = _load_paths()
        if path not in current:
            return False
        current = [p for p in current if p != path]
        _save("custom-paths.json", {"paths": current})
        return True
