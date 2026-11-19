/* Tests for item 7 — voice notes: ptt classification, download, local
   transcription, transcript-only handoff, failure fallback.
   Hermetic: fake downloader + injected transcriber (no Python, no socket). */
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

// Snapshot shared state BEFORE requiring the module (hermetic rule).
const WA = path.join(__dirname, "..");
const stateFiles = ["debug.log"];
const backups = new Map();
for (const f of stateFiles) {
  const p = path.join(WA, f);
  backups.set(p, fs.existsSync(p) ? fs.readFileSync(p) : null);
}
const inboxDir = path.join(WA, "chat-inbox");
const inboxBefore = fs.existsSync(inboxDir) ? fs.readdirSync(inboxDir) : [];

const wa = require("../whatsapp");

let pass = 0, fail = 0;
function t(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => { pass++; console.log("  ok " + name); })
    .catch((e) => { fail++; console.log("  FAIL " + name + " :: " + (e.message || e)); });
}

function restore() {
  for (const [p, data] of backups) {
    try {
      if (data === null) fs.existsSync(p) && fs.unlinkSync(p);
      else fs.writeFileSync(p, data);
    } catch {}
  }
  try {
    const now = fs.readdirSync(inboxDir);
    for (const f of now) if (!inboxBefore.includes(f)) fs.unlinkSync(path.join(inboxDir, f));
  } catch {}
}

const SELF = "917286870734@s.whatsapp.net";
wa._sentIds.add("SELFJIDSEED");
// mark self-jid the way connect() does
wa._rememberSelfJid ? wa._rememberSelfJid(SELF) : null;

function voiceMsg(id) {
  return {
    key: { remoteJid: SELF, fromMe: false, id: id || "VOICE1" },
    message: {
      audioMessage: {
        mimetype: "audio/ogg; codecs=opus",
        ptt: true,
        fileLength: "80000",
        seconds: 7,
      },
    },
  };
}

async function main() {
  console.log("voice:");

  await t("pickMedia: ptt audio -> kind voice", () => {
    const m = wa._pickMedia(voiceMsg().message);
    assert.ok(m, "classified");
    assert.strictEqual(m.kind, "voice");
    assert.strictEqual(m.seconds, 7);
  });

  await t("pickMedia: non-ptt audio without ogg ignored", () => {
    const m = wa._pickMedia({ audioMessage: { mimetype: "audio/mpeg", ptt: false, fileLength: "5000" } });
    assert.strictEqual(m, null);
  });

  await t("pickMedia: image/document still classify", () => {
    assert.strictEqual(wa._pickMedia({ imageMessage: { fileLength: "1" } }).kind, "image");
    assert.strictEqual(wa._pickMedia({ documentMessage: { fileLength: "1" } }).kind, "document");
  });

  await t("pipeline: voice downloads, transcribes, hands TEXT only to assistant", async () => {
    let gotText = null, gotFiles = null;
    const saved = [];
    wa._setDownloader(async (m) => Buffer.from("fake-opus-bytes"));
    wa._setTranscriber(async (p) => { saved.push(p); return "హాయ్ ఇంకింత పని ఉందా"; });
    const oldOn = { onMessage: null };
    wa.on({ onMessage: (text, files) => { gotText = text; gotFiles = files; } });
    await wa._processMessage(voiceMsg("VP1"), "notify");
    assert.strictEqual(gotText, "హాయ్ ఇంకింత పని ఉందా", "transcript delivered as text");
    assert.deepStrictEqual(gotFiles, [], "no audio file forwarded to assistant");
    assert.strictEqual(saved.length, 1, "transcriber called once with the downloaded path");
    // the .opus was cleaned up after transcription
    assert.ok(!fs.existsSync(saved[0]), "audio removed after transcribe");
    wa.on({ onMessage: oldOn.onMessage });
  });

  await t("pipeline: transcribe failure -> user note, no empty ask", async () => {
    let gotText = "NOT CALLED";
    wa._setDownloader(async () => Buffer.from("opus"));
    wa._setTranscriber(async () => "");
    wa.on({ onMessage: (text) => { gotText = text; } });
    const sends = [];
    const origSend = wa.send;
    await wa._processMessage(voiceMsg("VP2"), "notify");
    // failure path must NOT invoke onMessage with an empty/ask body
    assert.notStrictEqual(gotText, "");
    assert.ok(gotText === "NOT CALLED" || gotText.includes("🎧"),
      "either no ask or the fallback note, got: " + gotText);
  });

  await t("pipeline: voice via 'append' (history) is never downloaded", async () => {
    let called = false;
    wa._setDownloader(async () => { called = true; return Buffer.from("x"); });
    wa._setTranscriber(async () => { called = true; return "y"; });
    let got = null;
    wa.on({ onMessage: (text) => { got = text; } });
    await wa._processMessage(voiceMsg("VP3"), "append");
    assert.strictEqual(called, false, "no download on history sync");
    assert.strictEqual(got, null, "no handoff");
  });

  await t("pipeline: voice from a stranger chat is refused", async () => {
    let called = false;
    wa._setDownloader(async () => { called = true; return Buffer.from("x"); });
    let got = null;
    wa.on({ onMessage: (text) => { got = text; } });
    const m = voiceMsg("VP4");
    m.key.remoteJid = "129321599549671@lid"; // not self-chat (not remembered)
    await wa._processMessage(m, "notify");
    assert.strictEqual(called, false, "stranger voice not downloaded");
    assert.strictEqual(got, null, "stranger voice not forwarded");
  });

  await t("pipeline: our own sent voice echo (sentIds) ignored", async () => {
    let called = false;
    wa._setDownloader(async () => { called = true; return Buffer.from("x"); });
    await wa._processMessage(voiceMsg("MINE123"), "notify");
    // not in sentIds -> would download; add it and re-run
    wa._sentIds.add("MINE123");
    await wa._processMessage(voiceMsg("MINE123"), "notify");
    assert.strictEqual(called, true, "fresh voice (unknown id) does download");
    // now a DIFFERENT message object with the tracked id must be skipped
    called = false;
    const m = voiceMsg("MINE123");
    m.message.audioMessage.seconds = 9;
    let got = null;
    wa.on({ onMessage: (t2) => { got = t2; } });
    await wa._processMessage(m, "notify");
    assert.strictEqual(called, false, "tracked id skipped before download");
    assert.strictEqual(got, null, "tracked id skipped before handoff");
  });

  await t("oversize voice (over 16MB) -> warning note, no transcribe", async () => {
    let transcribed = false;
    wa._setDownloader(async () => Buffer.alloc(1));
    wa._setTranscriber(async () => { transcribed = true; return "x"; });
    const m = voiceMsg("VBIG");
    m.message.audioMessage.fileLength = String(17 * 1024 * 1024);
    await wa._processMessage(m, "notify");
    assert.strictEqual(transcribed, false, "not transcribed when over cap");
  });

  console.log("\n" + pass + " passed, " + fail + " failed");
  restore();
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error(e); restore(); process.exit(1); });
