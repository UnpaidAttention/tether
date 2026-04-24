from __future__ import annotations

import os
import signal
import threading
from concurrent.futures import ThreadPoolExecutor
from contextlib import asynccontextmanager
from dataclasses import dataclass, field
from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from . import activity, github, repo, store
from .scanner import RepoEntry, classify_path, scan

ROOT_DIR = os.environ.get("TETHER_ROOT", os.path.expanduser("~"))
FRONTEND_DIR = Path(__file__).resolve().parent.parent / "frontend"

app: "FastAPI"  # forward decl for lifespan


# --- Enrichment model ----------------------------------------------


@dataclass
class GithubRemoteLink:
    remote_name: str
    owner: str
    repo_name: str
    fetch_url: str
    visibility: str | None = None        # "PUBLIC" / "PRIVATE" / "INTERNAL" / None
    exists: bool | None = None            # None = unknown
    is_archived: bool = False
    lookup_error: str | None = None

    def to_dict(self) -> dict:
        return {
            "remoteName": self.remote_name,
            "owner": self.owner,
            "repo": self.repo_name,
            "fetchUrl": self.fetch_url,
            "visibility": self.visibility,
            "exists": self.exists,
            "isArchived": self.is_archived,
            "lookupError": self.lookup_error,
        }


@dataclass
class RepoEnrichment:
    remote_count: int = 0
    dirty: bool = False
    changed_files: int = 0
    current_branch: str | None = None
    github_remotes: list[GithubRemoteLink] = field(default_factory=list)
    visibility_summary: str = "none"      # none | private | public | mixed | unknown
    sensitive: bool = False
    url_changes: dict[str, dict] = field(default_factory=dict)
    name_mismatch: bool = False           # any gh remote's repo name ≠ folder name

    def to_dict(self) -> dict:
        return {
            "remoteCount": self.remote_count,
            "dirty": self.dirty,
            "changedFiles": self.changed_files,
            "currentBranch": self.current_branch,
            "githubRemotes": [g.to_dict() for g in self.github_remotes],
            "visibilitySummary": self.visibility_summary,
            "sensitive": self.sensitive,
            "urlChanges": self.url_changes,
            "nameMismatch": self.name_mismatch,
        }


_REPOS: dict[str, RepoEntry] = {}
_ENRICH: dict[str, RepoEnrichment] = {}
_LOCK = threading.Lock()


# --- Scan + enrichment --------------------------------------------


def _enrich_one(entry: RepoEntry) -> tuple[str, list[tuple[str, str]], list[GithubRemoteLink], bool, int, str | None]:
    """Cheap per-repo work safe to run in a thread: remotes + status + folder name."""
    try:
        remote_list = repo.remotes(entry.path)
    except repo.GitError:
        remote_list = []

    remote_pairs = [(r.name, r.fetch_url) for r in remote_list]

    gh_links: list[GithubRemoteLink] = []
    folder = os.path.basename(entry.path)
    name_mismatch = False

    for r in remote_list:
        parsed = github.parse_owner_repo(r.fetch_url)
        if not parsed:
            continue
        owner, name = parsed
        gh_links.append(GithubRemoteLink(
            remote_name=r.name,
            owner=owner,
            repo_name=name,
            fetch_url=r.fetch_url,
        ))
        if name.lower() != folder.lower():
            name_mismatch = True

    try:
        status = repo.status_summary(entry.path)
        dirty = bool(status.get("dirty"))
        changed_files = int(status.get("changedFiles") or 0)
    except Exception:
        dirty = False
        changed_files = 0

    current = repo.default_branch(entry.path)

    return entry.id, remote_pairs, gh_links, dirty, changed_files, current


def _rescan() -> list[RepoEntry]:
    with _LOCK:
        entries = scan(ROOT_DIR, extra_paths=store.custom_paths())
        _REPOS.clear()
        for r in entries:
            _REPOS[r.id] = r

    sensitive_paths = store.all_sensitive()

    # Phase 1: per-repo git work (remotes, status) in parallel.
    per_repo_work: dict[str, tuple[list[tuple[str, str]], list[GithubRemoteLink], bool, int, str | None]] = {}
    with ThreadPoolExecutor(max_workers=8) as pool:
        for rid, pairs, gh_links, dirty, changed, current in pool.map(_enrich_one, entries):
            per_repo_work[rid] = (pairs, gh_links, dirty, changed, current)

    # Phase 2: record URL changes + collect unique GitHub lookups.
    url_changes_per_repo: dict[str, dict] = {}
    github_pairs_needed: set[tuple[str, str]] = set()
    for entry in entries:
        pairs, gh_links, _, _, _ = per_repo_work[entry.id]
        diffs = store.record_remotes(entry.path, pairs)
        changed = {k: v for k, v in diffs.items() if v.get("changed")}
        url_changes_per_repo[entry.id] = changed
        # Emit an activity event for every URL change we detect (this is
        # distinct from a user-initiated edit-URL — it surfaces drift).
        for remote_name, info in changed.items():
            activity.log_event(
                activity.KIND_REMOTE_URL_DETECTED_CHANGE,
                repo_path=entry.path,
                repo_id=entry.id,
                repo_name=entry.name,
                details={
                    "remoteName": remote_name,
                    "previousUrl": info.get("previousUrl"),
                    "previousSeenAt": info.get("previousSeenAt"),
                    "currentUrl": next((u for n, u in pairs if n == remote_name), None),
                },
            )
        for link in gh_links:
            github_pairs_needed.add((link.owner, link.repo_name))

    # Phase 3: concurrently fetch visibility for every unique github repo.
    visibility_map: dict[tuple[str, str], dict] = {}
    if github.gh_available() and github_pairs_needed:
        visibility_map = github.visibility_batch(list(github_pairs_needed))

    # Phase 4: build enrichment objects.
    with _LOCK:
        _ENRICH.clear()
        for entry in entries:
            pairs, gh_links, dirty, changed_files, current = per_repo_work[entry.id]
            # Attach visibility to each github link.
            for link in gh_links:
                v = visibility_map.get((link.owner, link.repo_name)) or {}
                link.visibility = v.get("visibility")
                link.exists = v.get("exists")
                link.is_archived = bool(v.get("isArchived"))
                link.lookup_error = v.get("error")

            summary = _summarize_visibility(gh_links, github.gh_available())
            name_mismatch = any(
                link.repo_name.lower() != os.path.basename(entry.path).lower()
                for link in gh_links
                if link.exists is not False
            )
            _ENRICH[entry.id] = RepoEnrichment(
                remote_count=len(pairs),
                dirty=dirty,
                changed_files=changed_files,
                current_branch=current,
                github_remotes=gh_links,
                visibility_summary=summary,
                sensitive=entry.path in sensitive_paths,
                url_changes=url_changes_per_repo.get(entry.id, {}),
                name_mismatch=name_mismatch,
            )
    return entries


def _summarize_visibility(gh_links: list[GithubRemoteLink], gh_ok: bool) -> str:
    if not gh_links:
        return "none"
    if not gh_ok:
        return "unknown"
    visibilities = {link.visibility for link in gh_links}
    if None in visibilities:
        # Some lookup failed — treat as unknown so the UI stays cautious.
        return "unknown"
    if len(visibilities) == 1:
        only = next(iter(visibilities))
        if only == "PUBLIC":
            return "public"
        if only == "PRIVATE":
            return "private"
        if only == "INTERNAL":
            return "private"  # from an end-user standpoint, internal is "not world-readable"
        return "unknown"
    return "mixed"


def _enriched_entry(entry: RepoEntry) -> dict:
    enr = _ENRICH.get(entry.id)
    base = entry.to_dict()
    base["enrichment"] = enr.to_dict() if enr else None
    return base


def _get(repo_id: str) -> RepoEntry:
    with _LOCK:
        entry = _REPOS.get(repo_id)
    if entry is None:
        raise HTTPException(status_code=404, detail="repo not found (try rescan)")
    return entry


@asynccontextmanager
async def lifespan(_app: FastAPI):
    _rescan()
    yield


app = FastAPI(title="Tether", version="0.2.0", lifespan=lifespan)


# --- Meta / auth ---------------------------------------------------


@app.get("/api/meta")
def meta() -> dict:
    return {
        "root": ROOT_DIR,
        "repoCount": len(_REPOS),
        "gh": github.auth_status(),
    }


@app.post("/api/gh/recheck")
def recheck_gh() -> dict:
    return github.auth_status()


@app.post("/api/rescan")
def rescan() -> dict:
    entries = _rescan()
    with _LOCK:
        payload = [_enriched_entry(e) for e in entries]
    return {"count": len(payload), "repos": payload}


# --- Repo list / detail -------------------------------------------


@app.get("/api/repos")
def list_repos() -> dict:
    with _LOCK:
        items = [_enriched_entry(r) for r in _REPOS.values()]
    items.sort(key=lambda r: r["path"].lower())
    return {"count": len(items), "repos": items}


@app.get("/api/repos/{repo_id}")
def repo_detail(repo_id: str) -> dict:
    entry = _get(repo_id)
    try:
        remotes = [r.to_dict() for r in repo.remotes(entry.path)]
    except repo.GitError as e:
        raise HTTPException(status_code=500, detail=str(e))
    try:
        branches = [b.to_dict() for b in repo.branches(entry.path)]
    except repo.GitError:
        branches = []
    status = repo.status_summary(entry.path)
    default = repo.default_branch(entry.path)
    with _LOCK:
        enr = _ENRICH.get(repo_id)
    return {
        **entry.to_dict(),
        "remotes": remotes,
        "branches": branches,
        "status": status,
        "defaultBranch": default,
        "enrichment": enr.to_dict() if enr else None,
    }


# --- Remote mutations ---------------------------------------------


class RemoteCreate(BaseModel):
    name: str = Field(min_length=1, max_length=64)
    url: str = Field(min_length=1, max_length=2048)


class RemoteUrlUpdate(BaseModel):
    url: str = Field(min_length=1, max_length=2048)
    push: bool = False


class RemoteRename(BaseModel):
    newName: str = Field(min_length=1, max_length=64)


def _refresh_single(entry: RepoEntry) -> None:
    """Cheap re-enrichment of one repo after a mutation."""
    try:
        remote_list = repo.remotes(entry.path)
    except repo.GitError:
        remote_list = []
    pairs = [(r.name, r.fetch_url) for r in remote_list]
    diffs = store.record_remotes(entry.path, pairs)
    url_changes = {k: v for k, v in diffs.items() if v.get("changed")}

    gh_links: list[GithubRemoteLink] = []
    for r in remote_list:
        parsed = github.parse_owner_repo(r.fetch_url)
        if not parsed:
            continue
        owner, name = parsed
        gh_links.append(GithubRemoteLink(
            remote_name=r.name,
            owner=owner,
            repo_name=name,
            fetch_url=r.fetch_url,
        ))

    vis_map = {}
    if github.gh_available() and gh_links:
        vis_map = github.visibility_batch([(l.owner, l.repo_name) for l in gh_links])
    for link in gh_links:
        v = vis_map.get((link.owner, link.repo_name)) or {}
        link.visibility = v.get("visibility")
        link.exists = v.get("exists")
        link.is_archived = bool(v.get("isArchived"))
        link.lookup_error = v.get("error")

    status = repo.status_summary(entry.path)
    current = repo.default_branch(entry.path)
    folder = os.path.basename(entry.path)
    sensitive_paths = store.all_sensitive()

    with _LOCK:
        _ENRICH[entry.id] = RepoEnrichment(
            remote_count=len(pairs),
            dirty=bool(status.get("dirty")),
            changed_files=int(status.get("changedFiles") or 0),
            current_branch=current,
            github_remotes=gh_links,
            visibility_summary=_summarize_visibility(gh_links, github.gh_available()),
            sensitive=entry.path in sensitive_paths,
            url_changes=url_changes,
            name_mismatch=any(
                l.repo_name.lower() != folder.lower() for l in gh_links if l.exists is not False
            ),
        )


@app.post("/api/repos/{repo_id}/remotes")
def add_remote(repo_id: str, body: RemoteCreate) -> dict:
    entry = _get(repo_id)
    try:
        repo.add_remote(entry.path, body.name, body.url)
    except repo.GitError as e:
        raise HTTPException(status_code=400, detail=str(e))
    activity.log_event(
        activity.KIND_REMOTE_ADDED,
        repo_path=entry.path, repo_id=entry.id, repo_name=entry.name,
        details={"remoteName": body.name, "url": body.url},
    )
    _refresh_single(entry)
    return {"ok": True, "remotes": [r.to_dict() for r in repo.remotes(entry.path)]}


@app.delete("/api/repos/{repo_id}/remotes/{name}")
def delete_remote(repo_id: str, name: str) -> dict:
    entry = _get(repo_id)
    # Capture the URL before we remove it, for forensic value.
    try:
        prior = next((r for r in repo.remotes(entry.path) if r.name == name), None)
    except repo.GitError:
        prior = None
    try:
        repo.remove_remote(entry.path, name)
    except repo.GitError as e:
        raise HTTPException(status_code=400, detail=str(e))
    activity.log_event(
        activity.KIND_REMOTE_REMOVED,
        repo_path=entry.path, repo_id=entry.id, repo_name=entry.name,
        details={"remoteName": name, "url": prior.fetch_url if prior else None},
    )
    _refresh_single(entry)
    return {"ok": True, "remotes": [r.to_dict() for r in repo.remotes(entry.path)]}


@app.patch("/api/repos/{repo_id}/remotes/{name}/url")
def update_remote_url(repo_id: str, name: str, body: RemoteUrlUpdate) -> dict:
    entry = _get(repo_id)
    prior_url = None
    try:
        prior_url = next((r.fetch_url for r in repo.remotes(entry.path) if r.name == name), None)
    except repo.GitError:
        pass
    try:
        repo.set_remote_url(entry.path, name, body.url, push=body.push)
    except repo.GitError as e:
        raise HTTPException(status_code=400, detail=str(e))
    activity.log_event(
        activity.KIND_REMOTE_URL_CHANGED,
        repo_path=entry.path, repo_id=entry.id, repo_name=entry.name,
        details={
            "remoteName": name,
            "previousUrl": prior_url,
            "newUrl": body.url,
            "pushOnly": body.push,
        },
    )
    _refresh_single(entry)
    return {"ok": True, "remotes": [r.to_dict() for r in repo.remotes(entry.path)]}


@app.post("/api/repos/{repo_id}/remotes/{name}/rename")
def do_rename_remote(repo_id: str, name: str, body: RemoteRename) -> dict:
    entry = _get(repo_id)
    try:
        repo.rename_remote(entry.path, name, body.newName)
    except repo.GitError as e:
        raise HTTPException(status_code=400, detail=str(e))
    activity.log_event(
        activity.KIND_REMOTE_RENAMED,
        repo_path=entry.path, repo_id=entry.id, repo_name=entry.name,
        details={"oldName": name, "newName": body.newName},
    )
    _refresh_single(entry)
    return {"ok": True, "remotes": [r.to_dict() for r in repo.remotes(entry.path)]}


# --- Sensitive flag -----------------------------------------------


class SensitiveBody(BaseModel):
    value: bool


@app.post("/api/repos/{repo_id}/sensitive")
def set_sensitive(repo_id: str, body: SensitiveBody) -> dict:
    entry = _get(repo_id)
    store.set_sensitive(entry.path, body.value)
    activity.log_event(
        activity.KIND_SENSITIVE_MARKED if body.value else activity.KIND_SENSITIVE_UNMARKED,
        repo_path=entry.path, repo_id=entry.id, repo_name=entry.name,
        details={},
    )
    _refresh_single(entry)
    return {"ok": True, "sensitive": body.value}


# --- Fetch / Pull / Push ------------------------------------------


class FetchBody(BaseModel):
    remote: str | None = None
    prune: bool = True


@app.post("/api/repos/{repo_id}/fetch")
def do_fetch(repo_id: str, body: FetchBody | None = None) -> dict:
    entry = _get(repo_id)
    body = body or FetchBody()
    try:
        out = repo.fetch(entry.path, body.remote, prune=body.prune)
    except repo.GitError as e:
        raise HTTPException(status_code=400, detail=str(e))
    return {"ok": True, "output": out}


class PullBody(BaseModel):
    remote: str | None = None
    branch: str | None = None


@app.post("/api/repos/{repo_id}/pull")
def do_pull(repo_id: str, body: PullBody | None = None) -> dict:
    entry = _get(repo_id)
    body = body or PullBody()
    try:
        out = repo.pull(entry.path, body.remote, body.branch)
    except repo.GitError as e:
        raise HTTPException(status_code=400, detail=str(e))
    return {"ok": True, "output": out}


class PushBody(BaseModel):
    remote: str
    branch: str
    setUpstream: bool = False
    acknowledgePublic: bool = False


@app.post("/api/repos/{repo_id}/push")
def do_push(repo_id: str, body: PushBody) -> dict:
    entry = _get(repo_id)
    with _LOCK:
        enr = _ENRICH.get(repo_id)
    link = None
    if enr:
        link = next((l for l in enr.github_remotes if l.remote_name == body.remote), None)
    # Safety gate: refuse to push to a PUBLIC remote unless the client
    # explicitly acknowledged it (frontend does this after the retype prompt).
    if link and link.visibility == "PUBLIC" and not body.acknowledgePublic:
        raise HTTPException(
            status_code=409,
            detail=(
                "PUBLIC_PUSH_NOT_ACKNOWLEDGED: pushing to a public GitHub repo "
                "requires explicit acknowledgement from the client."
            ),
        )
    try:
        out = repo.push(entry.path, body.remote, body.branch, set_upstream=body.setUpstream)
    except repo.GitError as e:
        raise HTTPException(status_code=400, detail=str(e))
    activity.log_event(
        activity.KIND_PUSH,
        repo_path=entry.path, repo_id=entry.id, repo_name=entry.name,
        details={
            "remoteName": body.remote,
            "branch": body.branch,
            "setUpstream": body.setUpstream,
            "isPublic": bool(link and link.visibility == "PUBLIC"),
            "target": f"{link.owner}/{link.repo_name}" if link else None,
        },
    )
    return {"ok": True, "output": out}


# --- GitHub integration --------------------------------------------


@app.get("/api/repos/{repo_id}/github")
def github_info(repo_id: str) -> dict:
    entry = _get(repo_id)
    if not github.gh_available():
        return {"available": False, "remotes": []}

    results = []
    try:
        remotes_list = repo.remotes(entry.path)
    except repo.GitError:
        remotes_list = []

    for r in remotes_list:
        parsed = github.parse_owner_repo(r.fetch_url)
        if not parsed:
            continue
        owner, name = parsed
        info = github.repo_info(owner, name)
        prs = github.open_prs(owner, name) if info.get("exists") else []
        results.append({
            "remoteName": r.name,
            "owner": owner,
            "repo": name,
            "info": info,
            "openPRs": prs,
        })
    return {"available": True, "remotes": results}


class GithubCreateBody(BaseModel):
    name: str = Field(min_length=1, max_length=100)
    owner: str | None = None                    # default: authenticated user
    description: str | None = None
    private: bool = True
    defaultBranch: str | None = None
    addReadme: bool = False
    gitignore: str | None = None
    license: str | None = None
    remoteName: str = Field(default="origin", min_length=1, max_length=64)


@app.post("/api/repos/{repo_id}/github/create")
def github_create_for_repo(repo_id: str, body: GithubCreateBody) -> dict:
    entry = _get(repo_id)
    if not github.gh_available():
        raise HTTPException(status_code=400, detail="gh CLI not installed")

    # Guardrail: refuse to overwrite an existing remote by the same name.
    try:
        existing = {r.name: r for r in repo.remotes(entry.path)}
    except repo.GitError as e:
        raise HTTPException(status_code=500, detail=str(e))
    if body.remoteName in existing:
        raise HTTPException(
            status_code=409,
            detail=(
                f"Remote {body.remoteName!r} already exists on this repo "
                f"({existing[body.remoteName].fetch_url}). Rename or remove it first."
            ),
        )

    result = github.create_repo(
        body.name,
        owner=body.owner,
        description=body.description,
        is_private=body.private,
        default_branch=body.defaultBranch,
        add_readme=body.addReadme,
        gitignore=body.gitignore,
        license_key=body.license,
    )
    if not result.get("ok"):
        raise HTTPException(status_code=400, detail=result.get("error") or "gh repo create failed")

    # Wire up the remote. Prefer SSH URL if we can guess one; fall back to
    # whatever gh returned.
    url = result.get("url") or ""
    owner = body.owner or github.current_login() or ""
    ssh_url = f"git@github.com:{owner}/{body.name}.git" if owner else ""
    wire_url = ssh_url or url
    if not wire_url:
        raise HTTPException(
            status_code=500,
            detail="Repo was created but no URL was returned — wire it manually.",
        )

    try:
        repo.add_remote(entry.path, body.remoteName, wire_url)
    except repo.GitError as e:
        raise HTTPException(
            status_code=500,
            detail=(
                f"Repo was created at {url} but wiring the local remote failed: {e}. "
                "Add the remote manually."
            ),
        )

    activity.log_event(
        activity.KIND_GITHUB_REPO_CREATED,
        repo_path=entry.path, repo_id=entry.id, repo_name=entry.name,
        details={
            "owner": owner,
            "name": body.name,
            "url": url,
            "remoteUrl": wire_url,
            "remoteName": body.remoteName,
            "private": body.private,
        },
    )
    _refresh_single(entry)
    return {
        "ok": True,
        "url": url,
        "remoteUrl": wire_url,
        "owner": owner,
        "name": body.name,
        "private": body.private,
    }


class VisibilityBody(BaseModel):
    visibility: str = Field(pattern=r"^(public|private|internal)$")
    acknowledge: bool = False


@app.patch("/api/repos/{repo_id}/github/{remote_name}/visibility")
def set_github_visibility(repo_id: str, remote_name: str, body: VisibilityBody) -> dict:
    entry = _get(repo_id)
    with _LOCK:
        enr = _ENRICH.get(repo_id)
    link = None
    if enr:
        link = next((l for l in enr.github_remotes if l.remote_name == remote_name), None)
    if not link:
        raise HTTPException(status_code=404, detail=f"no GitHub remote named {remote_name!r}")
    # Require explicit acknowledgement when going public.
    if body.visibility == "public" and not body.acknowledge:
        raise HTTPException(
            status_code=409,
            detail="PUBLIC_VISIBILITY_NOT_ACKNOWLEDGED",
        )
    previous = link.visibility
    result = github.set_visibility(link.owner, link.repo_name, body.visibility)
    if not result.get("ok"):
        raise HTTPException(status_code=400, detail=result.get("error") or "set visibility failed")
    activity.log_event(
        activity.KIND_GITHUB_VISIBILITY_CHANGED,
        repo_path=entry.path, repo_id=entry.id, repo_name=entry.name,
        details={
            "remoteName": remote_name,
            "owner": link.owner,
            "name": link.repo_name,
            "previous": previous,
            "current": result.get("visibility"),
        },
    )
    _refresh_single(entry)
    return result


# --- Safety audit --------------------------------------------------


@app.get("/api/audit")
def audit() -> dict:
    """Bird's-eye safety view. Reads current enrichment; does not re-scan."""
    with _LOCK:
        snapshot = [(e, _ENRICH.get(e.id)) for e in _REPOS.values()]

    public_exposure = []        # any remote is public
    mixed_remotes = []          # multiple owners across remotes
    name_mismatch = []          # folder name vs. remote repo name
    url_changes = []            # URL changed since last scan
    sensitive_public = []       # marked sensitive AND has public remote
    unknown = []                # couldn't determine (lookup failed)
    not_found = []              # remote points to a repo gh can't find

    def mini(entry: RepoEntry, enr: RepoEnrichment) -> dict:
        return {
            "id": entry.id,
            "name": entry.name,
            "path": entry.path,
            "sensitive": enr.sensitive if enr else False,
            "visibilitySummary": enr.visibility_summary if enr else "unknown",
        }

    for entry, enr in snapshot:
        if not enr:
            continue
        if any(l.visibility == "PUBLIC" for l in enr.github_remotes):
            public_exposure.append(mini(entry, enr))
        if enr.sensitive and any(l.visibility == "PUBLIC" for l in enr.github_remotes):
            sensitive_public.append(mini(entry, enr))
        owners = {l.owner.lower() for l in enr.github_remotes if l.exists is not False}
        if len(owners) > 1:
            mixed_remotes.append({
                **mini(entry, enr),
                "owners": sorted(owners),
            })
        if enr.name_mismatch:
            first = next((l for l in enr.github_remotes if l.exists is not False), None)
            name_mismatch.append({
                **mini(entry, enr),
                "remoteRepoName": first.repo_name if first else None,
            })
        if enr.url_changes:
            url_changes.append({
                **mini(entry, enr),
                "changes": enr.url_changes,
            })
        if enr.visibility_summary == "unknown" and enr.github_remotes:
            unknown.append(mini(entry, enr))
        if any(l.exists is False for l in enr.github_remotes):
            not_found.append({
                **mini(entry, enr),
                "missingRemotes": [
                    {"name": l.remote_name, "owner": l.owner, "repo": l.repo_name}
                    for l in enr.github_remotes if l.exists is False
                ],
            })

    total = len(snapshot)
    return {
        "totalRepos": total,
        "publicExposure": public_exposure,
        "sensitivePublic": sensitive_public,
        "mixedRemotes": mixed_remotes,
        "nameMismatch": name_mismatch,
        "urlChanges": url_changes,
        "unknown": unknown,
        "notFound": not_found,
    }


# --- Project (local directory) management -------------------------


def _expand_user_path(raw: str) -> str:
    return os.path.realpath(os.path.expanduser(raw))


@app.get("/api/projects/detect")
def detect_project(path: str) -> dict:
    """Live-evaluate a path so the frontend can show contextual next steps."""
    raw = (path or "").strip()
    if not raw:
        return {
            "raw": raw, "path": "", "exists": False, "isDirectory": False,
            "isGitRepo": False, "isBare": False, "alreadyTracked": False,
            "repoId": None, "underScanRoot": False,
            "suggestion": "empty",
        }
    resolved = _expand_user_path(raw)
    info = classify_path(resolved)
    under_root = False
    try:
        under_root = os.path.commonpath([resolved, ROOT_DIR]) == ROOT_DIR
    except ValueError:
        under_root = False

    with _LOCK:
        tracked_entry = next((e for e in _REPOS.values() if e.path == info["path"]), None)

    already_tracked = tracked_entry is not None

    # Decide the single best suggestion for the UI button.
    if not info["exists"]:
        suggestion = "notFound"
    elif not info["isDirectory"]:
        suggestion = "notDirectory"
    elif already_tracked:
        suggestion = "jumpTo"
    elif info["isGitRepo"]:
        suggestion = "addExistingRepo"
    else:
        suggestion = "initAndAdd"

    return {
        "raw": raw,
        "path": info["path"],
        "exists": info["exists"],
        "isDirectory": info["isDirectory"],
        "isGitRepo": info["isGitRepo"],
        "isBare": info["isBare"],
        "alreadyTracked": already_tracked,
        "repoId": tracked_entry.id if tracked_entry else None,
        "underScanRoot": under_root,
        "suggestion": suggestion,
    }


class AddProjectBody(BaseModel):
    path: str = Field(min_length=1, max_length=4096)
    initGit: bool = False


@app.post("/api/projects/add")
def add_project(body: AddProjectBody) -> dict:
    resolved = _expand_user_path(body.path)
    info = classify_path(resolved)

    if not info["exists"]:
        raise HTTPException(status_code=400, detail=f"Path not found: {resolved}")
    if not info["isDirectory"]:
        raise HTTPException(status_code=400, detail=f"Not a directory: {resolved}")

    was_initialized = False
    if not info["isGitRepo"]:
        if not body.initGit:
            raise HTTPException(
                status_code=409,
                detail="NOT_A_GIT_REPO: pass initGit:true to `git init` this directory first.",
            )
        try:
            # git init in the directory — reuse the same subprocess wrapper
            # pattern as the rest of the backend.
            import subprocess
            proc = subprocess.run(
                ["git", "init", "--quiet", resolved],
                capture_output=True, text=True, timeout=15.0,
            )
            if proc.returncode != 0:
                raise HTTPException(
                    status_code=500,
                    detail=f"git init failed: {(proc.stderr or proc.stdout).strip()}",
                )
            was_initialized = True
            info = classify_path(resolved)
        except subprocess.TimeoutExpired as e:
            raise HTTPException(status_code=500, detail="git init timed out") from e

    try:
        under_root = os.path.commonpath([resolved, ROOT_DIR]) == ROOT_DIR
    except ValueError:
        under_root = False

    newly_custom = False
    if not under_root:
        # Persist so future rescans still see it.
        newly_custom = store.add_custom_path(resolved)

    # Update in-memory state immediately, then re-enrich that single repo so
    # the sidebar has current info without a full rescan.
    with _LOCK:
        existing = next((e for e in _REPOS.values() if e.path == resolved), None)
        if existing is None:
            from .scanner import _entry_from_path
            entry = _entry_from_path(resolved)
            if entry is None:
                raise HTTPException(
                    status_code=500,
                    detail="Unexpected: directory isn't a git repo after add.",
                )
            _REPOS[entry.id] = entry
        else:
            entry = existing

    _refresh_single(entry)

    activity.log_event(
        "project.added",
        repo_path=entry.path, repo_id=entry.id, repo_name=entry.name,
        details={
            "wasInitialized": was_initialized,
            "underScanRoot": under_root,
            "persistedAsCustomPath": newly_custom,
        },
    )

    return {
        "ok": True,
        "repo": _enriched_entry(entry),
        "wasInitialized": was_initialized,
        "underScanRoot": under_root,
        "persistedAsCustomPath": newly_custom,
        "alreadyTracked": existing is not None,
    }


# --- Activity log --------------------------------------------------


@app.get("/api/activity")
def get_activity(limit: int = 200, before: str | None = None) -> dict:
    events = activity.list_events(limit=limit, before=before)
    return {"count": len(events), "events": events}


@app.get("/api/repos/{repo_id}/activity")
def get_repo_activity(repo_id: str, limit: int = 200, before: str | None = None) -> dict:
    entry = _get(repo_id)
    events = activity.list_events(repo_id=repo_id, limit=limit, before=before)
    # Fallback: if nothing matches by id (e.g. older entries from before the id
    # existed), also include entries matched by path.
    if not events:
        events = activity.list_events(repo_path=entry.path, limit=limit, before=before)
    return {"count": len(events), "events": events}


# --- Server control ------------------------------------------------


@app.post("/api/quit")
def quit_server() -> dict:
    def _stop():
        os.kill(os.getpid(), signal.SIGTERM)

    threading.Timer(0.25, _stop).start()
    return {"ok": True, "message": "shutting down"}


# --- Static frontend (mounted last) --------------------------------


@app.get("/")
def index():
    return FileResponse(FRONTEND_DIR / "index.html")


app.mount("/static", StaticFiles(directory=FRONTEND_DIR), name="static")


def main() -> None:
    import uvicorn

    host = os.environ.get("TETHER_HOST", "127.0.0.1")
    port = int(os.environ.get("TETHER_PORT", "7733"))
    # Access log is useful for auditing mutations; we keep the noise level
    # moderate (access at INFO, app at WARNING) so real problems stay visible.
    uvicorn.run(
        "backend.main:app",
        host=host,
        port=port,
        log_level="info",
        access_log=True,
    )


if __name__ == "__main__":
    main()
