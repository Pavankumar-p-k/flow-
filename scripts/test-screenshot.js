/* Slash-only fresh screenshots: /screenshot (and /screen) hit the capture
   fast path; natural-language "take a screenshot ..." must go to the
   assistant instead (the model sometimes misunderstood old-vs-fresh).
   globalThis.fetch is patched — the fake returns an idle marker per turn so
   the queue drains; the capture fast path is asserted by the ABSENCE of an
   assistant prompt (its real ps run is left alone, we exit before it). */
const fs = require("fs");
const path = require("path");

// queue-pending.json is shared with the running app — snapshotted and
// restored here so the live queue is never disturbed.
const PENDING = path.join(__dirname, "..", "queue-pending.json");
let original = null, had = false;
try { original = fs.readFileSync(PENDING, "utf8"); had = true; } catch {}
function restorePending() {
  try {
    if (had) fs.writeFileSync(PENDING, original);
    else if (fs.existsSync(PENDING)) fs.unlinkSync(PENDING);
  } catch {}
}

const calls = [];
globalThis.fetch = async (url, opts) => {
  const u = String(url);
  calls.push({ url: u, method: opts && opts.method, body: opts && opts.body ? JSON.parse(opts.body) : null });
  const base = {
    ok: true, status: 200,
    headers: { get: () => "application/json" },
    text: async () => "{}",
  };
  // assistant polling for the turn result: hand back an idle marker so the
  // turn completes immediately and the queue keeps draining.
  if (/\/message\?/.test(u)) {
    return { ...base, json: async () => ({ ok: true, data: [{ type: "idle", time: { created: Date.now() }, outcome: "success" }] }) };
  }
  return { ...base, json: async () => ({ ok: true, data: { time: { created: Date.now() } } }) };
};

const bridge = require("../bridge");

function t(label, cond, extra) {
  console.log((cond ? "PASS " : "FAIL ") + label + (cond ? "" : "  << " + (extra || "")));
  if (!cond) process.exitCode = 1;
}

const sent = [];
const fakeWa = {
  send: async (text) => { sent.push(String(text)); },
  sendFile: async () => {},
};
const state = {
  online: true,
  sessions: [{ id: "ses_ONE", title: "One" }],
  active: {},
  stats: null,
};
const prompts = () => calls.filter((c) => c.method === "POST" && /\/prompt$/.test(c.url));
/* the assistant POSTs a beat after its ack (session bookkeeping first) — poll */
async function waitFor(n, ms = 5000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (prompts().length >= n) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return prompts().length >= n;
}

(async () => {
  await bridge.start({ whatsapp: fakeWa, getState: () => state, onEvent: () => {} });

  // 1. natural language -> assistant (NO capture)
  await bridge.handleIncoming("take a screenshot of my screen and show it");
  await waitFor(1);
  t("natural phrasing reaches the assistant", prompts().length >= 1,
    "prompts=" + prompts().length + " sent=" + JSON.stringify(sent));
  t("natural phrasing got the assistant ack", sent.some((s) => /on it/.test(s)),
    JSON.stringify(sent));

  // 2. natural language asking about OLD screenshots -> assistant too
  await bridge.handleIncoming("send me my old screenshot from yesterday");
  await waitFor(2);
  t("old-screenshot ask also goes to the assistant", prompts().length >= 2,
    "prompts=" + prompts().length);

  // 3. slash form -> capture fast path (assistant must NOT be called)
  const before = prompts().length;
  bridge.handleIncoming("/screenshot").catch(() => {});
  bridge.handleIncoming("/screen window").catch(() => {});
  await new Promise((r) => setTimeout(r, 1500));
  t("/screenshot bypasses the assistant", prompts().length === before,
    "prompts " + before + " -> " + prompts().length);
  t("/screen window bypasses the assistant", prompts().length === before,
    "prompts " + before + " -> " + prompts().length);

  console.log(process.exitCode ? "FAILED" : "ALL PASS");
  restorePending();
  process.exit(process.exitCode || 0);
})().catch((e) => { restorePending(); console.error(e); process.exit(1); });
