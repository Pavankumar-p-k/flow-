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
const repos = require("./repos");
const assistant = require("./assistant");
const { runPs } = require("./psrun");

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
  const list = ((state && state.sessions) || []).slice(0, 5);
  if (list.length) {
    lines.push("", "sessions:");
    for (const s of list) {
      const busy = state.active && state.active[s.id] ? "▶" : "·";
      lines.push(" " + busy + " " + (s.title || s.id).slice(0, 58));
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
  "help — this message",
  "",
  "messages run one at a time, in order (queued if busy)",
  "",
  "or just talk naturally:",
  "\"open notepad\" · \"play music\" · \"next song\"",
  "\"open github.com\" · \"send me my latest screenshot\"",
  "",
  "screenshots:  /screenshot  ·  /screenshot window  ·  /screenshot <app title>",
  "system:  \"how many tabs are open\" · \"what app is in front\"",
  "",
  "to answer a prompt:  allow / always / reject",
  "or numbered:  2 allow · 1 reject · 1: your answer",
].join("\n");

/* ---------- unified FIFO task queue ----------
   Every incoming message becomes a task. Tasks run strictly one at a time
   in arrival order — commands, approvals and assistant requests alike —
   so nothing is rejected while another task is still working, and replies
   come back in the order the messages arrived. */
const taskQueue = [];
let taskRunning = false;
const QUEUE_MAX = 8;

function enqueue(label, fn) {
  if (taskQueue.length >= QUEUE_MAX) {
    try { wa.send("🗑 queue is full (8) — wait for the current tasks to finish, then resend."); } catch {}
    return;
  }
  const waiting = taskRunning || taskQueue.length > 0;
  taskQueue.push({ label, fn });
  if (waiting) {
    log("queue +" + taskQueue.length + " " + label);
    try { wa.send("⏳ queued #" + taskQueue.length + ": " + label); } catch {}
  }
  drainQueue();
}

async function drainQueue() {
  if (taskRunning) return;
  taskRunning = true;
  try {
    while (taskQueue.length) {
      const t = taskQueue.shift();
      log("queue run " + t.label);
      try {
        await t.fn();
      } catch (e) {
        log("task error [" + t.label + "]: " + e.message);
        try { await wa.send("⚠️ failed: " + t.label); } catch {}
      }
    }
  } finally {
    taskRunning = false;
  }
}

/* ---------- incoming WhatsApp messages ---------- */

async function handleIncoming(text) {
  if (!wa) return;
  const raw = text.trim();
  // Safety net: never parse our own outbound messages as commands, even if
  // an id mismatch lets an echo through the dedupe in whatsapp.js.
  if (/^(🔔|📊|📁|🤖|❓|✅|⚠️|❌|⏳|↩️|🗑)/.test(raw)) return;
  const low = raw.toLowerCase();
  const label = raw.slice(0, 44).replace(/\s+/g, " ");
  const st = () => (getState ? getState() : null);

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
  // Only the direct form takes this fast path; longer natural phrasing falls
  // through to the assistant (which can emit its own screenshot: action).
  m = raw.match(/^\/\s*(?:screenshot|screen[\s-]?shot)\b\s*(.*)$/i)
    || raw.match(/^(?:screenshot|screen[\s-]?shot)\b\s*(.*)$/i);
  if (m) {
    const arg = m[1].trim();
    const simple = !arg || /^(window|current window|screen|full|desktop|entire screen)$/i.test(arg)
      || (arg.length <= 30 && !/\b(of|my|the|send|and|with|for)\b/i.test(arg));
    const slashed = /^\/\s*(?:screenshot|screen[\s-]?shot)/i.test(raw);
    if (slashed || simple) {
      return enqueue("screenshot", () => takeScreenshot(arg));
    }
  }

  switch (low) {
    case "help":
    case "commands":
      return enqueue("help", () => wa.send(HELP));
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
      return enqueue(label, () => askAssistant(raw));
    }
  }
}

/* Does this read like "go find/do something" rather than a form answer? */
function looksLikeRequest(s) {
  return /\b(send|find|get|show|give|search|look|where|which|list|latest|recent|my|me|open|run|check|how|what|can you|please|play|pause|music|song|browse|launch|website|url|site|volume|next|prev)\b/i.test(s)
    || s.length > 120;
}

async function askAssistant(text, depth = 0) {
  if (!assistant) return wa.send(HELP);
  // Acknowledge immediately — the agent can take a minute on a real search.
  await wa.send(depth === 0 ? "🧠 on it…" : "🔧 working…");
  log("assistant request: " + text.slice(0, 120).replace(/\n/g, " ") + (depth ? " (cont " + depth + ")" : ""));
  const res = await assistant.ask(text);
  for (const chunk of chunkReply(res.reply || "")) await wa.send(chunk);
  const actions = res.actions || [];
  if (!res.reply && actions.length) await wa.send("✅ done");
  for (const a of actions) {
    if (String(a.type).toLowerCase() === "screenshot") {
      // Screenshot is async: capture, then push the PNG into the chat.
      await takeScreenshot(a.value);
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
    await api("POST", "/api/session/" + item.sessionID + "/permission/" + item.id + "/reply", { reply });
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
      const id = ev.data && (ev.data.id || ev.data.permissionID || ev.data.formID);
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
  if (running) return;
  running = true;
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
  try { if (abort) abort.abort(); } catch {}
}

module.exports = { start, stop, handleIncoming, pending, pushPending, runAction };
