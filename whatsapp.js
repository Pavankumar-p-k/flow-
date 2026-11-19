/* WhatsApp link via Baileys (unofficial linked-device client).
   Auth persists in wa-auth/ — scan the QR once, stays linked. */
const path = require("path");
const fs = require("fs");
const QRCode = require("qrcode");

const AUTH_DIR = path.join(__dirname, "wa-auth");
// #8 — inbound images/files from the phone are fetched here, then handed to
// the assistant. 16MB cap: the prompt API inlines attachments as base64, so
// a giant file would blow up the request body (and the free-model context).
const INBOX_DIR = path.join(__dirname, "chat-inbox");
const MAX_INBOX_BYTES = 16 * 1024 * 1024;

// baileys' media downloader — bound inside connect() from the dynamic import;
// tests inject their own via _setDownloader.
let downloader = null;

/* #8 — classify an inbound media message. Returns null for anything we don't
   ingest (audio is #7, video/sticker unsupported). */
function pickMedia(message) {
  if (!message) return null;
  const img = message.imageMessage;
  if (img) {
    return {
      kind: "image",
      mime: img.mimetype || "image/jpeg",
      size: Number(img.fileLength) || 0,
      name: img.fileName || "",
    };
  }
  const doc = message.documentMessage;
  if (doc) {
    return {
      kind: "document",
      mime: doc.mimetype || "application/octet-stream",
      size: Number(doc.fileLength) || 0,
      name: doc.fileName || "",
    };
  }
  return null;
}

const EXT_FOR_MIME = {
  "image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp",
  "image/gif": ".gif", "image/bmp": ".bmp", "application/pdf": ".pdf",
  "text/plain": ".txt", "text/markdown": ".md", "application/json": ".json",
  "application/zip": ".zip", "text/csv": ".csv",
};

/* Write a downloaded blob into chat-inbox/ as <ts>_<name>. The name is
   sanitized (no separators/traversal) and always carries an extension so the
   model gets a sensible filename. Returns the absolute path. */
function saveInbox(buf, name) {
  fs.mkdirSync(INBOX_DIR, { recursive: true });
  let safe = String(name || "").replace(/[<>:"/\\|?*\x00-\x1f]/g, "_").slice(0, 80);
  if (!safe || /^\.+$/.test(safe)) safe = "inbound";
  if (!path.extname(safe)) safe += EXT_FOR_MIME[""] || ".bin";
  const p = path.join(INBOX_DIR, Date.now() + "_" + safe);
  fs.writeFileSync(p, buf);
  return p;
}

/* Download one message's media into the inbox. Returns { files, note } —
   note is a user-facing warning when nothing could be saved. */
async function ingestMedia(m, media) {
  if (media.size && media.size > MAX_INBOX_BYTES) {
    return {
      files: [],
      note: "⚠️ that " + media.kind + " is " + Math.round(media.size / 1048576) +
        "MB — over my 16MB limit, not sent.",
    };
  }
  if (!downloader) return { files: [], note: "⚠️ media download isn't ready — try again in a moment." };
  let buf;
  try {
    buf = await downloader(m);
  } catch (e) {
    log("media download failed: " + e.message);
    return { files: [], note: "⚠️ couldn't download that " + media.kind +
      " (" + String(e.message).slice(0, 60) + "). Try sending it again." };
  }
  if (!buf || !buf.length) {
    return { files: [], note: "⚠️ couldn't download that " + media.kind + " — try sending it again." };
  }
  if (buf.length > MAX_INBOX_BYTES) {
    return { files: [], note: "⚠️ that " + media.kind + " is over my 16MB limit, not sent." };
  }
  let name = media.name;
  if (!name) name = "inbound" + (EXT_FOR_MIME[media.mime] || ".bin");
  const p = saveInbox(buf, name);
  log("inbox saved " + path.basename(p) + " (" + buf.length + "B)");
  return { files: [p], note: "" };
}

/* What the assistant sees when the user attached media without typing. */
function syntheticText(media) {
  return media.kind === "image" ? "what is in this image?" : "what is in this document?";
}

/* Per-message pipeline, extracted so tests can drive it without a socket.
   `type` gates media download: "notify" = fresh phone message, "append" =
   history sync / our own echoes — those are never downloaded. */
async function processMessage(m, type) {
  if (!m || !m.message) return;
  const jid = m.key.remoteJid || "";
  const text =
    m.message.conversation ||
    (m.message.extendedTextMessage && m.message.extendedTextMessage.text) ||
    (m.message.imageMessage && m.message.imageMessage.caption) ||
    (m.message.documentMessage && m.message.documentMessage.caption) ||
    "";
  const media = type === "notify" ? pickMedia(m.message) : null;

  // Diagnostics: log everything we see so filters can be verified.
  log(
    "recv type=" + type + " jid=" + jid + " fromMe=" + !!m.key.fromMe +
    " id=" + (m.key.id || "") +
    " media=" + (media ? media.kind + ":" + media.name : "-") +
    " text=" + JSON.stringify(text.slice(0, 60))
  );

  if (!text.trim() && !media) return;
  // Ignore our own outgoing messages (we track their ids) so a reply
  // never re-triggers the command parser and loops.
  if (m.key.id && sentIds.has(m.key.id)) return;
  // A sent document/image echoes back with its fileName as the text.
  // That must never be read as a fresh request.
  if (text.trim() && wasRecentlySent(text)) {
    log("skip echo " + JSON.stringify(text.slice(0, 60)));
    return;
  }
  // Only the self-chat. The chat jid may be the PN form we derived, or
  // a LID form; messages sent from this phone arrive with fromMe=true
  // because both ends are the same account.
  if (!isSelfChatJid(jid)) return;

  let files = [];
  if (media) {
    const ing = await ingestMedia(m, media);
    files = ing.files;
    // Nothing usable arrived — say so instead of forwarding an empty ask.
    if (!files.length) {
      if (ing.note) send(ing.note);
      if (!text.trim()) return;
    }
  }
  const body = text.trim() || (files.length ? syntheticText(media) : "");
  if (!body) return;
  if (handlers.onMessage) handlers.onMessage(body, files);
}

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
  // #8 — media download context: reupload refreshes expired media URLs.
  downloader = (msg) => baileys.downloadMediaMessage(
    msg, "buffer", {},
    { reuploadRequest: (x) => sock.updateMediaMessage(x), logger: sock.logger },
  );

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
        await processMessage(m, type);
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

/* #8 — downloaded media piles up; delete inbox files older than 7 days. */
function cleanInbox() {
  try {
    if (!fs.existsSync(INBOX_DIR)) return 0;
    const cut = Date.now() - 7 * 24 * 60 * 60 * 1000;
    let removed = 0;
    for (const f of fs.readdirSync(INBOX_DIR)) {
      const p = path.join(INBOX_DIR, f);
      try {
        if (fs.statSync(p).mtimeMs < cut) { fs.unlinkSync(p); removed++; }
      } catch {}
    }
    if (removed) log("cleaned " + removed + " inbox file(s) older than 7 days");
    return removed;
  } catch { return 0; }
}

module.exports = {
  connect,
  send,
  sendFile,
  disconnect,
  forget,
  getStatus,
  cleanInbox,
  on: (h) => Object.assign(handlers, h),
  // #8 — test seams (no live socket needed)
  _pickMedia: pickMedia,
  _saveInbox: saveInbox,
  _processMessage: processMessage,
  _setDownloader: (fn) => { downloader = fn; },
  _sentIds: sentIds,
  _outbox: outbox,
  _rememberSelfJid: rememberSelfJid,
  _INBOX_DIR: INBOX_DIR,
  _MAX_INBOX_BYTES: MAX_INBOX_BYTES,
};
