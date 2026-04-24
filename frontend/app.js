// Tether frontend — single-page vanilla JS (no innerHTML)

const state = {
  repos: [],
  filtered: [],
  selectedId: null,
  activeView: "empty",  // "empty" | "repo" | "audit" | "activity"
  detail: null,
  detailLoading: false,
  activeTab: "remotes",
  query: "",
  gh: { available: false, authenticated: false, user: null },
  root: "~",
  audit: null,
  auditLoading: false,
  activity: null,
  activityLoading: false,
  repoActivity: null,          // per-repo cache, indexed by repo id
  githubCache: new Map(),
};

const $ = (s, r = document) => r.querySelector(s);
const clear = (el) => { while (el.firstChild) el.removeChild(el.firstChild); };

// --- API -----------------------------------------------------------

async function api(path, opts = {}) {
  const res = await fetch(path, {
    headers: { "Content-Type": "application/json" },
    ...opts,
  });
  if (!res.ok) {
    let msg = `${res.status} ${res.statusText}`;
    let code = null;
    try {
      const data = await res.json();
      if (data.detail) {
        msg = data.detail;
        const m = data.detail.match(/^([A-Z_]+): ?(.+)?$/);
        if (m) code = m[1];
      }
    } catch {}
    const err = new Error(msg);
    err.status = res.status;
    err.code = code;
    throw err;
  }
  return res.json();
}

// --- DOM helpers ---------------------------------------------------

function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  applyAttrs(el, attrs);
  appendChildren(el, children);
  return el;
}

function applyAttrs(el, attrs) {
  for (const [k, v] of Object.entries(attrs)) {
    if (v === false || v === null || v === undefined) continue;
    if (k === "class") el.className = v;
    else if (k === "dataset") Object.assign(el.dataset, v);
    else if (k === "style" && typeof v === "object") Object.assign(el.style, v);
    else if (k.startsWith("on") && typeof v === "function") {
      el.addEventListener(k.slice(2).toLowerCase(), v);
    } else {
      el.setAttribute(k, v);
    }
  }
}

function appendChildren(el, children) {
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}

const SVG_NS = "http://www.w3.org/2000/svg";
function svgEl(tag, attrs = {}) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  return el;
}

const ICONS = {
  https: [["circle", { cx: 8, cy: 8, r: 6.5 }], ["path", { d: "M1.5 8h13M8 1.5a10 10 0 0 1 0 13M8 1.5a10 10 0 0 0 0 13" }]],
  ssh: [["path", { d: "M10.5 5.5a3 3 0 1 0-4 2.8V10l-1 1 1 1-1 1 1.5 1.5 1.5-1.5V8.3a3 3 0 0 0 2-2.8Z" }], ["circle", { cx: 10.5, cy: 5.5, r: 0.6, fill: "currentColor" }]],
  local: [["path", { d: "M2 4.5h12v9H2zM2 7h12" }]],
  edit: [["path", { d: "M2 14 5 11l7-7 3 3-7 7-3 0 0-3Z" }]],
  rename: [["path", { d: "m4 2 4 4-6 6v3h3l6-6 4 4" }]],
  trash: [["path", { d: "M3 4h10M6 4V2.5A1 1 0 0 1 7 1.5h2a1 1 0 0 1 1 1V4M5 4l.5 9.5A1 1 0 0 0 6.5 14.5h3a1 1 0 0 0 1-1L11 4" }]],
  copy: [["path", { d: "M4 2h7l3 3v9H4V2Z" }], ["path", { d: "M11 2v3h3" }]],
  download: [["path", { d: "M8 2v9M4 8l4 4 4-4M2 14h12" }]],
  upload: [["path", { d: "M8 13V4M4 7l4-4 4 4M2 14h12" }]],
  external: [["path", { d: "M6 3H3v10h10v-3M9 3h4v4M13 3 7 9" }]],
  plus: [["path", { d: "M8 3v10M3 8h10" }]],
  shield: [["path", { d: "M8 1.5 3 3.5V8c0 3.2 2.1 5.8 5 6.5 2.9-.7 5-3.3 5-6.5V3.5L8 1.5Z" }]],
  warn: [["path", { d: "M8 1.5 14.5 13H1.5L8 1.5Z" }], ["path", { d: "M8 6v3.5M8 11v0.5", "stroke-width": "2" }]],
  star: [["path", { d: "M8 1.5 9.8 6 14.5 6.5 11 9.8 11.9 14.5 8 12.3 4.1 14.5 5 9.8 1.5 6.5 6.2 6 8 1.5Z" }]],
  arrows: [["path", { d: "M3 6h10M10 3l3 3-3 3M13 10H3M6 13l-3-3 3-3" }]],
  eye: [["path", { d: "M1.5 8S4 3 8 3s6.5 5 6.5 5S12 13 8 13 1.5 8 1.5 8Z" }], ["circle", { cx: 8, cy: 8, r: 2 }]],
  activity: [["path", { d: "M2 8h3l1.5-4 3 8 1.5-4h3" }]],
  clock: [["circle", { cx: 8, cy: 8, r: 6.5 }], ["path", { d: "M8 4.5V8l2.5 1.5" }]],
};

function icon(key, size = 14) {
  const defs = ICONS[key];
  const svg = svgEl("svg", {
    viewBox: "0 0 16 16",
    width: String(size),
    height: String(size),
    fill: "none",
    stroke: "currentColor",
    "stroke-width": "1.6",
    "stroke-linecap": "round",
    "stroke-linejoin": "round",
  });
  for (const [tag, attrs] of defs || []) svg.appendChild(svgEl(tag, attrs));
  return svg;
}

function urlIcon(url) {
  if (!url) return icon("local");
  if (url.startsWith("git@") || url.startsWith("ssh://")) return icon("ssh");
  if (url.startsWith("http://") || url.startsWith("https://")) return icon("https");
  return icon("local");
}

// --- Toast ---------------------------------------------------------

function toast(msg, kind = "ok") {
  const root = $("#toast-root");
  const el = h("div", { class: `toast toast--${kind}` }, msg);
  root.appendChild(el);
  requestAnimationFrame(() => el.classList.add("is-visible"));
  setTimeout(() => {
    el.classList.remove("is-visible");
    setTimeout(() => el.remove(), 300);
  }, 3600);
}

// --- Modal system --------------------------------------------------

function openModal(build) {
  const root = $("#modal-root");
  clear(root);
  const close = () => {
    root.setAttribute("data-open", "false");
    setTimeout(() => clear(root), 260);
    document.removeEventListener("keydown", onKey);
  };
  const onKey = (e) => { if (e.key === "Escape") close(); };
  document.addEventListener("keydown", onKey);

  const backdrop = h("div", { class: "modal-backdrop", onclick: close });
  const modal = build(close);
  root.append(backdrop, modal);
  requestAnimationFrame(() => root.setAttribute("data-open", "true"));

  const first = modal.querySelector("input, select, textarea, button[type=submit]");
  if (first) setTimeout(() => first.focus(), 120);
  return close;
}

function formModal({ title, description, fields, submitLabel, onSubmit, topContent, danger = false, submitClass }) {
  return openModal((close) => {
    const errorBox = h("div", { class: "modal-error", style: { display: "none" } });
    const inputs = {};
    const fieldEls = fields.map((f) => {
      let inp;
      if (f.type === "radio") {
        const wrap = h("div", { style: { display: "flex", gap: "8px", flexDirection: "column" } });
        for (const [v, label, desc] of f.options || []) {
          const r = h("input", {
            type: "radio",
            name: f.name,
            value: v,
            checked: (v === f.value) ? "checked" : null,
          });
          const lbl = h("label", {
            style: {
              display: "flex",
              gap: "10px",
              alignItems: "flex-start",
              padding: "10px 12px",
              border: "1px solid var(--hairline)",
              borderRadius: "var(--r-md)",
              cursor: "pointer",
            },
          }, r, h("div", {}, h("div", { style: { fontWeight: "500" } }, label), desc ? h("div", { style: { fontSize: "12px", color: "var(--muted)", marginTop: "2px" } }, desc) : null));
          wrap.append(lbl);
        }
        wrap.getValue = () => {
          const checked = wrap.querySelector(`input[name="${f.name}"]:checked`);
          return checked?.value ?? "";
        };
        inputs[f.name] = wrap;
        return h("div", { class: "field" },
          h("label", {}, f.label),
          wrap,
          f.hint ? h("div", { class: "field-hint" }, f.hint) : null,
        );
      } else if (f.type === "checkbox") {
        inp = h("input", { type: "checkbox", checked: f.value ? "checked" : null });
        inputs[f.name] = inp;
        return h("div", { class: "field", style: { flexDirection: "row", alignItems: "center", gap: "10px" } },
          inp,
          h("label", { style: { margin: 0, letterSpacing: "0", textTransform: "none", fontSize: "13px", color: "var(--ink)" } },
            f.label,
            f.hint ? h("span", { style: { color: "var(--muted)", fontSize: "12px", marginLeft: "6px" } }, f.hint) : null,
          ),
        );
      } else {
        inp = h("input", {
          type: f.type || "text",
          value: f.value ?? "",
          placeholder: f.placeholder || "",
          autocomplete: "off",
          spellcheck: "false",
        });
      }
      inputs[f.name] = inp;
      return h("div", { class: "field" },
        h("label", {}, f.label),
        inp,
        f.hint ? h("div", { class: "field-hint" }, f.hint) : null,
      );
    });

    const submitBtn = h("button", {
      class: submitClass || (danger ? "btn btn-danger" : "btn btn-primary"),
      type: "submit",
    }, submitLabel);

    const form = h("form", {
      class: "modal-form",
      onsubmit: async (e) => {
        e.preventDefault();
        const values = {};
        for (const [k, inp] of Object.entries(inputs)) {
          if (typeof inp.getValue === "function") values[k] = inp.getValue();
          else if (inp.type === "checkbox") values[k] = inp.checked;
          else values[k] = String(inp.value).trim();
        }
        submitBtn.setAttribute("aria-busy", "true");
        errorBox.style.display = "none";
        try {
          await onSubmit(values);
          close();
        } catch (err) {
          errorBox.textContent = err.message || String(err);
          errorBox.style.display = "block";
        } finally {
          submitBtn.removeAttribute("aria-busy");
        }
      },
    },
      topContent || null,
      ...fieldEls,
      errorBox,
      h("div", { class: "modal-footer" },
        h("button", { class: "btn btn-ghost", type: "button", onclick: close }, "Cancel"),
        submitBtn,
      ),
    );

    return h("div", { class: "modal", role: "dialog", "aria-modal": "true" },
      h("h3", {}, title),
      description ? h("p", {}, description) : null,
      form,
    );
  });
}

function confirmModal({ title, description, confirmLabel = "Confirm", danger = false, onConfirm }) {
  return openModal((close) => {
    const confirmBtn = h("button", {
      class: danger ? "btn btn-danger" : "btn btn-primary",
      onclick: async () => {
        confirmBtn.setAttribute("aria-busy", "true");
        try {
          await onConfirm();
          close();
        } catch (err) {
          toast(err.message || String(err), "err");
          confirmBtn.removeAttribute("aria-busy");
        }
      },
    }, confirmLabel);

    return h("div", { class: "modal", role: "dialog", "aria-modal": "true" },
      h("h3", {}, title),
      description ? h("p", {}, description) : null,
      h("div", { class: "modal-footer" },
        h("button", { class: "btn btn-ghost", onclick: close }, "Cancel"),
        confirmBtn,
      ),
    );
  });
}

// --- Auth banner ----------------------------------------------------

function renderAuthBanner() {
  const slot = $("#auth-banner-slot");
  clear(slot);
  if (state.gh.available && state.gh.authenticated) return;

  const signedOut = state.gh.available && !state.gh.authenticated;
  const cmd = signedOut ? "gh auth login" : "sudo dnf install gh  # or your package manager";

  const banner = h("div", { class: "auth-banner" },
    h("span", {}, icon("warn", 16)),
    h("div", {},
      h("strong", {}, signedOut ? "Sign in to the GitHub CLI" : "Install the GitHub CLI"),
      h("div", { style: { fontSize: "12px", marginTop: "2px" } },
        signedOut
          ? "Tether reads whatever account gh is signed in as. Run this in any terminal, then Recheck."
          : "Tether uses the gh CLI to read visibility, manage repos, and create new ones."
      ),
    ),
    h("code", {}, cmd),
    h("div", { class: "auth-banner-cta" },
      h("button", {
        class: "btn btn-sm",
        onclick: async () => {
          try { await navigator.clipboard.writeText(cmd); toast("Command copied"); } catch {}
        },
      }, icon("copy", 12), "Copy"),
      h("button", {
        class: "btn btn-sm btn-primary",
        onclick: async (e) => {
          const btn = e.currentTarget;
          btn.setAttribute("aria-busy", "true");
          try {
            const res = await api("/api/gh/recheck", { method: "POST" });
            state.gh = res;
            renderAuthBanner();
            renderMeta();
            if (res.authenticated) {
              toast(`Signed in as ${res.user}`, "ok");
              await doRescan();
            } else {
              toast("Still not signed in", "err");
            }
          } finally {
            btn.removeAttribute("aria-busy");
          }
        },
      }, "Recheck"),
    ),
  );
  slot.append(banner);
}

// --- Top meta bar --------------------------------------------------

function renderMeta() {
  const bar = $("#meta-bar");
  clear(bar);
  bar.append(
    h("span", { class: "meta-pill" },
      h("span", { class: "meta-pill-dot" }),
      h("span", {}, `${state.repos.length} repos`),
    ),
    h("span", { class: "meta-pill", title: state.root },
      `scanning: ${state.root.replace(/^\/home\/[^/]+/, "~")}`,
    ),
    h("span", {
      class: `meta-pill ${state.gh.available && state.gh.authenticated ? "meta-pill--ok" : state.gh.available ? "meta-pill--warn" : "meta-pill--err"}`,
    },
      h("span", { class: "meta-pill-dot" }),
      h("span", {}, !state.gh.available ? "gh missing" : state.gh.authenticated ? `gh: ${state.gh.user}` : "gh: not signed in"),
    ),
  );
}

// --- Sidebar (audit pinned + repo list) ---------------------------

function filterRepos() {
  const q = state.query.toLowerCase().trim();
  if (!q) state.filtered = state.repos;
  else state.filtered = state.repos.filter((r) =>
    r.name.toLowerCase().includes(q) || r.path.toLowerCase().includes(q)
  );
}

function auditCountsFromRepos() {
  let pub = 0, crit = 0, change = 0;
  for (const r of state.repos) {
    const e = r.enrichment;
    if (!e) continue;
    if (e.visibilitySummary === "public" || e.visibilitySummary === "mixed") pub++;
    if (e.sensitive && (e.visibilitySummary === "public" || e.visibilitySummary === "mixed")) crit++;
    if (Object.keys(e.urlChanges || {}).length > 0) change++;
  }
  return { pub, crit, change };
}

function renderRepoList() {
  const list = $("#repo-list");
  clear(list);

  // Add-project button pinned above everything else.
  const addEntry = h("button", {
    class: "addproject-entry",
    onclick: promptAddProject,
  },
    icon("plus", 16),
    h("div", {},
      h("div", {}, "Add project"),
      h("div", { class: "addproject-entry-sub" }, "track a folder or start a new one"),
    ),
  );
  list.append(addEntry);

  const counts = auditCountsFromRepos();
  const auditEntry = h("button", {
    class: `audit-entry ${state.activeView === "audit" ? "is-selected" : ""}`,
    onclick: () => selectAudit(),
  },
    h("div", { class: "audit-entry-title" }, icon("shield", 14), "Safety audit"),
    h("div", { class: "audit-entry-counts" },
      h("span", { class: counts.crit > 0 ? "num--danger" : "" }, `${counts.crit} critical`),
      h("span", { class: counts.pub > 0 ? "num--warn" : "" }, `${counts.pub} public`),
      h("span", {}, `${counts.change} URL change${counts.change === 1 ? "" : "s"}`),
    ),
  );
  list.append(auditEntry);

  const activityEntry = h("button", {
    class: `activity-entry ${state.activeView === "activity" ? "is-selected" : ""}`,
    onclick: () => selectActivity(),
  },
    h("div", { class: "activity-entry-title" }, icon("activity", 14), "Activity"),
    h("div", { class: "activity-entry-sub" }, "Every change Tether has made"),
  );
  list.append(activityEntry);

  if (state.repos.length === 0) {
    list.append(h("div", { class: "list-state list-state--empty" },
      h("strong", {}, "No repositories found."),
      h("div", {}, "Try rescanning, or check that you have .git folders under your home directory."),
    ));
    return;
  }
  if (state.filtered.length === 0) {
    list.append(h("div", { class: "list-state list-state--empty" }, `No repos match "${state.query}".`));
    return;
  }

  for (const r of state.filtered) {
    const e = r.enrichment || {};
    const vis = e.visibilitySummary || "none";
    const critical = e.sensitive && (vis === "public" || vis === "mixed");
    const urlChanged = Object.keys(e.urlChanges || {}).length > 0;

    const classes = ["repo-row", `repo-row--${vis}`];
    if (state.activeView === "repo" && state.selectedId === r.id) classes.push("is-selected");
    if (critical) classes.push("repo-row--critical");

    const row = h("a", {
      class: classes.join(" "),
      href: `#${r.id}`,
      dataset: { id: r.id },
      onclick: (ev) => { ev.preventDefault(); selectRepo(r.id); },
    },
      h("div", { class: "repo-row-top" },
        h("span", { class: "vis-dot", title: visibilityTitle(vis) }),
        h("span", { class: "repo-row-name" }, r.name),
        h("span", { class: "repo-row-flags" },
          e.sensitive ? h("span", { class: "flag flag--sensitive", title: "Marked sensitive" }, icon("star", 11)) : null,
          urlChanged ? h("span", { class: "flag flag--url-changed", title: "Remote URL changed recently" }, icon("arrows", 11)) : null,
        ),
        visPill(vis),
      ),
      h("div", { class: "repo-row-path", title: r.path }, r.path),
    );
    list.append(row);
  }
}

function visibilityTitle(summary) {
  return {
    public: "At least one remote is PUBLIC",
    private: "All remotes are private",
    mixed: "Mixed: some public, some private",
    none: "No GitHub remotes",
    unknown: "Visibility not determined (gh sign-in or API issue)",
  }[summary] || summary;
}

function visPill(summary) {
  if (summary === "none") return h("span", { class: "vis-pill vis-pill--none" }, "no remote");
  if (summary === "public") return h("span", { class: "vis-pill vis-pill--public" }, "public");
  if (summary === "private") return h("span", { class: "vis-pill vis-pill--private" }, "private");
  if (summary === "mixed") return h("span", { class: "vis-pill vis-pill--mixed" }, "mixed");
  return h("span", { class: "vis-pill vis-pill--unknown" }, "?");
}

// --- Detail panel --------------------------------------------------

async function selectRepo(id) {
  state.selectedId = id;
  state.activeView = "repo";
  state.detailLoading = true;
  state.detail = null;
  state.activeTab = "remotes";
  state.githubCache.delete(id);
  renderRepoList();
  renderDetail();
  try {
    state.detail = await api(`/api/repos/${id}`);
  } catch (err) {
    state.detail = { error: err.message };
  } finally {
    state.detailLoading = false;
    renderDetail();
  }
}

async function refreshDetail() {
  if (!state.selectedId) return;
  try {
    state.detail = await api(`/api/repos/${state.selectedId}`);
    const updated = state.repos.find((r) => r.id === state.selectedId);
    if (updated && state.detail?.enrichment) {
      updated.enrichment = state.detail.enrichment;
      filterRepos();
      renderRepoList();
    }
    // Invalidate activity caches — the mutation that triggered this refresh
    // may have appended a new event.
    state.repoActivity = null;
    state.activity = null;
    renderDetail();
  } catch (err) {
    toast(err.message, "err");
  }
}

function renderDetail() {
  const panel = $("#detail");
  clear(panel);

  if (state.activeView === "audit") { renderAuditDashboard(panel); return; }
  if (state.activeView === "activity") { renderActivityDashboard(panel); return; }

  if (state.activeView !== "repo" || !state.selectedId) {
    panel.append(h("div", { class: "detail-empty" },
      h("h2", {}, "Pick a repository"),
      h("p", {}, "Or open the Safety Audit from the sidebar for a bird's-eye view of visibility risks."),
    ));
    return;
  }

  if (state.detailLoading && !state.detail) {
    panel.append(h("div", { class: "detail-empty" },
      h("span", { class: "spinner" }),
      h("h2", {}, "Loading…"),
    ));
    return;
  }

  if (state.detail?.error) {
    panel.append(h("div", { class: "detail-empty" },
      h("h2", {}, "Couldn't load this repo"),
      h("p", {}, state.detail.error),
    ));
    return;
  }

  const d = state.detail;
  if (!d) return;

  const banner = buildSafetyBanner(d);
  if (banner) panel.append(banner);

  const enr = d.enrichment || {};
  const statusBadge = d.status?.error
    ? h("span", { class: "badge" }, "status unknown")
    : d.status?.dirty
    ? h("span", { class: "badge badge--dirty" }, `${d.status.changedFiles} changes`)
    : h("span", { class: "badge badge--clean" }, "clean");

  const defaultBadge = d.defaultBranch
    ? h("span", { class: "badge badge--accent" }, `on ${d.defaultBranch}`)
    : null;

  const remoteCountBadge = h("span", { class: "badge" },
    `${d.remotes.length} remote${d.remotes.length === 1 ? "" : "s"}`);

  const sensitiveBadge = enr.sensitive
    ? h("span", { class: "badge badge--accent" }, icon("star", 10), " sensitive")
    : null;

  panel.append(h("div", { class: "detail-header" },
    h("div", { class: "detail-title" },
      h("h2", {}, d.name),
      h("button", {
        class: "detail-path",
        type: "button",
        title: "Click to copy path",
        onclick: () => {
          navigator.clipboard.writeText(d.path);
          toast("Path copied to clipboard");
        },
      },
        icon("copy"),
        h("span", {}, d.path),
      ),
      h("div", { class: "detail-badges" },
        statusBadge, defaultBadge, remoteCountBadge, sensitiveBadge,
      ),
    ),
    h("div", { class: "detail-actions" },
      h("div", { class: "detail-actions-row" },
        h("button", {
          class: `btn btn-sm ${enr.sensitive ? "btn-danger" : "btn-ghost"}`,
          title: enr.sensitive
            ? "Unmark this repo as sensitive"
            : "Mark as sensitive — gets a loud warning if any remote is public",
          onclick: toggleSensitive,
        }, icon("star", 12), enr.sensitive ? "Unmark sensitive" : "Mark sensitive"),
      ),
      h("div", { class: "detail-actions-row" },
        makeActionBtn("Fetch", icon("download"), doFetch),
        makeActionBtn("Pull", icon("download"), doPull, true),
        makeActionBtn("Push", icon("upload"), promptPush, true),
      ),
    ),
  ));

  const ghRemotes = d.remotes.filter((r) => /github\.com/.test(r.fetchUrl));

  panel.append(h("div", { class: "tabs" },
    makeTab("remotes", "Remotes", d.remotes.length),
    makeTab("branches", "Branches", d.branches.length),
    makeTab("github", "GitHub", ghRemotes.length),
    makeTab("activity", "Activity", null),
  ));

  const body = h("div", { class: "tab-body" });
  panel.append(body);
  renderTab(body);
}

function buildSafetyBanner(d) {
  const enr = d.enrichment || {};
  const vis = enr.visibilitySummary || "none";
  const critical = enr.sensitive && (vis === "public" || vis === "mixed");
  const urlChanged = Object.keys(enr.urlChanges || {}).length > 0;

  if (critical) {
    return h("div", { class: "safety-banner safety-banner--critical", role: "alert" },
      h("span", { class: "safety-banner-icon" }, icon("warn", 18)),
      h("div", {},
        h("strong", {}, "Sensitive repo is connected to a public GitHub repo"),
        h("div", {}, "You marked this repo as sensitive, but at least one remote is publicly visible. Review the Remotes tab before any push."),
      ),
    );
  }
  if (vis === "public" || vis === "mixed") {
    return h("div", { class: "safety-banner safety-banner--public" },
      h("span", { class: "safety-banner-icon" }, icon("eye", 18)),
      h("div", {},
        h("strong", {}, vis === "mixed" ? "Mixed visibility — at least one remote is public" : "This repo is connected to a PUBLIC GitHub repo"),
        h("div", {}, "Pushes will be world-readable. Tether will require you to retype the repo name before the first public push."),
      ),
    );
  }
  if (urlChanged) {
    return h("div", { class: "safety-banner safety-banner--mixed" },
      h("span", { class: "safety-banner-icon" }, icon("arrows", 18)),
      h("div", {},
        h("strong", {}, "Remote URL changed since last scan"),
        h("div", {}, Object.entries(enr.urlChanges).map(([n, info]) => `${n}: ${info.previousUrl} → now`).join("; ")),
      ),
    );
  }
  if (vis === "private") {
    return h("div", { class: "safety-banner safety-banner--private" },
      h("span", { class: "safety-banner-icon" }, icon("shield", 18)),
      h("div", {},
        h("strong", {}, "All remotes are private"),
        h("div", {}, "This repo's GitHub remotes are private. Safe to push."),
      ),
    );
  }
  if (vis === "none") {
    return h("div", { class: "safety-banner safety-banner--none" },
      h("span", { class: "safety-banner-icon" }, icon("plus", 18)),
      h("div", {},
        h("strong", {}, "No GitHub remote"),
        h("div", {}, "Create one below — Tether defaults new repos to private."),
      ),
      h("div", { class: "safety-banner-ctas" },
        h("button", { class: "btn btn-primary btn-sm", onclick: promptCreateGithubRepo },
          icon("plus", 12), "Create GitHub repo"),
      ),
    );
  }
  return null;
}

function makeActionBtn(label, iconEl, onClick, ghost = false) {
  return h("button", {
    class: `btn ${ghost ? "btn-ghost" : ""}`,
    onclick: async (e) => {
      const btn = e.currentTarget;
      btn.setAttribute("aria-busy", "true");
      try {
        await onClick();
      } catch (err) {
        toast(err.message || String(err), "err");
      } finally {
        btn.removeAttribute("aria-busy");
      }
    },
  }, iconEl, label);
}

function makeTab(id, label, count) {
  return h("button", {
    class: `tab ${state.activeTab === id ? "is-active" : ""}`,
    onclick: () => { state.activeTab = id; renderDetail(); },
  },
    h("span", {}, label),
    count !== null && count !== undefined
      ? h("span", { class: "tab-count" }, String(count))
      : null,
  );
}

function renderTab(body) {
  clear(body);
  const d = state.detail;
  if (!d) return;
  if (state.activeTab === "remotes") renderRemotes(body, d);
  if (state.activeTab === "branches") renderBranches(body, d);
  if (state.activeTab === "github") renderGithub(body, d);
  if (state.activeTab === "activity") renderRepoActivity(body, d);
}

function renderRemotes(body, d) {
  const enr = d.enrichment || {};
  const ghLinks = enr.githubRemotes || [];
  const visMap = new Map(ghLinks.map((l) => [l.remoteName, l]));
  const hasGithub = ghLinks.length > 0;

  const actions = h("div", { style: { display: "flex", gap: "6px" } });
  if (!hasGithub && state.gh.available) {
    actions.append(h("button", {
      class: "btn btn-primary btn-sm",
      onclick: promptCreateGithubRepo,
    }, icon("plus", 12), "Create GitHub repo"));
  }
  actions.append(h("button", {
    class: `btn btn-sm ${hasGithub ? "btn-ghost" : ""}`,
    onclick: promptAddRemote,
  }, icon("plus", 12), "Add remote"));

  body.append(h("div", { class: "section-header" },
    h("h3", {}, "Remote connections"),
    actions,
  ));

  if (d.remotes.length === 0) {
    body.append(h("div", { class: "empty-state" },
      h("p", {}, "This repo has no remotes yet."),
      state.gh.available
        ? h("button", { class: "btn btn-primary", onclick: promptCreateGithubRepo },
            icon("plus", 12), "Create GitHub repo and connect")
        : h("button", { class: "btn btn-primary", onclick: promptAddRemote },
            icon("plus", 12), "Add a remote"),
    ));
    return;
  }

  const rows = d.remotes.map((r) => {
    const differentPush = r.pushUrl && r.pushUrl !== r.fetchUrl;
    const link = visMap.get(r.name);
    const visClass = link?.visibility
      ? (link.visibility === "PUBLIC" ? "vis-pill--public" : link.visibility === "PRIVATE" ? "vis-pill--private" : "vis-pill--unknown")
      : link ? "vis-pill--unknown" : "vis-pill--none";
    const visLabel = link?.exists === false
      ? "not found"
      : link?.visibility?.toLowerCase() || (link ? "?" : "not github");

    return h("tr", {},
      h("td", { class: "name-cell" },
        r.name,
        h("div", { style: { marginTop: "4px" } },
          h("span", { class: `vis-pill ${visClass}` }, visLabel),
        ),
      ),
      h("td", {},
        h("div", { class: "url-cell" },
          h("span", { class: "url-kind" }, urlIcon(r.fetchUrl)),
          h("span", {}, r.fetchUrl),
        ),
        differentPush
          ? h("div", { class: "url-cell", style: { marginTop: "4px", opacity: "0.75" } },
              h("span", { class: "badge", style: { fontSize: "10px" } }, "push"),
              h("span", {}, r.pushUrl),
            )
          : null,
      ),
      h("td", { class: "row-actions" },
        h("div", { class: "row-action-btns" },
          h("button", { class: "btn btn-icon btn-sm", title: "Edit URL", onclick: () => promptEditUrl(r) }, icon("edit")),
          h("button", { class: "btn btn-icon btn-sm", title: "Rename", onclick: () => promptRename(r) }, icon("rename")),
          h("button", { class: "btn btn-icon btn-sm", title: "Remove", onclick: () => promptRemoveRemote(r) }, icon("trash")),
        ),
      ),
    );
  });

  body.append(h("table", { class: "tbl" },
    h("thead", {}, h("tr", {},
      h("th", {}, "Name"),
      h("th", {}, "URL"),
      h("th", { style: { width: "140px" } }, ""),
    )),
    h("tbody", {}, ...rows),
  ));
}

function renderBranches(body, d) {
  body.append(h("div", { class: "section-header" },
    h("h3", {}, "Local branches"),
    h("span", { class: "field-hint" }, "ahead/behind is vs. upstream"),
  ));

  if (d.branches.length === 0) {
    body.append(h("div", { class: "empty-state" },
      h("p", {}, "No branches found (empty repo?)"),
    ));
    return;
  }

  const rows = d.branches.map((b) => h("tr", {},
    h("td", { class: "name-cell" },
      b.isCurrent ? h("span", { class: "badge badge--accent", style: { marginRight: "6px" } }, "HEAD") : null,
      b.name,
    ),
    h("td", { class: "url-cell" },
      b.upstream || h("span", { style: { color: "var(--muted-soft)" } }, "—")
    ),
    h("td", {},
      b.upstream
        ? h("div", { style: { display: "flex", gap: "4px", flexWrap: "wrap" } },
            b.ahead > 0 ? h("span", { class: "badge badge--ahead" }, `+${b.ahead}`) : null,
            b.behind > 0 ? h("span", { class: "badge badge--behind" }, `-${b.behind}`) : null,
            b.ahead === 0 && b.behind === 0
              ? h("span", { class: "badge", style: { color: "var(--muted)" } }, "in sync")
              : null,
          )
        : h("span", { style: { color: "var(--muted-soft)", fontSize: "12px" } }, "no upstream"),
    ),
    h("td", {},
      h("div", { style: { fontFamily: "var(--font-mono)", fontSize: "12px", color: "var(--muted)" } }, b.lastCommitSha),
      h("div", { style: { fontSize: "13px", color: "var(--ink-soft)", marginTop: "2px" } }, b.lastCommitSubject || ""),
    ),
  ));

  body.append(h("table", { class: "tbl" },
    h("thead", {}, h("tr", {},
      h("th", {}, "Branch"),
      h("th", {}, "Tracks"),
      h("th", { style: { width: "140px" } }, "Position"),
      h("th", {}, "Last commit"),
    )),
    h("tbody", {}, ...rows),
  ));
}

async function renderGithub(body, d) {
  const ghRemotes = d.remotes.filter((r) => /github\.com/.test(r.fetchUrl));
  if (!state.gh.available) {
    body.append(h("div", { class: "gh-banner" },
      h("strong", {}, "The GitHub CLI isn't installed."),
      " Install ", h("code", {}, "gh"), " and run ", h("code", {}, "gh auth login"),
    ));
    return;
  }
  if (!state.gh.authenticated) {
    body.append(h("div", { class: "gh-banner" },
      h("strong", {}, "GitHub CLI isn't signed in."),
      " Run ", h("code", {}, "gh auth login"), " in a terminal, then Recheck.",
    ));
    return;
  }
  if (ghRemotes.length === 0) {
    body.append(h("div", { class: "empty-state" },
      h("p", {}, "No GitHub remotes on this repo."),
      h("button", { class: "btn btn-primary", onclick: promptCreateGithubRepo },
        icon("plus", 12), "Create a GitHub repo for this"
      ),
    ));
    return;
  }

  const loading = h("div", { class: "empty-state" },
    h("span", { class: "spinner" }), " Talking to GitHub…");
  body.append(loading);

  let data;
  if (state.githubCache.has(state.selectedId)) {
    data = state.githubCache.get(state.selectedId);
  } else {
    try {
      data = await api(`/api/repos/${state.selectedId}/github`);
      state.githubCache.set(state.selectedId, data);
    } catch (err) {
      loading.remove();
      body.append(h("div", { class: "gh-banner" }, "Error from GitHub CLI: ", err.message));
      return;
    }
  }
  loading.remove();

  for (const entry of data.remotes || []) body.append(renderGhCard(entry));
}

function renderGhCard(entry) {
  const info = entry.info || {};
  const prs = entry.openPRs || [];
  const visKey = info.visibility?.toLowerCase() || "unknown";

  const titleChildren = [
    h("span", {
      style: {
        color: "var(--muted)",
        fontSize: "11px",
        fontFamily: "var(--font-body)",
        letterSpacing: "0.08em",
        textTransform: "uppercase",
        marginRight: "8px",
      },
    }, entry.remoteName),
  ];
  if (info.exists && info.url) {
    titleChildren.push(
      h("a", { href: info.url, target: "_blank", rel: "noopener" },
        `${entry.owner}/${entry.repo}`, icon("external", 12)),
    );
  } else {
    titleChildren.push(h("span", {}, `${entry.owner}/${entry.repo}`));
  }

  const visBadge = info.visibility
    ? h("button", {
        class: `vis-control vis-pill vis-pill--${visKey === "public" ? "public" : "private"}`,
        title: "Click to change visibility",
        onclick: () => promptSetVisibility(entry),
      },
        visKey === "public" ? icon("eye", 10) : icon("shield", 10),
        info.visibility.toLowerCase(),
        h("span", { style: { opacity: 0.7, marginLeft: "6px" } }, "change"))
    : null;

  const card = h("div", { class: "gh-card" },
    h("div", { class: "gh-card-header" },
      h("div", {},
        h("div", { class: "gh-title" }, ...titleChildren),
        info.description ? h("div", { class: "gh-description" }, info.description) : null,
      ),
      h("div", {
        style: { display: "flex", gap: "6px", flexWrap: "wrap", justifyContent: "flex-end", alignItems: "flex-start" },
      },
        info.exists === false
          ? h("span", { class: "vis-pill vis-pill--public" }, "not found")
          : info.isArchived
          ? h("span", { class: "vis-pill vis-pill--mixed" }, "archived")
          : null,
        visBadge,
        info.isFork ? h("span", { class: "badge" }, "fork") : null,
      ),
    ),
  );

  if (info.exists) {
    card.append(h("div", { class: "gh-stats" },
      info.defaultBranch ? h("span", {}, `default: ${info.defaultBranch}`) : null,
      info.stars !== undefined ? h("span", {}, `★ ${info.stars}`) : null,
      info.pushedAt ? h("span", {}, `pushed ${fmtRelative(info.pushedAt)}`) : null,
    ));

    if (prs.length > 0) {
      card.append(h("div", { class: "pr-list" },
        h("h3", {
          style: {
            fontSize: "11px",
            textTransform: "uppercase",
            letterSpacing: "0.08em",
            color: "var(--muted)",
            marginBottom: "8px",
            fontFamily: "var(--font-body)",
            fontWeight: "500",
          },
        }, `${prs.length} open PR${prs.length === 1 ? "" : "s"}`),
        ...prs.map((pr) => h("div", { class: "pr-row" },
          h("span", { class: "pr-num" }, `#${pr.number}`),
          h("div", { class: "pr-title" },
            h("a", { href: pr.url, target: "_blank", rel: "noopener" }, pr.title),
            pr.isDraft ? h("span", { class: "badge", style: { marginLeft: "8px" } }, "draft") : null,
          ),
          h("span", { class: "pr-meta" }, `${pr.author || "?"} · ${pr.headRefName}`),
        )),
      ));
    }
  } else if (info.error) {
    card.append(h("div", { class: "gh-banner" }, "gh said: ", info.error));
  }
  return card;
}

function fmtRelative(iso) {
  if (!iso) return "";
  const s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 172800) return `${Math.floor(s / 3600)}h ago`;
  if (s < 2592000) return `${Math.floor(s / 86400)}d ago`;
  if (s < 62208000) return `${Math.floor(s / 2592000)}mo ago`;
  return `${Math.floor(s / 31536000)}y ago`;
}

// --- Audit dashboard ----------------------------------------------

async function selectAudit() {
  state.activeView = "audit";
  state.selectedId = null;
  state.auditLoading = true;
  renderRepoList();
  renderDetail();
  try {
    state.audit = await api("/api/audit");
  } catch (err) {
    state.audit = { error: err.message };
  } finally {
    state.auditLoading = false;
    renderDetail();
  }
}

function renderAuditDashboard(panel) {
  if (state.auditLoading) {
    panel.append(h("div", { class: "detail-empty" },
      h("span", { class: "spinner" }),
      h("h2", {}, "Computing audit…"),
    ));
    return;
  }
  if (state.audit?.error) {
    panel.append(h("div", { class: "detail-empty" },
      h("h2", {}, "Couldn't compute audit"),
      h("p", {}, state.audit.error),
    ));
    return;
  }

  const a = state.audit || {};

  const scoreColor = a.sensitivePublic?.length ? "var(--danger)"
    : a.publicExposure?.length ? "var(--warn)"
    : "var(--success)";

  panel.append(h("div", { class: "audit-hero" },
    h("div", {},
      h("h2", {}, "Safety audit"),
      h("p", {}, `Bird's-eye view of visibility risks across all ${a.totalRepos ?? 0} repos under your home directory. Click any row to jump to that repo.`),
    ),
    h("div", { class: "audit-hero-score" },
      h("div", { class: "audit-hero-score-num", style: { color: scoreColor } },
        String(a.sensitivePublic?.length || a.publicExposure?.length || 0)),
      h("div", { class: "audit-hero-score-label" },
        a.sensitivePublic?.length ? "critical items" : a.publicExposure?.length ? "public exposures" : "no public risks"
      ),
    ),
  ));

  auditSection(panel, {
    title: "Sensitive repos connected to public GitHub",
    note: "You marked these repos sensitive AND at least one of their remotes is public. Fix these first.",
    severity: "critical",
    items: a.sensitivePublic,
    render: auditItemBasic,
  });

  auditSection(panel, {
    title: "Repos with at least one public remote",
    note: "Anything pushed to these remotes is world-readable. Review before pushing.",
    severity: "warn",
    items: a.publicExposure,
    render: auditItemBasic,
  });

  auditSection(panel, {
    title: "Remote URL changed since the last scan",
    note: "Tether remembers remote URLs between runs. A URL that flipped may be a mis-connection — check it.",
    severity: "warn",
    items: a.urlChanges,
    render: (r) => auditItemDetail(r, Object.entries(r.changes || {}).map(([n, c]) => `${n}: was ${c.previousUrl}`).join(" · ")),
  });

  auditSection(panel, {
    title: "Folder name doesn't match the remote repo name",
    note: "Often innocuous (rename), but sometimes a sign the repo got wired to the wrong GitHub project.",
    severity: "info",
    items: a.nameMismatch,
    render: (r) => auditItemDetail(r, `remote: ${r.remoteRepoName || "?"}`),
  });

  auditSection(panel, {
    title: "Remote points to a repo gh can't find",
    note: "The GitHub side may have been renamed, deleted, or you don't have access.",
    severity: "warn",
    items: a.notFound,
    render: (r) => auditItemDetail(r, (r.missingRemotes || []).map((m) => `${m.name}→${m.owner}/${m.repo}`).join(" · ")),
  });

  auditSection(panel, {
    title: "Multiple remotes with different owners",
    note: "Usually a fork-of-a-fork setup. Confirm each remote's role is what you expect.",
    severity: "info",
    items: a.mixedRemotes,
    render: (r) => auditItemDetail(r, (r.owners || []).join(" / ")),
  });

  auditSection(panel, {
    title: "Visibility couldn't be determined",
    note: "The gh CLI couldn't answer for at least one remote (network, rate limit, or permissions).",
    severity: "info",
    items: a.unknown,
    render: auditItemBasic,
  });
}

function auditSection(panel, { title, note, severity, items, render }) {
  const section = h("section", { class: "audit-section" });
  section.append(h("div", { class: "audit-section-header" },
    h("h3", {}, title),
    h("span", { class: `sev-chip sev-chip--${severity}` }, `${items?.length || 0}`),
  ));
  section.append(h("div", { class: "audit-section-note" }, note));
  if (!items || items.length === 0) {
    section.append(h("div", { class: "audit-empty" },
      items ? h("strong", {}, "Clear. ") : null,
      items ? "No repos in this category." : "n/a",
    ));
  } else {
    const list = h("div", { class: "audit-list" });
    for (const item of items) list.append(render(item));
    section.append(list);
  }
  panel.append(section);
}

function auditItemBasic(r) {
  return h("button", {
    class: "audit-item",
    onclick: () => selectRepo(r.id),
  },
    h("span", { class: "vis-dot", title: visibilityTitle(r.visibilitySummary || "unknown") }),
    h("div", {},
      h("div", { class: "audit-item-name" }, r.name, r.sensitive ? " ★" : ""),
      h("div", { class: "audit-item-path" }, r.path),
    ),
    visPill(r.visibilitySummary || "unknown"),
  );
}

// --- Activity view ------------------------------------------------

async function selectActivity() {
  state.activeView = "activity";
  state.selectedId = null;
  state.activityLoading = true;
  renderRepoList();
  renderDetail();
  try {
    state.activity = await api("/api/activity?limit=500");
  } catch (err) {
    state.activity = { error: err.message };
  } finally {
    state.activityLoading = false;
    renderDetail();
  }
}

function renderActivityDashboard(panel) {
  if (state.activityLoading && !state.activity) {
    panel.append(h("div", { class: "detail-empty" },
      h("span", { class: "spinner" }),
      h("h2", {}, "Loading activity…"),
    ));
    return;
  }
  if (state.activity?.error) {
    panel.append(h("div", { class: "detail-empty" },
      h("h2", {}, "Couldn't load activity"),
      h("p", {}, state.activity.error),
    ));
    return;
  }

  const events = state.activity?.events || [];

  panel.append(h("div", { class: "audit-hero" },
    h("div", {},
      h("h2", {}, "Activity"),
      h("p", {}, "Every mutation Tether has made — remote add/remove/rename/URL change, GitHub repo creation, visibility flip, push (public marked), sensitive toggle. Rescans, fetches and pulls are not logged."),
    ),
    h("div", { class: "audit-hero-score" },
      h("div", { class: "audit-hero-score-num" }, String(events.length)),
      h("div", { class: "audit-hero-score-label" }, events.length === 1 ? "event" : "events"),
    ),
  ));

  if (events.length === 0) {
    panel.append(h("div", { class: "audit-empty", style: { padding: "32px" } },
      "Nothing yet. When you add a remote, create a GitHub repo, push, or toggle sensitive, it shows up here.",
    ));
    return;
  }

  panel.append(renderTimeline(events, { includeRepoLinks: true }));
}

function renderRepoActivity(body, d) {
  body.append(h("div", { class: "section-header" },
    h("h3", {}, "Activity for this repo"),
    h("span", { class: "field-hint" }, "rescans and reads are not logged"),
  ));

  const cache = state.repoActivity;
  if (!cache || cache.repoId !== state.selectedId) {
    const loading = h("div", { class: "empty-state" },
      h("span", { class: "spinner" }), " Loading…");
    body.append(loading);
    (async () => {
      try {
        const data = await api(`/api/repos/${state.selectedId}/activity?limit=500`);
        state.repoActivity = { repoId: state.selectedId, events: data.events || [] };
        if (state.activeTab === "activity" && state.selectedId === d.id) renderDetail();
      } catch (err) {
        loading.remove();
        body.append(h("div", { class: "gh-banner" }, "Failed to load activity: ", err.message));
      }
    })();
    return;
  }

  const events = cache.events;
  if (events.length === 0) {
    body.append(h("div", { class: "empty-state" },
      h("p", {}, "No activity yet for this repo."),
    ));
    return;
  }

  body.append(renderTimeline(events, { includeRepoLinks: false }));
}

function renderTimeline(events, { includeRepoLinks }) {
  const byDay = new Map();
  for (const e of events) {
    const day = e.ts?.slice(0, 10) || "?";
    if (!byDay.has(day)) byDay.set(day, []);
    byDay.get(day).push(e);
  }

  const list = h("div", { class: "activity-list" });
  for (const [day, dayEvents] of byDay) {
    const dayBlock = h("div", { class: "activity-day" },
      h("div", { class: "activity-day-header" }, fmtDayHeader(day)),
    );
    for (const e of dayEvents) dayBlock.append(renderActivityItem(e, { includeRepoLinks }));
    list.append(dayBlock);
  }
  return list;
}

function fmtDayHeader(isoDay) {
  if (!isoDay || isoDay === "?") return "unknown date";
  const today = new Date().toISOString().slice(0, 10);
  if (isoDay === today) return "today";
  const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  if (isoDay === yesterday) return "yesterday";
  // YYYY-MM-DD as readable
  const [y, m, d] = isoDay.split("-");
  const months = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
  return `${months[parseInt(m, 10) - 1] || m} ${parseInt(d, 10)}, ${y}`;
}

function renderActivityItem(e, { includeRepoLinks }) {
  const cls = classifyActivity(e);
  const iconEl = h("span", { class: `activity-icon activity-icon--${cls.iconKey}` }, icon(cls.icon, 14));
  const bodyEl = h("div", { class: "activity-body" }, ...cls.children);

  if (includeRepoLinks && e.repoId) {
    bodyEl.append(h("button", {
      class: "activity-repo-link",
      title: e.repoPath,
      onclick: () => selectRepo(e.repoId),
    }, e.repoName || "repo"));
  }

  return h("div", {
    class: `activity-item ${cls.rowClass || ""}`.trim(),
  },
    iconEl,
    bodyEl,
    h("div", { class: "activity-time", title: e.ts }, fmtRelative(e.ts)),
  );
}

function classifyActivity(e) {
  const d = e.details || {};
  switch (e.kind) {
    case "remote.added":
      return {
        icon: "plus", iconKey: "add",
        children: [
          h("strong", {}, "Added remote "),
          h("code", {}, d.remoteName || "?"),
          h("div", { class: "activity-body-sub" }, d.url || ""),
        ],
      };
    case "remote.removed":
      return {
        icon: "trash", iconKey: "remove",
        children: [
          h("strong", {}, "Removed remote "),
          h("code", {}, d.remoteName || "?"),
          d.url ? h("div", { class: "activity-body-sub" }, "was ", d.url) : null,
        ].filter(Boolean),
      };
    case "remote.renamed":
      return {
        icon: "rename", iconKey: "edit",
        children: [
          h("strong", {}, "Renamed remote "),
          h("code", {}, d.oldName || "?"),
          " → ",
          h("code", {}, d.newName || "?"),
        ],
      };
    case "remote.url_changed":
      return {
        icon: "edit", iconKey: "edit",
        children: [
          h("strong", {}, `Changed `),
          h("code", {}, d.remoteName || "?"),
          h("span", {}, " URL"),
          h("div", { class: "activity-body-sub" }, `was ${d.previousUrl || "—"}`),
          h("div", { class: "activity-body-sub" }, `now ${d.newUrl || "—"}`),
        ],
      };
    case "remote.url_detected_change":
      return {
        icon: "arrows", iconKey: "detect",
        rowClass: "activity-item--public",
        children: [
          h("strong", {}, "URL drift detected on "),
          h("code", {}, d.remoteName || "?"),
          h("div", { class: "activity-body-sub" }, `was ${d.previousUrl || "—"}`),
          h("div", { class: "activity-body-sub" }, `now ${d.currentUrl || "—"}`),
        ],
      };
    case "github.repo_created": {
      const target = (d.owner && d.name) ? `${d.owner}/${d.name}` : (d.name || "?");
      return {
        icon: "plus", iconKey: "github",
        rowClass: d.private ? "" : "activity-item--public",
        children: [
          h("strong", {}, d.private ? "Created private GitHub repo " : "Created PUBLIC GitHub repo "),
          d.url ? h("a", { href: d.url, target: "_blank", rel: "noopener" }, target) : h("code", {}, target),
          h("div", { class: "activity-body-sub" },
            `wired as `, h("code", {}, d.remoteName || "origin"),
            d.remoteUrl ? ` → ${d.remoteUrl}` : "",
          ),
        ],
      };
    }
    case "github.visibility_changed": {
      const goingPublic = (d.current || "").toUpperCase() === "PUBLIC";
      return {
        icon: goingPublic ? "eye" : "shield", iconKey: "github",
        rowClass: goingPublic ? "activity-item--critical" : "",
        children: [
          h("strong", {}, goingPublic ? "Changed visibility to PUBLIC " : "Changed visibility to private "),
          d.owner && d.name ? h("code", {}, `${d.owner}/${d.name}`) : null,
          h("div", { class: "activity-body-sub" }, `${d.previous || "?"} → ${d.current || "?"}`),
        ].filter(Boolean),
      };
    }
    case "push": {
      const pub = !!d.isPublic;
      return {
        icon: "upload", iconKey: pub ? "push-public" : "add",
        rowClass: pub ? "activity-item--critical" : "",
        children: [
          h("strong", {}, pub ? "Pushed to a PUBLIC remote " : "Pushed "),
          h("code", {}, d.branch || "?"),
          " → ",
          h("code", {}, d.remoteName || "?"),
          d.target ? h("div", { class: "activity-body-sub" }, `target: ${d.target}`) : null,
        ].filter(Boolean),
      };
    }
    case "sensitive.marked":
      return {
        icon: "star", iconKey: "github",
        children: [h("strong", {}, "Marked sensitive")],
      };
    case "sensitive.unmarked":
      return {
        icon: "star", iconKey: "edit",
        children: [h("strong", {}, "Unmarked sensitive")],
      };
    default:
      return {
        icon: "clock", iconKey: "add",
        children: [h("strong", {}, e.kind)],
      };
  }
}

function auditItemDetail(r, detail) {
  return h("button", {
    class: "audit-item",
    onclick: () => selectRepo(r.id),
  },
    h("span", { class: "vis-dot", title: visibilityTitle(r.visibilitySummary || "unknown") }),
    h("div", {},
      h("div", { class: "audit-item-name" }, r.name),
      h("div", { class: "audit-item-path" }, r.path),
      h("div", { class: "audit-item-detail", style: { marginTop: "2px" } }, detail),
    ),
    visPill(r.visibilitySummary || "unknown"),
  );
}

// --- Action handlers ----------------------------------------------

function promptAddProject() {
  openModal((close) => {
    const pathInput = h("input", {
      type: "text",
      placeholder: "~/projects/my-new-thing",
      autocomplete: "off",
      spellcheck: "false",
    });

    const detectPanel = h("div", { class: "detect-panel" },
      h("div", { class: "detect-state-label" }, "Status"),
      h("div", { class: "detect-state-body" }, "Type a path above. Tether figures out what to do."),
    );

    const actionBtn = h("button", {
      class: "btn btn-primary",
      type: "submit",
      disabled: "disabled",
    }, "Pick a path");

    const errorBox = h("div", { class: "modal-error", style: { display: "none" } });

    let currentDetect = null;
    let currentInitGit = false;
    let debounceTimer = null;

    const render = (d) => {
      clear(detectPanel);
      currentDetect = d;
      currentInitGit = false;
      actionBtn.removeAttribute("disabled");
      actionBtn.classList.remove("btn-danger");
      actionBtn.classList.add("btn-primary");

      let label = "Status";
      let body;
      let btnLabel = "Add to Tether";
      let panelClass = "detect-panel";

      switch (d.suggestion) {
        case "empty":
          label = "Status";
          body = h("span", {}, "Type a path above. Tether figures out what to do.");
          actionBtn.setAttribute("disabled", "disabled");
          btnLabel = "Pick a path";
          break;
        case "notFound":
          label = "Path not found";
          body = h("span", {}, "Nothing at ", h("code", {}, d.path), ". Check the path — Tether won't create directories on your behalf.");
          panelClass = "detect-panel detect-panel--err";
          actionBtn.setAttribute("disabled", "disabled");
          btnLabel = "Fix the path";
          break;
        case "notDirectory":
          label = "Not a directory";
          body = h("span", {}, h("code", {}, d.path), " exists but is a file. Pick a directory.");
          panelClass = "detect-panel detect-panel--err";
          actionBtn.setAttribute("disabled", "disabled");
          btnLabel = "Fix the path";
          break;
        case "jumpTo":
          label = "Already tracked";
          body = h("span", {}, "Tether already sees ", h("code", {}, d.path), ". Jump straight to its detail view.");
          panelClass = "detect-panel detect-panel--info";
          btnLabel = "Open this repo";
          break;
        case "addExistingRepo":
          label = d.underScanRoot ? "Git repo ready to track" : "Git repo outside your scan root";
          body = h("span", {},
            h("code", {}, d.path),
            " is a git repo",
            d.underScanRoot
              ? " under your home directory. Adding will include it immediately."
              : ". Tether will remember it in a custom-paths file so future rescans keep including it.",
          );
          panelClass = "detect-panel detect-panel--ok";
          btnLabel = "Add to Tether";
          break;
        case "initAndAdd":
          label = "Not a git repo yet";
          body = h("span", {},
            h("code", {}, d.path),
            " is a plain directory. Tether will run ",
            h("code", {}, "git init"),
            " here and then start tracking it.",
          );
          panelClass = "detect-panel detect-panel--warn";
          btnLabel = "git init and add";
          currentInitGit = true;
          break;
      }

      detectPanel.className = panelClass;
      detectPanel.append(
        h("div", { class: "detect-state-label" }, label),
        h("div", { class: "detect-state-body" }, body),
      );
      clear(actionBtn);
      actionBtn.append(btnLabel);
    };

    render({ suggestion: "empty" });

    const kickDetect = () => {
      clearTimeout(debounceTimer);
      const raw = pathInput.value.trim();
      if (!raw) { render({ suggestion: "empty" }); return; }
      debounceTimer = setTimeout(async () => {
        try {
          const d = await api(`/api/projects/detect?path=${encodeURIComponent(raw)}`);
          render(d);
        } catch (err) {
          render({ suggestion: "notFound", path: raw });
        }
      }, 180);
    };
    pathInput.addEventListener("input", kickDetect);
    pathInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); form.requestSubmit(); }
    });

    const form = h("form", {
      class: "modal-form",
      onsubmit: async (e) => {
        e.preventDefault();
        if (!currentDetect) return;
        actionBtn.setAttribute("aria-busy", "true");
        errorBox.style.display = "none";
        try {
          if (currentDetect.suggestion === "jumpTo" && currentDetect.repoId) {
            close();
            await selectRepo(currentDetect.repoId);
            return;
          }
          if (currentDetect.suggestion === "notFound" || currentDetect.suggestion === "notDirectory" || currentDetect.suggestion === "empty") {
            throw new Error("Pick a valid directory first.");
          }
          const res = await api("/api/projects/add", {
            method: "POST",
            body: JSON.stringify({
              path: currentDetect.path,
              initGit: currentInitGit,
            }),
          });
          // Inject the new repo into the local list so the sidebar shows it
          // immediately without waiting for a full rescan.
          const existingIdx = state.repos.findIndex((r) => r.id === res.repo.id);
          if (existingIdx >= 0) state.repos[existingIdx] = res.repo;
          else state.repos.push(res.repo);
          state.repos.sort((a, b) => a.path.toLowerCase().localeCompare(b.path.toLowerCase()));
          filterRepos();
          renderRepoList();
          const msg = res.wasInitialized
            ? `git init + added ${res.repo.name}`
            : `Added ${res.repo.name}`;
          toast(msg);
          close();
          await selectRepo(res.repo.id);
        } catch (err) {
          errorBox.textContent = err.message || String(err);
          errorBox.style.display = "block";
        } finally {
          actionBtn.removeAttribute("aria-busy");
        }
      },
    },
      h("div", { class: "field" },
        h("label", {}, "Project path"),
        pathInput,
        h("div", { class: "field-hint" },
          "Absolute path. `~` expands to your home dir. Folders outside ", h("code", { style: { fontFamily: "var(--font-mono)" } }, "~"), " are remembered between launches.",
        ),
      ),
      detectPanel,
      errorBox,
      h("div", { class: "modal-footer" },
        h("button", { class: "btn btn-ghost", type: "button", onclick: close }, "Cancel"),
        actionBtn,
      ),
    );

    return h("div", { class: "modal", role: "dialog", "aria-modal": "true" },
      h("h3", {}, "Add a local project"),
      h("p", {}, "Point Tether at a directory on your machine. If it's already a git repo Tether will just start tracking it. If it's a plain directory Tether can run `git init` for you. Once added, use Create GitHub repo to wire it up."),
      form,
    );
  });
}

function promptAddRemote() {
  formModal({
    title: "Add remote",
    description: "Short name (origin / upstream / etc.) and a URL.",
    submitLabel: "Add remote",
    fields: [
      { name: "name", label: "Name", placeholder: "origin", value: state.detail?.remotes.length === 0 ? "origin" : "" },
      { name: "url", label: "URL", placeholder: "git@github.com:you/repo.git", hint: "SSH, HTTPS, or a local path all work." },
    ],
    onSubmit: async ({ name, url }) => {
      if (!name || !url) throw new Error("Both name and URL are required.");
      await api(`/api/repos/${state.selectedId}/remotes`, {
        method: "POST",
        body: JSON.stringify({ name, url }),
      });
      toast(`Added remote "${name}"`);
      state.githubCache.delete(state.selectedId);
      await refreshDetail();
    },
  });
}

function promptEditUrl(remote) {
  formModal({
    title: `Edit "${remote.name}" URL`,
    description: "Updates both fetch and push URLs.",
    submitLabel: "Update URL",
    fields: [{ name: "url", label: "Fetch/push URL", value: remote.fetchUrl }],
    onSubmit: async ({ url }) => {
      if (!url) throw new Error("URL is required.");
      await api(`/api/repos/${state.selectedId}/remotes/${encodeURIComponent(remote.name)}/url`, {
        method: "PATCH",
        body: JSON.stringify({ url, push: false }),
      });
      toast(`Updated "${remote.name}"`);
      state.githubCache.delete(state.selectedId);
      await refreshDetail();
    },
  });
}

function promptRename(remote) {
  formModal({
    title: `Rename "${remote.name}"`,
    submitLabel: "Rename",
    fields: [{ name: "newName", label: "New name", value: remote.name }],
    onSubmit: async ({ newName }) => {
      if (!newName) throw new Error("Name is required.");
      if (newName === remote.name) return;
      await api(`/api/repos/${state.selectedId}/remotes/${encodeURIComponent(remote.name)}/rename`, {
        method: "POST",
        body: JSON.stringify({ newName }),
      });
      toast(`Renamed to "${newName}"`);
      state.githubCache.delete(state.selectedId);
      await refreshDetail();
    },
  });
}

function promptRemoveRemote(remote) {
  confirmModal({
    title: `Remove "${remote.name}"?`,
    description: "The remote configuration is deleted locally only. The GitHub repo itself is untouched. Branches that tracked this remote lose their upstream.",
    confirmLabel: "Remove",
    danger: true,
    onConfirm: async () => {
      await api(`/api/repos/${state.selectedId}/remotes/${encodeURIComponent(remote.name)}`, { method: "DELETE" });
      toast(`Removed "${remote.name}"`);
      state.githubCache.delete(state.selectedId);
      await refreshDetail();
    },
  });
}

async function doFetch() {
  if (!state.selectedId) return;
  await api(`/api/repos/${state.selectedId}/fetch`, { method: "POST", body: JSON.stringify({}) });
  toast("Fetched all remotes");
  await refreshDetail();
}

async function doPull() {
  if (!state.selectedId) return;
  try {
    await api(`/api/repos/${state.selectedId}/pull`, { method: "POST", body: JSON.stringify({}) });
    toast("Pulled (fast-forward only)");
    await refreshDetail();
  } catch (err) {
    const m = err.message.toLowerCase();
    if (m.includes("non-fast-forward") || m.includes("diverge")) {
      toast("Pull rejected: branch has diverged — resolve in terminal", "err");
    } else {
      throw err;
    }
  }
}

function promptPush() {
  const d = state.detail;
  const current = d?.branches.find((b) => b.isCurrent);
  if (!current) { toast("No current branch to push", "err"); return; }

  const defaultRemote = current.upstream?.split("/")?.[0] || d.remotes[0]?.name || "origin";
  const enr = d.enrichment || {};
  const ghLinks = enr.githubRemotes || [];

  const performPush = async (remote, branch, acknowledgePublic) => {
    await api(`/api/repos/${state.selectedId}/push`, {
      method: "POST",
      body: JSON.stringify({
        remote, branch,
        setUpstream: !current.upstream,
        acknowledgePublic,
      }),
    });
    toast(`Pushed ${branch} → ${remote}`);
    await refreshDetail();
  };

  const linkFor = (remoteName) => ghLinks.find((l) => l.remoteName === remoteName);

  formModal({
    title: `Push ${current.name}`,
    description: "Tether runs `git push`. For public remotes you'll be asked to retype the repo name.",
    submitLabel: "Continue",
    fields: [
      { name: "remote", label: "Remote", value: defaultRemote },
      { name: "branch", label: "Branch", value: current.name },
    ],
    onSubmit: async ({ remote, branch }) => {
      const link = linkFor(remote);
      if (link?.visibility === "PUBLIC") {
        await publicPushRetypeGate(link, () => performPush(remote, branch, true));
      } else {
        await performPush(remote, branch, false);
      }
    },
  });
}

function publicPushRetypeGate(link, onConfirmed) {
  return new Promise((resolve, reject) => {
    formModal({
      title: "Confirm public push",
      submitLabel: "Push to public",
      submitClass: "btn btn-danger",
      topContent: h("div", { class: "push-safety-lead" },
        h("strong", {}, `You are about to push to a PUBLIC GitHub repo`),
        h("div", {}, `Anything pushed to `, h("code", {}, `${link.owner}/${link.repo}`), ` will be world-readable. Type the repo name to confirm.`),
      ),
      fields: [
        { name: "confirm", label: `Retype to confirm`, placeholder: link.repo, hint: `Expected: ${link.repo}` },
      ],
      onSubmit: async ({ confirm }) => {
        if (confirm !== link.repo) throw new Error(`Retyped name didn't match ${link.repo}.`);
        try { await onConfirmed(); resolve(); } catch (err) { reject(err); throw err; }
      },
    });
  });
}

function promptCreateGithubRepo() {
  const d = state.detail;
  if (!d) return;
  if (!state.gh.available || !state.gh.authenticated) {
    toast("Sign in to the GitHub CLI first (see banner).", "err");
    return;
  }

  const folderName = d.name;
  const defaultLogin = state.gh.user || "";

  formModal({
    title: "Create a new GitHub repo",
    description: "Creates the repo on GitHub via the gh CLI, then wires it as a remote on this local project.",
    submitLabel: "Create and connect",
    fields: [
      { name: "name", label: "Repo name", value: folderName, hint: "Defaults to the local folder name." },
      { name: "owner", label: "Owner", value: defaultLogin, hint: "Your username, or an organization you have access to." },
      { name: "description", label: "Description (optional)", placeholder: "One-line description…" },
      {
        name: "visibility",
        label: "Visibility",
        type: "radio",
        value: "private",
        options: [
          ["private", "Private", "Default. Only you and collaborators can see it."],
          ["public", "Public", "World-readable. Do not use for SaaS code or anything sensitive."],
        ],
      },
      { name: "remoteName", label: "Local remote name", value: "origin" },
      { name: "defaultBranch", label: "Default branch", value: "main" },
      { name: "gitignore", label: "Gitignore template (optional)", placeholder: "Python, Node, etc." },
      { name: "license", label: "License key (optional)", placeholder: "mit, apache-2.0, gpl-3.0…" },
      { name: "addReadme", label: "Initialize with a README", type: "checkbox", value: false, hint: "Only applies if the repo is empty on GitHub side." },
    ],
    onSubmit: async (v) => {
      if (!v.name) throw new Error("Name is required.");
      const body = {
        name: v.name,
        owner: v.owner || null,
        description: v.description || null,
        private: v.visibility !== "public",
        remoteName: v.remoteName || "origin",
        defaultBranch: v.defaultBranch || null,
        gitignore: v.gitignore || null,
        license: v.license || null,
        addReadme: !!v.addReadme,
      };

      if (!body.private) {
        await new Promise((resolve, reject) => {
          formModal({
            title: "Confirm public repo",
            submitLabel: "Create public repo",
            submitClass: "btn btn-danger",
            topContent: h("div", { class: "push-safety-lead" },
              h("strong", {}, "Creating a PUBLIC GitHub repo"),
              h("div", {}, "Anything you push here is world-readable. Retype the repo name to confirm."),
            ),
            fields: [
              { name: "confirm", label: `Retype "${body.name}"`, placeholder: body.name },
            ],
            onSubmit: async ({ confirm }) => {
              if (confirm !== body.name) throw new Error(`Retyped name didn't match "${body.name}".`);
              resolve();
            },
          });
        });
      }

      const res = await api(`/api/repos/${state.selectedId}/github/create`, {
        method: "POST",
        body: JSON.stringify(body),
      });
      toast(`Created ${res.owner}/${res.name} — connected as "${body.remoteName}"`);
      state.githubCache.delete(state.selectedId);
      await refreshDetail();
      state.activeTab = "github";
      renderDetail();
    },
  });
}

function promptSetVisibility(entry) {
  const info = entry.info || {};
  if (!info.visibility) return;
  const currentIsPublic = info.visibility === "PUBLIC";
  const target = currentIsPublic ? "private" : "public";

  const run = async (acknowledge) => {
    const res = await api(`/api/repos/${state.selectedId}/github/${encodeURIComponent(entry.remoteName)}/visibility`, {
      method: "PATCH",
      body: JSON.stringify({ visibility: target, acknowledge }),
    });
    toast(`${entry.owner}/${entry.repo} is now ${res.visibility.toLowerCase()}`);
    state.githubCache.delete(state.selectedId);
    await refreshDetail();
  };

  if (target === "private") {
    confirmModal({
      title: `Make ${entry.owner}/${entry.repo} private?`,
      description: "Changes GitHub visibility. Existing forks remain public; stars reset.",
      confirmLabel: "Make private",
      onConfirm: () => run(false),
    });
    return;
  }

  formModal({
    title: `Make ${entry.owner}/${entry.repo} public?`,
    submitLabel: "Make public",
    submitClass: "btn btn-danger",
    topContent: h("div", { class: "push-safety-lead" },
      h("strong", {}, "This will make the entire repo world-readable"),
      h("div", {}, "Past commits and all current files become public. Retype the repo name to confirm."),
    ),
    fields: [
      { name: "confirm", label: `Retype "${entry.repo}"`, placeholder: entry.repo },
    ],
    onSubmit: async ({ confirm }) => {
      if (confirm !== entry.repo) throw new Error(`Retyped name didn't match "${entry.repo}".`);
      await run(true);
    },
  });
}

async function toggleSensitive() {
  if (!state.selectedId) return;
  const enr = state.detail?.enrichment || {};
  const target = !enr.sensitive;
  await api(`/api/repos/${state.selectedId}/sensitive`, {
    method: "POST",
    body: JSON.stringify({ value: target }),
  });
  toast(target ? "Marked sensitive" : "Unmarked sensitive");
  await refreshDetail();
}

// --- Top-level actions --------------------------------------------

async function doRescan() {
  const btn = $("#btn-rescan");
  btn.setAttribute("aria-busy", "true");
  try {
    const res = await api("/api/rescan", { method: "POST" });
    state.repos = res.repos;
    state.githubCache.clear();
    filterRepos();
    renderMeta();
    renderRepoList();
    toast(`Found ${res.count} repositories`);
    if (state.activeView === "repo" && state.selectedId) {
      if (!state.repos.find((r) => r.id === state.selectedId)) {
        state.selectedId = null;
        state.activeView = "empty";
        renderDetail();
      } else {
        await refreshDetail();
      }
    } else if (state.activeView === "audit") {
      state.audit = await api("/api/audit");
      renderDetail();
    }
  } catch (err) {
    toast(err.message, "err");
  } finally {
    btn.removeAttribute("aria-busy");
  }
}

function renderGoodbye() {
  clear(document.body);
  const wrap = h("div", {
    style: {
      display: "grid",
      placeItems: "center",
      height: "100vh",
      fontFamily: "Fraunces, serif",
      color: "#1C1713",
      background: "#F3EEE4",
    },
  },
    h("div", { style: { textAlign: "center" } },
      h("h1", { style: { fontSize: "42px", margin: "0 0 12px", fontWeight: "600" } }, "Goodbye."),
      h("p", { style: { fontFamily: "'IBM Plex Mono', monospace", color: "#75695C", fontSize: "13px" } }, "You can close this tab."),
    ),
  );
  document.body.append(wrap);
}

function doQuit() {
  confirmModal({
    title: "Quit Tether?",
    description: "Shuts down the local server. Start it again from your app menu.",
    confirmLabel: "Quit",
    danger: true,
    onConfirm: async () => {
      try { await api("/api/quit", { method: "POST" }); } catch {}
      renderGoodbye();
    },
  });
}

// --- Boot ----------------------------------------------------------

async function boot() {
  $("#btn-rescan").addEventListener("click", doRescan);
  $("#btn-quit").addEventListener("click", doQuit);

  const search = $("#search");
  search.addEventListener("input", (e) => {
    state.query = e.target.value;
    filterRepos();
    renderRepoList();
  });

  document.addEventListener("keydown", (e) => {
    if (e.key === "/" && document.activeElement !== search) {
      e.preventDefault(); search.focus(); search.select();
    }
    if (e.key === "Escape" && document.activeElement === search) {
      search.value = ""; state.query = "";
      filterRepos(); renderRepoList();
    }
  });

  try {
    await waitForInitialScan();
    const res = await api("/api/repos");
    state.repos = res.repos;
    filterRepos();
    renderAuthBanner();
    renderMeta();
    renderRepoList();
  } catch (err) {
    toast(`Can't reach the Tether server: ${err.message}`, "err");
  }
}

async function waitForInitialScan() {
  // Poll /api/meta until the background scan finishes or errors out.
  // The launcher now returns as soon as uvicorn binds, so the UI can load
  // before the scan has any repos to show.
  const started = Date.now();
  const maxWaitMs = 60000;
  while (true) {
    const meta = await api("/api/meta");
    state.root = meta.root;
    state.gh = meta.gh;
    const scan = meta.scan || {};
    if (scan.lastError) {
      toast(`Scan error: ${scan.lastError}`, "err");
    }
    // First paint — always render what we have so far so the user sees chrome.
    renderAuthBanner();
    renderMeta();
    if (!scan.inProgress || scan.lastCompletedAt) break;
    if (Date.now() - started > maxWaitMs) {
      toast("Initial scan is taking a while. Showing what we have so far.", "err");
      break;
    }
    // Show a scanning placeholder in the repo list while we wait.
    const list = $("#repo-list");
    if (list && !list.querySelector(".list-state--scanning")) {
      clear(list);
      list.append(h("div", { class: "list-state list-state--scanning" },
        h("span", { class: "spinner" }),
        "Scanning your repositories…",
      ));
    }
    await new Promise((r) => setTimeout(r, 500));
  }
}

boot();
