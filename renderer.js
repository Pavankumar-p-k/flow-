const $ = (id) => document.getElementById(id);

let state = { online: false, sessions: [], active: {}, stats: null, agentNames: {} };
let media = { active: false };
let expanded = false;
let pinned = false;

/* ---------- helpers ---------- */

function fmt(n) {
  if (n >= 1e9) return (n / 1e9).toFixed(1) + "B";
  if (n >= 1e6) return (n / 1e6).toFixed(1) + "M";
  if (n >= 1e3) return (n / 1e3).toFixed(1) + "k";
  return String(n);
}

function sessTokens(s) {
  const t = s.tokens || {};
  return (t.input || 0) + (t.output || 0) + (t.reasoning || 0) + ((t.cache && t.cache.read) || 0);
}

function badgeClass(agent) {
  if (agent === "plan") return "plan";
  if (agent === "general") return "general";
  return "";
}

/* ---------- render ---------- */

function render() {
  // pill
  const activeIds = Object.keys(state.active || {});
  const busyCount = activeIds.length;
  $("pill-count").textContent = busyCount > 0 ? busyCount + " active" : state.sessions.length + " sess";
  $("pill-dot").className = "dot" + (busyCount > 0 ? " live" : "");
  $("head-dot").className = "dot" + (busyCount > 0 ? " live" : "");

  const st = state.stats;
  if (st && st.tokens) {
    $("pill-tokens").textContent = fmt((st.tokens.input || 0) + (st.tokens.output || 0));
  }

  // head status
  const hs = $("head-status");
  if (state.online) {
    hs.textContent = busyCount > 0 ? busyCount + " running" : "idle";
    hs.className = "ok";
  } else {
    hs.textContent = "offline";
    hs.className = "err";
  }

  // KPI tiles — each widget carries its own accent color
  const kAct = $("kpi-active");
  kAct.textContent = String(busyCount);
  kAct.parentElement.className = "kpi " + (busyCount > 0 ? "k-green" : "k-blue");
  $("kpi-sub").textContent = state.sessions.length + " session" + (state.sessions.length === 1 ? "" : "s");
  $("agents-meta").textContent = state.sessions.length + "/" + (busyCount > 0 ? busyCount + " live" : "idle");

  // agents list — token mini-bars relative to the biggest session
  const list = $("agent-list");
  const sessions = [...(state.sessions || [])].sort((a, b) => {
    const ba = state.active[a.id] ? 1 : 0;
    const bb = state.active[b.id] ? 1 : 0;
    if (ba !== bb) return bb - ba;
    return (b.time && b.time.updated || 0) - (a.time && a.time.updated || 0);
  });

  if (sessions.length === 0) {
    list.innerHTML = '<div class="empty">' + (state.online ? "No sessions yet" : "Cannot reach OpenCode") + "</div>";
  } else {
    const top = sessions.slice(0, 12);   // own panel now → room for more
    const maxTok = Math.max(1, ...top.map(sessTokens));
    list.innerHTML = top.map((s) => {
      const busy = !!state.active[s.id];
      const agent = s.agent || "build";
      const name = state.agentNames[agent] || agent;
      const model = s.model ? s.model.id : "";
      const sub = name + (model ? " · " + model : "");
      const title = s.title || s.id;
      const tok = sessTokens(s);
      const pct = Math.max(4, (tok / maxTok) * 100);
      return (
        '<div class="agent-row">' +
        '<span class="dot' + (busy ? " live" : "") + '"></span>' +
        '<div class="agent-title" title="' + escapeAttr(title) + '">' + escapeHtml(title) + "</div>" +
        '<span class="agent-badge ' + badgeClass(agent) + '">' + escapeHtml(agent) + "</span>" +
        '<div class="agent-sub">' + escapeHtml(sub) + "</div>" +
        '<div class="tok-cell" title="' + escapeAttr(fmt(tok)) + ' tokens">' +
        '<div class="tok-bar"><div class="tok-fill' + (busy ? " busy" : "") + '" style="width:' + pct.toFixed(1) + '%"></div></div>' +
        '<span class="agent-tok' + (busy ? " busy" : "") + '">' + fmt(tok) + "</span>" +
        "</div>" +
        "</div>"
      );
    }).join("");
  }

  // usage charts: donut + legend + activity bars + tool success bar
  if (st && st.tokens) {
    const t = st.tokens;
    const cacheR = (t.cache && t.cache.read) || 0;
    $("u-in").textContent = fmt(t.input || 0);
    $("u-out").textContent = fmt(t.output || 0);
    $("u-reason").textContent = fmt(t.reasoning || 0);
    $("u-cache").textContent = fmt(cacheR);

    const parts = [t.input || 0, t.output || 0, t.reasoning || 0, cacheR];
    const colors = ["#26A5E4", "#3DD68C", "#B892FF", "#E39A4C"];
    const sum = parts.reduce((a, b) => a + b, 0);

    // token KPI tile (violet accent)
    $("kpi-tokens").textContent = fmt(sum);
    $("kpi-tok-sub").textContent = "in " + fmt(t.input || 0) + " · out " + fmt(t.output || 0);

    const donut = $("donut");
    if (sum > 0) {
      let acc = 0;
      const stops = [];
      for (let i = 0; i < parts.length; i++) {
        const a = (acc / sum) * 360;
        acc += parts[i];
        const b = (acc / sum) * 360;
        stops.push(colors[i] + " " + a.toFixed(2) + "deg " + b.toFixed(2) + "deg");
      }
      donut.style.background = "conic-gradient(" + stops.join(",") + ")";
    } else {
      donut.style.background = "conic-gradient(#2c2c2e 0deg 360deg)";
    }
    $("donut-total").textContent = fmt(sum);

    // activity bar chart (steps per day)
    const act = (st.activity || []).slice(-7);
    const chart = $("activity-chart");
    if (act.length) {
      const maxA = Math.max(1, ...act.map((a) => a.steps || 0));
      chart.innerHTML = act.map((a) => {
        const pct = Math.max(6, ((a.steps || 0) / maxA) * 100);
        const day = (a.date || "").slice(5).replace("-", "/");
        return (
          '<div class="act-col" title="' + (a.steps || 0) + ' steps">' +
          '<div class="act-track"><div class="act-bar" style="height:' + pct.toFixed(1) + '%"></div></div>' +
          '<span class="act-lbl">' + escapeHtml(day) + "</span>" +
          "</div>"
        );
      }).join("");
    } else {
      chart.innerHTML = '<div class="empty">no activity</div>';
    }

    // tool success stacked bar + KPI tile
    const tt = st.tools && st.tools.totals;
    if (tt) {
      const total = Math.max(1, tt.calls || 0);
      const okPct = ((tt.succeeded || 0) / total) * 100;
      $("tools-ok").style.width = okPct.toFixed(1) + "%";
      $("tools-fail").style.width = (((tt.failed || 0) / total) * 100).toFixed(1) + "%";
      $("tools-run").style.width = (((tt.unfinished || 0) / total) * 100).toFixed(1) + "%";
      $("tools-val").textContent = (tt.succeeded || 0) + "/" + (tt.calls || 0);

      // success-rate tile: green when healthy, amber mid, red below 80%
      $("kpi-tools").textContent = okPct.toFixed(0) + "%";
      $("kpi-tools-sub").textContent = (tt.failed || 0) + " failed · " + (tt.unfinished || 0) + " running";
      $("kpi-tools").parentElement.className =
        "kpi " + (okPct >= 95 ? "k-green" : okPct >= 80 ? "k-amber" : "k-red");
    }
  } else {
    $("kpi-tokens").textContent = "—";
    $("kpi-tok-sub").textContent = "no stats";
    $("kpi-tools").textContent = "—";
    $("kpi-tools-sub").textContent = "no stats";
    $("kpi-tools").parentElement.className = "kpi k-violet";
    $("kpi-active").parentElement.className = "kpi k-blue";
  }

  // media icon on pill
  $("pill-media").classList.toggle("playing", media.active && media.status === "Playing");

  // the pill is content-sized: re-report once the label has resized it
  reportRects();
}

function renderMedia() {
  const t = $("media-title");
  const a = $("media-artist");
  const on = media.active && media.title;
  if (on) {
    t.textContent = media.title;
    a.textContent = [media.artist, media.app].filter(Boolean).join(" · ");
  } else {
    t.textContent = "Nothing playing";
    a.textContent = "";
  }
  const playing = !!(media.active && media.status === "Playing");
  $("pill-media").classList.toggle("playing", playing);
  $("media-art").classList.toggle("playing", playing);

  // progress bar — only when the source reports a real timeline
  let pct = 0;
  if (typeof media.position === "number" && typeof media.duration === "number" && media.duration > 1) {
    pct = Math.max(0, Math.min(100, (media.position / media.duration) * 100));
  }
  $("media-track-fill").style.width = pct.toFixed(1) + "%";

  // elapsed / total time under the track
  const mmss = (s) => {
    if (typeof s !== "number" || s < 0) return "0:00";
    const m = Math.floor(s / 60), r = Math.floor(s % 60);
    return m + ":" + String(r).padStart(2, "0");
  };
  $("media-pos").textContent = mmss(media.position);
  $("media-dur").textContent = mmss(media.duration);
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function escapeAttr(s) { return escapeHtml(s); }

/* ---------- layout ---------- */

function applyLayout() {
  $("notch").className = expanded ? "expanded" : "collapsed";
  $("pin-btn").classList.toggle("on", pinned);
  reportRects();
}

/* ---------- pages (sessions / music) ---------- */

const PAGES = ["sessions", "music", "chat"];
let page = "sessions";
try { const p = localStorage.getItem("page"); if (PAGES.includes(p)) page = p; } catch {}

function setPage(p) {
  if (!PAGES.includes(p)) return;
  if (p === page && $("page-" + p).classList.contains("active")) return;
  page = p;
  try { localStorage.setItem("page", p); } catch {}
  document.querySelectorAll(".pg-tab").forEach((b) => b.classList.toggle("active", b.dataset.page === p));
  document.querySelectorAll(".pg-dot").forEach((d) => d.classList.toggle("active", d.dataset.page === p));
  PAGES.forEach((k) => $("page-" + k).classList.toggle("active", k === p));
  restoreSub(p);
  if (p === "chat") refreshWaPage();
  reportRects();
}

document.querySelectorAll(".pg-tab, .pg-dot").forEach((el) => {
  el.addEventListener("click", (e) => {
    e.stopPropagation();
    console.log("CLICK pg-tab " + el.dataset.page);
    setPage(el.dataset.page);
  });
});

/* ---------- sub panels (focused views inside a page) ---------- */

// The main process hides the notch with CSS (never win.hide() — that breaks
// transparent-window painting on Windows) while the intro overlay runs.
window.notch.onIntroVisible((v) => { $("notch").classList.toggle("intro-hidden", !v); });

// #fs — full-screen video/game detected: dim the notch (body class keeps it
// safe from the wholesale className writes on #notch). CSS handles hover:
// expanded (i.e. the mouse is on it) restores full brightness.
window.notch.onFullscreen((v) => { document.body.classList.toggle("fs-dim", !!v); });

function setSub(pageEl, subId) {
  if (!pageEl || !subId) return;
  const subs = [...pageEl.querySelectorAll(".sub")];
  if (!subs.some((s) => s.id === subId)) return;
  pageEl.querySelectorAll(".sub-tab").forEach((b) => b.classList.toggle("active", b.dataset.sub === subId));
  subs.forEach((s) => s.classList.toggle("active", s.id === subId));
  if (subId === "w-shots") loadShots(); // #4 — refresh the gallery each open
  try { localStorage.setItem("sub-" + pageEl.id, subId); } catch {}
}

function restoreSub(p) {
  const pageEl = $("page-" + p);
  if (!pageEl) return;
  try {
    const saved = localStorage.getItem("sub-" + pageEl.id);
    if (saved) setSub(pageEl, saved);
  } catch {}
}

document.querySelectorAll(".sub-tabs").forEach((row) => {
  row.addEventListener("click", (e) => {
    const btn = e.target.closest(".sub-tab");
    console.log("CLICK sub-tabs row=" + row.parentElement.id + " target=" + (e.target.className || e.target.tagName) + " btn=" + (btn ? btn.dataset.sub : "none"));
    if (!btn) return;
    e.stopPropagation();
    setSub(row.parentElement, btn.dataset.sub);
  });
});

/* ---------- events ---------- */

window.notch.onState((d) => { state = d; render(); });
window.notch.onMedia((d) => { media = d || {}; renderMedia(); });
window.notch.onLayout((d) => {
  expanded = !!d.expanded;
  pinned = !!d.pinned;
  applyLayout();
});

const root = $("notch");

// The main process watches the cursor against these rects (same approach as
// Dexter), so the transparent parts of the window stay click-through and the
// nub / panel are the only things that catch the mouse.
let lastRectsJson = "";
function reportRects() {
  const grab = (el) => {
    if (!el) return null;
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return null; // display:none
    return { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) };
  };
  const rects = { pill: grab($("pill")), panel: grab($("panel-wrap")) };
  const json = JSON.stringify(rects);
  if (json === lastRectsJson) return;
  lastRectsJson = json;
  window.notch.setRects(rects);
  console.log("RECTS " + json);
}

$("pin-btn").addEventListener("click", (e) => {
  e.stopPropagation();
  window.notch.togglePin();
});

document.querySelectorAll(".mctrl").forEach((btn) => {
  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    window.notch.media(btn.dataset.action);
  });
});

document.addEventListener("keydown", (e) => {
  console.log("KEY code=" + e.code + " key=" + e.key +
    " mod=" + (e.ctrlKey ? "C" : "-") + (e.altKey ? "A" : "-") + (e.metaKey ? "M" : "-") + (e.shiftKey ? "S" : "-"));
  if (e.key === "Escape") window.notch.forceCollapse();
  const i = PAGES.indexOf(page);
  if (e.key === "ArrowLeft") setPage(PAGES[(i + PAGES.length - 1) % PAGES.length]);
  if (e.key === "ArrowRight") setPage(PAGES[(i + 1) % PAGES.length]);
  // up / down steps through the sub panels of the current page
  if (e.key === "ArrowUp" || e.key === "ArrowDown") {
    const pageEl = $("page-" + page);
    const subs = [...pageEl.querySelectorAll(".sub")];
    if (subs.length > 1) {
      const cur = subs.findIndex((s) => s.classList.contains("active"));
      const n = ((cur < 0 ? 0 : cur) + (e.key === "ArrowDown" ? 1 : subs.length - 1)) % subs.length;
      setSub(pageEl, subs[n].id);
    }
  }
});

// prevent drag-selection quirks on the pill
$("pill").addEventListener("click", (e) => { e.preventDefault(); window.notch.mouseEnter(); });

applyLayout();
setPage(page);
restoreSub(page);
render();
renderMedia();

// diagnostics: log any change of the rendered pill / window size (bug
// report: pill reportedly shrinks to ~5x15mm on a keyboard hotkey)
(() => {
  let lw = -1, lh = -1, ww = -1, wh = -1;
  setInterval(() => {
    const p = $("pill");
    if (!p) return;
    const w = p.offsetWidth, h = p.offsetHeight;
    if (w !== lw || h !== lh) {
      if (lw !== -1) console.log("PILL size " + w + "x" + h + " (was " + lw + "x" + lh + ")");
      lw = w; lh = h;
    }
    if (window.innerWidth !== ww || window.innerHeight !== wh) {
      if (ww !== -1) console.log("WIN size " + window.innerWidth + "x" + window.innerHeight + " (was " + ww + "x" + wh + ")");
      ww = window.innerWidth; wh = window.innerHeight;
    }
  }, 500);
})();

// cat GIFs: alternate between the two desktop cats (nub + panel strip)
(() => {
  const cats = ["assets/cat1.gif", "assets/cat2.gif"];
  const imgs = () => [$("pill-cat"), $("panel-cat-img")].filter(Boolean);
  cats.forEach((s) => { new Image().src = s; }); // preload so the swap is seamless
  let i = 0;
  setInterval(() => {
    i = (i + 1) % cats.length;
    imgs().forEach((img) => { img.src = cats[i]; });
  }, 9000);
})();

/* ---------- whatsapp bridge page ---------- */

const waState = { status: "idle", qr: null, error: "", jid: null };
let waPending = [];
let reposCache = null;

function renderWa() {
  const st = $("wa-state");
  const qrWrap = $("wa-qr-wrap");
  const conn = $("wa-connected");
  const err = $("wa-error");
  const btn = $("wa-btn");
  const s = waState.status;

  st.textContent =
    s === "open" ? "linked" :
    s === "qr" ? "scan qr" :
    s === "connecting" ? "connecting…" :
    s === "closed" ? "disconnected" :
    s === "error" ? "error" : "idle";
  st.style.color = s === "open" ? "var(--green)" : s === "error" ? "var(--red)" : "var(--ink-4)";

  qrWrap.classList.toggle("show", s === "qr" && !!waState.qr);
  if (waState.qr) $("wa-qr").src = waState.qr;
  conn.classList.toggle("show", s === "open");
  $("wa-jid").textContent = waState.jid || "—";
  err.textContent = s === "open" ? "" : (waState.error || "");

  btn.textContent =
    s === "open" ? "Reconnect" :
    s === "qr" ? "Waiting for scan…" :
    (s === "connecting" || s === "closed") ? "Retry" : "Link WhatsApp";
  btn.disabled = s === "qr" || s === "connecting";
  btn.style.opacity = btn.disabled ? ".55" : "1";
}

function renderPending() {
  const box = $("wa-pending");
  $("wa-pending-count").textContent = String(waPending.length);
  if (!waPending.length) {
    box.innerHTML = '<div class="empty">No prompts waiting</div>';
    return;
  }
  box.innerHTML = waPending.map((p) => (
    '<div class="prompt-row">' +
    '<div class="prompt-main">' +
    '<div class="prompt-title">#' + escapeHtml(String(p.seq)) + " " + escapeHtml(p.title || p.kind) + "</div>" +
    '<div class="prompt-sub">' + escapeHtml(p.kind) + " · " + escapeHtml((p.sessionID || "").slice(0, 14)) + "</div>" +
    "</div>" +
    (p.kind === "permission"
      ? '<div class="prompt-btns">' +
        '<button class="pb-allow" data-cmd="' + p.seq + ' allow">allow</button>' +
        '<button class="pb-reject" data-cmd="' + p.seq + ' reject">reject</button>' +
        "</div>"
      : '<div class="prompt-btns"><span class="prompt-sub">reply in chat</span></div>') +
    "</div>"
  )).join("");
  box.querySelectorAll("button[data-cmd]").forEach((b) => {
    b.addEventListener("click", (e) => {
      e.stopPropagation();
      window.notch.waCommand(b.dataset.cmd);
      // optimistic removal: the bridge will confirm via wa-event
      const seq = Number(b.dataset.cmd.split(" ")[0]);
      waPending = waPending.filter((x) => x.seq !== seq);
      renderPending();
    });
  });
}

function renderRepos() {
  const box = $("repos-list");
  if (!reposCache) {
    box.innerHTML = '<div class="empty">scanning…</div>';
    return;
  }
  $("repos-count").textContent = String(reposCache.length);
  if (!reposCache.length) {
    box.innerHTML = '<div class="empty">no git repos found</div>';
    return;
  }
  box.innerHTML = reposCache.map((r) => (
    '<div class="repo-row" title="' + escapeAttr(r.dir) + '">' +
    '<span class="repo-name">' + escapeHtml(r.name) + "</span>" +
    '<span class="repo-branch">' + escapeHtml(r.branch || "?") + "</span>" +
    (r.dirty ? '<span class="repo-dirty">' + r.dirty + " Δ</span>" : "") +
    (r.ahead ? '<span class="repo-dirty">↑' + r.ahead + "</span>" : "") +
    '<span class="repo-age">' + escapeHtml(r.lastAge || "") + "</span>" +
    "</div>"
  )).join("");
}

async function refreshWaPage() {
  try {
    const s = await window.notch.waStatus();
    if (s) { Object.assign(waState, s); renderWa(); }
  } catch {}
  if (!reposCache) {
    try {
      reposCache = await window.notch.waRepos();
      renderRepos();
    } catch {}
  }
}

/* ---------- screenshot gallery (#4) ---------- */
let shotsLoaded = false;

function fmtShotTime(ms) {
  const d = new Date(ms);
  const sameDay = d.toDateString() === new Date().toDateString();
  const hm = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  return sameDay ? hm : d.toLocaleDateString([], { month: "short", day: "numeric" }) + " " + hm;
}

async function loadShots() {
  const grid = $("shots-grid");
  if (!grid) return;
  if (!shotsLoaded) grid.innerHTML = '<div class="empty">loading…</div>';
  try {
    const shots = await window.notch.shotsList();
    $("shots-count").textContent = String(shots.length);
    if (!shots.length) {
      grid.innerHTML = '<div class="empty">no screenshots yet — ask for one in chat</div>';
      return;
    }
    grid.innerHTML = shots.map((s, i) => (
      '<div class="shot" data-i="' + i + '" title="' + escapeAttr(s.name) + '">' +
      (s.thumb
        ? '<img class="shot-img" src="' + s.thumb + '" alt="" draggable="false"/>'
        : '<div class="shot-img shot-ph">' + escapeHtml(s.name.slice(0, 18)) + "</div>") +
      '<span class="shot-when">' + escapeHtml(fmtShotTime(s.mtime)) + "</span>" +
      '<button class="shot-send" data-i="' + i + '" title="send to chat">&#8599;</button>' +
      "</div>"
    )).join("");
    shotsLoaded = true;
    grid.querySelectorAll(".shot").forEach((el) => {
      el.addEventListener("click", (e) => {
        if (e.target.closest(".shot-send")) return;
        window.notch.shotsOpen(shots[Number(el.dataset.i)].path);
      });
    });
    grid.querySelectorAll(".shot-send").forEach((b) => {
      b.addEventListener("click", (e) => {
        e.stopPropagation();
        window.notch.shotsSend(shots[Number(b.dataset.i)].path);
        b.textContent = "✓";
        setTimeout(() => { b.innerHTML = "&#8599;"; }, 1500);
      });
    });
  } catch (e) {
    grid.innerHTML = '<div class="empty">gallery unavailable</div>';
  }
}

$("wa-btn").addEventListener("click", (e) => {
  e.stopPropagation();
  window.notch.waConnect();
});
$("wa-btn-unlink").addEventListener("click", (e) => {
  e.stopPropagation();
  window.notch.waForget();
  waState.status = "idle";
  waState.qr = null;
  waState.jid = null;
  renderWa();
});

window.notch.onWaStatus((s) => { Object.assign(waState, s); renderWa(); });
window.notch.onWaQr((dataUrl) => { waState.qr = dataUrl; waState.status = "qr"; renderWa(); });
window.notch.onWaEvent((e) => {
  if (!e) return;
  if (e.type === "pending") { waPending = e.items || []; renderPending(); }
  if (e.type === "repos") { reposCache = e.items || []; renderRepos(); }
  if (e.type === "gh") flashNotch();
});

/* GitHub watcher found something → brief green glow on the notch.
   Class goes on <body>: #notch.className is rewritten wholesale on every
   expand/collapse, so a class on #notch itself would be wiped. */
let ghFlashTimer = null;
function flashNotch() {
  document.body.classList.remove("gh-flash");
  void document.body.offsetWidth; // restart the animation
  document.body.classList.add("gh-flash");
  clearTimeout(ghFlashTimer);
  ghFlashTimer = setTimeout(() => document.body.classList.remove("gh-flash"), 3600);
}

/* weather pill: main pushes fresh conditions every 30 min (#feature 3) */
window.notch.onWeather((w) => {
  const el = $("pill-weather");
  if (!el || !w || !w.ok) return;
  el.textContent = w.emoji + " " + w.temp + "°";
  el.title = w.city + " · " + w.text + " · feels " + w.feels + "°";
  el.style.display = "";
});

/* ---------- drag-drop → WhatsApp (#9) ----------
   The window is click-through outside the notch rects, so a drag can leave
   the window without a dragleave — a 500ms watchdog clears the veil when
   dragover events stop arriving. */
let dragDepth = 0;
let dragWatch = null;
let dropToastTimer = null;

function isFileDrag(e) {
  const dt = e.dataTransfer;
  return !!dt && !!dt.types && Array.from(dt.types).indexOf("Files") !== -1;
}

function showDropToast(msg, ms) {
  const el = $("drop-toast");
  el.textContent = msg;
  el.classList.add("show");
  clearTimeout(dropToastTimer);
  dropToastTimer = setTimeout(() => el.classList.remove("show"), ms || 4000);
}

function armDragWatch() {
  clearTimeout(dragWatch);
  dragWatch = setTimeout(() => {
    dragDepth = 0;
    document.body.classList.remove("dropping");
  }, 500);
}

document.addEventListener("dragenter", (e) => {
  if (!isFileDrag(e)) return;
  e.preventDefault();
  dragDepth++;
  document.body.classList.add("dropping");
  armDragWatch();
});

document.addEventListener("dragover", (e) => {
  if (!isFileDrag(e)) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = "copy";
  // the window is click-through until the hover watch un-ignores it (100ms
  // tick), so the initial dragenter can be missed — recover on dragover
  if (!document.body.classList.contains("dropping")) {
    dragDepth = Math.max(dragDepth, 1);
    document.body.classList.add("dropping");
  }
  armDragWatch();
});

document.addEventListener("dragleave", (e) => {
  if (!isFileDrag(e)) return;
  dragDepth = Math.max(0, dragDepth - 1);
  if (dragDepth === 0) document.body.classList.remove("dropping");
});

document.addEventListener("drop", (e) => {
  if (!isFileDrag(e)) return;
  e.preventDefault();
  dragDepth = 0;
  clearTimeout(dragWatch);
  document.body.classList.remove("dropping");
  const files = Array.from((e.dataTransfer && e.dataTransfer.files) || []);
  const paths = [];
  for (const f of files) {
    try {
      const p = window.notch.getPathForFile(f);
      if (p) paths.push(p);
    } catch {}
  }
  if (!paths.length) { showDropToast("⚠️ couldn't read those files"); return; }
  showDropToast("📤 sending " + paths.length + " file(s) to WhatsApp…", 6000);
  window.notch.filesDropped(paths);
});

window.notch.onDropStatus((d) => {
  if (!d) return;
  if (d.error) { showDropToast("⚠️ " + d.error, 4500); return; }
  let msg = d.sent ? "✅ sent " + d.sent + " file(s) to WhatsApp" : "⚠️ nothing sent";
  if (d.rejected && d.rejected.length) msg += " · skipped " + d.rejected.length + ": " + d.rejected[0];
  showDropToast(msg, 4500);
});

renderWa();
renderPending();
renderRepos();
