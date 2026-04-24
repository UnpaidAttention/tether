# Tether

**A local desktop app for seeing which GitHub repo every local project is actually wired to — and catching visibility mistakes before they become leaks.**

Tether walks your home directory, finds every `.git` folder, and gives you a single pane where you can see remote connections, branch tracking, and GitHub visibility at a glance. It was built specifically to answer the question: *"Is this private project I'm about to push actually connected to a private repo?"*

No cloud. No telemetry. Runs as a local FastAPI server on `localhost:7733` with a `.desktop` launcher so it opens like any other Linux app.

---

## Why

If you juggle both public OSS work and private projects (e.g. a SaaS you're building), it's alarmingly easy to end up with the wrong remote wired to a local directory — especially if you've renamed, forked, or recreated repos. A push that should have gone to a private repo can end up world-readable before you notice.

Tether makes that mistake hard to make:

- Every repo in the sidebar shows a colored visibility pill: **public / private / mixed / no remote**.
- Opening a repo with a public remote surfaces a prominent safety banner at the top of the detail view.
- Pushing to a public remote for the first time requires **retyping the repo name** to confirm.
- A **Safety audit** dashboard surfaces every risky state across all repos: sensitive-and-public, folder/repo name mismatches, URL changes detected between scans, repos pointing to GitHub repos that `gh` can't find, and more.
- An append-only **Activity** log records every mutation Tether performs, so you can always answer "when did this remote get added / changed / removed?"

---

## Features

### Discover
- Auto-scans every `.git` repo under `$HOME` (configurable)
- Excludes the usual junk (`node_modules`, `.venv`, `target`, `dist`, etc.)
- Add projects outside the scan root; they're remembered in `~/.config/tether/custom-paths.json`
- Add a brand-new project from a plain directory — Tether runs `git init` for you

### See
- Per-repo detail: remotes, local branches with upstream tracking + ahead/behind counts, GitHub repo info (via `gh`)
- Sidebar repo list with live visibility signals (colored dots + pills)
- GitHub tab shows visibility, description, stars, default branch, last push, and open PRs per remote
- "Mark sensitive" per-repo flag — gets a loud warning if any remote is public

### Act
- Add / remove / rename remotes, or change a remote's URL
- Create a new GitHub repo for the current local project and wire it up as `origin` in one flow (defaults to **private**)
- Toggle a GitHub repo's visibility from inside Tether (with a typed-confirmation step when flipping to public)
- Fetch (all + prune), Pull (`--ff-only`), Push — all with access logging
- Pre-push safety gate on public remotes: type the repo name to confirm

### Audit
- **Safety audit** dashboard: sensitive+public, public exposure, URL changes, name mismatches, unknown visibility, 404s from `gh`, mixed-owner remotes
- **Activity** timeline (global and per-repo): remote add/remove/rename/URL change, GitHub repo created, visibility changed, push (public flagged), URL drift detected, sensitive toggled

---

## Requirements

- Linux (tested on Fedora / Nobara). Should work on any modern Linux with Python 3.10+ and a desktop environment.
- `python3` + `git`
- [GitHub CLI](https://cli.github.com/) (`gh`) for visibility reads, PR lists, creating/flipping GitHub repos. Optional but recommended — Tether degrades gracefully without it.

If `gh` isn't installed or signed in, Tether shows a banner at the top with the exact command you need (`gh auth login`) and a "Recheck" button so you don't have to restart the app after signing in.

---

## Quick start

```bash
git clone https://github.com/UnpaidAttention/tether.git ~/tether
cd ~/tether
./install.sh
```

`install.sh` is safe to re-run at any time — it only does work that needs doing. It:

1. Checks that `python3` is at least 3.10 and that the `venv` module is present (fails fast with a clear message otherwise)
2. Creates a Python venv at `.venv/`
3. Installs FastAPI + Uvicorn into it
4. Stamps the `.desktop` entry with the absolute path of your install
5. Drops the desktop entry into `~/.local/share/applications/`
6. Runs `update-desktop-database` so the app menu picks it up

After that, search for **Tether** in your app menu (or run `./launcher/tether.sh` directly). It opens in your default browser.

### Signing in to GitHub

Tether reads whatever account `gh` is signed in as. If you haven't already:

```bash
gh auth login
```

Then click **Recheck** in the Tether banner — no restart needed.

---

## Configuration

Everything is environment-variable driven. Defaults are fine for most people.

| Variable | Default | Meaning |
|---|---|---|
| `TETHER_PORT` | `7733` | Port the local server binds to |
| `TETHER_ROOT` | `$HOME` | Directory to scan for git repos |
| `TETHER_HOST` | `127.0.0.1` | Bind address. **Don't** expose this over the network — there's no auth. |

Override at launch time:

```bash
TETHER_PORT=9999 TETHER_ROOT=/path/to/code ./launcher/tether.sh
```

Custom paths (projects outside the scan root) are persisted in `~/.config/tether/custom-paths.json`. The "Add project" button in the UI manages that file for you.

---

## Files it creates

All under `~/.config/tether/`:

| File | Contents |
|---|---|
| `sensitive.json` | Per-repo "sensitive" flag. Tether shows a loud warning if a sensitive repo has a public remote. |
| `custom-paths.json` | Paths outside `TETHER_ROOT` to include in scans. |
| `remote-history.json` | Remembers each repo's remote URLs; used to flag URL drift between launches. |
| `activity.jsonl` | Append-only log of every mutation Tether has performed. Hand-inspectable. |

Tether also writes a PID + log to `$XDG_RUNTIME_DIR` (or `/tmp`) at `tether-<PORT>.pid` / `tether-<PORT>.log`.

---

## Uninstall

```bash
rm ~/.local/share/applications/tether.desktop
rm -rf ~/tether
rm -rf ~/.config/tether   # if you want to remove state too
```

That's it. No system-wide files, no daemons.

---

## Safety model

Tether is a **local tool**. It talks to your local git repos via the `git` CLI and to GitHub via the `gh` CLI — the same tools you'd use from a terminal. It does not store your credentials or talk to any third party.

Guardrails enforced in code:

- Pushing to a public remote without explicit client acknowledgement returns `409 PUBLIC_PUSH_NOT_ACKNOWLEDGED`. The UI's retype gate is what sends the acknowledgement.
- Flipping a GitHub repo to public requires the same typed-confirmation step.
- "Create GitHub repo" refuses to overwrite an existing remote by the same name — you have to rename or remove the old one first.
- Every mutation is logged to `activity.jsonl` before returning success, so there's always a paper trail.

---

## Architecture

```
tether/
├── backend/
│   ├── main.py        FastAPI app + all endpoints
│   ├── scanner.py     Walks the filesystem, finds .git dirs
│   ├── repo.py        git subprocess wrapper (remotes, branches, fetch, pull, push)
│   ├── github.py      gh CLI wrapper (visibility, PRs, create, edit)
│   ├── store.py       On-disk JSON state (sensitive flag, URL history, custom paths)
│   └── activity.py    Append-only JSONL mutation log
├── frontend/
│   ├── index.html     Shell — a single <main>, populated by JS
│   ├── style.css      Design tokens + component styles
│   ├── app.js         Vanilla JS, no framework, no bundler
│   └── favicon.svg
├── launcher/
│   ├── tether.sh      Single-instance launcher (starts server, opens browser)
│   ├── tether.desktop Template — stamped with install path at install time
│   └── tether.svg     App icon
├── install.sh         Install / reinstall
├── requirements.txt   FastAPI + Uvicorn
└── README.md
```

No build step. Edit `frontend/app.js` or `backend/*.py`, restart Tether, done.

---

## Contributing

Issues and PRs welcome, especially for platform coverage (macOS / BSD launchers, Wayland-specific quirks). The codebase is intentionally small — ~2k lines of Python + ~1k lines of JS — so it's easy to read end-to-end.

---

## License

MIT. See [LICENSE](./LICENSE).

