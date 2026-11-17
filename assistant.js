/* Notchy — natural-language personal assistant over WhatsApp.
   Free-form messages go to a persistent OpenCode session; we wait for it to
   finish, then hand back its reply plus any file paths it found so the bridge
   can push those files into the chat. */
const fs = require("fs");
const path = require("path");
const os = require("os");

const SERVICE_FILE = path.join(os.homedir(), ".local", "state", "opencode", "service.json");
const STATE_FILE = path.join(__dirname, "assistant.json");
const DEBUG = path.join(__dirname, "debug.log");

const TIMEOUT_MS = 240000;   // agent can take a while on big searches
const MAX_FILES = 5;
const MAX_FILE_BYTES = 200 * 1024 * 1024;
const POLL_MS = 2000;
const STALL_MS = 45000;      // give up early if the reply stopped growing

const PROTOCOL = [
  "PROTOCOL — you are Notchy, a personal assistant the user messages from their phone over WhatsApp.",
  "They send short free-form lines. Help them find and retrieve files on this Windows PC.",
  "Actually search the disk with Glob/Grep/Read. Home: C:\\Users\\peter.",
  "Screenshots: C:\\Users\\peter\\OneDrive\\Pictures\\Screenshots. Blender files usually sit in C:\\Users\\peter\\Documents.",
  "Reply BRIEFLY and plainly — it renders as one chat bubble. No markdown headers, no bullet walls.",
  "If the user asked for files, end your reply with this block, up to 5 absolute paths that really exist and are under 200MB:",
  "<files>",
  "C:\\full\\path\\to\\file.ext",
  "</files>",
  "Leave the block out entirely when there is nothing to send. Never invent a path.",
].join("\n");

let sessionID = null;
let busy = false;
let waiter = null; // { sid, kind: 'idle'|'failed', resolve }

function log(line) {
  try { fs.appendFileSync(DEBUG, new Date().toISOString() + " ASSIST " + line + "\n"); } catch {}
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

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
  if (!svc || !svc.url) throw new Error("opencode service unavailable");
  const res = await fetch(svc.url + p, {
    method,
    headers: { Authorization: authHeader(), "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error("HTTP " + res.status + " " + (await res.text()).slice(0, 200));
  const ct = res.headers.get("content-type") || "";
  return ct.includes("json") ? res.json() : res.text();
}

/* ---------- session persistence ---------- */

function persist() {
  try { fs.writeFileSync(STATE_FILE, JSON.stringify({ sessionID })); } catch {}
}

function restore() {
  try {
    const s = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
    if (s.sessionID) sessionID = s.sessionID;
  } catch {}
}

async function ensureSession() {
  if (sessionID) {
    try {
      await api("GET", "/api/session/" + sessionID); // throws 404 if deleted
      return sessionID;
    } catch (e) {
      log("session " + sessionID + " gone (" + e.message.slice(0, 60) + ") — recreating");
      sessionID = null;
    }
  }
  const res = await api("POST", "/api/session", { title: "Notchy Assistant", agent: "general" });
  sessionID = res.data.id;
  persist();
  log("created session " + sessionID);
  return sessionID;
}

/* ---------- completion signalling (SSE) + polling fallback ---------- */

function notify(sid, kind) {
  if (waiter && waiter.sid === sid && (!waiter.kind || waiter.kind === kind)) {
    const w = waiter;
    waiter = null;
    w.resolve(kind);
  }
}

function waitFor(sid, kind, ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      if (waiter && waiter.sid === sid) waiter = null;
      resolve("timeout");
    }, ms);
    waiter = {
      sid,
      kind,
      resolve: (k) => { clearTimeout(timer); resolve(k); },
    };
  });
}

async function fetchMessages(sid) {
  const res = await api("GET", "/api/session/" + sid + "/message?order=desc&limit=100");
  const list = (res && res.data) || [];
  return list.sort((a, b) => (b.time?.created || 0) - (a.time?.created || 0));
}

/* ---------- reply + file extraction ---------- */

function extractFiles(text) {
  const files = [];
  let clean = text;
  const block = text.match(/<files>\s*([\s\S]*?)\s*<\/files>/i);
  if (block) {
    clean = text.replace(block[0], "");
    for (const line of block[1].split(/\r?\n/)) {
      const p = line.trim().replace(/^[-*•]\s*/, "").replace(/^["'`]|["'`]$/g, "");
      if (p) files.push(p);
    }
  }
  // Safety net: if the model forgot the block but wrote real paths, pick them up.
  if (!files.length) {
    const re = /[A-Za-z]:\\[^\s"'<>|?*]+/g;
    let m;
    while ((m = re.exec(text))) {
      let p = m[0].replace(/[.,;:)\]]+$/, "");
      if (p) files.push(p);
    }
  }
  const seen = new Set();
  const valid = [];
  for (const p of files) {
    const norm = p.replace(/\//g, "\\");
    if (seen.has(norm)) continue;
    seen.add(norm);
    try {
      const st = fs.statSync(norm);
      if (st.isFile() && st.size <= MAX_FILE_BYTES) valid.push({ path: norm, size: st.size });
    } catch {}
  }
  return { reply: clean.replace(/\n{3,}/g, "\n\n").trim(), files: valid.slice(0, MAX_FILES) };
}

function collectReply(list, t0) {
  const mine = list
    .filter((m) => m.type === "assistant" && (m.time?.created || 0) >= t0)
    .sort((a, b) => (a.time?.created || 0) - (b.time?.created || 0));
  let text = "";
  for (const m of mine) {
    for (const c of m.content || []) {
      if (c.type === "text" && c.text) text += (text ? "\n\n" : "") + c.text;
    }
  }
  return text;
}

/* ---------- public API ---------- */

async function ask(userText) {
  if (busy) return { reply: "Still working on your last request — send that again in a minute.", files: [], busy: true };
  busy = true;
  try {
    const sid = await ensureSession();
    const t0 = Date.now();
    log("prompt -> " + sid + " :: " + userText.slice(0, 90).replace(/\n/g, " "));

    // Register the waiter before prompting so a fast completion isn't missed.
    const completion = waitFor(sid, null, TIMEOUT_MS);
    const res = await api("POST", "/api/session/" + sid + "/prompt", {
      text: PROTOCOL + "\n\nUSER: " + userText,
    });
    const startedAt = (res.data && res.data.time && res.data.time.created) || t0;

    // Poll for an idle marker after our prompt; SSE notify short-circuits it.
    const deadline = Date.now() + TIMEOUT_MS;
    let lastText = "";
    let lastChange = Date.now();
    let outcome = "timeout";

    while (Date.now() < deadline) {
      const raced = await Promise.race([
        completion.then((k) => ({ done: true, kind: k })),
        sleep(POLL_MS).then(() => ({ done: false })),
      ]);

      let list = [];
      try { list = await fetchMessages(sid); } catch (e) { log("fetch failed: " + e.message.slice(0, 80)); }

      const text = collectReply(list, startedAt);
      if (text && text !== lastText) { lastText = text; lastChange = Date.now(); }

      const idle = list.some((m) => m.type === "idle" && (m.time?.created || 0) >= startedAt);
      if (idle) { outcome = "idle"; break; }

      if (raced.done) {
        if (raced.kind === "failed") { outcome = "failed"; break; }
        if (raced.kind === "idle") { outcome = "idle"; break; }
      }
      // Reply exists but nothing new for a while → treat as finished.
      if (lastText && Date.now() - lastChange > STALL_MS) { outcome = "stalled"; break; }
    }

    if (outcome === "timeout" && !lastText) {
      return { reply: "⏰ That took too long and produced no reply. Try a narrower request.", files: [], error: "timeout" };
    }

    const finalText = lastText || "";
    const { reply, files } = extractFiles(finalText);
    log("done outcome=" + outcome + " chars=" + finalText.length + " files=" + files.length);

    if (!reply && !files.length) {
      return { reply: "🤔 The assistant finished but said nothing. Try rewording.", files: [] };
    }
    return { reply, files, outcome };
  } catch (e) {
    log("ask error: " + e.message);
    const offline = /service unavailable|ENOTFOUND|ECONNREFUSED|fetch failed/i.test(e.message);
    return {
      reply: offline
        ? "⚠️ OpenCode isn't running, so I can't think right now."
        : "⚠️ Assistant error: " + String(e.message).slice(0, 180),
      files: [],
      error: e.message,
    };
  } finally {
    busy = false;
    waiter = null;
  }
}

restore();

module.exports = { ask, notify, get sessionID() { return sessionID; }, MAX_FILE_BYTES };
