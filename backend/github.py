from __future__ import annotations

import json
import re
import shutil
import subprocess
from concurrent.futures import ThreadPoolExecutor, as_completed
from functools import lru_cache


GH_URL_PATTERNS = [
    re.compile(r"^git@github\.com:([^/]+)/([^/]+?)(?:\.git)?$"),
    re.compile(r"^ssh://git@github\.com[:/]([^/]+)/([^/]+?)(?:\.git)?$"),
    re.compile(r"^https?://github\.com/([^/]+)/([^/]+?)(?:\.git)?/?$"),
    re.compile(r"^github\.com[:/]([^/]+)/([^/]+?)(?:\.git)?$"),
]


def parse_owner_repo(url: str) -> tuple[str, str] | None:
    if not url:
        return None
    for pat in GH_URL_PATTERNS:
        m = pat.match(url.strip())
        if m:
            return m.group(1), m.group(2)
    return None


@lru_cache(maxsize=1)
def _gh_path() -> str | None:
    return shutil.which("gh")


def gh_available() -> bool:
    return _gh_path() is not None


def _run_gh(args: list[str], timeout: float = 15.0) -> tuple[int, str, str]:
    path = _gh_path()
    if not path:
        return -1, "", "gh not installed"
    try:
        proc = subprocess.run(
            [path, *args],
            capture_output=True,
            text=True,
            timeout=timeout,
        )
        return proc.returncode, proc.stdout, proc.stderr
    except subprocess.TimeoutExpired:
        return -1, "", f"gh timed out after {timeout}s"


def auth_status() -> dict:
    if not gh_available():
        return {"available": False, "authenticated": False, "user": None}
    code, out, err = _run_gh(["api", "user", "--jq", ".login"], timeout=10.0)
    if code == 0 and out.strip():
        return {"available": True, "authenticated": True, "user": out.strip()}
    return {
        "available": True,
        "authenticated": False,
        "user": None,
        "error": (err or out).strip() or None,
    }


def repo_info(owner: str, name: str) -> dict:
    fields = "name,owner,visibility,description,url,defaultBranchRef,isFork,isArchived,pushedAt,stargazerCount"
    code, out, err = _run_gh(
        ["repo", "view", f"{owner}/{name}", "--json", fields],
        timeout=15.0,
    )
    if code != 0:
        msg = (err or out).strip().lower()
        exists = "not found" not in msg and "could not resolve" not in msg
        return {"exists": exists, "error": (err or out).strip() or None}
    try:
        data = json.loads(out)
    except json.JSONDecodeError as e:
        return {"exists": True, "error": f"bad JSON from gh: {e}"}
    default_branch = None
    dbr = data.get("defaultBranchRef") or {}
    if isinstance(dbr, dict):
        default_branch = dbr.get("name")
    return {
        "exists": True,
        "name": data.get("name"),
        "owner": (data.get("owner") or {}).get("login"),
        "visibility": data.get("visibility"),
        "description": data.get("description"),
        "url": data.get("url"),
        "defaultBranch": default_branch,
        "isFork": data.get("isFork", False),
        "isArchived": data.get("isArchived", False),
        "pushedAt": data.get("pushedAt"),
        "stars": data.get("stargazerCount", 0),
    }


def visibility(owner: str, name: str) -> dict:
    """Return {"exists": bool, "visibility": "PUBLIC"|"PRIVATE"|None, "error": str|None}.

    Cheaper than repo_info; used for at-a-glance scanning.
    """
    code, out, err = _run_gh(
        ["repo", "view", f"{owner}/{name}", "--json", "visibility,isArchived"],
        timeout=12.0,
    )
    if code != 0:
        msg = (err or out).strip()
        lower = msg.lower()
        if "not found" in lower or "could not resolve" in lower:
            return {"exists": False, "visibility": None, "error": None}
        return {"exists": None, "visibility": None, "error": msg or None}
    try:
        data = json.loads(out)
    except json.JSONDecodeError:
        return {"exists": True, "visibility": None, "error": "bad JSON from gh"}
    return {
        "exists": True,
        "visibility": data.get("visibility"),
        "isArchived": bool(data.get("isArchived")),
        "error": None,
    }


def visibility_batch(pairs: list[tuple[str, str]], max_workers: int = 8) -> dict[tuple[str, str], dict]:
    """Concurrently fetch visibility for many (owner, name) pairs. Dedupes input."""
    uniq = list(dict.fromkeys(pairs))
    results: dict[tuple[str, str], dict] = {}
    if not uniq:
        return results
    with ThreadPoolExecutor(max_workers=max_workers) as pool:
        futures = {pool.submit(visibility, o, n): (o, n) for o, n in uniq}
        for fut in as_completed(futures):
            key = futures[fut]
            try:
                results[key] = fut.result()
            except Exception as e:
                results[key] = {"exists": None, "visibility": None, "error": str(e)}
    return results


def create_repo(
    name: str,
    *,
    owner: str | None = None,
    description: str | None = None,
    is_private: bool = True,
    default_branch: str | None = None,
    add_readme: bool = False,
    gitignore: str | None = None,
    license_key: str | None = None,
) -> dict:
    """Create a GitHub repo via `gh repo create`. Returns {"ok": bool, "url"|"error": ...}.

    Does NOT wire up any local git remote — the caller does that once the
    repo exists so we can surface richer errors (e.g. origin already set).
    """
    if not name or not re.match(r"^[A-Za-z0-9._-]+$", name):
        return {"ok": False, "error": f"Invalid repo name: {name!r}"}

    target = f"{owner}/{name}" if owner else name
    args = [
        "repo", "create", target,
        "--private" if is_private else "--public",
    ]
    if description:
        args += ["--description", description]
    if add_readme:
        args.append("--add-readme")
    if gitignore:
        args += ["--gitignore", gitignore]
    if license_key:
        args += ["--license", license_key]

    code, out, err = _run_gh(args, timeout=30.0)
    if code != 0:
        return {"ok": False, "error": (err or out).strip() or "gh repo create failed"}

    # gh prints the new repo URL on success (typically the last non-empty line).
    url = ""
    for line in reversed(out.splitlines()):
        line = line.strip()
        if line.startswith("https://") or line.startswith("http://"):
            url = line
            break
    if not url:
        # Fallback: resolve via `gh repo view`.
        resolved = _run_gh(
            ["repo", "view", target, "--json", "url", "--jq", ".url"],
            timeout=10.0,
        )
        if resolved[0] == 0:
            url = resolved[1].strip()

    result = {"ok": True, "url": url or None, "name": name, "owner": owner}
    if default_branch and default_branch not in ("", "main"):
        # Best-effort default branch rename on the new repo (only matters when
        # gh created it with a README/gitignore and thus a commit exists).
        _run_gh(
            ["repo", "edit", target, "--default-branch", default_branch],
            timeout=10.0,
        )
    return result


def set_visibility(owner: str, name: str, new_visibility: str) -> dict:
    vis = new_visibility.lower()
    if vis not in ("public", "private", "internal"):
        return {"ok": False, "error": f"invalid visibility: {new_visibility!r}"}
    code, out, err = _run_gh(
        [
            "repo", "edit", f"{owner}/{name}",
            "--visibility", vis,
            "--accept-visibility-change-consequences",
        ],
        timeout=20.0,
    )
    if code != 0:
        return {"ok": False, "error": (err or out).strip() or "gh repo edit failed"}
    return {"ok": True, "visibility": vis.upper()}


def current_login() -> str | None:
    code, out, _ = _run_gh(["api", "user", "--jq", ".login"], timeout=10.0)
    return out.strip() if code == 0 and out.strip() else None


def open_prs(owner: str, name: str, limit: int = 10) -> list[dict]:
    code, out, err = _run_gh(
        [
            "pr", "list",
            "--repo", f"{owner}/{name}",
            "--state", "open",
            "--limit", str(limit),
            "--json", "number,title,author,isDraft,createdAt,url,headRefName",
        ],
        timeout=15.0,
    )
    if code != 0:
        return []
    try:
        data = json.loads(out)
    except json.JSONDecodeError:
        return []
    prs = []
    for pr in data:
        author = pr.get("author") or {}
        prs.append({
            "number": pr.get("number"),
            "title": pr.get("title"),
            "author": author.get("login") if isinstance(author, dict) else None,
            "isDraft": pr.get("isDraft", False),
            "createdAt": pr.get("createdAt"),
            "url": pr.get("url"),
            "headRefName": pr.get("headRefName"),
        })
    return prs
