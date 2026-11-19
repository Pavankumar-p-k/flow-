/* Queue management test (#1): status visibility during a running task and
   clear dropping only the waiting ones. queue-pending.json is shared with
   the running app — snapshotted and restored here. */
const fs = require("fs");
const path = require("path");

const PENDING = path.join(__dirname, "..", "queue-pending.json");
let original = null;
let had = false;
try { original = fs.readFileSync(PENDING, "utf8"); had = true; } catch {}
function restorePending() {
  try {
    if (had) fs.writeFileSync(PENDING, original);
    else if (fs.existsSync(PENDING)) fs.unlinkSync(PENDING);
  } catch {}
}

// slow prompt so the queue has something to sit behind
let promptDelay = 0;
function okResp() {
  return { ok: true, status: 200, headers: { get: () => "application/json" },
    json: async () => ({ ok: true, data: { time: { created: Date.now() } } }), text: async () => "{}" };
}
globalThis.fetch = async (url, opts) => {
  if (opts.method === "POST" && /\/prompt$/.test(String(url))) await new Promise((r) => setTimeout(r, promptDelay));
  return okResp();
};

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
const state = {
  online: true,
  sessions: [{ id: "ses_RUN", title: "Runner" }],
  active: {},
  stats: null,
};

(async () => {
  await bridge.start({ whatsapp: fakeWa, getState: () => state, onEvent: () => {} });

  // idle queue
  await bridge.handleIncoming("queue");
  await new Promise((r) => setTimeout(r, 200));
  t("idle queue report", sent.some((s) => s.includes("nothing running") && s.includes("queue empty")), sent.join(" || "));

  // slow task in flight + two commands behind it
  promptDelay = 2000;
  bridge.handleIncoming("run 1 build the thing");
  await new Promise((r) => setTimeout(r, 300));
  await bridge.handleIncoming("status");
  await bridge.handleIncoming("help");
  await new Promise((r) => setTimeout(r, 200));
  t("queued chatter sent", sent.some((s) => s.includes("queued #1: status")) && sent.some((s) => s.includes("queued #2: help")), sent.join(" || "));

  // live view WHILE the slow task runs (immediate, not queued)
  await bridge.handleIncoming("queue");
  await new Promise((r) => setTimeout(r, 200));
  const view = sent.filter((s) => s.includes("TASK QUEUE")).pop() || "";
  t("shows running task", view.includes("running: run #1"), view);
  t("shows 2 waiting with ages", view.includes("waiting (2)") && view.includes("status (") && view.includes("help ("), view);

  // clear drops the waiting pair, keeps the running one
  await bridge.handleIncoming("clear");
  await new Promise((r) => setTimeout(r, 200));
  t("clear confirms", sent.some((s) => s.includes("cleared 2 waiting task(s)")), sent.join(" || "));
  const pend = fs.existsSync(PENDING) ? fs.readFileSync(PENDING, "utf8") : "[]";
  t("pending file keeps running raw only", pend.includes("run 1 build the thing") && !pend.includes('"status"') && !pend.includes('"help"'), pend);

  // let the run finish; cleared tasks must never execute
  await new Promise((r) => setTimeout(r, 2500));
  t("run completes", sent.some((s) => s.includes("▶ sent to [1] Runner")), sent.join(" || "));
  t("cleared status never ran", !sent.some((s) => s.includes("NOTCH STATUS")), sent.join(" || "));
  t("cleared help never ran", !sent.some((s) => s.includes("NOTCH COMMANDS")), sent.join(" || "));

  // empty-clear alias
  await bridge.handleIncoming("clear queue");
  await new Promise((r) => setTimeout(r, 200));
  t("empty clear reports", sent.some((s) => s.includes("queue is already empty")), sent.join(" || "));

  bridge.stop();
  restorePending();
  console.log(process.exitCode ? "TEST FAILED" : "ALL PASS");
  process.exit(process.exitCode || 0);
})().catch((e) => { restorePending(); console.error("ERR", e); process.exit(1); });
