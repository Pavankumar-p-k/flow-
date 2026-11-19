/* Item 8: inbound images/files from the phone reach the assistant.
   Hermetic — no live socket, no live OpenCode: the downloader is injected,
   globalFetch is patched, and every shared state file is snapshotted and
   restored (bridge/assistant load theirs at require time). */
const fs = require("fs");
const path = require("path");

/* ---- snapshot shared state BEFORE requiring bridge (it reads at require) ---- */
const STATE_FILES = ["queue-pending.json", "assistant.json", "digest-state.json", "reminders.json", "dnd.json"];
const saved = STATE_FILES.map((f) => {
  const p = path.join(__dirname, "..", f);
  let data = null;
  try { data = fs.readFileSync(p, "utf8"); } catch {}
  return { p, data };
});
function restoreState() {
  for (const s of saved) {
    try {
      if (s.data !== null) fs.writeFileSync(s.p, s.data);
      else if (fs.existsSync(s.p)) fs.unlinkSync(s.p);
    } catch {}
  }
}

/* ---- patched fetch: capture prompt bodies, fake the session lifecycle ---- */
const prompts = [];
function okResp(data) {
  return {
    ok: true, status: 200,
    headers: { get: (h) => (String(h).toLowerCase() === "content-type" ? "application/json" : null) },
    json: async () => ({ ok: true, data }),
    text: async () => JSON.stringify({ ok: true, data }),
  };
}
globalThis.fetch = async (url, opts) => {
  const u = String(url);
  const method = ((opts && opts.method) || "GET").toUpperCase();
  if (method === "POST" && /\/prompt$/.test(u)) {
    try { prompts.push(JSON.parse(opts.body)); } catch {}
    return okResp({ time: { created: Date.now() } });
  }
  // askOnce polls for an idle marker — answer instantly so the turn ends.
  if (/\/message/.test(u)) {
    return okResp([{ type: "idle", time: { created: Date.now() }, outcome: "success" }]);
  }
  if (method === "POST" && /\/session$/.test(u)) return okResp({ id: "ses_TEST" });
  // SSE: no body -> subscribe() throws -> reconnect loop (test-queue pattern)
  if (/\/event/.test(u)) return { ok: true, status: 200, headers: { get: () => "text/event-stream" } };
  return okResp({});
};

const wa = require("../whatsapp");
const bridge = require("../bridge");

function t(label, cond, extra) {
  console.log((cond ? "PASS " : "FAIL ") + label + (cond ? "" : "  << " + (extra || "")));
  if (!cond) process.exitCode = 1;
}
async function waitFor(fn, ms) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (fn()) return true; await new Promise((r) => setTimeout(r, 100)); }
  return fn();
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const SELF = "917286870734@s.whatsapp.net";
const STRANGER = "9998887777@s.whatsapp.net";

const IMG = { key: { remoteJid: SELF, fromMe: true, id: "IMG1" },
  message: { imageMessage: { mimetype: "image/jpeg", fileLength: 1234 } } };
const IMG_CAP = { key: { remoteJid: SELF, fromMe: true, id: "IMG2" },
  message: { imageMessage: { mimetype: "image/jpeg", fileLength: 99, caption: "check this out" } } };
const DOC = { key: { remoteJid: SELF, fromMe: true, id: "DOC1" },
  message: { documentMessage: { mimetype: "application/pdf", fileName: "report.pdf", fileLength: 500 } } };
const PLAIN = { key: { remoteJid: SELF, fromMe: true, id: "TXT1" },
  message: { conversation: "hello there" } };
const AUDIO = { key: { remoteJid: SELF, fromMe: true, id: "AUD1" },
  message: { audioMessage: { mimetype: "audio/ogg; codecs=opus", ptt: true } } };

let dlCalls = 0;
let received = [];
const outboxBase = () => wa._outbox.length;

(async () => {
  /* ================= A. whatsapp unit layer ================= */
  wa._rememberSelfJid(SELF);
  wa.on({ onMessage: (text, files) => received.push({ text, files: files || [] }) });
  wa._setDownloader(async () => { dlCalls++; return Buffer.from("PNGDATA"); });

  // -- pickMedia classification
  const pm1 = wa._pickMedia(IMG.message);
  t("pickMedia image", pm1 && pm1.kind === "image" && pm1.mime === "image/jpeg" && pm1.size === 1234, JSON.stringify(pm1));
  const pm2 = wa._pickMedia(DOC.message);
  t("pickMedia document keeps fileName", pm2 && pm2.kind === "document" && pm2.name === "report.pdf", JSON.stringify(pm2));
  t("pickMedia plain text -> null", wa._pickMedia(PLAIN.message) === null);
  // item 7 landed: ptt audio now classifies as voice (transcribed, not attached)
  t("pickMedia audio -> voice (item 7)", wa._pickMedia(AUDIO.message)?.kind === "voice");

  // -- saveInbox sanitization
  const evil = wa._saveInbox(Buffer.from("x"), "../../evil.png");
  t("saveInbox stays inside chat-inbox", evil.startsWith(wa._INBOX_DIR + path.sep), evil);
  t("saveInbox strips traversal", !path.basename(evil).includes("/") && !path.basename(evil).includes("\\"), path.basename(evil));
  t("saveInbox file exists", fs.existsSync(evil));

  // -- notify + caption-less image -> synthetic text + file
  received = [];
  await wa._processMessage(IMG, "notify");
  t("notify image: downloader called", dlCalls === 1, "dlCalls=" + dlCalls);
  t("notify image: synthetic text", received.length === 1 && received[0].text === "what is in this image?", JSON.stringify(received));
  t("notify image: file saved & passed", received.length === 1 && received[0].files.length === 1 && fs.existsSync(received[0].files[0]),
    JSON.stringify(received[0] && received[0].files));
  const imgA = received.length ? received[0].files[0] : "";

  // -- notify + caption -> caption is the text, file still attached
  received = [];
  await wa._processMessage(IMG_CAP, "notify");
  t("notify captioned image: caption text", received.length === 1 && received[0].text === "check this out", JSON.stringify(received));
  t("notify captioned image: file attached", received.length === 1 && received[0].files.length === 1);

  // -- append (history/echoes) never downloads media
  received = [];
  const dlBefore = dlCalls;
  await wa._processMessage(IMG, "append");
  t("append image: no download", dlCalls === dlBefore, "dlCalls=" + dlCalls);
  t("append image: no onMessage", received.length === 0, JSON.stringify(received));

  // -- document keeps its real filename
  received = [];
  await wa._processMessage(DOC, "notify");
  t("notify document: synthetic text", received.length === 1 && received[0].text === "what is in this document?", JSON.stringify(received));
  t("notify document: fileName kept", received.length === 1 && received[0].files[0] && path.basename(received[0].files[0]).endsWith("_report.pdf"),
    received[0] && received[0].files[0]);

  // -- our own sent id is an echo: no download
  received = [];
  wa._sentIds.add("IMG_ECHO");
  const dlBefore2 = dlCalls;
  await wa._processMessage({ ...IMG, key: { ...IMG.key, id: "IMG_ECHO" } }, "notify");
  t("sent-id echo: no download", dlCalls === dlBefore2, "dlCalls=" + dlCalls);
  t("sent-id echo: no onMessage", received.length === 0);

  // -- stranger jid is refused before any download (security)
  received = [];
  const dlBefore3 = dlCalls;
  await wa._processMessage({ ...IMG, key: { ...IMG.key, remoteJid: STRANGER, id: "STR1" } }, "notify");
  t("stranger: no download", dlCalls === dlBefore3, "dlCalls=" + dlCalls);
  t("stranger: no onMessage", received.length === 0);

  // -- oversize refused from fileLength alone, with a warning in the outbox
  received = [];
  const dlBefore4 = dlCalls;
  const ob4 = outboxBase();
  await wa._processMessage({ key: { remoteJid: SELF, fromMe: true, id: "BIG1" },
    message: { imageMessage: { mimetype: "image/png", fileLength: wa._MAX_INBOX_BYTES + 1 } } }, "notify");
  t("oversize: no download", dlCalls === dlBefore4, "dlCalls=" + dlCalls);
  t("oversize: no onMessage", received.length === 0);
  t("oversize: warning queued", wa._outbox.length > ob4 && /16MB/.test(wa._outbox[ob4] && wa._outbox[ob4].text || ""),
    JSON.stringify(wa._outbox.slice(ob4)));

  // -- downloader failure -> warning, no empty ask forwarded
  received = [];
  const ob5 = outboxBase();
  wa._setDownloader(async () => { throw new Error("media expired"); });
  await wa._processMessage({ key: { remoteJid: SELF, fromMe: true, id: "FAIL1" },
    message: { imageMessage: { mimetype: "image/jpeg", fileLength: 10 } } }, "notify");
  t("download failure: no onMessage", received.length === 0);
  t("download failure: warning queued", wa._outbox.length > ob5 && /couldn't download/.test((wa._outbox[ob5] || {}).text || ""),
    JSON.stringify(wa._outbox.slice(ob5)));
  wa._setDownloader(async () => { dlCalls++; return Buffer.from("PNGDATA"); });

  /* ================= B. bridge threading ================= */
  const sent = [];
  const fakeWa = {
    send: async (text) => { sent.push(String(text)); },
    sendFile: async () => {},
  };
  const state = { online: true, sessions: [{ id: "ses_X", title: "Runner" }], active: {}, stats: null };
  await bridge.start({ whatsapp: fakeWa, getState: () => state, onEvent: () => {} });

  const imgB = wa._saveInbox(Buffer.from("second"), "pic2.png");

  // A: caption-less photo -> prompt must carry a file:/// attachment
  await bridge.handleIncoming("what is in this image?", [imgA]);
  t("prompt captured", await waitFor(() => prompts.length >= 1, 30000), "prompts=" + prompts.length);
  const body = prompts[0] || {};
  t("prompt text carries USER line", typeof body.text === "string" && body.text.includes("USER: what is in this image?"),
    String(body.text).slice(-120));
  t("prompt files array present", Array.isArray(body.files) && body.files.length === 1, JSON.stringify(body.files));
  t("exact file:/// URI shape", body.files && body.files[0] && body.files[0].uri === "file:///" + imgA.replace(/\\/g, "/"),
    body.files && body.files[0] && body.files[0].uri);
  t("attachment name = basename", body.files && body.files[0] && body.files[0].name === path.basename(imgA),
    body.files && body.files[0] && body.files[0].name);

  // B1: SAME text, DIFFERENT file -> must NOT be swallowed by the dedupe
  await bridge.handleIncoming("what is in this image?", [imgB]);
  t("second photo not deduped", await waitFor(() => prompts.length >= 2, 30000), "prompts=" + prompts.length);
  t("second prompt has its own file", prompts[1] && prompts[1].files && prompts[1].files[0] &&
    prompts[1].files[0].uri === "file:///" + imgB.replace(/\\/g, "/"),
    prompts[1] && prompts[1].files && JSON.stringify(prompts[1].files));

  // B2: SAME text, SAME file within 10s -> double-tap suppressed
  await bridge.handleIncoming("what is in this image?", [imgB]);
  await sleep(700);
  t("double-tap of same file suppressed", prompts.length === 2, "prompts=" + prompts.length);

  bridge.stop();
  restoreState();
  console.log(process.exitCode ? "TEST FAILED" : "ALL PASS");
  process.exit(process.exitCode || 0);
})().catch((e) => { restoreState(); console.error("ERR", e); process.exit(1); });
