/* Clipboard actions test (#7): copy/read/image-fallback routing against a
   fake clipboard — no electron needed, no real messages leave this process. */
const fs = require("fs");
const os = require("os");
const path = require("path");
const bridge = require("../bridge");

function t(label, cond, extra) {
  console.log((cond ? "PASS " : "FAIL ") + label + (cond ? "" : "  << " + (extra || "")));
  if (!cond) process.exitCode = 1;
}

// fake electron clipboard
const clipState = { text: "", image: null };
const fakeClip = {
  writeText: (s) => { clipState.text = String(s); },
  readText: () => clipState.text,
  readImage: () => clipState.image,
};

const sent = [];
const files = [];
const fakeWa = {
  send: async (text) => { sent.push(String(text)); console.log("  WA< " + String(text).replace(/\n/g, " | ").slice(0, 130)); },
  sendFile: async (p, cap) => { files.push({ p, cap }); console.log("  WAFILE< " + p + " (" + cap + ")"); },
};

(async () => {
  await bridge.start({ whatsapp: fakeWa, getState: () => null, onEvent: () => {}, clipboard: fakeClip });

  // copy
  await bridge.handleIncoming("copy remember the milk 2L");
  await new Promise((r) => setTimeout(r, 300));
  t("copy writes clipboard", clipState.text === "remember the milk 2L", JSON.stringify(clipState));
  t("copy confirms", sent.some((s) => s.includes("copied 20 chars")), sent.join(" || "));

  // read back
  clipState.text = "hello from the PC";
  await bridge.handleIncoming("clipboard");
  await new Promise((r) => setTimeout(r, 300));
  t("read sends clipboard text", sent.some((s) => s.includes("CLIPBOARD (17 chars)") && s.includes("hello from the PC")), sent.join(" || "));

  // paste alias
  clipState.text = "via paste alias";
  await bridge.handleIncoming("paste");
  await new Promise((r) => setTimeout(r, 300));
  t("paste reads clipboard", sent.some((s) => s.includes("via paste alias")), sent.join(" || "));

  // bare "copy" also reads
  await bridge.handleIncoming("copy");
  await new Promise((r) => setTimeout(r, 300));
  t("bare copy reads clipboard", sent.filter((s) => s.includes("via paste alias")).length >= 2, sent.join(" || "));

  // image fallback -> temp PNG -> sendFile
  // (wait out the 10s duplicate-tap guard: "clipboard" was sent above)
  await new Promise((r) => setTimeout(r, 10500));
  clipState.text = "";
  clipState.image = { isEmpty: () => false, toPNG: () => Buffer.from([137, 80, 78, 71]) };
  await bridge.handleIncoming("clipboard");
  await new Promise((r) => setTimeout(r, 300));
  t("image announced", sent.some((s) => s.includes("clipboard has an image")), sent.join(" || "));
  t("image sent as file", files.length === 1 && fs.existsSync(files[0].p), JSON.stringify(files));

  // empty clipboard
  clipState.image = null;
  await bridge.handleIncoming("paste");
  await new Promise((r) => setTimeout(r, 300));
  t("empty clipboard reported", sent.some((s) => s.includes("clipboard is empty")), sent.join(" || "));

  // no provider (fresh bridge without clipboard dep) -> graceful
  bridge.stop();
  await bridge.start({ whatsapp: fakeWa, getState: () => null, onEvent: () => {} });
  await bridge.handleIncoming("copy anything");
  await new Promise((r) => setTimeout(r, 300));
  t("missing provider handled", sent.some((s) => s.includes("clipboard unavailable")), sent.join(" || "));

  // cleanup temp file
  for (const f of files) { try { fs.unlinkSync(f.p); } catch {} }

  bridge.stop();
  console.log(process.exitCode ? "TEST FAILED" : "ALL PASS");
  process.exit(process.exitCode || 0);
})().catch((e) => { console.error("ERR", e); process.exit(1); });
