const { app, BrowserWindow, ipcMain, screen, Tray, Menu, nativeImage, clipboard, globalShortcut } = require("electron");
const path = require("path");
const fs = require("fs");
const os = require("os");
const { spawn, execFile } = require("child_process");
const { pathToFileURL } = require("url");

const SERVICE_FILE = path.join(os.homedir(), ".local", "state", "opencode", "service.json");
const RUN_KEY = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run";
const AUTOSTART_VALUE = "AgentNotch";
const ELECTRON_EXE = process.execPath;
const APP_DIR = __dirname;
const CONFIG_FILE = path.join(APP_DIR, "config.json");

const wa = require("./whatsapp");
const bridge = require("./bridge");
const INTRO = require("./intro/intro.config");   // one config: clips + timings

// Dexter's nub is 96x28 r12; the window adds room for the shoulder flares
// and the idle glow (0 10px 34px), which would otherwise be clipped.
const COLLAPSED = { w: 264, h: 80 };
const EXPANDED = { w: 460, h: 540 };
const POLL_MS = 4000;

let win = null;
let tray = null;
let expanded = false;
let pinned = false;
let leaveTimer = null;
let animTimer = null;
let mediaChild = null;
let mediaLine = "";
let prevActive = null;
let lastState = null;

// Intro overlay state (see the Intro section below)
let introWin = null;
let introOriginY = 80;
let introEsc = false;
let introClickChild = null;
let introClickTimer = null;
const INTRO_FLAG = path.join(os.tmpdir(), "notch-intro-click.flag");

/* ---------- Config + phone notifications (ntfy.sh) ---------- */

function loadConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8")); } catch { return null; }
}
function saveConfig(c) {
  try { fs.writeFileSync(CONFIG_FILE, JSON.stringify(c, null, 2)); } catch {}
}
let config = loadConfig();
if (!config || !config.ntfyTopic) {
  config = config || {};
  config.ntfyTopic = "agent-notch-" + Math.random().toString(36).slice(2, 8) + Math.random().toString(36).slice(2, 6);
  if (config.notifyEnabled == null) config.notifyEnabled = true;
  saveConfig(config);
}

function notify(title, message, tags) {
  if (!config || config.notifyEnabled === false || !config.ntfyTopic) return;
  try {
    fetch("https://ntfy.sh/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ topic: config.ntfyTopic, title, message, tags: tags || ["robot"], priority: 3 }),
    }).catch(() => {});
  } catch {}
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (win) {
      expand();
      win.showInactive();
    }
  });
}

/* ---------- OpenCode API ---------- */

function readService() {
  try {
    return JSON.parse(fs.readFileSync(SERVICE_FILE, "utf8"));
  } catch {
    return null;
  }
}

async function apiGet(p) {
  const svc = readService();
  if (!svc || !svc.url) throw new Error("service file missing: " + SERVICE_FILE);
  const auth = Buffer.from(`opencode:${svc.password}`).toString("base64");
  const res = await fetch(svc.url + p, { headers: { Authorization: "Basic " + auth } });
  if (!res.ok) throw new Error("HTTP " + res.status);
  return res.json();
}

async function poll() {
  let state;
  try {
    const [sessions, active, stats, agents] = await Promise.all([
      apiGet("/api/session?limit=50"),
      apiGet("/api/session/active"),
      apiGet("/api/experimental/session/stats"),
      apiGet("/api/agent"),
    ]);
    const agentNames = {};
    for (const a of agents.data || []) agentNames[a.id] = a.name || a.id;
    state = {
      online: true,
      sessions: sessions.data || [],
      active: active.data || {},
      stats: stats.data || null,
      agentNames,
      ts: Date.now(),
    };
  } catch (e) {
    state = { online: false, sessions: [], active: {}, stats: null, agentNames: {}, ts: Date.now(), error: String(e.message || e) };
    try {
      fs.appendFileSync(path.join(APP_DIR, "debug.log"), new Date().toISOString() + " POLL_ERR " + state.error + "\n");
    } catch {}
  }
  lastState = state;

  // Phone notifications: detect session start / finish transitions
  if (state.online && prevActive) {
    const cur = state.active || {};
    const titleOf = (id) => {
      const s = (state.sessions || []).find((x) => x.id === id);
      return (s && s.title) || id;
    };
    for (const id of Object.keys(prevActive)) {
      if (!cur[id]) notify("Agent finished", titleOf(id), ["white_check_mark"]);
    }
    for (const id of Object.keys(cur)) {
      if (!prevActive[id]) notify("Agent started", titleOf(id), ["rocket"]);
    }
  }
  if (state.online) prevActive = state.active || {};

  if (win && !win.isDestroyed()) win.webContents.send("state", state);
  try {
    fs.appendFileSync(path.join(APP_DIR, "debug.log"), new Date().toISOString() + " POLL online=" + state.online + " sessions=" + (state.sessions || []).length + " stats=" + (!!state.stats) + (state.error ? " err=" + state.error : "") + "\n");
  } catch {}
}

/* ---------- Window bounds animation ---------- */

function boundsFor(exp) {
  const wa = screen.getPrimaryDisplay().workArea;
  const w = exp ? EXPANDED.w : COLLAPSED.w;
  const h = exp ? EXPANDED.h : COLLAPSED.h;
  return { x: Math.round(wa.x + (wa.width - w) / 2), y: wa.y, width: Math.round(w), height: Math.round(h) };
}

function animateTo(exp) {
  if (!win || win.isDestroyed()) return;
  const target = boundsFor(exp);
  const start = win.getBounds();
  const t0 = Date.now();
  const dur = 240;
  if (animTimer) clearInterval(animTimer);
  animTimer = setInterval(() => {
    if (!win || win.isDestroyed()) { clearInterval(animTimer); animTimer = null; return; }
    const p = Math.min(1, (Date.now() - t0) / dur);
    const e = 1 - Math.pow(1 - p, 3);
    win.setBounds({
      x: Math.round(start.x + (target.x - start.x) * e),
      y: Math.round(start.y + (target.y - start.y) * e),
      width: Math.round(start.width + (target.width - start.width) * e),
      height: Math.round(start.height + (target.height - start.height) * e),
    });
    if (p >= 1) {
      clearInterval(animTimer);
      animTimer = null;
    }
  }, 16);
}

function setExpanded(exp) {
  if (expanded === exp) return;
  expanded = exp;
  if (!exp) pinned = false;
  animateTo(exp);
  sendLayout();
}

function sendLayout() {
  if (win && !win.isDestroyed()) win.webContents.send("layout", { expanded, pinned });
}

function expand() {
  if (leaveTimer) { clearTimeout(leaveTimer); leaveTimer = null; }
  setExpanded(true);
}

function collapse() {
  setExpanded(false);
}

/* ---------- Media ---------- */

function startMediaWatcher() {
  const script = path.join(APP_DIR, "scripts", "media-info.ps1");
  mediaChild = spawn(
    "powershell.exe",
    ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script],
    { windowsHide: true, stdio: ["ignore", "pipe", "ignore"] }
  );
  mediaChild.stdout.setEncoding("utf8");
  mediaChild.stdout.on("data", (chunk) => {
    mediaLine += chunk;
    let idx;
    while ((idx = mediaLine.indexOf("\n")) >= 0) {
      const line = mediaLine.slice(0, idx).trim();
      mediaLine = mediaLine.slice(idx + 1);
      if (!line) continue;
      try {
        const m = JSON.parse(line);
        if (win && !win.isDestroyed()) win.webContents.send("media", m);
      } catch { /* partial line, wait */ }
    }
  });
  mediaChild.on("exit", () => {
    mediaChild = null;
    setTimeout(startMediaWatcher, 3000);
  });
}

ipcMain.on("media", (_e, action) => {
  const allowed = ["playpause", "next", "prev", "stop"];
  if (!allowed.includes(action)) return;
  spawn("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", path.join(APP_DIR, "scripts", "media-key.ps1"), action], {
    windowsHide: true,
    stdio: "ignore",
  });
});

/* ---------- IPC from renderer ---------- */

ipcMain.on("mouseenter", () => expand());
ipcMain.on("mouseleave", () => {
  scheduleCollapse();
});
ipcMain.on("toggle-pin", () => {
  pinned = !pinned;
  if (pinned) expand();
  else collapse();
  sendLayout();
});
ipcMain.on("force-collapse", () => collapse());
ipcMain.on("mouse-ignore", (_e, ignore) => {
  if (win && !win.isDestroyed()) win.setIgnoreMouseEvents(!!ignore, { forward: true });
});

/* ---------- WhatsApp bridge IPC ---------- */

ipcMain.on("wa-connect", () => wa.connect());
ipcMain.on("wa-disconnect", () => wa.disconnect());
ipcMain.on("wa-forget", () => wa.forget());
ipcMain.on("wa-command", (_e, text) => {
  if (typeof text === "string" && text.trim()) bridge.handleIncoming(text.trim());
});
ipcMain.handle("wa-status", () => wa.getStatus());
ipcMain.handle("wa-repos", async () => {
  try {
    const repos = require("./repos");
    return await repos.list(false);
  } catch (e) {
    return [];
  }
});

/* File-drop outbox: write text into wa-outbox.txt and it is sent to the
   linked chat, then the file is cleared. Lets any script on this PC (or an
   agent) push a WhatsApp message without talking to the app directly. */
const WA_OUTBOX = path.join(APP_DIR, "wa-outbox.txt");
function pumpOutbox() {
  try {
    if (!fs.existsSync(WA_OUTBOX)) return;
    const text = fs.readFileSync(WA_OUTBOX, "utf8").trim();
    fs.writeFileSync(WA_OUTBOX, "");
    if (text) wa.send(text);
  } catch {}
}
setInterval(pumpOutbox, 2500);

wa.on({
  onStatus: (s) => {
    if (s.status === "open") setTimeout(pumpOutbox, 1500);
    if (win && !win.isDestroyed()) win.webContents.send("wa-status", s);
    try {
      fs.appendFileSync(path.join(APP_DIR, "debug.log"), new Date().toISOString() + " WA_STATUS " + JSON.stringify(s) + "\n");
    } catch {}
  },
  onQr: (dataUrl) => {
    if (win && !win.isDestroyed()) win.webContents.send("wa-qr", dataUrl);
  },
  onMessage: (text) => {
    try {
      fs.appendFileSync(path.join(APP_DIR, "debug.log"), new Date().toISOString() + " WA_RECV " + text.slice(0, 120).replace(/\n/g, " | ") + "\n");
    } catch {}
    bridge.handleIncoming(text);
  },
});

/* ---------- hover watch ----------
   Same approach as Dexter: the window is click-through by default, the
   renderer reports the rects of the nub and the panel, and the main process
   tests the cursor against them. The transparent areas therefore never
   swallow clicks from whatever is underneath. */

let hitRects = { pill: null, panel: null };
let mouseIgnored = true;
let hoverTimer = null;

function applyMouseIgnore(ignore) {
  if (!win || win.isDestroyed() || ignore === mouseIgnored) return;
  mouseIgnored = ignore;
  win.setIgnoreMouseEvents(ignore, { forward: true });
}

function inRect(r, x, y) {
  return !!r && x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h;
}

function scheduleCollapse() {
  if (pinned || leaveTimer) return; // set-once: the 100ms hover ticks must not reset it or it never fires
  leaveTimer = setTimeout(() => {
    leaveTimer = null;
    if (!pinned) collapse();
  }, 260);
}

function startHoverWatch() {
  if (hoverTimer) return;
  let lastOver = null;
  let lastPinned = null;
  hoverTimer = setInterval(() => {
    if (!win || win.isDestroyed()) return;
    if (introWin && !introWin.isDestroyed()) return;   // intro owns the screen right now
    const b = win.getBounds();
    const p = screen.getCursorScreenPoint();
    const x = p.x - b.x;
    const y = p.y - b.y;
    const over = inRect(hitRects.pill, x, y) || inRect(hitRects.panel, x, y);
    if (over !== lastOver || pinned !== lastPinned) {
      lastOver = over;
      lastPinned = pinned;
      try {
        fs.appendFileSync(path.join(APP_DIR, "debug.log"),
          new Date().toISOString() + " HOVER over=" + over + " pinned=" + pinned +
          " local=" + Math.round(x) + "," + Math.round(y) + " rects=" + JSON.stringify(hitRects) + "\n");
      } catch {}
    }
    applyMouseIgnore(!over);
    if (over) expand();
    else scheduleCollapse();
  }, 100);
}

ipcMain.on("rects", (_e, r) => {
  hitRects = {
    pill: r && r.pill ? r.pill : null,
    panel: r && r.panel ? r.panel : null,
  };
});

/* ---------- Intro overlay ----------
   Fullscreen, borderless, always-on-top, click-through, truly transparent
   window on the monitor that has the notch. Runs once when the app loads;
   Ctrl+Alt+N replays it; Esc or a click skips straight to step 4. */

function ilog(msg) {
  try { fs.appendFileSync(path.join(APP_DIR, "debug.log"), new Date().toISOString() + " " + msg + "\n"); } catch {}
}

function spawnPsRetry(args, tries = 2) {
  try {
    const c = spawn("powershell.exe", args, { windowsHide: true, stdio: "ignore" });
    c.on("error", (e) => {
      ilog("INTRO click-watch spawn error: " + e.message + (tries > 1 ? " (retrying)" : ""));
      if (tries > 1) setTimeout(() => { introClickChild = spawnPsRetry(args, tries - 1); }, 1500);
    });
    c.unref();
    return c;
  } catch (e) {
    ilog("INTRO click-watch spawn throw: " + e.message);
    return null;
  }
}

/* The overlay is click-through, so its own renderer can never see a click.
   A tiny PowerShell poller drops a flag file on left-click; we pick it up. */
function startClickWatch() {
  try { fs.unlinkSync(INTRO_FLAG); } catch {}
  introClickChild = spawnPsRetry(["-NoProfile", "-ExecutionPolicy", "Bypass", "-File",
    path.join(APP_DIR, "scripts", "click-watch.ps1"), INTRO_FLAG]);
  introClickTimer = setInterval(() => {
    try {
      if (fs.existsSync(INTRO_FLAG)) { fs.unlinkSync(INTRO_FLAG); skipIntro(); }
    } catch {}
  }, 90);
}

function startIntro() {
  try {
    if (introWin && !introWin.isDestroyed()) return false;           // already playing
    const clipAbs = INTRO.clips.map((c) => path.join(APP_DIR, c));
    if (!clipAbs.every((f) => fs.existsSync(f))) {
      ilog("INTRO skipped: clip file missing");
      return false;
    }
    const nb = (win && !win.isDestroyed()) ? win.getBounds() : boundsFor(false);
    const display = screen.getDisplayMatching(nb) || screen.getPrimaryDisplay();
    const db = display.bounds;
    introOriginY = Math.round(nb.y + nb.height - db.y);              // notch bottom edge

    introWin = new BrowserWindow({
      x: db.x, y: db.y, width: db.width, height: db.height,         // fullscreen on the notch's monitor
      title: "agent-notch-intro",
      frame: false,
      transparent: true,
      resizable: false,
      movable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      hasShadow: false,
      focusable: false,
      show: false,
      backgroundColor: "#00000000",                                  // no background colour
      webPreferences: {
        preload: path.join(__dirname, "preload.js"),
        contextIsolation: true,
        nodeIntegration: false,
        backgroundThrottling: false,
      },
    });
    introWin.setAlwaysOnTop(true, "screen-saver");
    introWin.setIgnoreMouseEvents(true, { forward: true });          // click-through: never blocks the mouse

    introWin.webContents.on("console-message", (...args) => {
      try {
        const last = args[args.length - 1];
        const p = last && typeof last === "object" && "message" in last
          ? last
          : { level: args[1], message: args[2], line: args[3], sourceId: args[4] };
        fs.appendFileSync(path.join(APP_DIR, "debug.log"),
          new Date().toISOString() + " INTRO_CONSOLE " + p.message + "\n");
      } catch {}
    });
    introWin.webContents.on("did-fail-load", (_e, code, desc) => {
      ilog("INTRO LOAD_FAIL " + code + " " + desc);
      cleanupIntro();
    });

    // The shrinking circle lands on the notch, so hide the real one first.
    if (win && !win.isDestroyed()) { collapse(); win.hide(); }

    introWin.loadFile(path.join(__dirname, "intro", "intro.html"));
    introWin.once("ready-to-show", () => {
      if (introWin && !introWin.isDestroyed()) introWin.showInactive();
    });

    // Esc skips straight to step 4 — global because the overlay is
    // click-through and unfocusable. Unregistered again in cleanup.
    try { introEsc = globalShortcut.register(INTRO.skipKey, () => skipIntro()); }
    catch (e) { introEsc = false; ilog("INTRO esc register failed: " + e.message); }

    startClickWatch();
    ilog("INTRO start display=" + db.width + "x" + db.height + "@" + db.x + "," + db.y +
      " originY=" + introOriginY + " esc=" + introEsc);
    return true;
  } catch (e) {
    ilog("INTRO err " + e.message);
    cleanupIntro();
    return false;
  }
}

function skipIntro() {
  if (introWin && !introWin.isDestroyed()) introWin.webContents.send("intro:skip");
}

function cleanupIntro() {
  if (introEsc) { try { globalShortcut.unregister(INTRO.skipKey); } catch {} introEsc = false; }
  if (introClickTimer) { clearInterval(introClickTimer); introClickTimer = null; }
  if (introClickChild) { try { introClickChild.kill(); } catch {} introClickChild = null; }
  try { fs.unlinkSync(INTRO_FLAG); } catch {}
  // The circle shrank into the notch — bring it back as the normal UI.
  if (win && !win.isDestroyed()) { collapse(); win.showInactive(); }
  if (introWin && !introWin.isDestroyed()) {
    const w = introWin;
    introWin = null;
    try { w.destroy(); } catch {}
  }
  ilog("INTRO cleaned up");
}

ipcMain.handle("intro:info", () => ({
  config: INTRO,
  clips: INTRO.clips.map((c) => pathToFileURL(path.join(APP_DIR, c)).href),
  originY: introOriginY,
}));
ipcMain.on("intro:start", () => startIntro());
ipcMain.on("intro:skip-req", () => skipIntro());
ipcMain.on("intro:done", () => cleanupIntro());

/* ---------- Autostart ---------- */

function regQuery() {
  return new Promise((resolve) => {
    execFile("reg", ["query", RUN_KEY, "/v", AUTOSTART_VALUE], { windowsHide: true }, (err) => resolve(!err));
  });
}

function regAdd() {
  const cmd = `"${ELECTRON_EXE}" "${APP_DIR}"`;
  return new Promise((resolve) => {
    execFile("reg", ["add", RUN_KEY, "/v", AUTOSTART_VALUE, "/t", "REG_SZ", "/d", cmd, "/f"], { windowsHide: true }, () => resolve());
  });
}

function regDelete() {
  return new Promise((resolve) => {
    execFile("reg", ["delete", RUN_KEY, "/v", AUTOSTART_VALUE, "/f"], { windowsHide: true }, () => resolve());
  });
}

/* ---------- UI ---------- */

function createWindow() {
  win = new BrowserWindow({
    ...boundsFor(false),
    frame: false,
    transparent: true,
    // NOTE: no backgroundMaterial here. "acrylic" paints the whole window
    // rectangle and cannot follow the rounded notch shape — that was the
    // stray rectangle around the pill. Dexter uses a plain transparent
    // window and draws the shape in CSS instead.
    resizable: false,
    movable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    hasShadow: false,
    focusable: false,
    show: false,
    backgroundColor: "#00000000",
    icon: path.join(APP_DIR, "assets", "icon.png"),
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.setAlwaysOnTop(true, "screen-saver");
  // Pass clicks through the transparent parts of the window (Dexter does the
  // same): the renderer re-enables hit-testing only over the nub / panel.
  win.setIgnoreMouseEvents(true, { forward: true });
  win.webContents.on("console-message", (...args) => {
    try {
      const last = args[args.length - 1];
      const p = last && typeof last === "object" && "message" in last
        ? last
        : { level: args[1], message: args[2], line: args[3], sourceId: args[4] };
      fs.appendFileSync(path.join(APP_DIR, "debug.log"), new Date().toISOString() + " CONSOLE[" + p.level + "] " + p.message + " (" + p.sourceId + ":" + p.line + ")\n");
    } catch {}
  });
  win.webContents.on("did-fail-load", (_e, code, desc) => {
    try {
      fs.appendFileSync(path.join(APP_DIR, "debug.log"), new Date().toISOString() + " LOAD_FAIL " + code + " " + desc + "\n");
    } catch {}
  });
  win.loadFile(path.join(__dirname, "index.html"));
  startHoverWatch();
  win.once("ready-to-show", () => win.showInactive());
  win.on("closed", () => { win = null; });
}

function createTray() {
  const iconPath = path.join(APP_DIR, "assets", "icon.png");
  let img;
  try { img = nativeImage.createFromPath(iconPath); } catch { img = nativeImage.createEmpty(); }
  tray = new Tray(img);
  tray.setToolTip("Agent Notch");
  rebuildTrayMenu();
}

async function rebuildTrayMenu() {
  if (!tray) return;
  const hasAuto = await regQuery();
  const menu = Menu.buildFromTemplate([
    { label: "Show Notch", click: () => { if (!win) createWindow(); expand(); win && win.showInactive(); } },
    { label: "Hide Notch", click: () => collapse() },
    { type: "separator" },
    { label: "ntfy topic: " + config.ntfyTopic, click: () => { clipboard.writeText(config.ntfyTopic); } },
    {
      label: "Phone notifications",
      type: "checkbox",
      checked: config.notifyEnabled !== false,
      click: (item) => { config.notifyEnabled = item.checked; saveConfig(config); },
    },
    { type: "separator" },
    {
      label: "Start with Windows",
      type: "checkbox",
      checked: hasAuto,
      click: async (item) => {
        if (item.checked) await regAdd();
        else await regDelete();
        rebuildTrayMenu();
      },
    },
    { type: "separator" },
    { label: "Quit", click: () => { app.quit(); } },
  ]);
  tray.setContextMenu(menu);
}

/* ---------- Lifecycle ---------- */

app.whenReady().then(async () => {
  createWindow();
  createTray();
  poll();
  setInterval(poll, POLL_MS);
  startMediaWatcher();
  // Ensure 24/7: register autostart on first run
  if (!(await regQuery())) await regAdd();

  // Intro: plays once, shortly after the app loads
  setTimeout(() => startIntro(), 800);

  // Debug: replay the intro on demand
  try {
    const ok = globalShortcut.register(INTRO.replayShortcut, () => startIntro());
    ilog("INTRO replay shortcut " + INTRO.replayShortcut + (ok ? " registered" : " ALREADY TAKEN"));
  } catch (e) { ilog("INTRO replay shortcut err " + e.message); }

  // WhatsApp bridge: OpenCode event stream → chat, replies → prompts
  if (config.whatsappEnabled !== false) {
    bridge.start({
      whatsapp: wa,
      getState: () => lastState,
      onEvent: (e) => {
        if (win && !win.isDestroyed()) win.webContents.send("wa-event", e);
      },
    });
    // auto-connect if we have stored auth, otherwise wait for the QR button
    const authDir = path.join(APP_DIR, "wa-auth");
    if (fs.existsSync(path.join(authDir, "creds.json"))) wa.connect();
  }
});

app.on("window-all-closed", (e) => {
  // Keep the notch alive 24/7 — recreate instead of quitting
  if (win === null) setTimeout(() => { if (!win) createWindow(); }, 500);
});

app.on("before-quit", () => {
  if (mediaChild) { try { mediaChild.kill(); } catch {} }
  if (animTimer) clearInterval(animTimer);
  if (introClickTimer) clearInterval(introClickTimer);
  if (introClickChild) { try { introClickChild.kill(); } catch {} }
  try { fs.unlinkSync(INTRO_FLAG); } catch {}
  try { globalShortcut.unregisterAll(); } catch {}
  if (introWin && !introWin.isDestroyed()) { try { introWin.destroy(); } catch {} introWin = null; }
  try { bridge.stop(); } catch {}
  try { wa.disconnect(); } catch {}
});

// Exposed for programmatic control / tests
module.exports = { startIntro, skipIntro, cleanupIntro };
