/* Daily digest test (#8): manual send, reschedule, hour gating, once-a-day.
   digest-state.json is shared with the running app — saved and restored. */
const fs = require("fs");
const path = require("path");

const STATE = path.join(__dirname, "..", "digest-state.json");
let original = null;
let hadState = false;
try { original = fs.readFileSync(STATE, "utf8"); hadState = true; } catch {}

// The live app may have already marked TODAY's digest as sent — bridge reads
// this file at require time, so reset BEFORE requiring it. hour:24 suppresses
// the boot catch-up pump (real time is past 09:00) until "digest at 18:00"
// installs the schedule the test wants. Restored at the end.
try { fs.writeFileSync(STATE, JSON.stringify({ day: null, hour: 24, minute: 0 })); } catch {}

const bridge = require("../bridge");

function restoreState() {
  try {
    if (hadState) fs.writeFileSync(STATE, original);
    else if (fs.existsSync(STATE)) fs.unlinkSync(STATE);
  } catch {}
}

function t(label, cond, extra) {
  console.log((cond ? "PASS " : "FAIL ") + label + (cond ? "" : "  << " + (extra || "")));
  if (!cond) process.exitCode = 1;
}

const sent = [];
const fakeWa = {
  send: async (text) => { sent.push(String(text)); console.log("  WA< " + String(text).replace(/\n/g, " | ").slice(0, 130)); },
  sendFile: async () => {},
};

const state = {
  online: true,
  sessions: [{ id: "ses_1", title: "Alpha" }, { id: "ses_2", title: "Beta" }],
  active: { ses_1: true },
  stats: { tokens: { input: 120000, output: 40000 }, tools: { totals: { calls: 10, succeeded: 9, failed: 1 } } },
};

const digests = () => sent.filter((s) => s.includes("DAILY DIGEST"));

// sendDigest() scans 15+ repos AND builds the Tony/news sections (first
// build does real network: model list, chain pings, HN + RSS — later sends
// hit the 30-min module cache) — poll instead of guessing a fixed delay.
async function waitFor(fn, ms) {
  const end = Date.now() + (ms || 45000);
  while (Date.now() < end) {
    if (fn()) return true;
    await new Promise((r) => setTimeout(r, 200));
  }
  return fn();
}

(async () => {
  await bridge.start({ whatsapp: fakeWa, getState: () => state, onEvent: () => {} });

  // manual send now
  await bridge.handleIncoming("digest");
  await waitFor(() => digests().length >= 1);
  t("manual digest sends", digests().length === 1, JSON.stringify(sent));
  t("digest carries status", (digests()[0] || "").includes("sessions: 2") && (digests()[0] || "").includes("tokens 24h"), digests()[0] || "");
  t("digest carries repos", (digests()[0] || "").includes("📁 repos:"), digests()[0] || "");

  // reschedule
  await bridge.handleIncoming("digest at 18:00");
  await new Promise((r) => setTimeout(r, 400));
  t("reschedule confirms", sent.some((s) => s.includes("rescheduled to 18:00")), sent.join(" || "));
  t("config reflects new hour", bridge.digestCfg().hour === 18, JSON.stringify(bridge.digestCfg()));

  // before the hour: nothing auto-fires
  bridge.pumpDigest(new Date(2026, 10, 19, 8, 0));
  await new Promise((r) => setTimeout(r, 500));
  t("no send before schedule", digests().length === 1, String(digests().length));

  // after the hour: exactly one auto-send
  bridge.pumpDigest(new Date(2026, 10, 19, 19, 0));
  await waitFor(() => digests().length >= 2);
  t("auto digest fires after hour", digests().length === 2, String(digests().length));

  // later that day: never twice
  bridge.pumpDigest(new Date(2026, 10, 19, 20, 0));
  await new Promise((r) => setTimeout(r, 500));
  t("once per day", digests().length === 2, String(digests().length));

  // next day (still past the rescheduled 18:00 hour): fires again
  bridge.pumpDigest(new Date(2026, 10, 20, 19, 0));
  await waitFor(() => digests().length >= 3);
  t("fires again next day", digests().length === 3, String(digests().length));

  // bad usage hint
  await bridge.handleIncoming("digest whenever you like");
  await new Promise((r) => setTimeout(r, 400));
  t("usage hint on bad time", sent.some((s) => s.includes("usage: digest")), sent.join(" || "));

  bridge.stop();
  restoreState();
  console.log(process.exitCode ? "TEST FAILED" : "ALL PASS");
  process.exit(process.exitCode || 0);
})().catch((e) => { restoreState(); console.error("ERR", e); process.exit(1); });
