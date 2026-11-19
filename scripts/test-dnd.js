/* DND test (#10 tier-1): durations, status, off, auto-expiry, persistence.
   dnd.json is shared with the running app — snapshotted and restored. */
const fs = require("fs");
const path = require("path");

const FILE = path.join(__dirname, "..", "dnd.json");
let original = null;
let had = false;
try { original = fs.readFileSync(FILE, "utf8"); had = true; } catch {}
function restore() {
  try {
    if (had) fs.writeFileSync(FILE, original);
    else if (fs.existsSync(FILE)) fs.unlinkSync(FILE);
  } catch {}
}

const bridge = require("../bridge");

function t(label, cond, extra) {
  console.log((cond ? "PASS " : "FAIL ") + label + (cond ? "" : "  << " + (extra || "")));
  if (!cond) process.exitCode = 1;
}

const sent = [];
const fakeWa = {
  send: async (text) => { sent.push(String(text)); console.log("  WA< " + String(text).replace(/\n/g, " | ").slice(0, 140)); },
  sendFile: async () => {},
};
const last = () => sent[sent.length - 1] || "";

(async () => {
  await bridge.start({ whatsapp: fakeWa, getState: () => null, onEvent: () => {} });
  t("starts off", bridge.isDnd() === false);

  // on with duration
  await bridge.handleIncoming("dnd on 30m");
  await new Promise((r) => setTimeout(r, 200));
  t("on confirms", last().includes("DND on for 30m"), last());
  t("isDnd true", bridge.isDnd() === true);
  const saved = JSON.parse(fs.readFileSync(FILE, "utf8"));
  const left = saved.until - Date.now();
  t("persisted ~30m", left > 29 * 60000 && left <= 30 * 60000 + 5000, String(left));

  // status
  await bridge.handleIncoming("dnd");
  await new Promise((r) => setTimeout(r, 200));
  t("status active", last().includes("DND active") && last().includes("30m left"), last());

  // off
  await bridge.handleIncoming("dnd off");
  await new Promise((r) => setTimeout(r, 200));
  t("off confirms", last().includes("DND off"), last());
  t("isDnd false", bridge.isDnd() === false);
  t("file removed", !fs.existsSync(FILE));

  // default duration (no arg after on)
  await bridge.handleIncoming("dnd on");
  await new Promise((r) => setTimeout(r, 200));
  t("default 1h", last().includes("DND on for 1h"), last());

  // bare-number minutes
  await bridge.handleIncoming("dnd off");
  await bridge.handleIncoming("dnd on 90");
  await new Promise((r) => setTimeout(r, 200));
  t("bare number = minutes", last().includes("DND on for 1h 30m"), last());

  // auto-expiry via seconds
  await bridge.handleIncoming("dnd off");
  await bridge.handleIncoming("dnd on 1s");
  await new Promise((r) => setTimeout(r, 200));
  t("1s on works", bridge.isDnd() === true, last());
  await new Promise((r) => setTimeout(r, 1300));
  t("auto-expires", bridge.isDnd() === false);

  // bad input
  await bridge.handleIncoming("dnd on banana");
  await new Promise((r) => setTimeout(r, 200));
  t("usage hint", last().includes("usage: dnd on 30m"), last());

  bridge.stop();
  restore();
  console.log(process.exitCode ? "TEST FAILED" : "ALL PASS");
  process.exit(process.exitCode || 0);
})().catch((e) => { restore(); console.error("ERR", e); process.exit(1); });
