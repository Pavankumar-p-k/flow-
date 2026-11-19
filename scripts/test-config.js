/* Config-from-chat test (item 3): view, bool keys, digest time, ntfy topic.
   config.json and digest-state.json are shared with the running app —
   both snapshotted and restored here. */
const fs = require("fs");
const path = require("path");

const CFG = path.join(__dirname, "..", "config.json");
const DIG = path.join(__dirname, "..", "digest-state.json");
function snap(f) { try { return fs.readFileSync(f, "utf8"); } catch { return null; } }
const origCfg = snap(CFG);
const origDig = snap(DIG);
function restore() {
  try { if (origCfg != null) fs.writeFileSync(CFG, origCfg); else if (fs.existsSync(CFG)) fs.unlinkSync(CFG); } catch {}
  try { if (origDig != null) fs.writeFileSync(DIG, origDig); else if (fs.existsSync(DIG)) fs.unlinkSync(DIG); } catch {}
}
const readCfg = () => { try { return JSON.parse(fs.readFileSync(CFG, "utf8")); } catch { return {}; } };

const bridge = require("../bridge");

function t(label, cond, extra) {
  console.log((cond ? "PASS " : "FAIL ") + label + (cond ? "" : "  << " + (extra || "")));
  if (!cond) process.exitCode = 1;
}

const sent = [];
const fakeWa = {
  send: async (text) => { sent.push(String(text)); console.log("  WA< " + String(text).replace(/\n/g, " | ").slice(0, 150)); },
  sendFile: async () => {},
};
const last = () => sent[sent.length - 1] || "";

(async () => {
  await bridge.start({ whatsapp: fakeWa, getState: () => null, onEvent: () => {} });

  // view
  await bridge.handleIncoming("config");
  await new Promise((r) => setTimeout(r, 200));
  t("view shows keys", last().includes("CONFIG") && last().includes("mirror") && last().includes("digest"), last());

  // bool: off then on
  await bridge.handleIncoming("config mirror off");
  await new Promise((r) => setTimeout(r, 200));
  t("mirror off saved", readCfg().notifyMirror === false, JSON.stringify(readCfg()));
  t("mirror off confirms", last().includes("mirror = off") && last().includes("live now"), last());

  await bridge.handleIncoming("config mirror on");
  await new Promise((r) => setTimeout(r, 200));
  t("mirror back on", readCfg().notifyMirror === true, JSON.stringify(readCfg()));

  // whatsapp (restart-scoped reply)
  await bridge.handleIncoming("config whatsapp off");
  await new Promise((r) => setTimeout(r, 200));
  t("whatsapp off notes restart", readCfg().whatsappEnabled === false && last().includes("after restart"), last());
  await bridge.handleIncoming("config whatsapp on");
  await new Promise((r) => setTimeout(r, 200));
  t("whatsapp back on", readCfg().whatsappEnabled === true);

  // digest time -> config.digest, stale override cleared
  await bridge.handleIncoming("config digest 18:30");
  await new Promise((r) => setTimeout(r, 200));
  const dc = readCfg().digest;
  t("digest written", dc && dc.hour === 18 && dc.minute === 30, JSON.stringify(dc));
  t("digest effective", bridge.digestCfg().hour === 18 && bridge.digestCfg().minute === 30, JSON.stringify(bridge.digestCfg()));
  t("digest confirms", last().includes("18:30"), last());

  // ntfy topic
  await bridge.handleIncoming("config ntfy my-topic-123");
  await new Promise((r) => setTimeout(r, 200));
  t("ntfy saved", readCfg().ntfyTopic === "my-topic-123", JSON.stringify(readCfg()));
  t("ntfy confirms", last().includes("ntfy topic saved"), last());

  // bad input
  await bridge.handleIncoming("config mirror maybe");
  await new Promise((r) => setTimeout(r, 200));
  t("bad bool usage", last().includes("usage: config"), last());

  await bridge.handleIncoming("config banana 1");
  await new Promise((r) => setTimeout(r, 200));
  t("unknown key", last().includes("unknown setting 'banana'"), last());

  await bridge.handleIncoming("config digest 99:99");
  await new Promise((r) => setTimeout(r, 200));
  t("bad digest time", last().includes("usage: config"), last());

  bridge.stop();
  restore();
  console.log(process.exitCode ? "TEST FAILED" : "ALL PASS");
  process.exit(process.exitCode || 0);
})().catch((e) => { restore(); console.error("ERR", e); process.exit(1); });
