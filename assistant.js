/* Notchy — natural-language personal assistant over WhatsApp.
   Free-form messages go to a persistent OpenCode session; we wait for it to
   finish, then hand back its reply plus any file paths it found so the bridge
   can push those files into the chat. */
const fs = require("fs");
const path = require("path");
const os = require("os");
const { runPs } = require("./psrun");

const SERVICE_FILE = path.join(os.homedir(), ".local", "state", "opencode", "service.json");
const STATE_FILE = path.join(__dirname, "assistant.json");
const DEBUG = path.join(__dirname, "debug.log");

const TIMEOUT_MS = 480000;   // hard cap — computer-use turns can legitimately take minutes
const MAX_FILES = 5;
const MAX_FILE_BYTES = 200 * 1024 * 1024;
const POLL_MS = 2000;
const STALL_MS = 60000;      // give up if NOTHING changes (no text, no tools) this long

// The default session model can point at a provider that is out of credits
// (OpenRouter 402s killed every request once). Pin ours to a free model —
// the same one this app's own session uses: MiMo-V2.6-Flash Free.
const ASSIST_MODEL = { providerID: "opencode", id: "mimo-v2.6-flash-free" };

const PROTOCOL = [
  "PROTOCOL — you are Notchy, a personal assistant the user messages from their phone over WhatsApp.",
  "They send short free-form lines. Help them find and retrieve files on this Windows PC,",
  "launch apps, control music, and open websites. Understand their natural language — no fixed commands.",
  "Actually search the disk with Glob/Grep/Read. Home: C:\\Users\\peter.",
  "Screenshots: C:\\Users\\peter\\OneDrive\\Pictures\\Screenshots. Blender files usually sit in C:\\Users\\peter\\Documents.",
  "Reply BRIEFLY and plainly — it renders as one chat bubble. No markdown headers, no bullet walls.",
  "SYSTEM AWARENESS — every message carries a LIVE SYSTEM SNAPSHOT: the foreground window, all open windows, and per-browser tab counts. Answer \"what's open\", \"which app is in front\", \"how many tabs\" directly from it — no tools needed. If it's absent, say you couldn't read the system state.",
  "",
  "FILES — if the user asked for files, end your reply with this block, up to 5 absolute paths that really exist and are under 200MB:",
  "<files>",
  "C:\\full\\path\\to\\file.ext",
  "</files>",
  "Leave the block out entirely when there is nothing to send. Never invent a path.",
  "",
  "ACTIONS — to make the PC do things, put action lines in this block at the very end of your reply:",
  "<action>",
  "app:notepad",
  "</action>",
  "Action types (one per line, as many as needed):",
  "- app:NAME  → launch a program by its exe name (notepad, calc, chrome, msedge, spotify, vlc, explorer, code…). To find installed apps, list C:\\Users\\peter\\AppData\\Roaming\\Microsoft\\Windows\\Start Menu and C:\\ProgramData\\Microsoft\\Windows\\Start Menu.",
  "- media:playpause | media:next | media:prev | media:stop  → media keys, but they ONLY work while a player or browser tab is already playing/paused. There are NO desktop music apps on this PC — music means YouTube in Chrome.",
  "- browser:URL  → open a URL in the default browser (must include https://). For \"search the web for X\" you may browse yourself and answer in text instead.",
  "- file:PATH  → open a file or folder with its default app.",
  "- focus:TITLE  → bring an existing window to the front (substring of its title), e.g. focus:Notepad or focus:Google Chrome.",
  "- screenshot:screen | screenshot:window | screenshot:<title>  → capture a FRESH screenshot right now and send the PNG into the chat. Use for \"take a screenshot\", \"screenshot current window\", \"screenshot of chrome\". window = the app currently in front; <title> = that app's window.",
  "MUSIC RECIPE — to play a specific song: a YouTube /results SEARCH page never plays anything, so never emit one for a play request. Instead: (1) use browser tools to find a direct link — browser_navigate to https://www.youtube.com/results?search_query=<song>, then browser_read_links and take the FIRST /watch?v=VIDEO_ID link; (2) emit browser:https://www.youtube.com/watch?v=VIDEO_ID as your action. Chrome autoplays direct watch URLs immediately. One search, first link, done — keep it under ~20 seconds. For pause/next/prev while something is already playing, just emit the media: action.",
  "SPEED RULE — for app / browser / focus requests, emit the action block IMMEDIATELY and reply in one line. Do NOT run shell commands: shell here is slow and often access-denied. Browser tools are allowed ONLY for the music recipe above and for answering web questions.",
  "NEVER launch a program by simulating keys or clicking the UI (no Win+R, no Start-menu clicking, no explorer tricks) — that is slow and fails. Launching = the app: action, always. Use open-computer-use tools only for WORKING INSIDE an already-open app.",
  "CONTINUE — for tasks that need an app open first (\"open Paint and draw a circle\", \"open Chrome and go to…\"), do BOTH in one reply: (1) emit the launch action, (2) end the reply with this block telling your next turn what to do once the app is up:",
  "<continue>",
  "Now that Paint is open, use open-computer-use to draw a blue circle.",
  "</continue>",
  "The notch runs your action, waits a few seconds, then sends the continue text back to you as a new turn so you can finish the job with the computer-use tools. Omit the block when no follow-up work is needed.",
  "The notch executes actions instantly and reliably — prefer action blocks over shell for launching/opening things.",
  "After actions, say in one short line what you did (e.g. \"Opened Notepad ✅\").",
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
      await pinModel();
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
  await pinModel();
  return sessionID;
}

/* Force the free model — survives config defaults and provider credit runs. */
async function pinModel() {
  if (!sessionID) return;
  try {
    await api("POST", "/api/session/" + sessionID + "/model", { model: ASSIST_MODEL });
    log("model pinned to " + ASSIST_MODEL.providerID + "/" + ASSIST_MODEL.id);
  } catch (e) {
    log("pin model failed: " + e.message.slice(0, 120));
  }
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

function extractActions(text) {
  const actions = [];
  let clean = text;
  const block = text.match(/<action>\s*([\s\S]*?)\s*<\/action>/i);
  if (block) {
    clean = text.replace(block[0], "");
    for (const line of block[1].split(/\r?\n/)) {
      const s = line.trim().replace(/^[-*•]\s*/, "");
      const m = s.match(/^(app|media|browser|file|focus|screenshot)\s*:\s*(.+)$/i);
      if (!m) continue;
      const value = m[2].trim().replace(/^["'`]|["'`]$/g, "");
      if (value) actions.push({ type: m[1].toLowerCase(), value });
    }
  }
  return { reply: clean.replace(/\n{3,}/g, "\n\n").trim(), actions };
}

/* Multi-step requests: the model launches the app in this turn and leaves a
   follow-up instruction the bridge feeds back once the app is open. */
function extractContinue(text) {
  const block = text.match(/<continue>\s*([\s\S]*?)\s*<\/continue>/i);
  if (!block) return { reply: text, cont: null };
  return {
    reply: text.replace(block[0], "").replace(/\n{3,}/g, "\n\n").trim(),
    cont: block[1].trim(),
  };
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

/* Signature of everything that happened after our prompt — message count plus
   per-message content sizes. Any tool call or streamed token changes it, so a
   busy tool-only turn never looks idle to the stall detector. */
function activitySig(list, t0) {
  const parts = [];
  for (const m of list) {
    if ((m.time?.created || 0) < t0) continue;
    let sz = 0;
    for (const c of m.content || []) {
      sz += c.type === "text" ? (c.text || "").length : 1;
      if (c.type === "tool") sz += (c.state && c.state.status ? c.state.status.length : 0);
    }
    parts.push(m.type + ":" + sz);
  }
  return parts.join("|");
}

/* ---------- public API ---------- */

async function ask(userText) {
  if (busy) return { reply: "Still working on your last request — send that again in a minute.", files: [], actions: [], busy: true };
  busy = true;
  try {
    const sid = await ensureSession();
    const t0 = Date.now();
    log("prompt -> " + sid + " :: " + userText.slice(0, 90).replace(/\n/g, " "));

    // Register the waiter before prompting so a fast completion isn't missed.
    const completion = waitFor(sid, null, TIMEOUT_MS);

    // Live system snapshot (foreground window, open windows, browser tab
    // counts) so the model can answer awareness questions without tools.
    let snap = "";
    try {
      snap = await runPs(path.join(__dirname, "scripts", "system-info.ps1"), [],
        { timeoutMs: 12000 });
    } catch (e) { log("system snapshot failed: " + e.message); }
    const prompt = PROTOCOL
      + (snap ? "\n\nLIVE SYSTEM SNAPSHOT (right now):\n" + snap : "")
      + "\n\nUSER: " + userText;

    const res = await api("POST", "/api/session/" + sid + "/prompt", { text: prompt });
    const startedAt = (res.data && res.data.time && res.data.time.created) || t0;

    // Poll for an idle marker after our prompt; SSE notify short-circuits it.
    // Progress = ANY change in the thread (text, tool calls, reasoning) — a
    // tool-only turn must not look "stalled" just because no text appeared yet.
    const deadline = Date.now() + TIMEOUT_MS;
    let lastText = "";
    let lastSig = "";
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
      if (text) lastText = text;

      const sig = activitySig(list, startedAt);
      if (sig !== lastSig) { lastSig = sig; lastChange = Date.now(); }

      const idleMsg = list.find((m) => m.type === "idle" && (m.time?.created || 0) >= startedAt);
      if (idleMsg) {
        // A failed turn (quota, provider error) arrives as an idle marker too —
        // never report it as "finished but said nothing".
        if (idleMsg.outcome === "failed") {
          const err = idleMsg.error || {};
          log("turn failed: " + (err.type || "?") + " " + String(err.message || "").slice(0, 160));
          return {
            reply: "⚠️ Assistant backend error (" + (err.type || "failed") + "): " +
              String(err.message || "unknown").slice(0, 300),
            files: [], actions: [], error: err.type || "failed",
          };
        }
        outcome = "idle"; break;
      }

      if (raced.done) {
        if (raced.kind === "failed") { outcome = "failed"; break; }
        if (raced.kind === "idle") { outcome = "idle"; break; }
      }
      // Nothing at all changed for a long while → the turn is truly stuck.
      if (Date.now() - lastChange > STALL_MS) { outcome = lastText ? "stalled" : "stuck"; break; }
    }

    if ((outcome === "timeout" || outcome === "stuck") && !lastText) {
      // Stop the runaway turn so the session is free for the next request.
      try { await api("POST", "/api/session/" + sid + "/interrupt"); log("interrupted stuck turn"); } catch {}
      return { reply: "⏰ That took too long and produced no reply. Try a narrower request.", files: [], actions: [], error: "timeout" };
    }

    // No reply at all → re-check why before blaming the wording (quota and
    // provider failures land here when the SSE path beat the poll).
    if (!lastText) {
      try {
        const list = await fetchMessages(sid);
        const idleMsg = list.find((m) => m.type === "idle" && (m.time?.created || 0) >= startedAt);
        if (idleMsg && idleMsg.outcome === "failed") {
          const err = idleMsg.error || {};
          log("turn failed (post-loop): " + (err.type || "?") + " " + String(err.message || "").slice(0, 160));
          return {
            reply: "⚠️ Assistant backend error (" + (err.type || "failed") + "): " +
              String(err.message || "unknown").slice(0, 300),
            files: [], actions: [], error: err.type || "failed",
          };
        }
      } catch {}
    }

    const finalText = lastText || "";
    // Actions first: their file: lines must not be mistaken for <files> paths.
    const acted = extractActions(finalText);
    const contd = extractContinue(acted.reply);
    const { reply, files } = extractFiles(contd.reply);
    const actions = acted.actions;
    const cont = contd.cont;
    log("done outcome=" + outcome + " chars=" + finalText.length + " files=" + files.length + " actions=" + actions.length + " cont=" + (cont ? 1 : 0));

    if (!reply && !files.length && !actions.length && !cont) {
      return { reply: "🤔 The assistant finished but said nothing. Try rewording.", files: [], actions: [] };
    }
    return { reply, files, actions, cont, outcome };
  } catch (e) {
    log("ask error: " + e.message);
    const offline = /service unavailable|ENOTFOUND|ECONNREFUSED|fetch failed/i.test(e.message);
    return {
      reply: offline
        ? "⚠️ OpenCode isn't running, so I can't think right now."
        : "⚠️ Assistant error: " + String(e.message).slice(0, 180),
      files: [],
      actions: [],
      error: e.message,
    };
  } finally {
    busy = false;
    waiter = null;
  }
}

restore();

module.exports = { ask, notify, get sessionID() { return sessionID; }, MAX_FILE_BYTES };
