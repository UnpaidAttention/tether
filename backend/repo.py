from __future__ import annotations

import re
import subprocess
from dataclasses import dataclass


class GitError(RuntimeError):
    def __init__(self, cmd: list[str], code: int, stderr: str):
        super().__init__(f"git {' '.join(cmd[1:])} exited {code}: {stderr.strip()}")
        self.cmd = cmd
        self.code = code
        self.stderr = stderr


def _git(path: str, *args: str, timeout: float = 30.0) -> str:
    cmd = ["git", "-C", path, *args]
    try:
        proc = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            timeout=timeout,
        )
    except subprocess.TimeoutExpired as e:
        raise GitError(cmd, -1, f"timed out after {timeout}s") from e
    if proc.returncode != 0:
        raise GitError(cmd, proc.returncode, proc.stderr)
    return proc.stdout


@dataclass
class Remote:
    name: str
    fetch_url: str
    push_url: str

    def to_dict(self) -> dict:
        return {
            "name": self.name,
            "fetchUrl": self.fetch_url,
            "pushUrl": self.push_url,
        }


@dataclass
class Branch:
    name: str
    is_current: bool
    upstream: str | None
    ahead: int
    behind: int
    last_commit_sha: str
    last_commit_subject: str

    def to_dict(self) -> dict:
        return {
            "name": self.name,
            "isCurrent": self.is_current,
            "upstream": self.upstream,
            "ahead": self.ahead,
            "behind": self.behind,
            "lastCommitSha": self.last_commit_sha,
            "lastCommitSubject": self.last_commit_subject,
        }


def remotes(path: str) -> list[Remote]:
    out = _git(path, "remote", "-v")
    by_name: dict[str, Remote] = {}
    for line in out.splitlines():
        m = re.match(r"^(\S+)\s+(\S+)\s+\((fetch|push)\)$", line)
        if not m:
            continue
        name, url, kind = m.group(1), m.group(2), m.group(3)
        r = by_name.get(name) or Remote(name=name, fetch_url="", push_url="")
        if kind == "fetch":
            r.fetch_url = url
        else:
            r.push_url = url
        by_name[name] = r
    return sorted(by_name.values(), key=lambda r: r.name)


def add_remote(path: str, name: str, url: str) -> None:
    _git(path, "remote", "add", name, url)


def remove_remote(path: str, name: str) -> None:
    _git(path, "remote", "remove", name)


def rename_remote(path: str, old: str, new: str) -> None:
    _git(path, "remote", "rename", old, new)


def set_remote_url(path: str, name: str, url: str, *, push: bool = False) -> None:
    args = ["remote", "set-url"]
    if push:
        args.append("--push")
    args += [name, url]
    _git(path, *args)


def fetch(path: str, remote: str | None = None, *, prune: bool = True) -> str:
    args = ["fetch"]
    if prune:
        args.append("--prune")
    if remote:
        args.append(remote)
    else:
        args.append("--all")
    return _git(path, *args, timeout=120.0)


def pull(path: str, remote: str | None = None, branch: str | None = None) -> str:
    args = ["pull", "--ff-only"]
    if remote:
        args.append(remote)
        if branch:
            args.append(branch)
    return _git(path, *args, timeout=120.0)


def push(path: str, remote: str, branch: str, *, set_upstream: bool = False) -> str:
    args = ["push"]
    if set_upstream:
        args.append("-u")
    args += [remote, branch]
    return _git(path, *args, timeout=120.0)


def branches(path: str) -> list[Branch]:
    try:
        current = _git(path, "symbolic-ref", "--quiet", "--short", "HEAD").strip()
    except GitError:
        current = ""

    fmt = "%(refname:short)\x1f%(upstream:short)\x1f%(objectname:short)\x1f%(contents:subject)"
    try:
        out = _git(
            path,
            "for-each-ref",
            f"--format={fmt}",
            "refs/heads",
        )
    except GitError:
        return []

    result: list[Branch] = []
    for line in out.splitlines():
        if not line:
            continue
        parts = line.split("\x1f")
        if len(parts) < 4:
            continue
        name, upstream, sha, subject = parts[0], parts[1], parts[2], parts[3]
        ahead, behind = 0, 0
        if upstream:
            try:
                counts = _git(
                    path,
                    "rev-list",
                    "--left-right",
                    "--count",
                    f"{upstream}...{name}",
                ).strip()
                b, a = counts.split()
                ahead, behind = int(a), int(b)
            except (GitError, ValueError):
                ahead, behind = 0, 0
        result.append(
            Branch(
                name=name,
                is_current=(name == current),
                upstream=upstream or None,
                ahead=ahead,
                behind=behind,
                last_commit_sha=sha,
                last_commit_subject=subject,
            )
        )
    result.sort(key=lambda b: (not b.is_current, b.name.lower()))
    return result


def default_branch(path: str) -> str | None:
    try:
        out = _git(path, "symbolic-ref", "--quiet", "--short", "HEAD").strip()
        return out or None
    except GitError:
        return None


def status_summary(path: str) -> dict:
    try:
        out = _git(path, "status", "--porcelain=v1")
    except GitError as e:
        return {"error": str(e), "dirty": False, "changedFiles": 0}
    lines = [l for l in out.splitlines() if l.strip()]
    return {"dirty": bool(lines), "changedFiles": len(lines)}
