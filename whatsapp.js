/* WhatsApp link via Baileys (unofficial linked-device client).
   Auth persists in wa-auth/ — scan the QR once, stays linked. */
const path = require("path");
const fs = require("fs");
const QRCode = require("qrcode");

const AUTH_DIR = path.join(__dirname, "wa-auth");

let sock = null;
let selfJid = null;          // our own chat ("Message yourself")
let status = "idle";         // idle | qr | connecting | open | closed | error
let qrDataUrl = null;
let lastError = "";
const handlers = { onStatus: null, onMessage: null, onQr: null };
const outbox = [];
let sending = false;

// ids of messages we transmitted, so our own chat echo is never treated
// as an incoming command
const sentIds = new Set();
// every jid that identifies the self-chat: the PN we derived plus any LID
const ownJids = new Set();

function rememberSelfJid(jid) {
  if (!jid) return;
  ownJids.add(jid);
  if (selfJid) ownJids.add(selfJid);
}

function isSelfChatJid(jid) {
  if (!jid) return false;
  if (ownJids.has(jid)) return true;
  if (selfJid && jid === selfJid) return true;
  // self-chat, PN form derived from our own number
  if (selfJid && jid.split("@")[0] === selfJid.split("@")[0]) return true;
  return false;
}

function rememberSent(id) {
  if (!id) return;
  sentIds.add(id);
  if (sentIds.size > 400) {
    // drop oldest half; Set preserves insertion order
    const half = [...sentIds].slice(0, 200);
    sentIds.clear();
    half.forEach((x) => sentIds.add(x));
  }
}

/* Outbound text/filenames we produced. A document message echoes back with
   its fileName as the message text — without this the echo is read as a new
   request, the assistant re-sends the file, and it loops forever. */
const recentSent = new Map(); // normalized text -> ms timestamp
const RECENT_TTL = 10 * 60 * 1000;

function normalizeEcho(s) {
  // WhatsApp rewrites what we send: emoji can arrive as "?", em dashes become
  // hyphens, and whitespace collapses. Compare on a stripped core so an echo
  // still matches even after that rewriting.
  return String(s || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function rememberOutbound(text) {
  const raw = String(text || "").trim().toLowerCase();
  const core = normalizeEcho(text);
  if (!raw && !core) return;
  const now = Date.now();
  if (raw) recentSent.set("r:" + raw, now);
  if (core) recentSent.set("c:" + core, now);
  if (recentSent.size > 600) {
    const cutoff = Date.now() - RECENT_TTL;
    for (const [key, t] of recentSent) if (t < cutoff) recentSent.delete(key);
  }
}

function wasRecentlySent(text) {
  const raw = "r:" + String(text || "").trim().toLowerCase();
  const core = "c:" + normalizeEcho(text);
  for (const k of [raw, core]) {
    if (!k || k === "r:" || k === "c:") continue;
    const t = recentSent.get(k);
    if (!t) continue;
    if (Date.now() - t > RECENT_TTL) { recentSent.delete(k); continue; }
    return true;
  }
  return false;
}

function setStatus(s, err) {
  status = s;
  if (err) lastError = String(err).slice(0, 200);
  try { handlers.onStatus && handlers.onStatus({ status, qr: qrDataUrl, error: lastError, jid: selfJid }); } catch {}
}

function log(line) {
  try {
    fs.appendFileSync(path.join(__dirname, "debug.log"), new Date().toISOString() + " WA " + line + "\n");
  } catch {}
}

async function connect() {
  if (status === "connecting" || status === "open") return;
  setStatus("connecting");
  lastError = "";
  let baileys;
  try {
    baileys = await import("@whiskeysockets/baileys");
  } catch (e) {
    setStatus("error", "baileys load failed: " + e.message);
    return;
  }
  const makeWASocket = baileys.makeWASocket || baileys.default;
  const { useMultiFileAuthState, DisconnectReason } = baileys;

  let state, saveCreds;
  try {
    ({ state, saveCreds } = await useMultiFileAuthState(AUTH_DIR));
  } catch (e) {
    setStatus("error", "auth state failed: " + e.message);
    return;
  }

  try {
    sock = makeWASocket({ auth: state, printQRInTerminal: false });
  } catch (e) {
    setStatus("error", "socket failed: " + e.message);
    return;
  }

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", async (u) => {
    try {
      if (u.qr) {
        qrDataUrl = await QRCode.toDataURL(u.qr, { margin: 1, width: 220, color: { dark: "#000000", light: "#ffffff" } });
        setStatus("qr");
        log("qr issued");
        if (handlers.onQr) handlers.onQr(qrDataUrl);
      }
      if (u.connection === "open") {
        qrDataUrl = null;
        const me = sock && sock.user && sock.user.id ? sock.user.id : "";
        // "1234567890:xx@s.whatsapp.net" -> "1234567890@s.whatsapp.net"
        selfJid = me.split(":")[0] + "@s.whatsapp.net";
        // newer accounts also carry a LID identity; the self-chat may arrive
        // under either form
        rememberSelfJid(selfJid);
        const myLid = (sock.user && sock.user.lid) || (sock.authState && sock.authState.creds && sock.authState.creds.me && sock.authState.creds.me.lid) || "";
        if (myLid) rememberSelfJid(String(myLid).split(":")[0] + "@lid");
        setStatus("open");
        log("open as " + me + " lid=" + myLid + " jids=" + [...ownJids].join(","));
        flushOutbox();
      }
      if (u.connection === "close") {
        const code = u.lastDisconnect && u.lastDisconnect.error
          ? (u.lastDisconnect.error.output && u.lastDisconnect.error.output.statusCode) || u.lastDisconnect.error.statusCode
          : 0;
        const loggedOut = code === DisconnectReason.loggedOut || code === 401;
        if (loggedOut) {
          qrDataUrl = null;
          setStatus("closed", "logged out — reconnect to scan again");
          log("closed (logged out, code " + code + ")");
        } else {
          setStatus("closed", "disconnected (code " + code + ") — retrying");
          log("closed code " + code + " — retrying in 3s");
          setTimeout(() => connect(), 3000);
        }
      }
    } catch (e) {
      log("connection.update error: " + e.message);
    }
  });

  sock.ev.on("messages.upsert", async (payload) => {
    const { messages, type } = payload || {};
    log("upsert type=" + type + " n=" + ((messages && messages.length) || 0));
    if (type !== "notify" && type !== "append") return;
    for (const m of messages) {
      try {
        if (!m || !m.message) continue;
        const jid = m.key.remoteJid || "";
        const fromMe = !!m.key.fromMe;
        const text =
          m.message.conversation ||
          (m.message.extendedTextMessage && m.message.extendedTextMessage.text) ||
          (m.message.imageMessage && m.message.imageMessage.caption) ||
          "";

        // Diagnostics: log everything we see so filters can be verified.
        log(
          "recv type=" + type + " jid=" + jid + " fromMe=" + fromMe +
          " id=" + (m.key.id || "") + " text=" + JSON.stringify(text.slice(0, 60))
        );

        if (!text.trim()) continue;
        // Ignore our own outgoing messages (we track their ids) so a reply
        // never re-triggers the command parser and loops.
        if (m.key.id && sentIds.has(m.key.id)) continue;
        // A sent document/image echoes back with its fileName as the text.
        // That must never be read as a fresh request.
        if (wasRecentlySent(text)) {
          log("skip echo " + JSON.stringify(text.slice(0, 60)));
          continue;
        }
        // Only the self-chat. The chat jid may be the PN form we derived, or
        // a LID form; messages sent from this phone arrive with fromMe=true
        // because both ends are the same account.
        if (!isSelfChatJid(jid)) continue;

        if (handlers.onMessage) handlers.onMessage(text.trim());
      } catch (e) {
        log("message error: " + e.message);
      }
    }
  });

  sock.ev.on("contacts.upsert", () => {});
}

/* outgoing: paced queue (gentle = lower ban risk) */
function send(text) {
  outbox.push({ kind: "text", text });
  flushOutbox();
}

/* Send a file into the chat as an image (if it looks like one) or a document. */
function sendFile(filePath, caption) {
  outbox.push({ kind: "file", path: filePath, caption: caption || "" });
  flushOutbox();
}

const IMAGE_EXT = new Set([".png", ".jpg", ".jpeg", ".bmp", ".webp"]);
const MIME = {
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif",
  ".bmp": "image/bmp", ".webp": "image/webp", ".pdf": "application/pdf",
  ".txt": "text/plain", ".md": "text/markdown", ".json": "application/json",
  ".zip": "application/zip", ".7z": "application/x-7z-compressed", ".rar": "application/vnd.rar",
  ".blend": "application/octet-stream", ".blend1": "application/octet-stream",
  ".py": "text/x-python", ".js": "text/javascript", ".ts": "text/typescript",
  ".html": "text/html", ".css": "text/css", ".csv": "text/csv", ".log": "text/plain",
  ".mp4": "video/mp4", ".mkv": "video/x-matroska", ".webm": "video/webm",
  ".mp3": "audio/mpeg", ".wav": "audio/wav", ".flac": "audio/flac",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".exe": "application/octet-stream", ".msi": "application/octet-stream",
};

function mimeFor(p) {
  return MIME[path.extname(p).toLowerCase()] || "application/octet-stream";
}

async function deliver(job) {
  const fs = require("fs");
  const buf = await fs.promises.readFile(job.path);
  const ext = path.extname(job.path).toLowerCase();
  const base = path.basename(job.path);
  rememberOutbound(base);

  let res;
  if (ext === ".gif") {
    // GIFs go as video with gifPlayback so they animate in the chat.
    res = await sock.sendMessage(selfJid, {
      video: buf, mimetype: "video/gif", gifPlayback: true, caption: job.caption || undefined,
    });
  } else if (IMAGE_EXT.has(ext)) {
    res = await sock.sendMessage(selfJid, {
      image: buf, mimetype: mimeFor(job.path), caption: job.caption || undefined,
    });
  } else {
    res = await sock.sendMessage(selfJid, {
      document: buf, mimetype: mimeFor(job.path), fileName: base, caption: job.caption || undefined,
    });
  }
  if (res && res.key && res.key.id) rememberSent(res.key.id);
  return res;
}

async function flushOutbox() {
  if (sending || !sock || status !== "open" || !selfJid) return;
  sending = true;
  while (outbox.length) {
    const job = outbox.shift();
    try {
      if (job.kind === "file") {
        await deliver(job);
        log("sent file " + path.basename(job.path));
      } else {
        const res = await sock.sendMessage(selfJid, { text: job.text });
        if (res && res.key && res.key.id) rememberSent(res.key.id);
        rememberOutbound(job.text);
        log("sent " + job.text.length + " chars");
      }
    } catch (e) {
      log("send failed: " + e.message);
      lastError = e.message;
      // A failed file shouldn't kill the rest of the queue.
      if (job.kind === "file") {
        try {
          await sock.sendMessage(selfJid, { text: "⚠️ Couldn't send " + path.basename(job.path) + ": " + String(e.message).slice(0, 120) });
        } catch {}
      }
    }
    // human pacing: 700-1400ms between messages, longer after media
    await new Promise((r) => setTimeout(r, (job.kind === "file" ? 1400 : 700) + Math.random() * 700));
  }
  sending = false;
}

function disconnect() {
  try { if (sock) sock.end(undefined); } catch {}
  sock = null;
  qrDataUrl = null;
  selfJid = null;
  ownJids.clear();
  setStatus("idle");
}

function forget() {
  disconnect();
  try { fs.rmSync(AUTH_DIR, { recursive: true, force: true }); } catch {}
}

function getStatus() {
  return { status, qr: qrDataUrl, error: lastError, jid: selfJid };
}

module.exports = {
  connect,
  send,
  sendFile,
  disconnect,
  forget,
  getStatus,
  on: (h) => Object.assign(handlers, h),
};
