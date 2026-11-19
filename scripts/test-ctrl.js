/* stop/skip control test (#9): immediate preemption of the running task.
   global.fetch is patched — no real prompts or interrupts hit any session. */
const calls = [];
let promptDelay = 0;
function okResp() {
  return {
    ok: true, status: 200,
    headers: { get: () => "application/json" },
    json: async () => ({ ok: true, data: { time: { created: Date.now() } } }),
    text: async () => "{}",
  };
}
globalThis.fetch = async (url, opts) => {
  const u = String(url);
  calls.push({ url: u, method: opts.method, at: Date.now(), body: opts.body ? JSON.parse(opts.body) : null });
  if (opts.method === "POST" && /\/prompt$/.test(u)) await new Promise((r) => setTimeout(r, promptDelay));
  return okResp();
};

const bridge = require("../bridge");

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
  sessions: [{ id: "ses_RUN", title: "Runner" }, { id: "ses_TWO", title: "Second" }],
  active: { ses_RUN: { type: "running" } },
  stats: null,
};
const interrupts = () => calls.filter((c) => c.method === "POST" && /\/interrupt$/.test(c.url));

(async () => {
  await bridge.start({ whatsapp: fakeWa, getState: () => state, onEvent: () => {} });

  // start a slow task, then preempt it mid-flight
  promptDelay = 2500;
  const runP = bridge.handleIncoming("run 1 build the thing");
  await new Promise((r) => setTimeout(r, 300));
  t("task in flight (no interrupt yet)", interrupts().length === 0, JSON.stringify(calls));

  await bridge.handleIncoming("stop");
  await new Promise((r) => setTimeout(r, 200));
  t("stop preempts immediately", interrupts().length === 1 && interrupts()[0].url.includes("ses_RUN"), JSON.stringify(interrupts()));
  t("stop confirms", sent.some((s) => s.includes("⏹ stopped the current task") && s.includes("Runner")), sent.join(" || "));

  await runP;
  await new Promise((r) => setTimeout(r, 2600));
  t("queued run still completes", sent.some((s) => s.includes("▶ sent to [1] Runner")), sent.join(" || "));

  // skip: interrupts and announces the next-up state
  state.active = { ses_RUN: { type: "running" } };
  await bridge.handleIncoming("skip");
  await new Promise((r) => setTimeout(r, 200));
  t("skip interrupts too", interrupts().length === 2, String(interrupts().length));
  t("skip confirms", sent.some((s) => s.includes("⏭ skipped the current task")), sent.join(" || "));

  // "stop current" variant with nothing active
  state.active = {};
  await bridge.handleIncoming("stop current");
  await new Promise((r) => setTimeout(r, 200));
  t("idle stop reports nothing", sent.some((s) => s.includes("no tasks running right now")), sent.join(" || "));
  t("idle stop sends no extra interrupt", interrupts().length === 2, String(interrupts().length));

  // "stop 2" must still take the targeted (queued) path, not the control path
  await bridge.handleIncoming("stop 2");
  await new Promise((r) => setTimeout(r, 300));
  const last = interrupts()[interrupts().length - 1];
  t("stop <n> stays targeted", interrupts().length === 3 && last.url.includes("ses_TWO"), JSON.stringify(last));
  t("stop <n> confirmation", sent.some((s) => s.includes("⏹ interrupted [2] Second")), sent.join(" || "));

  bridge.stop();
  console.log(process.exitCode ? "TEST FAILED" : "ALL PASS");
  process.exit(process.exitCode || 0);
})().catch((e) => { console.error("ERR", e); process.exit(1); });
