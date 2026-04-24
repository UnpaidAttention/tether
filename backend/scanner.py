from __future__ import annotations

import hashlib
import os
from dataclasses import dataclass
from pathlib import Path

SKIP_DIRS = {
    "node_modules",
    ".venv",
    "venv",
    "env",
    "__pycache__",
    ".cache",
    ".mypy_cache",
    ".pytest_cache",
    ".tox",
    "target",
    "build",
    "dist",
    ".next",
    ".nuxt",
    ".svelte-kit",
    ".turbo",
    ".parcel-cache",
    ".gradle",
    ".idea",
    ".vscode",
    "vendor",
    ".trash",
    ".Trash",
    "snap",
    ".local",
    ".claude",
    ".npm",
    ".pnpm-store",
    ".yarn",
    ".rustup",
    ".cargo",
    ".pyenv",
    ".nvm",
}


@dataclass
class RepoEntry:
    id: str
    path: str
    name: str
    is_bare: bool

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "path": self.path,
            "name": self.name,
            "isBare": self.is_bare,
        }


def _repo_id(path: str) -> str:
    return hashlib.sha1(path.encode("utf-8")).hexdigest()[:12]


def classify_path(path: str | os.PathLike) -> dict:
    """Describe a single filesystem path: exists / is dir / is git repo / kind."""
    p = Path(path).expanduser()
    try:
        p = p.resolve(strict=False)
    except OSError:
        pass
    info = {
        "path": str(p),
        "exists": p.exists(),
        "isDirectory": p.is_dir() if p.exists() else False,
        "isGitRepo": False,
        "isBare": False,
    }
    if not info["isDirectory"]:
        return info
    contents = set(os.listdir(p))
    if ".git" in contents:
        info["isGitRepo"] = True
    elif {"HEAD", "objects", "refs"}.issubset(contents):
        info["isGitRepo"] = True
        info["isBare"] = True
    return info


def _entry_from_path(path: str) -> RepoEntry | None:
    """Build a RepoEntry for an already-git-initialized path.

    Returns None if the path doesn't look like a git repo any more (e.g. the
    .git dir was removed since it was added as a custom path).
    """
    info = classify_path(path)
    if not info["isGitRepo"]:
        return None
    resolved = info["path"]
    return RepoEntry(
        id=_repo_id(resolved),
        path=resolved,
        name=os.path.basename(resolved) or resolved,
        is_bare=info["isBare"],
    )


def scan(root: str | os.PathLike, *, extra_paths: list[str] | None = None) -> list[RepoEntry]:
    """Walk ``root`` and return every git repo found, plus any ``extra_paths``
    that point to a git repo (typically custom paths tracked by the user).

    A directory is a repo if it contains ``.git/`` (working tree) or looks
    like a bare repo (has ``HEAD`` and ``objects/`` at the top level).
    We do not descend into a repo once found — submodules are ignored on
    purpose to keep the list clean.
    """
    root = Path(root).expanduser().resolve()
    seen: dict[str, RepoEntry] = {}

    for dirpath, dirnames, filenames in os.walk(root, followlinks=False):
        dn = set(dirnames)

        is_worktree = ".git" in dn or ".git" in set(filenames)
        is_bare = "HEAD" in set(filenames) and "objects" in dn and "refs" in dn

        if is_worktree or is_bare:
            path = os.path.realpath(dirpath)
            if path not in seen:
                seen[path] = RepoEntry(
                    id=_repo_id(path),
                    path=path,
                    name=os.path.basename(path) or path,
                    is_bare=is_bare and not is_worktree,
                )
            dirnames[:] = []
            continue

        dirnames[:] = [
            d for d in dirnames
            if not d.startswith(".") and d not in SKIP_DIRS
        ]

    for extra in extra_paths or []:
        entry = _entry_from_path(extra)
        if entry and entry.path not in seen:
            seen[entry.path] = entry

    return sorted(seen.values(), key=lambda r: r.path.lower())
