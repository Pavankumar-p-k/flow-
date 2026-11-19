/* Permission reply regression: OpenCode ≥2.x requires
   {decision:"once"|"always"|"reject"} — sending {reply} is HTTP 400.
   Injects fake pending approvals and asserts the exact request body. */

// queue-pending.json is shared with the running app AND replayed by start() —
// snapshot before bridge is even loaded, then park an empty backlog.
const fs = require("fs");
const path = require("path");
const PENDING = path.join(__dirname, "..", "queue-pending.json");
let original = null;
let had = false;
try { original = fs.readFileSync(PENDING, "utf8"); had = true; } catch {}
try { fs.writeFileSync(PENDING, "[]"); } catch {}
function restorePending() {
  try {
    if (had) fs.writeFileSync(PENDING, original);
    else if (fs.existsSync(PENDING)) fs.unlinkSync(PENDING);
  } catch {}
}

const calls = [];
globalThis.fetch = async (url, opts) => {
  calls.push({ url: String(url), body: opts && opts.body ? JSON.parse(opts.body) : null });
  return { ok: true, status: 200, headers: { get: () => "application/json" },
    json: async () => ({ ok: true }), text: async () => "{}" };
};

const bridge = require("../bridge");

function t(label, cond, extra) {
  console.log((cond ? "PASS " : "FAIL ") + label + (cond ? "" : "  << " + (extra || "")));
  if (!cond) process.exitCode = 1;
}

const sent = [];
const fakeWa = {
  send: async (text) => { sent.push(String(text)); console.log("  WA< " + String(text).replace(/\n/g, " | ").slice(0, 120)); },
  sendFile: async () => {},
};

function injectPermission(id, seq) {
  bridge.pending.set(id, {
    kind: "permission", id, sessionID: "ses_test", action: "shell",
    resources: ["git status"], __seq: seq,
  });
  bridge.pushPending();
}

(async () => {
  await bridge.start({ whatsapp: fakeWa, getState: () => null, onEvent: () => {} });

  // allow -> once
  calls.length = 0;
  injectPermission("perm_a", 1);
  await bridge.handleIncoming("allow");
  await new Promise((r) => setTimeout(r, 300));
  let c = calls.find((x) => x.url.includes("/permission/perm_a/reply"));
  t("allow sends decision:once", c && c.body && c.body.decision === "once", JSON.stringify(c && c.body));
  t("no legacy reply key", c && !("reply" in c.body), JSON.stringify(c && c.body));
  t("allow confirms", sent.some((s) => s.includes("allowed (once)")), sent.join(" || "));
  t("pending cleared", !bridge.pending.has("perm_a"));

  // always
  calls.length = 0;
  injectPermission("perm_b", 2);
  await bridge.handleIncoming("2 always");
  await new Promise((r) => setTimeout(r, 300));
  c = calls.find((x) => x.url.includes("/permission/perm_b/reply"));
  t("always sends decision:always", c && c.body && c.body.decision === "always", JSON.stringify(c && c.body));

  // reject (and deny alias)
  calls.length = 0;
  injectPermission("perm_c", 3);
  await bridge.handleIncoming("deny");
  await new Promise((r) => setTimeout(r, 300));
  c = calls.find((x) => x.url.includes("/permission/perm_c/reply"));
  t("deny sends decision:reject", c && c.body && c.body.decision === "reject", JSON.stringify(c && c.body));

  // URL shape
  t("reply endpoint correct", c && c.url.includes("/api/session/ses_test/permission/perm_c/reply"), c && c.url);

  // no pending -> friendly answer, no HTTP call
  calls.length = 0;
  await bridge.handleIncoming("allow");
  await new Promise((r) => setTimeout(r, 300));
  t("no pending reports", sent.some((s) => s.includes("no pending approval")), sent.join(" || "));
  t("no permission reply call", !calls.some((x) => x.url.includes("/reply")), JSON.stringify(calls));

  bridge.stop();
  restorePending();
  console.log(process.exitCode ? "TEST FAILED" : "ALL PASS");
  process.exit(process.exitCode || 0);
})().catch((e) => { restorePending(); console.error("ERR", e); process.exit(1); });
