/* OpenCode ⇄ WhatsApp bridge
   - subscribes to the OpenCode SSE event stream (permission.asked, form.created,
     session.execution.*, session.idle)
   - pushes approval prompts and agent questions to the WhatsApp chat
   - replies from that chat are routed back: permission reply / form reply / commands
   - "status" / "repos" / "sessions" commands push the same data the notch shows */

const fs = require("fs");
const path = require("path");
const os = require("os");
const { spawn } = require("child_process");
const { writeAtomic } = require("./fsutil");
const repos = require("./repos");
const assistant = require("./assistant");
const { runPs } = require("./psrun");
const ghwatch = require("./ghwatch");
const weather = require("./weather");
// Tony pack (#1-3) + news pack (#4-5): sections of the 09:00 newspaper
const modelradar = require("./modelradar");
const modelprobe = require("./modelprobe");
const selfaudit = require("./selfaudit");
const news = require("./news");

const SERVICE_FILE = path.join(os.homedir(), ".local", "state", "opencode", "service.json");
const DEBUG = path.join(__dirname, "debug.log");

let wa = null;               // whatsapp module
let getState = null;         // () => poll state from main.js
let onEvent = null;          // forward to renderer (pending list etc.)
let abort = null;
let running = false;
let reconnectDelay = 1000;

// pending prompts awaiting a WhatsApp reply: id -> {kind, sessionID, ...}
const pending = new Map();
let pendingSeq = 0;

function log(line) {
  try { fs.appendFileSync(DEBUG, new Date().toISOString() + " BRIDGE " + line + "\n"); } catch {}
}

function readService() {
  try { return JSON.parse(fs.readFileSync(SERVICE_FILE, "utf8")); } catch { return null; }
}

function authHeader() {
  const svc = readService();
  if (!svc) return null;
  return "Basic " + Buffer.from("opencode:" + svc.password).toString("base64");
}

async function api(method, p, body) {
  const svc = readService();
  if (!svc || !svc.url) throw new Error("service unavailable");
  const res = await fetch(svc.url + p, {
    method,
    headers: { Authorization: authHeader(), "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error("HTTP " + res.status + " " + (await res.text()).slice(0, 200));
  const ct = res.headers.get("content-type") || "";
  return ct.includes("json") ? res.json() : res.text();
}

/* ---------- message formatting ---------- */

function sessionTitle(id, state) {
  const s = state && state.sessions ? state.sessions.find((x) => x.id === id) : null;
  if (!s) return id || "?";
  return (s.title || id).slice(0, 80);
}

function fmtPermission(d, state) {
  const n = d.__seq;
  const lines = [
    "🔔 APPROVAL NEEDED  #" + n,
    "session: " + sessionTitle(d.sessionID, state),
    "action: " + (d.action || "?"),
  ];
  if (d.resources && d.resources.length) {
    lines.push("resource:");
    for (const r of d.resources.slice(0, 6)) lines.push("  • " + String(r).slice(0, 160));
  }
  if (d.message) lines.push("note: " + String(d.message).slice(0, 300));
  lines.push("", "reply: allow | always | reject", "or: " + n + " allow / " + n + " reject");
  return lines.join("\n");
}

function fmtForm(form, state) {
  const n = form.__seq;
  const lines = [
    "❓ AGENT QUESTION  #" + n,
    "session: " + sessionTitle(form.sessionID, state),
    "title: " + (form.title || "?"),
  ];
  const fields = form.fields || [];
  for (const f of fields.slice(0, 8)) {
    const req = f.required ? " *" : "";
    const desc = f.description ? " — " + String(f.description).slice(0, 140) : "";
    lines.push("• " + (f.title || f.key) + " (" + f.type + ")" + req + desc);
    if (f.options && f.options.length) {
      lines.push("  options: " + f.options.map((o) => (typeof o === "string" ? o : o.label || o.value)).join(" | "));
    }
  }
  lines.push("", "reply with your answer, e.g. " + n + ": yes");
  return lines.join("\n");
}

/* ---------- session control (#6) ----------
   The numbered list shown by status/sessions is snapshotted, so "run 2 x"
   resolves against exactly what the user last saw (session order can shift
   between polls). Falls back to a fresh snapshot if none exists yet. */

let sessionSnap = { ids: [], at: 0 };

function snapSessions(state) {
  const list = ((state && state.sessions) || []).slice(0, 5);
  sessionSnap = { ids: list.map((s) => s.id), at: Date.now() };
  return list;
}

function resolveSession(n) {
  // build the snapshot only if we never showed a list; a bad number must NOT
  // renumber what the user is looking at.
  if (!sessionSnap.ids.length) snapSessions(getState ? getState() : null);
  const id = sessionSnap.ids[n - 1];
  if (!id) return null;
  const state = getState ? getState() : null;
  const s = state && state.sessions ? state.sessions.find((x) => x.id === id) : null;
  return { id, title: (s && (s.title || s.id)) || id };
}

/* ---------- clipboard actions (#7) ----------
   Electron clipboard injected by main.js via start() (bridge runs in the
   main process; injecting keeps this module testable in plain node). */

let clip = null;
let regionFn = null;   // (mode, cb) => void — main.js region drag-select

async function copyToClipboard(text) {
  if (!clip) return "⚠️ clipboard unavailable.";
  try {
    clip.writeText(String(text));
    return "📋 copied " + String(text).length + " chars to the PC clipboard — paste it anywhere.";
  } catch (e) { return "⚠️ copy failed: " + e.message; }
}

async function readClipboard() {
  if (!clip) return { msg: "⚠️ clipboard unavailable." };
  try {
    const text = clip.readText() || "";
    if (text.trim()) return { msg: "📋 CLIPBOARD (" + text.length + " chars):\n" + text.slice(0, 3500) };
    const img = clip.readImage();
    if (img && typeof img.isEmpty === "function" && !img.isEmpty() && typeof img.toPNG === "function") {
      const p = path.join(os.tmpdir(), "notch-clip-" + Date.now() + ".png");
      fs.writeFileSync(p, img.toPNG());
      setTimeout(() => { try { fs.unlinkSync(p); } catch {} }, 120000);
      return { msg: "📋 clipboard has an image — sending it below.", file: p };
    }
    return { msg: "📋 clipboard is empty." };
  } catch (e) { return { msg: "⚠️ clipboard read failed: " + e.message }; }
}

async function sendClipboard() {
  const r = await readClipboard();
  log("clipboard read: " + (r.file ? "image" : r.msg.split("\n")[0].slice(0, 70)));
  await wa.send(r.msg);
  if (r.file) await wa.sendFile(r.file, "clipboard image");
}

/* ---------- stop / skip (#9) — immediate control, bypasses the FIFO ----------
   These exist to preempt the task that is running RIGHT NOW, so queueing
   them behind it would defeat the purpose. They interrupt the active
   OpenCode session(s) at once; "skip" additionally mutes the in-flight
   assistant reply so the queue visibly moves on. */

function activeIds() {
  const st0 = getState ? getState() : null;
  return { st0, ids: st0 && st0.active ? Object.keys(st0.active).filter(Boolean) : [] };
}

async function interruptActive(ids, st0) {
  const names = [];
  for (const id of ids) {
    try { await api("POST", "/api/session/" + id + "/interrupt"); }
    catch (e) { log("interrupt err " + id + ": " + e.message); }
    names.push(sessionTitle(id, st0));
  }
  return names;
}

async function stopCurrent() {
  const { st0, ids } = activeIds();
  if (!ids.length) return wa.send("✅ no tasks running right now.");
  const names = await interruptActive(ids, st0);
  log("stop current: " + ids.length + " session(s)");
  return wa.send("⏹ stopped the current task" + (ids.length > 1 ? "s" : "") + ":\n• " + names.join("\n• "));
}

async function skipCurrent() {
  skipRequested = true; // in-flight assistant turn: drop its partial reply
  const { st0, ids } = activeIds();
  await interruptActive(ids, st0);
  const waiting = taskQueue.length;
  log("skip: interrupted " + ids.length + ", " + waiting + " queued behind");
  if (!ids.length && !waiting) return wa.send("⏭ nothing running or queued.");
  return wa.send("⏭ skipped the current task — next" +
    (waiting ? " up (" + waiting + " queued)" : " (queue empty)"));
}

function fmtStatus(state) {
  const st = state && state.stats;
  const active = Object.keys(state && state.active ? state.active : {}).length;
  const lines = [
    "📊 NOTCH STATUS",
    "opencode: " + (state && state.online ? "online" : "OFFLINE"),
    "sessions: " + ((state && state.sessions) || []).length + "  ·  active: " + active,
  ];
  if (st && st.tokens) {
    const t = st.tokens;
    const total = (t.input || 0) + (t.output || 0) + (t.reasoning || 0) + ((t.cache && t.cache.read) || 0);
    lines.push(
      "tokens 24h: " + fmtNum(total) + "  (in " + fmtNum(t.input || 0) + " · out " + fmtNum(t.output || 0) + ")"
    );
  }
  if (st && st.tools && st.tools.totals) {
    const tt = st.tools.totals;
    lines.push("tools: " + (tt.succeeded || 0) + "/" + (tt.calls || 0) + " ok · " + (tt.failed || 0) + " failed");
  }
  const list = snapSessions(state);
  if (list.length) {
    lines.push("", "sessions  (run <n> <prompt> · stop <n>):");
    for (let i = 0; i < list.length; i++) {
      const s = list[i];
      const busy = state.active && state.active[s.id] ? "▶" : "·";
      lines.push(" " + (i + 1) + " " + busy + " " + (s.title || s.id).slice(0, 58));
    }
  }
  if (pending.size) lines.push("", "⏳ " + pending.size + " prompt(s) waiting for your reply");
  return lines.join("\n");
}

function fmtRepos(list) {
  const lines = ["📁 GIT REPOS (" + list.length + ")"];
  for (const r of list.slice(0, 30)) {
    if (!r.ok) { lines.push("• " + r.name + " — ?"); continue; }
    const flags = [];
    if (r.dirty) flags.push(r.dirty + " dirty");
    if (r.ahead) flags.push("↑" + r.ahead);
    if (r.behind) flags.push("↓" + r.behind);
    lines.push("• " + r.name + "  [" + r.branch + "]" + (flags.length ? " " + flags.join(" ") : "") + (r.lastAge ? "  " + r.lastAge : ""));
  }
  if (list.length > 30) lines.push("… +" + (list.length - 30) + " more");
  return lines.join("\n");
}

function fmtNum(n) {
  if (n >= 1e9) return (n / 1e9).toFixed(1) + "B";
  if (n >= 1e6) return (n / 1e6).toFixed(1) + "M";
  if (n >= 1e3) return (n / 1e3).toFixed(1) + "k";
  return String(n);
}

const HELP = [
  "🤖 NOTCH COMMANDS",
  "status — sessions, tokens, tools",
  "repos — all git repos + branch/dirty",
  "sessions — active sessions",
  "prompts — pending approvals",
  "reminders — list pending reminders",
  "help — this message",
  "",
  "messages run one at a time, in order (queued if busy)",
  "",
  "or just talk naturally:",
  "\"open notepad\" · \"play music\" · \"next song\"",
  "\"open github.com\" · \"send me my latest screenshot\" (old ones come back as files)",
  "",
  "screenshots:  /screenshot  ·  /screen  ·  /screenshot window  ·  /screenshot <app title>",
  "(fresh captures ONLY via /screenshot — plain \"screenshot\" text just talks to the assistant)",
  "region:  /screenshot region — drag-select a piece of the screen",
  "ocr:  /ocr (drag-select text)  ·  /ocr full (read the whole screen)",
  "ghwatch:  ghwatch <owner>/<repo> (watch issues/PRs/CI)  ·  ghwatch (status)  ·  ghwatch off",
  "weather:  weather (current + 4-day)  ·  weather <city> (set the default)",
  "news:  news (HN top-5 + company headlines)  ·  news hn  ·  news <company>",
  "attachments:  send a photo/file in the chat — I'll read it (max 16MB); voice notes are transcribed and answered",
  "reminders:  remind in 10m <text>  ·  remind at 18:30 <text>  ·  cancel <n>",
  "sessions:  run <n> <prompt>  ·  stop <n>   (n from the sessions list)",
  "control:  stop / stop current  ·  skip   (preempt what's running NOW)",
  "queue — show running/waiting tasks  ·  clear — drop the waiting ones",
  "dnd — do not disturb: dnd on 30m · dnd off (silences push + 🔔 mirror)",
  "config — view · config mirror off · config digest 18:00 (live settings)",
  "clipboard:  copy <text>  ·  clipboard / paste  (read it back)",
  "digest — the daily paper (auto: first laptop open of the day)",
  "digest at 18:00 — schedule instead · digest auto — back to first-open",
  "digest status — mode · sent today? · last send",
  "brief — 8-line short summary of the day (summary · tldr)",
  "links — numbered paper links · open <n> | hn | giants | all (browser tabs)",
  "system:  \"how many tabs are open\" · \"what app is in front\"",
  "",
  "to answer a prompt:  allow / always / reject",
  "or numbered:  2 allow · 1 reject · 1: your answer",
].join("\n");

/* ---------- reminders (#3) ----------
   Parsed "when" + text, persisted to reminders.json, fired by a 10s pump.
   Survives restarts (missed ones fire late, not lost). */

const REMINDERS_FILE = path.join(__dirname, "reminders.json");
let reminders = [];
try { reminders = JSON.parse(fs.readFileSync(REMINDERS_FILE, "utf8")) || []; } catch {}

function saveReminders() {
  try { writeAtomic(REMINDERS_FILE, JSON.stringify(reminders)); } catch {}
}

/* "in 10m ..." | "at 18:30 ..." | "tomorrow 9am ..." -> {at, rest} or null. */
function parseWhen(s) {
  const now = Date.now();
  let m = s.match(/^in\s+(\d+)\s*(s|sec|secs|second|seconds|m|min|mins|minute|minutes|h|hr|hrs|hour|hours|d|day|days)\b\s*/i);
  if (m) {
    const n = Number(m[1]);
    const u = m[2].toLowerCase();
    const mult = /^(s|sec)/.test(u) ? 1000 : /^(m|min)/.test(u) ? 60000 : /^(h|hr)/.test(u) ? 3600000 : 86400000;
    return { at: now + n * mult, rest: s.slice(m[0].length).trim() };
  }
  m = s.match(/^at\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b\s*/i);
  if (m) {
    let h = Number(m[1]);
    const min = m[2] ? Number(m[2]) : 0;
    const ap = (m[3] || "").toLowerCase();
    if (ap === "pm" && h < 12) h += 12;
    if (ap === "am" && h === 12) h = 0;
    const d = new Date();
    d.setHours(h, min, 0, 0);
    if (d.getTime() <= now) d.setDate(d.getDate() + 1); // already past -> tomorrow
    return { at: d.getTime(), rest: s.slice(m[0].length).trim() };
  }
  m = s.match(/^tomorrow\s+(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b\s*/i);
  if (m) {
    let h = Number(m[1]);
    const min = m[2] ? Number(m[2]) : 0;
    const ap = (m[3] || "").toLowerCase();
    if (ap === "pm" && h < 12) h += 12;
    if (ap === "am" && h === 12) h = 0;
    const d = new Date();
    d.setDate(d.getDate() + 1);
    d.setHours(h, min, 0, 0);
    return { at: d.getTime(), rest: s.slice(m[0].length).trim() };
  }
  return null;
}

function fmtWhen(at) {
  const d = new Date(at);
  const sameDay = d.toDateString() === new Date().toDateString();
  const hm = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  return sameDay ? hm : d.toLocaleDateString([], { month: "short", day: "numeric" }) + " " + hm;
}

function addReminder(at, text) {
  const id = reminders.reduce((mx, r) => Math.max(mx, r.id || 0), 0) + 1;
  reminders.push({ id, at, text, created: Date.now() });
  saveReminders();
  return id;
}

function pumpReminders() {
  if (!wa) return;
  const now = Date.now();
  const due = reminders.filter((r) => r.at <= now);
  if (!due.length) return;
  reminders = reminders.filter((r) => r.at > now);
  saveReminders();
  for (const r of due.sort((a, b) => a.at - b.at)) {
    log("reminder fired #" + r.id + " " + String(r.text).slice(0, 50));
    wa.send("⏰ reminder: " + r.text);
  }
}

/* ---------- daily digest (#8) ----------
   DEFAULT: first-open mode — the day's ONE paper goes out the first time
   the app sees you on a NEW day (boot, wake from sleep, session unlock, or
   the minute pump) — with a quiet floor: never between 00:00-05:00.
   An explicit schedule ("digest at 18:00" / "config digest 18:00") overrides
   it until "digest auto" clears it back. Marked BEFORE the first send, so
   resume+unlock in the same morning can never double-send. */

const DIGEST_STATE = path.join(__dirname, "digest-state.json");
const OPEN_FLOOR = 5; // first-open mode never fires before 05:00
let digestState = { day: null, hour: null, minute: null };
try { digestState = Object.assign(digestState, JSON.parse(fs.readFileSync(DIGEST_STATE, "utf8"))); } catch {}
let digestTimer = null;

function saveDigestState() {
  try { writeAtomic(DIGEST_STATE, JSON.stringify(digestState)); } catch {}
}

/* "digest auto" / "config digest auto" — drop the explicit schedule (both
   the config.json copy and the quick override) so first-open mode applies. */
function clearDigestSchedule() {
  try {
    const c = readConfigFile();
    if (c && c.digest != null) { delete c.digest; writeConfigFile(c); }
  } catch (e) { log("digest schedule clear err " + e.message); }
  digestState.hour = null;
  digestState.minute = null;
  saveDigestState();
  log("digest schedule cleared -> first-open mode");
}

function digestCfg() {
  const cfg = { mode: "open", floor: OPEN_FLOOR, hour: 9, minute: 0, enabled: true };
  try {
    const c = JSON.parse(fs.readFileSync(path.join(__dirname, "config.json"), "utf8"));
    if (c && c.digest === false) cfg.enabled = false;
    else if (c && c.digest && typeof c.digest === "object") {
      if (typeof c.digest.hour === "number") { cfg.mode = "at"; cfg.hour = c.digest.hour; }
      if (typeof c.digest.minute === "number") cfg.minute = c.digest.minute;
      if (c.digest.mode === "open") cfg.mode = "open"; // "digest auto" wrote this
      if (typeof c.digest.floor === "number") cfg.floor = c.digest.floor;
      if (c.digest.enabled === false) cfg.enabled = false;
    }
  } catch {}
  if (digestState.hour != null) { cfg.mode = "at"; cfg.hour = digestState.hour; cfg.minute = digestState.minute || 0; } // "digest at" wins
  return cfg;
}

async function fmtDigest() {
  const st0 = getState ? getState() : null;
  const lines = ["🗞 NOTCH DAILY DIGEST — " + new Date().toDateString()];
  // morning brief: weather first (fresh fetch; silent if offline)
  try {
    const w = await weather.get(null);
    if (w && w.ok) lines.push(weather.fmtLine(w));
  } catch (e) { log("digest weather err " + e.message); }
  if (st0) {
    const active = Object.keys(st0.active || {}).length;
    lines.push("opencode: " + (st0.online ? "online" : "OFFLINE") +
      " · sessions: " + ((st0.sessions || []).length) + " · active: " + active);
    const st = st0.stats;
    if (st && st.tokens) {
      const t = st.tokens;
      const total = (t.input || 0) + (t.output || 0) + (t.reasoning || 0) + ((t.cache && t.cache.read) || 0);
      lines.push("tokens 24h: " + fmtNum(total) + " (in " + fmtNum(t.input || 0) + " · out " + fmtNum(t.output || 0) + ")");
    }
    if (st && st.tools && st.tools.totals) {
      const tt = st.tools.totals;
      lines.push("tools: " + (tt.succeeded || 0) + "/" + (tt.calls || 0) + " ok · " + (tt.failed || 0) + " failed");
    }
  }
  if (isDnd()) lines.push(dndStatus());
  const endToday = new Date();
  endToday.setHours(23, 59, 59, 999);
  const today = reminders.filter((r) => r.at <= endToday.getTime()).sort((a, b) => a.at - b.at);
  if (today.length) {
    lines.push("", "⏰ reminders today:");
    for (const r of today.slice(0, 6)) lines.push("  • " + fmtWhen(r.at) + " — " + r.text);
  }
  // Tony pack + news pack — one newspaper: model radar, chain health,
  // self-audit, HN top-5, company giants. Built in parallel; every section
  // fails soft (a dead feed never kills the digest) and the whole block is
  // hard-capped at 15s so a hung request can't stall the morning.
  try {
    const secs = await Promise.all([
      modelradar.section(), modelprobe.section(), selfaudit.section(), news.section(),
    ].map((p) => new Promise((resolve) => {
      let done = false;
      const timer = setTimeout(() => {
        if (done) return;
        done = true;
        log("digest section timeout");
        resolve(null);
      }, 15000);
      Promise.resolve(p).then(
        (v) => { if (!done) { done = true; clearTimeout(timer); resolve(v); } },
        (e) => { if (!done) { done = true; clearTimeout(timer); log("digest section err " + e.message); resolve(null); } },
      );
    })));
    for (const s of secs) if (s) lines.push("", s);
  } catch (e) { log("digest sections err " + e.message); }
  try {
    const list = await repos.list(true);
    const dirty = list.filter((r) => r.ok && r.dirty);
    const ahead = list.filter((r) => r.ok && r.ahead);
    lines.push("", "📁 repos: " + list.length + " · " + dirty.length + " dirty" + (ahead.length ? " · " + ahead.length + " ahead" : ""));
    if (dirty.length) for (const r of dirty.slice(0, 5)) lines.push("  • " + r.name + " [" + (r.branch || "?") + "] " + r.dirty + " dirty");
    else if (list.length) lines.push("  all clean ✅");
    // GitHub watcher status — the one repo we poll for issues/PRs/CI
    try {
      const g = ghwatch._state();
      if (g && g.repo) {
        lines.push("👀 ghwatch: " + g.repo +
          " · open " + Object.keys(g.issues || {}).length + " issues / " + Object.keys(g.prs || {}).length + " PRs" +
          " · last CI: " + (g.lastRunId ? (g.lastRunFail ? "FAILED" : "ok") : "—"));
      }
    } catch {}
  } catch { lines.push("", "📁 repos: unavailable"); }
  if (pending.size) lines.push("", "⏳ " + pending.size + " prompt(s) waiting for your reply");
  return lines.join("\n");
}

async function sendDigest(now) {
  const text = await fmtDigest();
  // A4: stamp the send time HERE — the one place every path funnels through
  // (pump + manual). Written before the send loop, so a crash mid-send still
  // records it; the clock-back guard below can then never double-fire.
  digestState.lastAt = (now instanceof Date) ? now.getTime()
    : (typeof now === "number" ? now : Date.now());
  saveDigestState();
  log("digest sent (" + text.length + " chars)");
  for (const c of chunkReply(text)) await wa.send(c);
}

function pumpDigest(nowOverride) {
  if (!wa) return;
  const now = nowOverride || new Date();
  // A4 clock-back guard: a send stamped AHEAD of this pump's clock means
  // time was rewound (manual clock change / sleep rollover) — re-pumping a
  // past "day" must never fire another paper.
  if (typeof digestState.lastAt === "number" && digestState.lastAt > now.getTime() + 60000) {
    log("digest skipped: clock back (last " + new Date(digestState.lastAt).toTimeString() +
      " ahead of pump " + now.toTimeString() + ")");
    return;
  }
  const cfg = digestCfg();
  if (!cfg.enabled) return;
  if (digestState.day === now.toDateString()) return;
  if (cfg.mode === "at") {
    // explicit schedule: fire at/after HH:MM (late is fine — boot catches up)
    if (now.getHours() < cfg.hour || (now.getHours() === cfg.hour && now.getMinutes() < cfg.minute)) return;
  } else if (now.getHours() < cfg.floor) {
    return; // first-open mode: quiet floor — 00:00-05:00 never fires
  }
  digestState.day = now.toDateString();
  saveDigestState(); // mark BEFORE sending — a crash can never double-send
  sendDigest(now).catch((e) => log("digest err " + e.message));
}

/* ---------- brief (#11) — the whole day in ~8 lines ----------
   Built from LAST-RUN module data (state files + caches), so it is fast
   and deterministic: no network except one quick weather check. `digest`
   remains the full newspaper; this is the "just tell me the gist" view. */
async function fmtBrief() {
  const st0 = getState ? getState() : null;
  const lines = ["⚡ DAILY BRIEF — " + new Date().toDateString()];
  try {
    const w = await weather.get(null);
    if (w && w.ok) lines.push(weather.fmtLine(w));
  } catch (e) { log("brief weather err " + e.message); }
  if (st0) {
    const active = Object.keys(st0.active || {}).length;
    lines.push("opencode: " + (st0.online ? "online" : "OFFLINE") +
      " · sessions: " + ((st0.sessions || []).length) + " · active: " + active);
    const st = st0.stats;
    if (st && st.tokens) {
      const t = st.tokens;
      const total = (t.input || 0) + (t.output || 0) + (t.reasoning || 0) + ((t.cache && t.cache.read) || 0);
      lines.push("tokens 24h: " + fmtNum(total) + " (in " + fmtNum(t.input || 0) + " · out " + fmtNum(t.output || 0) + ")");
    }
  }
  // one line per module, from its last run (null = never ran -> omitted)
  for (const s of [modelradar.brief(), modelprobe.brief(), news.brief()]) if (s) lines.push(s);
  try { const a = selfaudit.brief(); if (a) lines.push(a); } catch (e) { log("brief audit err " + e.message); }
  try {
    const g = ghwatch._state();
    if (g && g.repo) {
      lines.push("👀 ghwatch: " + g.repo + " · last CI: " +
        (g.lastRunId ? (g.lastRunFail ? "FAILED" : "ok") : "—"));
    }
  } catch {}
  const endToday = new Date();
  endToday.setHours(23, 59, 59, 999);
  const today = reminders.filter((r) => r.at <= endToday.getTime()).sort((a, b) => a.at - b.at);
  if (today.length) {
    lines.push("⏰ " + today.length + " reminder(s) today · next " +
      fmtWhen(today[0].at) + " — " + today[0].text);
  }
  if (isDnd()) lines.push(dndStatus());
  try {
    const list = await repos.list(true);
    const dirty = list.filter((r) => r.ok && r.dirty);
    lines.push("📁 repos: " + list.length + " · " + dirty.length + " dirty" +
      (pending.size ? " · ⏳ " + pending.size + " prompt(s) waiting" : ""));
  } catch { lines.push("📁 repos: unavailable"); }
  lines.push("", "full paper: `digest` · links: `links` · open tabs: `open all`");
  return lines.join("\n");
}

/* ---------- do not disturb (#10 tier-1) ----------
   DND silences the UNPROMPTED channels only: the ntfy phone push and the
   🔔 notification mirror (both gated in main.js via isDnd()). Commands,
   approvals, reminders, digest and replies still go through — the user
   asked for those. Survives restarts via dnd.json {until}. */

const DND_FILE = path.join(__dirname, "dnd.json");
let dndUntil = 0;
try {
  const d = JSON.parse(fs.readFileSync(DND_FILE, "utf8"));
  if (d && typeof d.until === "number" && d.until > Date.now()) dndUntil = d.until;
} catch {}

function saveDnd() {
  try {
    if (dndUntil > Date.now()) writeAtomic(DND_FILE, JSON.stringify({ until: dndUntil }));
    else if (fs.existsSync(DND_FILE)) fs.unlinkSync(DND_FILE);
  } catch {}
}

function isDnd() { return dndUntil > Date.now(); }

function fmtDur(ms) {
  const s = Math.ceil(ms / 1000);
  if (s < 60) return s + "s";
  const m = Math.round(ms / 60000);
  if (m < 60) return m + "m";
  const h = Math.floor(m / 60);
  return (m % 60) ? h + "h " + (m % 60) + "m" : h + "h";
}

function parseDndDur(arg) {
  if (!arg) return 60 * 60 * 1000;                                     // "dnd on" -> 1h
  const bare = arg.match(/^(\d+)$/);                                   // "dnd on 90" -> 90 min
  if (bare) return Number(bare[1]) * 60000;
  const w = parseWhen(/^in\s+/i.test(arg) ? arg : "in " + arg);        // "30m" / "2h"
  if (w) return Math.max(1000, w.at - Date.now());
  return null;
}

function dndStatus() {
  if (!isDnd()) return "☀️ DND is off.";
  const d = new Date(dndUntil);
  return "🌙 DND active — " + fmtDur(dndUntil - Date.now()) + " left (until " +
    String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0") + ")";
}

function handleDnd(arg) {
  if (!arg || /^(status|check)$/i.test(arg)) return wa.send(dndStatus());
  if (/^(off|disable|end)$/i.test(arg)) {
    dndUntil = 0;
    saveDnd();
    log("dnd off");
    return wa.send("☀️ DND off — notifications back on.");
  }
  const rest = /^on\b\s*/i.test(arg) ? arg.replace(/^on\b\s*/i, "") : arg;
  const dur = parseDndDur(rest.trim());
  if (dur === null) return wa.send("⚠️ usage: dnd on 30m · dnd off · dnd (status)");
  dndUntil = Date.now() + dur;
  saveDnd();
  log("dnd on for " + fmtDur(dur));
  return wa.send("🌙 DND on for " + fmtDur(dur) +
    " — ntfy push + 🔔 mirror silenced (commands, approvals, reminders still come through)");
}

/* ---------- config from chat (#10 tier-2 / item 3) ----------
   Whitelisted settings edited from WhatsApp; main.js re-reads config.json
   before every notify/mirror so changes are live without a restart. */

function readConfigFile() {
  try {
    const c = JSON.parse(fs.readFileSync(path.join(__dirname, "config.json"), "utf8"));
    return c && typeof c === "object" ? c : {};
  } catch { return {}; }
}

function writeConfigFile(c) {
  try { fs.writeFileSync(path.join(__dirname, "config.json"), JSON.stringify(c, null, 2)); }
  catch (e) { log("config write err " + e.message); }
}

function fmtConfig() {
  const c = readConfigFile();
  const dc = digestCfg();
  const lines = [
    "⚙️ CONFIG (effective)",
    "mirror (🔔 → WhatsApp): " + (c.notifyMirror !== false ? "on" : "off"),
    "notify (ntfy push):     " + (c.notifyEnabled === false ? "off" : "on"),
    "whatsapp bridge:        " + (c.whatsappEnabled === false ? "off (after restart)" : "on"),
    "digest: " + (dc.mode === "open"
      ? "first open of the day (from " + String(dc.floor).padStart(2, "0") + ":00)"
      : String(dc.hour).padStart(2, "0") + ":" + String(dc.minute).padStart(2, "0") +
        (digestState.hour != null ? " (quick override)" : "")),
    "ntfy topic: " + (c.ntfyTopic ? String(c.ntfyTopic) : "(none)"),
    "",
    "set: config mirror off · config notify off · config digest 18:00 or auto · config ntfy <topic>",
  ];
  return lines.join("\n");
}

const CONFIG_USAGE = "⚠️ usage: config (view) · config mirror off · config digest 18:00 or auto";

function handleConfig(arg) {
  if (!arg) return wa.send(fmtConfig());
  const sm = arg.match(/^(\w+)\s+([\s\S]+)$/);
  if (!sm) return wa.send(CONFIG_USAGE);
  const key = sm[1].toLowerCase();
  const val = sm[2].trim();

  const BOOLS = { mirror: "notifyMirror", notify: "notifyEnabled", whatsapp: "whatsappEnabled" };
  if (key in BOOLS) {
    const b = /^(on|true|1|yes)$/i.test(val) ? true
      : /^(off|false|0|no)$/i.test(val) ? false : null;
    if (b === null) return wa.send(CONFIG_USAGE + " (" + key + ": on/off)");
    const c = readConfigFile();
    c[BOOLS[key]] = b;
    writeConfigFile(c);
    log("config " + key + " = " + b);
    return wa.send("✅ " + key + " = " + (b ? "on" : "off") +
      (key === "whatsapp" ? " (applies after restart)" : " — live now"));
  }
  if (key === "ntfy") {
    if (!val || val.length > 120 || /\s/.test(val)) return wa.send(CONFIG_USAGE + " (ntfy: one topic word)");
    const c = readConfigFile();
    c.ntfyTopic = val;
    writeConfigFile(c);
    log("config ntfy topic saved");
    return wa.send("✅ ntfy topic saved — set config notify on to push to it");
  }
  if (key === "digest") {
    if (/^(auto|open|first)$/i.test(val)) {
      clearDigestSchedule();
      log("config digest = first-open");
      return wa.send("✅ digest back to FIRST OPEN of the day — one paper when you open the laptop (never before 05:00)");
    }
    const dm = val.match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/i);
    if (!dm) return wa.send(CONFIG_USAGE + " (digest: 18:00 or 9am)");
    let h = Number(dm[1]);
    const min = dm[2] ? Number(dm[2]) : 0;
    const ap = (dm[3] || "").toLowerCase();
    if (ap === "pm" && h < 12) h += 12;
    if (ap === "am" && h === 12) h = 0;
    if (h > 23 || min > 59) return wa.send(CONFIG_USAGE + " (digest: 18:00 or 9am)");
    const c = readConfigFile();
    c.digest = { hour: h, minute: min };
    writeConfigFile(c);
    digestState.hour = null; // config becomes the source; drop stale quick override
    digestState.minute = null;
    saveDigestState();
    log("config digest = " + h + ":" + String(min).padStart(2, "0"));
    return wa.send("✅ digest scheduled daily at " +
      String(h).padStart(2, "0") + ":" + String(min).padStart(2, "0"));
  }
  return wa.send("⚠️ unknown setting '" + key + "' — try: mirror · notify · whatsapp · digest · ntfy");
}

/* ---------- unified FIFO task queue ----------
   Every incoming message becomes a task. Tasks run strictly one at a time
   in arrival order — commands, approvals and assistant requests alike —
   so nothing is rejected while another task is still working, and replies
   come back in the order the messages arrived. */
const taskQueue = [];
let taskRunning = false;
const QUEUE_MAX = 8;
let skipRequested = false; // #9 — "skip": in-flight assistant turn drops its reply
let currentTask = null;    // {label, at} while a task is executing (queue cmd)

/* #10 — pending tasks survive a crash/restart: every routed message text is
   written to queue-pending.json and removed when its task finishes; on boot
   the leftovers are fed back through handleIncoming (at-least-once). */
const PENDING_FILE = path.join(__dirname, "queue-pending.json");
let pendingRaw = [];
try { pendingRaw = JSON.parse(fs.readFileSync(PENDING_FILE, "utf8")) || []; } catch {}
let curRaw = null;     // message text being routed right now (enqueue reads it)
let restoring = false; // suppress "queued #" chatter while replaying
let remindTimer = null; // #3 reminder pump
let lastMsg = { text: "", at: 0 }; // #17 duplicate-tap guard

/* #14 — assistant rate cap: this hour's turn timestamps (assistant.ask only;
   commands/approvals bypass it). Keeps a runaway echo loop from burning the
   free-model quota. */
const ASSIST_RATE_MAX = 20;
const ASSIST_RATE_WINDOW = 60 * 60 * 1000;
const assistTurns = [];
function assistRateHit() {
  const now = Date.now();
  while (assistTurns.length && now - assistTurns[0] > ASSIST_RATE_WINDOW) assistTurns.shift();
  if (assistTurns.length >= ASSIST_RATE_MAX) return true;
  assistTurns.push(now);
  return false;
}

function savePending() {
  try { writeAtomic(PENDING_FILE, JSON.stringify(pendingRaw)); } catch {}
}

function enqueue(label, fn) {
  if (taskQueue.length >= QUEUE_MAX) {
    try { wa.send("🗑 queue is full (8) — wait for the current tasks to finish, then resend."); } catch {}
    return;
  }
  const waiting = taskRunning || taskQueue.length > 0;
  taskQueue.push({ label, fn, raw: curRaw, at: Date.now() });
  if (curRaw) { pendingRaw.push(curRaw); savePending(); }
  if (waiting && !restoring) {
    log("queue +" + taskQueue.length + " " + label);
    try { wa.send("⏳ queued #" + taskQueue.length + ": " + label); } catch {}
  }
  drainQueue();
}

function finishTask(t) {
  if (!t.raw) return;
  const i = pendingRaw.indexOf(t.raw);
  if (i >= 0) pendingRaw.splice(i, 1);
  savePending();
}

async function drainQueue() {
  if (taskRunning) return;
  taskRunning = true;
  try {
    while (taskQueue.length) {
      const t = taskQueue.shift();
      skipRequested = false; // fresh task — a stale skip must not mute it
      currentTask = { label: t.label, at: Date.now() };
      log("queue run " + t.label);
      try {
        await t.fn();
      } catch (e) {
        log("task error [" + t.label + "]: " + e.message);
        try { await wa.send("⚠️ failed: " + t.label); } catch {}
      } finally {
        finishTask(t);
        currentTask = null;
      }
    }
  } finally {
    taskRunning = false;
  }
}

/* ---------- queue visibility + management (#10 tier-1) ----------
   "queue" must answer NOW (a status check queued behind a long task would
   arrive too late to be useful), so both commands sit with the other
   control signals and bypass the FIFO. */

function fmtAge(at) {
  const s = Math.max(0, Math.floor((Date.now() - at) / 1000));
  return s < 60 ? s + "s" : Math.floor(s / 60) + "m " + (s % 60) + "s";
}

function fmtQueue() {
  const lines = ["🧾 TASK QUEUE"];
  lines.push(currentTask
    ? "▶ running: " + currentTask.label + " (" + fmtAge(currentTask.at) + ")"
    : "▶ nothing running");
  if (taskQueue.length) {
    lines.push("⏳ waiting (" + taskQueue.length + "):");
    taskQueue.forEach((t, i) => lines.push("  " + (i + 1) + ". " + t.label + " (" + fmtAge(t.at || Date.now()) + ")"));
  } else {
    lines.push("⏳ queue empty");
  }
  lines.push("", "clear drops waiting · skip stops current");
  return lines.join("\n");
}

function clearQueue() {
  if (!taskQueue.length) {
    return wa.send("✅ queue is already empty" + (currentTask ? " (current task keeps running)" : "") + ".");
  }
  const n = taskQueue.length;
  for (const t of taskQueue) finishTask(t); // also drop their raws from queue-pending.json
  taskQueue.length = 0;
  log("queue cleared " + n + " waiting task(s)");
  return wa.send("🗑 cleared " + n + " waiting task(s)" +
    (currentTask ? " — current keeps running (skip to stop it)" : "") + ".");
}

/* ---------- incoming WhatsApp messages ---------- */

async function handleIncoming(text, files) {
  if (!wa) return;
  const raw = text.trim();
  curRaw = raw;
  try {
    return await routeIncoming(raw, text, files);
  } finally {
    curRaw = null;
  }
}

async function routeIncoming(raw, text, files) {
  // Safety net: never parse our own outbound messages as commands, even if
  // an id mismatch lets an echo through the dedupe in whatsapp.js.
  if (/^(🔔|📊|📁|🤖|❓|✅|⚠️|❌|⏳|↩️|🗑|📸|🧠|🔧)/.test(raw)) return;

  // #17 — pocket double-tap: the exact same text again within 10s is a
  // duplicate, not a new request. Skip it silently (the first copy runs).
  // #8 — attachments join the key: two caption-less photos share the same
  // synthetic text, and only the file identity tells them apart.
  const now = Date.now();
  const dupKey = raw + (files && files.length
    ? "\u0000" + files.map((f) => path.basename(String(f)).replace(/^\d+_/, "")).join(",")
    : "");
  if (dupKey === lastMsg.text && now - lastMsg.at < 10000) {
    log("duplicate suppressed: " + raw.slice(0, 50));
    return;
  }
  lastMsg = { text: dupKey, at: now };

  const low = raw.toLowerCase();
  const label = raw.slice(0, 44).replace(/\s+/g, " ");
  const st = () => (getState ? getState() : null);

  // #9 — stop/skip are CONTROL signals: they act on whatever is running this
  // instant, so they bypass the FIFO (a queued "stop" would arrive too late).
  // "stop <n>" stays in the queue path below (targeted, not preemptive).
  if (/^\/?\s*(?:stop|halt)(?:\s+(?:current|now|this))?\s*$/i.test(raw)) return stopCurrent();
  if (/^\/?\s*skip\s*$/i.test(raw)) return skipCurrent();
  // queue observability/management — also immediate (see fmtQueue).
  if (/^\/?\s*queue\s*$/i.test(raw)) return wa.send(fmtQueue());
  if (/^\/?\s*clear(?:\s+queue)?\s*$/i.test(raw)) return clearQueue();
  // DND — must take effect NOW, even while a task is running
  const dm = raw.match(/^\/?\s*(?:dnd|quiet|donotdisturb)\b\s*(.*)$/i);
  if (dm) return handleDnd(dm[1].trim());
  // config view/set — immediate (a settings read queued behind a long task is useless)
  const cm = raw.match(/^\/?\s*(?:config|settings)\b\s*(.*)$/i);
  if (cm) return handleConfig(cm[1].trim());

  // numbered: "<n> allow|always|reject>" — re-resolved when it actually runs,
  // so a prompt answered or cancelled while queued reports accurately.
  let m = raw.match(/^(\d{1,2})\s+(allow|always|reject|approve|deny)\b/i);
  if (m) {
    const n = Number(m[1]);
    const choice = m[2].toLowerCase();
    return enqueue("#" + n + " " + choice, async () => {
      const item = findBySeq(n);
      if (!item) return wa.send("⚠️ #" + n + " is no longer pending.");
      return answerPrompt(item, choice, raw);
    });
  }

  // numbered form answer: "<n>: <answer>"
  m = raw.match(/^(\d{1,2})\s*[:\-]\s*([\s\S]+)$/);
  if (m) {
    const n = Number(m[1]);
    const ans = m[2];
    const seen = findBySeq(n);
    if (seen && seen.kind === "form") {
      return enqueue("#" + n + " answer", async () => {
        const item = findBySeq(n);
        if (!item) return wa.send("⚠️ #" + n + " is no longer pending.");
        return answerForm(item, ans);
      });
    }
    if (seen) {
      return enqueue("#" + n + " reply", async () => {
        const item = findBySeq(n);
        if (!item) return wa.send("⚠️ #" + n + " is no longer pending.");
        return answerPrompt(item, ans, raw);
      });
    }
    // no matching prompt — fall through to the normal command/assistant path
  }

  // /screenshot [window|screen|<app title>] — fresh capture sent to the chat.
  // SLASH-ONLY by user request: natural-language screenshot asks ("take a
  // screenshot", "send my screenshot") sometimes get misunderstood by the
  // model, so a fresh capture is ONLY ever triggered by /screenshot or
  // /screen. Unslashed text falls through to the assistant, which handles
  // old/saved screenshots via the Screenshots directory + <files>.
  m = raw.match(/^\/\s*(?:screenshot|screen[\s-]?shot)\b\s*(.*)$/i);
  if (m) {
    const arg = m[1].trim();
    // /screenshot region|selection|area|select — drag-select a region.
    if (/^(region|selection|sel|area|select)$/i.test(arg)) {
      return enqueue("region shot", () => runRegion("shot"));
    }
    return enqueue("screenshot", () => takeScreenshot(arg));
  }

  // /ocr [region] — drag-select text, OCR it locally (Windows.Media.Ocr).
  // /ocr full|screen|all — OCR the whole current screen with no selection.
  m = raw.match(/^\/\s*ocr\b\s*(.*)$/i);
  if (m) {
    const arg = m[1].trim();
    const mode = /^(full|screen|all|desktop)$/i.test(arg) ? "ocrfull" : "ocr";
    return enqueue("ocr", () => runRegion(mode));
  }

  // ghwatch [owner/repo | off] — watch a repo's issues/PRs/CI (#feature 2)
  m = raw.match(/^\/?\s*gh(?:hub)?watch\b\s*(.*)$/i);
  if (m) {
    const arg = m[1].trim();
    return enqueue("ghwatch", () => ghwatch.handle(arg));
  }

  // weather [city] — current conditions + 4-day outlook (#feature 3).
  // With an arg the city is saved as the default (pill + digest use it).
  m = raw.match(/^\/?\s*weather\b\s*(.*)$/i);
  if (m) {
    const arg = m[1].trim();
    return enqueue("weather", () => cmdWeather(arg));
  }

  // news [hn|<company>] — HN top-5 + company headlines on demand (#4/#5)
  m = raw.match(/^\/?\s*news\b\s*(.*)$/i);
  if (m) {
    const arg = m[1].trim();
    return enqueue("news", () => news.handle(arg));
  }

  // links / tabs — the paper's URLs, numbered for `open <n>` (#11)
  m = raw.match(/^\/?\s*(?:links|tabs)\s*$/i);
  if (m) return enqueue("links", sendLinks);

  // open <n|hn|giants|all> — open the paper's links as browser tabs.
  // Strict full-message vocab on purpose: "open notepad" / "open github.com"
  // must keep falling through to the assistant.
  m = raw.match(/^\/?\s*open\s+(tabs?|links?|hn|hacker|giants|compan(?:y|ies)|all|\d{1,2})\s*$/i);
  if (m) return enqueue("open links", () => openLinks(m[1]));

  // reminders: "remind in 10m X" / "remind at 18:30 X" / "reminders" / "cancel 3"
  m = raw.match(/^\/?\s*remind(?:er)?s?\b\s*(.*)$/i);
  if (m) {
    const arg = m[1].trim();
    if (!arg || /^(list|show)$/i.test(arg)) {
      return enqueue("reminders", () => {
        if (!reminders.length) return wa.send("✅ no pending reminders.");
        const lines = [...reminders].sort((a, b) => a.at - b.at).map((r) =>
          "#" + r.id + " · " + fmtWhen(r.at) + " · " + r.text);
        return wa.send("⏰ REMINDERS (" + reminders.length + "):\n" + lines.join("\n") + "\n\ncancel <n> to remove one");
      });
    }
    const w = parseWhen(arg);
    if (w && w.rest) {
      const text = w.rest.replace(/^to\s+/i, "");
      return enqueue("remind", () => {
        const id = addReminder(w.at, text);
        log("reminder set #" + id + " for " + new Date(w.at).toISOString() + " " + text.slice(0, 50));
        return wa.send("⏰ reminder #" + id + " set for " + fmtWhen(w.at) + ": " + text);
      });
    }
    // "remind ..." with no recognizable time -> let the assistant parse it
    // ("remind me to drink water when I'm free" style falls through).
  }
  m = raw.match(/^\/?\s*cancel\s+(?:reminder\s+)?#?(\d+)$/i);
  if (m) {
    const id = Number(m[1]);
    return enqueue("cancel reminder", () => {
      const i = reminders.findIndex((r) => r.id === id);
      if (i < 0) return wa.send("⚠️ no reminder #" + id + ".");
      const r = reminders[i];
      reminders.splice(i, 1);
      saveReminders();
      return wa.send("🗑 cancelled #" + id + ": " + r.text);
    });
  }

  // session control (#6): "run <n> <prompt>" / "stop <n>" against the
  // numbered list from status/sessions.
  m = raw.match(/^\/?\s*run\s+#?(\d{1,2})\s+([\s\S]+)$/i);
  if (m) {
    const n = Number(m[1]);
    const text = m[2].trim();
    if (!text) return;
    return enqueue("run #" + n, async () => {
      const s = resolveSession(n);
      if (!s) return wa.send("⚠️ no session #" + n + " — send \"sessions\" first.");
      try {
        await api("POST", "/api/session/" + s.id + "/prompt", { text });
        log("session run #" + n + " -> " + s.id + ": " + text.slice(0, 60));
        return wa.send("▶ sent to [" + n + "] " + s.title + ":\n" + text.slice(0, 300) +
          "\n\n(ping me when done? the bridge reports finished sessions — or stop " + n + " to interrupt)");
      } catch (e) {
        return wa.send("⚠️ run failed: " + e.message);
      }
    });
  }
  m = raw.match(/^\/?\s*(?:stop|interrupt)\s+#?(\d{1,2})\s*$/i);
  if (m) {
    const n = Number(m[1]);
    return enqueue("stop #" + n, async () => {
      const s = resolveSession(n);
      if (!s) return wa.send("⚠️ no session #" + n + " — send \"sessions\" first.");
      try {
        await api("POST", "/api/session/" + s.id + "/interrupt");
        log("session stop #" + n + " -> " + s.id);
        return wa.send("⏹ interrupted [" + n + "] " + s.title);
      } catch (e) {
        return wa.send("⚠️ stop failed: " + e.message);
      }
    });
  }

  // clipboard (#7): "copy <text>" -> PC clipboard; "clipboard"/"paste" -> read it back
  m = raw.match(/^\/?\s*copy(?:\s+([\s\S]+))?$/i);
  if (m) {
    const text = (m[1] || "").trim();
    if (text) {
      return enqueue("copy", async () => {
        const msg = await copyToClipboard(text);
        log("clipboard copy: " + (msg.startsWith("📋") ? text.length + " chars" : msg));
        return wa.send(msg);
      });
    }
    return enqueue("clipboard", sendClipboard);
  }
  m = raw.match(/^\/?\s*(?:clipboard|clip|paste)\s*$/i);
  if (m) return enqueue("clipboard", sendClipboard);

  // daily digest (#8): "digest" sends now · "digest at 18:00" schedules ·
  // "digest auto" returns to first-open-of-the-day mode
  m = raw.match(/^\/?\s*(?:digest|daily)\b\s*(.*)$/i);
  if (m) {
    const arg = m[1].trim();
    if (arg) {
      if (/^(auto|open|first|first-open)$/i.test(arg)) {
        clearDigestSchedule();
        return enqueue("digest schedule", () =>
          wa.send("🗞 daily digest set to FIRST OPEN of the day — one paper the moment you open the laptop each day (never before 05:00)"));
      }
      if (/^status$/i.test(arg)) { // A4: where the digest stands right now
        const cfg = digestCfg();
        const mode = !cfg.enabled ? "off"
          : (cfg.mode === "at"
            ? "at " + String(cfg.hour).padStart(2, "0") + ":" + String(cfg.minute).padStart(2, "0")
            : "first-open (floor " + String(cfg.floor).padStart(2, "0") + ":00)");
        let last = "never";
        if (typeof digestState.lastAt === "number") {
          const d = new Date(digestState.lastAt);
          last = d.toDateString() + " " +
            String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0");
        }
        const todayStr = new Date().toDateString();
        const sentToday = digestState.day === todayStr ||
          (typeof digestState.lastAt === "number" && new Date(digestState.lastAt).toDateString() === todayStr);
        return enqueue("digest status", () => wa.send(
          "🗞 digest: " + mode + " · today: " + (sentToday ? "sent ✅" : "not yet") + " · last: " + last));
      }
      const w = parseWhen(arg);
      if (w) {
        const d = new Date(w.at);
        digestState.hour = d.getHours();
        digestState.minute = d.getMinutes();
        saveDigestState();
        return enqueue("digest schedule", () =>
          wa.send("🗞 daily digest rescheduled to " +
            String(digestState.hour).padStart(2, "0") + ":" + String(digestState.minute).padStart(2, "0") +
            " — auto-sends daily (late is fine if the PC was off)"));
      }
      return enqueue("digest", () =>
        wa.send("⚠️ usage: digest (send now) · digest at 18:00 (schedule) · digest auto (first open) · digest status"));
    }
    return enqueue("digest", () => sendDigest()); // manual send also stamps lastAt (A4)
  }

  switch (low) {
    case "help":
    case "commands":
      return enqueue("help", () => wa.send(HELP));
    case "brief":
    case "summary":
    case "tldr":
    case "short":
      return enqueue("brief", async () => wa.send(await fmtBrief()));
    case "status":
      return enqueue("status", () => wa.send(fmtStatus(st())));
    case "repos":
    case "git":
      return enqueue("repos", async () => wa.send(fmtRepos(await repos.list(true))));
    case "sessions":
      return enqueue("sessions", () => wa.send(fmtStatus(st())));
    case "prompts":
    case "pending":
      return enqueue("prompts", () =>
        wa.send(pending.size ? [...pending.values()].map(describe).join("\n\n") : "✅ no pending prompts"));
    case "allow":
    case "approve":
    case "always":
    case "reject":
    case "deny":
      return enqueue(low, () => {
        const item = [...pending.values()].find((p) => p.kind === "permission");
        if (!item) return wa.send("✅ no pending approval.");
        return answerPrompt(item, low === "approve" ? "allow" : low, raw);
      });
    default: {
      // A pending form takes short free-text as its answer.
      if (raw.length <= 300 && !looksLikeRequest(raw)) {
        const form = [...pending.values()].find((p) => p.kind === "form");
        if (form) return enqueue("form answer", () => answerForm(form, raw));
      }
      // Otherwise treat it as a natural-language request for Notchy.
      // #8 — files ride along with the ask (dropped after a restart-replay:
      // enqueue only persists the raw text).
      return enqueue(label, () => askAssistant(raw, 0, files));
    }
  }
}

/* Does this read like "go find/do something" rather than a form answer? */
function looksLikeRequest(s) {
  return /\b(send|find|get|show|give|search|look|where|which|list|latest|recent|my|me|open|run|check|how|what|can you|please|play|pause|music|song|browse|launch|website|url|site|volume|next|prev)\b/i.test(s)
    || s.length > 120;
}

async function askAssistant(text, depth = 0, files = null) {
  if (!assistant) return wa.send(HELP);
  // #14 — cap assistant turns per hour. Every turn (including <continue>
  // follow-ups) is a real model call, so all of them count.
  if (assistRateHit()) {
    log("rate cap hit — request refused");
    return wa.send("⏳ Assistant is rate-limited right now (20 requests/hour). Try again in a few minutes.");
  }
  // Acknowledge immediately — the agent can take a minute on a real search.
  await wa.send(depth === 0 ? "🧠 on it…" : "🔧 working…");
  log("assistant request: " + text.slice(0, 120).replace(/\n/g, " ") +
    (depth ? " (cont " + depth + ")" : "") + (files && files.length ? " +files" : ""));
  const res = await assistant.ask(text, false, files);
  if (skipRequested) {
    // #9 — user skipped while this turn was running: the session was already
    // interrupted; don't dump the partial reply on them.
    log("assistant reply dropped (skipped)");
    return;
  }
  for (const chunk of chunkReply(res.reply || "")) await wa.send(chunk);
  const actions = res.actions || [];
  if (!res.reply && actions.length) await wa.send("✅ done");
  for (const a of actions) {
    if (String(a.type).toLowerCase() === "remind") {
      // #3 — assistant-parsed reminder: "remind:in 10m drink water".
      const w = parseWhen(String(a.value));
      if (w && w.rest) {
        const text = w.rest.replace(/^to\s+/i, "");
        const id = addReminder(w.at, text);
        log("reminder set (assistant) #" + id + " " + new Date(w.at).toISOString());
        await wa.send("⏰ reminder #" + id + " set for " + fmtWhen(w.at) + ": " + text);
      } else {
        await wa.send("⚠️ couldn't read that reminder time — try: remind in 10m <text>");
      }
      continue;
    }
    if (String(a.type).toLowerCase() === "copy") {
      // #7 — assistant-parsed clipboard write: "copy:<text>".
      await wa.send(await copyToClipboard(a.value));
      continue;
    }
    if (String(a.type).toLowerCase() === "clipboard") {
      // #7 — "clipboard:" (no value) reads the PC clipboard back into chat.
      await sendClipboard();
      continue;
    }
    const ok = runAction(a);
    log("action " + a.type + ":" + a.value + " -> " + ok);
    if (!ok) await wa.send("⚠️ couldn't do that: " + a.type + ":" + a.value);
  }
  for (const f of res.files || []) {
    await wa.sendFile(f.path, path.basename(f.path));
  }
  // Multi-step: the assistant launched an app and left follow-up work.
  // Give the app a moment to open, then hand the instruction back as turn 2.
  if (res.cont && depth < 2) {
    log("continue -> " + res.cont.slice(0, 100).replace(/\n/g, " "));
    await new Promise((r) => setTimeout(r, 3500));
    return askAssistant(res.cont, depth + 1);
  }
}

/* Execute one <action> line decided by the assistant (natural language in,
   deterministic action out). Runs in the Electron main process, so it is
   reliable even when OpenCode's own shell is flaky. */
function spawnRetry(cmd, args, opts, tries = 2) {
  try {
    const c = spawn(cmd, args, opts);
    c.on("error", (e) => {
      log("spawn error " + cmd + " (" + e.message + ")" + (tries > 1 ? " — retrying" : ""));
      if (tries > 1) setTimeout(() => spawnRetry(cmd, args, opts, tries - 1), 1500);
    });
    c.unref();
    return c;
  } catch (e) {
    log("spawn throw " + cmd + ": " + e.message);
    return null;
  }
}

/* Fresh screenshot on demand: runs screenshot.ps1, then pushes the PNG into
   the chat. value: "" | "screen" | "window" | <app title> */
async function takeScreenshot(value) {
  const v = String(value || "").trim();
  const target = /^window$|^current window$/i.test(v) ? "window" : /^screen$|^full$|^desktop$/i.test(v) || !v ? "screen" : "window";
  const title = target === "window" && v && !/^window$|^current window$/i.test(v) ? v : "";
  const args = target === "window" ? ["-Target", "window"] : ["-Target", "screen"];
  if (title) args.push("-Title", title);
  log("screenshot target=" + target + (title ? " title=" + title : ""));
  await wa.send("📸 capturing " + (title || target) + "…");
  const out = await runPs(path.join(__dirname, "scripts", "screenshot.ps1"), args, { timeoutMs: 20000, tries: 3 });
  const file = (out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean).pop()) || "";
  if (!file || !fs.existsSync(file)) {
    return wa.send("⚠️ screenshot failed — no image produced.");
  }
  await wa.sendFile(file, path.basename(file));
  log("screenshot sent: " + file);
}

/* Region capture + OCR: hand the mode to main.js (it pre-captures the
   screen, opens the drag selector, crops / OCRs) and push the result into
   the chat. mode: "shot" | "ocr" (select) | "ocrfull" (whole screen). */
function runRegion(mode) {
  return new Promise((resolve) => {
    if (!regionFn) { resolve(wa.send("⚠️ region capture is not available in this build.")); return; }
    wa.send(mode === "shot" ? "✂️ drag to select a region…" : mode === "ocr" ? "📄 drag to select text…" : "📄 reading the whole screen…");
    let done = false;
    let guard = null;
    const finish = async (err, out) => {
      if (done) return;
      done = true;
      if (guard) clearTimeout(guard);
      try {
        if (err === "cancelled") return resolve(await wa.send("↩️ selection cancelled"));
        if (err) return resolve(await wa.send("⚠️ " + err));
        if (out && out.kind === "shot" && out.path) {
          await wa.sendFile(out.path, path.basename(out.path));
          log("region shot sent: " + out.path);
          return resolve();
        }
        if (out && out.kind === "ocr") {
          const t = String(out.text || "").trim();
          if (!t) return resolve(await wa.send("📄 no text found in that region."));
          return resolve(await wa.send("📄 OCR (" + (out.lang || "?") + "):\n" + t));
        }
        resolve();
      } catch (e) {
        log("region send err " + e.message);
        resolve();
      }
    };
    try {
      regionFn(mode, finish);
    } catch (e) {
      done = true;
      resolve(wa.send("⚠️ region capture failed: " + e.message));
    }
    // Safety: never let a forgotten selection wedge the FIFO queue.
    if (!done) guard = setTimeout(() => {
      if (done) return;
      done = true;
      resolve(wa.send("⚠️ selection timed out — try /screenshot region again."));
    }, 120000);
  });
}

/* weather [city]: fresh Open-Meteo fetch; an argument becomes the default
   city (config.json weatherCity) — only after the fetch proves it exists. */
async function cmdWeather(arg) {
  const cityArg = String(arg || "").replace(/^\s*(?:in|for|at)\s+/i, "").trim();
  try {
    const w = await weather.get(cityArg || null);
    if (cityArg) {
      try { weather.setCity(cityArg); } catch (e) { log("weather city save err " + e.message); }
    }
    return wa.send(weather.fmtFull(w, cityArg ? "city saved as default — bare \"weather\" uses it" : null));
  } catch (e) {
    return wa.send("⚠️ weather unavailable: " + e.message);
  }
}

/* links — list the paper's URLs numbered; open <sel> — open them as
   browser tabs (#11). Both read news.links() (the last-collected paper,
   fetched on demand if it was never built). Opening goes through
   runAction(browser): Electron shell in-process, PowerShell fallback —
   unless a test injected its own openUrl. */
let openUrl = null; // (url) => void — injected by tests; null = runAction

async function sendLinks() {
  try {
    const list = await news.links();
    if (!list.length) return wa.send("🔗 no links yet — send `digest` (or `news`) first.");
    const lines = ["🔗 paper links (" + list.length + "):"];
    list.forEach((l, i) => lines.push((i + 1) + ". " + l.title + " " + l.url));
    lines.push("", "open <n> · open hn · open giants · open all");
    return wa.send(lines);
  } catch (e) {
    return wa.send("⚠️ links failed: " + e.message);
  }
}

async function openLinks(arg) {
  const a = String(arg || "").trim().toLowerCase();
  let list;
  try { list = await news.links(); } catch (e) { return wa.send("⚠️ links unavailable: " + e.message); }
  if (!list.length) return wa.send("🔗 no links yet — send `digest` (or `news`) first.");
  let pick;
  if (/^\d+$/.test(a)) {
    const n = Number(a);
    if (n < 1 || n > list.length) {
      return wa.send("⚠️ no link #" + n + " — the paper has " + list.length + " (see `links`)");
    }
    pick = [list[n - 1]];
  } else if (a === "hn" || a === "hacker") pick = list.filter((l) => l.group === "hn");
  else if (/^compan/.test(a)) pick = list.filter((l) => l.group === "giants");
  else if (/^(all|tabs?|links?)$/.test(a)) pick = list;
  else return wa.send("⚠️ usage: open <n> · open hn · open giants · open all · links");
  // dedupe — the same URL never opens twice in one go
  const seen = new Set();
  pick = pick.filter((l) => (seen.has(l.url) ? false : (seen.add(l.url), true)));
  for (const l of pick) {
    if (openUrl) { try { openUrl(l.url); } catch (e) { log("openUrl err " + e.message); } }
    else runAction({ type: "browser", value: l.url });
  }
  log("opened " + pick.length + " link tab(s)");
  return wa.send(pick.length === 1
    ? "🔗 opened 1 tab — " + pick[0].title
    : "🔗 opened " + pick.length + " tabs in your browser");
}

function runAction(a) {
  try {
    const v = String((a && a.value) || "").trim();
    const type = String((a && a.type) || "").toLowerCase();
    if (!v) return false;
    const detached = { detached: true, stdio: "ignore", windowsHide: true };

    if (type === "media") {
      if (!/^(playpause|next|prev|stop)$/.test(v)) return false;
      spawnRetry("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File",
        path.join(__dirname, "scripts", "media-key.ps1"), v], detached);
      return true;
    }

    // Prefer Electron's shell API when running inside the app — it calls
    // ShellExecute in-process (no spawn), so it survives this PC's flaky
    // process creation.
    let eshell = null;
    try { const el = require("electron"); if (el && el.shell) eshell = el.shell; } catch {}

    if (type === "browser") {
      if (!/^https?:\/\//i.test(v)) return false;
      if (eshell) { eshell.openExternal(v).catch((e) => log("openExternal failed: " + e.message)); return true; }
    } else if (type === "file") {
      if (eshell) { eshell.openPath(v).then((err) => { if (err) log("openPath failed: " + err); }).catch((e) => log("openPath threw: " + e.message)); return true; }
    } else if (type === "app") {
      // "start" resolves PATH, App Paths (chrome, msedge…) and .lnk names.
      const parts = v.split(/\s+/);
      spawnRetry("cmd.exe", ["/c", "start", "", ...parts], detached);
      // Bring the new window to the front once it has had time to open.
      const appName = parts[0];
      setTimeout(() => {
        spawnRetry("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File",
          path.join(__dirname, "scripts", "focus-window.ps1"), appName], detached);
      }, 1500);
      return true;
    } else if (type === "focus") {
      spawnRetry("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File",
        path.join(__dirname, "scripts", "focus-window.ps1"), v], detached);
      return true;
    }
    // Plain-node fallbacks for browser/file. cmd's `start` mangles URLs into
    // about:blank, so use PowerShell Start-Process (verified reliable).
    if (type === "browser" || type === "file") {
      spawnRetry("powershell.exe", ["-NoProfile", "-Command", "Start-Process", v], detached);
      return true;
    }
    return false;
  } catch (e) {
    log("action failed: " + e.message);
    return false;
  }
}

/* WhatsApp will not carry a giant bubble; split on paragraph boundaries. */
function chunkReply(text, limit = 3000) {
  const t = (text || "").trim();
  if (!t) return [];
  if (t.length <= limit) return [t];
  const out = [];
  let rest = t;
  while (rest.length > limit) {
    let cut = rest.lastIndexOf("\n\n", limit);
    if (cut < limit * 0.5) cut = rest.lastIndexOf(". ", limit);
    if (cut < limit * 0.5) cut = limit;
    out.push(rest.slice(0, cut + 1).trim());
    rest = rest.slice(cut + 1).trim();
  }
  if (rest) out.push(rest);
  return out;
}

function findBySeq(n) {
  for (const p of pending.values()) if (p.__seq === n) return p;
  return null;
}

function describe(p) {
  if (p.kind === "permission") return fmtPermission(p, getState ? getState() : null);
  return fmtForm(p, getState ? getState() : null);
}

async function answerPrompt(item, choice, raw) {
  const reply = choice === "always" ? "always" : choice === "reject" || choice === "deny" ? "reject" : "once";
  try {
    // OpenCode ≥2.x expects {decision: "once"|"always"|"reject"} — {reply} is a 400.
    await api("POST", "/api/session/" + item.sessionID + "/permission/" + item.id + "/reply", { decision: reply });
    pending.delete(item.id);
    pushPending();
    log("permission " + item.id + " -> " + reply);
    return wa.send(
      (reply === "reject" ? "❌ rejected" : reply === "always" ? "✅ allowed (always)" : "✅ allowed (once)") +
        " — #" + item.__seq
    );
  } catch (e) {
    log("permission reply failed: " + e.message);
    return wa.send("⚠️ failed to reply: " + e.message);
  }
}

async function answerForm(item, text) {
  try {
    const fields = item.fields || [];
    const answer = {};
    // single-field forms map directly; multi-field: match by order of "key: value" pairs, else first field
    const pairs = {};
    const re = /([A-Za-z0-9_\- ]{1,40})\s*[:=]\s*([^;]+)/g;
    let mm;
    while ((mm = re.exec(text))) pairs[mm[1].trim().toLowerCase()] = mm[2].trim();
    let usedPair = false;
    for (const f of fields) {
      const key = (f.title || f.key || "").toLowerCase();
      let val = pairs[key] || pairs[(f.key || "").toLowerCase()];
      if (val != null) { usedPair = true; }
      else if (fields.length === 1) val = text;
      else continue;
      answer[f.key] = coerce(f, val);
    }
    if (!usedPair && fields.length > 1 && Object.keys(answer).length === 0) {
      // fallback: put the whole text into the first field
      answer[fields[0].key] = coerce(fields[0], text);
    }
    await api("POST", "/api/form/" + item.id + "/reply", { answer });
    pending.delete(item.id);
    pushPending();
    log("form " + item.id + " answered");
    return wa.send("✅ answered #" + item.__seq + " — " + JSON.stringify(answer).slice(0, 180));
  } catch (e) {
    log("form reply failed: " + e.message);
    return wa.send("⚠️ form reply failed: " + e.message);
  }
}

function coerce(f, val) {
  if (f.type === "boolean") return /^(y|yes|true|1|allow)$/i.test(val.trim());
  if (f.type === "number" || f.type === "integer") {
    const n = Number(String(val).replace(/[^\d.\-]/g, ""));
    return f.type === "integer" ? Math.round(n) : n;
  }
  if (f.type === "multiselect") return String(val).split(/[,|]/).map((s) => s.trim()).filter(Boolean);
  return String(val);
}

/* ---------- event stream ---------- */

function pushPending() {
  if (onEvent) {
    try {
      onEvent({
        type: "pending",
        items: [...pending.values()].map((p) => ({
          seq: p.__seq,
          kind: p.kind,
          sessionID: p.sessionID,
          title: p.title || (p.action || ""),
          when: p.__when,
        })),
      });
    } catch {}
  }
}

async function subscribe() {
  const svc = readService();
  if (!svc || !svc.url) throw new Error("service file missing");
  const types = [
    "permission.asked",
    "permission.replied",
    "form.created",
    "form.replied",
    "form.cancelled",
    "session.execution.succeeded",
    "session.execution.failed",
    "session.idle",
  ];
  const qs = types.map((t) => "types=" + encodeURIComponent(t)).join("&");
  abort = new AbortController();
  const res = await fetch(svc.url + "/api/event?" + qs, {
    headers: { Authorization: authHeader(), Accept: "text/event-stream" },
    signal: abort.signal,
  });
  if (!res.ok || !res.body) throw new Error("event stream HTTP " + res.status);
  log("event stream connected");
  reconnectDelay = 1000;

  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf("\n\n")) >= 0) {
      const block = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      for (const line of block.split("\n")) {
        if (!line.startsWith("data:")) continue;
        try { handleEvent(JSON.parse(line.slice(5).trim())); } catch {}
      }
    }
  }
}

async function handleEvent(ev) {
  if (!ev || !ev.type) return;
  const state = getState ? getState() : null;

  // Let the assistant know its run finished (it also polls as a fallback).
  if (ev.type === "session.idle" || ev.type === "session.execution.succeeded") {
    try { assistant.notify(ev.data && ev.data.sessionID, "idle"); } catch {}
  } else if (ev.type === "session.execution.failed") {
    try { assistant.notify(ev.data && ev.data.sessionID, "failed"); } catch {}
  }

  switch (ev.type) {
    case "permission.asked": {
      const d = ev.data;
      if (!d || pending.has(d.id)) return;
      d.__seq = ++pendingSeq;
      d.__when = Date.now();
      d.kind = "permission";
      d.title = d.action;
      pending.set(d.id, d);
      pushPending();
      log("permission.asked #" + d.__seq + " " + d.action);
      if (wa) wa.send(fmtPermission(d, state));
      break;
    }
    case "permission.replied":
    case "form.replied":
    case "form.cancelled": {
      // permission.replied carries {sessionID, requestID, reply}
      const id = ev.data && (ev.data.requestID || ev.data.id || ev.data.permissionID || ev.data.formID);
      if (id && pending.has(id)) { pending.delete(id); pushPending(); }
      break;
    }
    case "form.created": {
      const f = ev.data && ev.data.form;
      if (!f || pending.has(f.id)) return;
      f.__seq = ++pendingSeq;
      f.__when = Date.now();
      f.kind = "form";
      pending.set(f.id, f);
      pushPending();
      log("form.created #" + f.__seq + " " + (f.title || ""));
      if (wa) wa.send(fmtForm(f, state));
      break;
    }
    case "session.execution.succeeded":
    case "session.execution.failed": {
      // gentle completion ping — only for sessions the poll hasn't already flagged
      const id = ev.data && ev.data.sessionID;
      if (!id || !state || !state.online || !wa) return;
      // The assistant's own runs already reply with their answer; no ping.
      if (id === assistant.sessionID) return;
      if (!state.active || !state.active[id]) return;
      const ok = ev.type.endsWith("succeeded");
      if (wa) wa.send((ok ? "✅ " : "❌ ") + "session finished: " + sessionTitle(id, state));
      break;
    }
    default:
      break;
  }
}

/* ---------- lifecycle ---------- */

async function start(deps) {
  wa = deps.whatsapp;
  getState = deps.getState;
  onEvent = deps.onEvent;
  clip = deps.clipboard || null; // #7 — electron clipboard (optional in tests)
  regionFn = deps.region || null; // /screenshot region + /ocr drag-select (main.js)
  openUrl = deps.openUrl || null; // #11 — `open <n>` links (tests inject a capture)
  // GitHub watcher: resumes ghwatch-state.json and starts polling if set
  ghwatch.start({ send: (t) => wa.send(t), onEvent: (e) => { if (onEvent) try { onEvent(e); } catch {} }, log });
  // Tony + news packs: no timers of their own — fmtDigest builds their
  // sections on demand; urgent pushes go through the same WhatsApp outbox.
  modelradar.start({ send: (t) => wa.send(t), log });
  modelprobe.start({ send: (t) => wa.send(t), log });
  selfaudit.start({ log });
  news.start({ send: (t) => wa.send(t), log });
  if (running) return;
  running = true;

  // #3 — reminders: fire anything that came due while we were down, then pump.
  pumpReminders();
  if (remindTimer) clearInterval(remindTimer);
  remindTimer = setInterval(pumpReminders, 10000);

  // #8 — daily digest: catch up immediately (missed while the PC was off),
  // then check once a minute until the day's copy has gone out.
  pumpDigest();
  if (digestTimer) clearInterval(digestTimer);
  digestTimer = setInterval(pumpDigest, 60000);

  // #10 — replay messages that were queued when the app last died.
  if (pendingRaw.length) {
    const leftover = pendingRaw.slice();
    log("restoring " + leftover.length + " pending task(s) from queue-pending.json");
    pendingRaw = [];
    savePending();
    restoring = true; // suppress "queued #" chatter; enqueue re-adds each raw
    try {
      if (wa) await wa.send("🔁 recovered " + leftover.length + " task(s) that were queued before a restart.");
      for (const raw of leftover) {
        try { await handleIncoming(raw); } catch (e) { log("restore error: " + e.message); }
      }
    } finally {
      restoring = false;
    }
  }

  // #16 — pending approvals/forms: entries only shrink on reply events, so
  // a missed event would keep them forever. Drop anything older than 24h.
  setInterval(() => {
    const cut = Date.now() - 24 * 60 * 60 * 1000;
    for (const [id, p] of pending) {
      if ((p.__when || 0) < cut) {
        pending.delete(id);
        log("pending expired #" + p.__seq);
      }
    }
    pushPending();
  }, 60 * 60 * 1000);

  (async () => {
    while (running) {
      try {
        await subscribe();
        log("stream ended");
      } catch (e) {
        log("stream error: " + e.message);
      }
      if (!running) break;
      await new Promise((r) => setTimeout(r, reconnectDelay));
      reconnectDelay = Math.min(reconnectDelay * 2, 30000);
    }
  })();
}

function stop() {
  running = false;
  if (remindTimer) { clearInterval(remindTimer); remindTimer = null; }
  if (digestTimer) { clearInterval(digestTimer); digestTimer = null; }
  try { ghwatch.stop(); } catch {}
  try { if (abort) abort.abort(); } catch {}
}

module.exports = { start, stop, handleIncoming, pending, pushPending, runAction, parseWhen, pumpDigest, digestCfg, isDnd };
