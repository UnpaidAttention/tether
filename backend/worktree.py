"""Working-tree inspection: what actually gets pushed vs. ignored.

Tether's Files tab answers the question "which folders under this repo
actually make it to GitHub when I push?" by classifying every entry under a
subdirectory as tracked / untracked / ignored / mixed.

Implementation uses three `git ls-files` calls against the whole repo once,
then matches filesystem entries against the resulting sets — far cheaper
than `git check-ignore` per entry on large trees.
"""
from __future__ import annotations

import os
import subprocess
from dataclasses import dataclass, field
from pathlib import PurePosixPath


class WorkTreeError(RuntimeError):
    pass


def _git_out(path: str, *args: str, timeout: float = 30.0) -> str:
    proc = subprocess.run(
        ["git", "-C", path, *args],
        capture_output=True, text=True, timeout=timeout,
    )
    if proc.returncode != 0:
        raise WorkTreeError(
            f"git {' '.join(args)} exited {proc.returncode}: {proc.stderr.strip() or proc.stdout.strip()}"
        )
    return proc.stdout


def _ls_posix(path: str, *args: str) -> set[str]:
    """Return a set of POSIX-style relative paths from `git ls-files`."""
    out = _git_out(path, "ls-files", "-z", *args)
    return {p for p in out.split("\0") if p}


@dataclass
class _RepoIndex:
    tracked: set[str]
    untracked: set[str]
    ignored: set[str]
    # Subsets of ``tracked`` that have uncommitted changes.
    modified: set[str]  # worktree differs from index
    staged: set[str]    # index differs from HEAD (may or may not also be modified)
    # Directory -> status counts, computed lazily.
    _dir_summary_cache: dict[str, dict[str, int]] = field(default_factory=dict)


def _parse_porcelain(out: str) -> tuple[set[str], set[str]]:
    """Parse `git status --porcelain=v1 -z` into (modified, staged) sets.

    Porcelain v1 format per entry: ``XY path[\x00orig]`` where
      X = index status, Y = worktree status.
    With ``-z`` the separator is NUL. Rename/copy entries use two NULs
    (current then original); we only care about the current filename.
    """
    modified: set[str] = set()
    staged: set[str] = set()
    if not out:
        return modified, staged
    records = out.split("\0")
    i = 0
    while i < len(records):
        rec = records[i]
        if len(rec) < 3:
            i += 1
            continue
        x = rec[0]
        y = rec[1]
        name = rec[3:]
        # Skip the original-name field on rename/copy.
        skip_next = x in ("R", "C") or y in ("R", "C")
        if x != " " and x != "?":
            staged.add(name)
        if y != " " and y != "?":
            modified.add(name)
        i += 2 if skip_next else 1
    return modified, staged


def _build_index(path: str) -> _RepoIndex:
    tracked = _ls_posix(path, "--cached")
    untracked = _ls_posix(path, "--others", "--exclude-standard")
    ignored = _ls_posix(path, "--others", "--ignored", "--exclude-standard")
    try:
        porcelain = _git_out(path, "status", "--porcelain=v1", "-z")
        modified, staged = _parse_porcelain(porcelain)
    except WorkTreeError:
        modified, staged = set(), set()
    # Intersect with ``tracked`` — we only want to classify tracked files
    # as modified/staged. An "??" porcelain entry is untracked and already
    # captured in ``untracked`` above.
    modified &= tracked
    staged_tracked = staged & tracked
    return _RepoIndex(
        tracked=tracked,
        untracked=untracked,
        ignored=ignored,
        modified=modified,
        staged=staged_tracked,
    )


def _summarise_dir(idx: _RepoIndex, rel_dir: str) -> dict[str, int]:
    """Count how many files under ``rel_dir`` fall into each status bucket.

    ``rel_dir`` is a POSIX-style relative path (""==repo root). Includes
    descendants at every depth. ``modified`` and ``staged`` are *not*
    disjoint from ``tracked`` — they're counts of subsets of the tracked
    files within this subtree that happen to have uncommitted changes.
    """
    cache_key = rel_dir
    cached = idx._dir_summary_cache.get(cache_key)
    if cached is not None:
        return cached

    prefix = "" if rel_dir in ("", ".") else rel_dir.rstrip("/") + "/"
    def _count(s: set[str]) -> int:
        if not prefix:
            return len(s)
        return sum(1 for f in s if f.startswith(prefix))

    counts = {
        "tracked": _count(idx.tracked),
        "untracked": _count(idx.untracked),
        "ignored": _count(idx.ignored),
        "modified": _count(idx.modified),
        "staged": _count(idx.staged),
    }
    idx._dir_summary_cache[cache_key] = counts
    return counts


def _classify_dir(summary: dict[str, int]) -> str:
    """Pick the most meaningful single status for a directory.

    Priorities (when non-zero): modified/staged beat "clean tracked" because
    uncommitted changes are the signal a user most wants to see. Untracked
    beats ignored when both are present. An entirely empty dir is "empty"
    (won't be pushed — git doesn't track empty dirs).
    """
    t, u, i = summary.get("tracked", 0), summary.get("untracked", 0), summary.get("ignored", 0)
    m, s = summary.get("modified", 0), summary.get("staged", 0)
    total = t + u + i
    if total == 0:
        return "empty"

    # Base classifier — uses only the disjoint buckets.
    base_counts = {"tracked": t, "untracked": u, "ignored": i}
    nonzero = [name for name, n in base_counts.items() if n > 0]
    if len(nonzero) == 1:
        base = nonzero[0]
    else:
        base = "mixed"

    # Overlay: if there are uncommitted changes inside, that's the lead.
    # Staged beats modified because "ready to commit" is a stronger signal
    # than "edited".
    if s > 0:
        return "staged"
    if m > 0:
        return "modified"
    return base


def _classify_file(rel: str, idx: _RepoIndex) -> str:
    if rel in idx.tracked:
        if rel in idx.staged:
            return "staged"
        if rel in idx.modified:
            return "modified"
        return "tracked"
    if rel in idx.ignored:
        return "ignored"
    if rel in idx.untracked:
        return "untracked"
    # Fallback — file exists but git ls-files didn't list it. This happens for
    # files inside an ignored directory (git doesn't recurse into those unless
    # --ignored is combined with --directory=no). Mark it as ignored since
    # none of the three sets claimed it.
    return "ignored"


def list_tree(path: str, subdir: str = "") -> dict:
    """Describe what lives immediately inside ``subdir`` of the repo at ``path``.

    Raises WorkTreeError for bare repos or if git commands fail.
    """
    # Refuse on bare repos — there's no working tree to inspect.
    try:
        out = _git_out(path, "rev-parse", "--is-bare-repository").strip()
        if out == "true":
            raise WorkTreeError("Bare repo has no working tree to inspect.")
    except WorkTreeError:
        raise

    idx = _build_index(path)
    # Normalise subdir: strip leading slashes, resolve ".." away to avoid escapes.
    requested = (subdir or "").strip().strip("/").strip()
    if ".." in PurePosixPath(requested).parts:
        raise WorkTreeError("Subdir can't contain '..'")

    abs_dir = os.path.join(path, requested) if requested else path
    if not os.path.isdir(abs_dir):
        raise WorkTreeError(f"Not a directory: {abs_dir}")

    entries: list[dict] = []
    with os.scandir(abs_dir) as it:
        for de in it:
            # Skip the .git dir itself — it's an implementation detail, not
            # something the user pushes.
            if de.name == ".git":
                continue
            rel = (requested + "/" + de.name) if requested else de.name
            if de.is_dir(follow_symlinks=False):
                summary = _summarise_dir(idx, rel)
                status = _classify_dir(summary)
                entries.append({
                    "name": de.name,
                    "type": "dir",
                    "status": status,
                    "summary": summary,
                })
            else:
                status = _classify_file(rel, idx)
                try:
                    size = de.stat(follow_symlinks=False).st_size
                except OSError:
                    size = None
                entries.append({
                    "name": de.name,
                    "type": "file",
                    "status": status,
                    "size": size,
                })

    # Sort: directories first, then by name case-insensitive.
    entries.sort(key=lambda e: (e["type"] != "dir", e["name"].lower()))

    root_summary = _summarise_dir(idx, requested)
    return {
        "path": abs_dir,
        "subdir": requested,
        "entries": entries,
        "rootSummary": root_summary,
        "totals": {
            "tracked": len(idx.tracked),
            "untracked": len(idx.untracked),
            "ignored": len(idx.ignored),
            "modified": len(idx.modified),
            "staged": len(idx.staged),
        },
    }


def check_ignore(path: str, rel: str) -> dict:
    """Return {"ignored": bool, "rule": str|None, "source": str|None, "line": int|None}.

    Uses `git check-ignore -v` which prints `<source>:<line>:<pattern>\t<path>`
    for ignored paths.
    """
    proc = subprocess.run(
        ["git", "-C", path, "check-ignore", "-v", "--no-index", rel],
        capture_output=True, text=True, timeout=10.0,
    )
    # check-ignore returns 0 if ignored, 1 if not ignored, >1 on error.
    if proc.returncode not in (0, 1):
        raise WorkTreeError((proc.stderr or proc.stdout).strip() or "check-ignore failed")
    if proc.returncode == 1 or not proc.stdout.strip():
        return {"ignored": False, "rule": None, "source": None, "line": None}
    # Output: "<source>:<line>:<pattern>\t<path>"
    first = proc.stdout.splitlines()[0]
    left, _, _ = first.partition("\t")
    parts = left.split(":", 2)
    if len(parts) == 3:
        source, line_num, pattern = parts
        try:
            line_i = int(line_num)
        except ValueError:
            line_i = None
        return {"ignored": True, "rule": pattern, "source": source, "line": line_i}
    return {"ignored": True, "rule": left, "source": None, "line": None}
