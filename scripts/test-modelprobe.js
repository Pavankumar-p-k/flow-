/* Model health probe (Tony pack #2):
   - run 1 = silent baseline: statuses reported, NO pushes, chain advances
     when the CURRENT model is genuinely dead (402 -> advanceModel)
   - run 2 = same statuses -> no pushes (change detection)
   - run 3 = dead model comes back -> one "recovered" push
   - a 429 FreeUsageLimit never advances the chain (transient by nature)
   - all-unknown payloads -> no section at all (test doubles stay quiet)
   - transport failure (offline) -> status "net": shown as NOT judged,
     never advances the chain, never pushes (A1 hardening)
   modelprobe-state.json is shared with the live app -> snapshotted and
   restored; deleted first so the baseline test is genuine. */
const fs = require("fs");
const path = require("path");

const STATE = path.join(__dirname, "..", "modelprobe-state.json");
function snap(f) { try { return fs.readFileSync(f, "utf8"); } catch { return null; } }
const orig = snap(STATE);
function restore() {
  try {
    if (orig != null) fs.writeFileSync(STATE, orig);
    else if (fs.existsSync(STATE)) fs.unlinkSync(STATE);
  } catch {}
}
try { if (fs.existsSync(STATE)) fs.unlinkSync(STATE); } catch {}

/* mimo is DEAD (402), deepseek answers, hy4 is rate/usage limited (429) */
const DEAD = { "mimo-v2.6-flash-free": 402, "deepseek-v4.1-flash-free": 200, "hy4-flash-free": 429 };
let MIMO_OK = false;
let UNKNOWN = false; // proxy/test payload: 200 but no choices[]
let NET_DOWN = false; // transport failure: fetch throws, no HTTP answer

globalThis.fetch = async (url, opts) => {
  const u = String(url);
  const ok = (j) => ({ ok: true, status: 200, json: async () => j, text: async () => JSON.stringify(j) });
  if (u.includes("/api/provider")) {
    return ok({ data: [{ id: "opencode", settings: { baseURL: "https://opencode.ai/inference/openai/v1", apiKey: "public" } }] });
  }
  if (u.includes("/api/model")) {
    return ok({ data: [
      { providerID: "opencode", modelID: "mimo-v2.6-flash-free" },
      { providerID: "opencode", modelID: "deepseek-v4.1-flash-free" },
      { providerID: "opencode", modelID: "hy4-flash-free" },
    ] });
  }
  if (u.includes("/chat/completions")) {
    const body = opts && opts.body ? JSON.parse(opts.body) : {};
    if (NET_DOWN) throw new Error("fetch failed");
    if (UNKNOWN) return ok({ ok: true, data: { time: Date.now() } });
    if (body.model === "mimo-v2.6-flash-free" && !MIMO_OK) {
      return { ok: false, status: DEAD[body.model], json: async () => ({ error: "nope" }) };
    }
    if (DEAD[body.model] === 429 && body.model === "hy4-flash-free") {
      return { ok: false, status: 429, json: async () => ({ type: "error", error: { type: "FreeUsageLimitError" } }) };
    }
    return ok({ choices: [{ message: { content: "" }, finish_reason: "stop" }] });
  }
  return ok({ ok: true, data: {} });
};

const probe = require("../modelprobe");
const assistant = require("../assistant");

function t(label, cond, extra) {
  console.log((cond ? "PASS " : "FAIL ") + label + (cond ? "" : "  << " + (extra || "")));
  if (!cond) process.exitCode = 1;
}

(async () => {
  const pushes = [];
  probe.start({ send: async (x) => pushes.push(String(x)), log: () => {} });
  t("chain starts at mimo", assistant.currentModel().id === "mimo-v2.6-flash-free",
    JSON.stringify(assistant.currentModel()));

  /* ---- 1. baseline: statuses + auto-advance, NO pushes ---- */
  const s1 = await probe.section({ fresh: true });
  t("chain health header", /🩺 CHAIN HEALTH/.test(s1 || ""), s1);
  t("dead current model flagged", /❌ mimo-v2\.6-flash-free · HTTP 402 ← current/.test(s1 || ""), s1);
  t("healthy model reported with ms", /✅ deepseek-v4\.1-flash-free · \d+ms/.test(s1 || ""), s1);
  t("429 = limit, not dead", /⚠️ hy4-flash-free · free usage limit/.test(s1 || ""), s1);
  t("auto-advanced to deepseek", /🔁 auto-advanced → deepseek-v4\.1-flash-free/.test(s1 || ""), s1);
  t("assistant actually advanced", assistant.currentModel().id === "deepseek-v4.1-flash-free",
    JSON.stringify(assistant.currentModel()));
  t("no push on baseline", pushes.length === 0, JSON.stringify(pushes));

  /* ---- 2. same statuses -> change detection stays quiet ---- */
  const s2 = await probe.section({ fresh: true });
  t("current marker moved", /✅ deepseek-v4\.1-flash-free · \d+ms ← current/.test(s2 || ""), s2);
  t("no push when nothing changed", pushes.length === 0, JSON.stringify(pushes));

  /* ---- 3. dead model recovers -> exactly one push ---- */
  MIMO_OK = true;
  await probe.section({ fresh: true });
  t("recovery push fired", pushes.length === 1 && /🟢 model recovered: mimo-v2\.6-flash-free/.test(pushes[0]),
    JSON.stringify(pushes));

  /* ---- 4. unjudgeable payloads -> no section, no pushes ---- */
  UNKNOWN = true;
  const s4 = await probe.section({ fresh: true });
  t("all-unknown omits section", s4 === null, JSON.stringify(s4));
  t("unknown never pushes", pushes.length === 1, JSON.stringify(pushes));

  /* ---- 5. network outage: transport failure is NOT a verdict ---- */
  UNKNOWN = false;
  NET_DOWN = true;
  const s5 = await probe.section({ fresh: true });
  t("outage shown as network, not judged",
    /🌐 mimo-v2\.6-flash-free · fetch failed \(network — not judged\)/.test(s5 || "") &&
    /🌐 deepseek-v4\.1-flash-free · fetch failed \(network — not judged\)/.test(s5 || ""), s5);
  t("outage never advances the chain", assistant.currentModel().id === "deepseek-v4.1-flash-free",
    JSON.stringify(assistant.currentModel()));
  t("outage never pushes", pushes.length === 1, JSON.stringify(pushes));

  /* ---- 6. network back: silent return, no fake recovery claim ---- */
  NET_DOWN = false;
  const s6 = await probe.section({ fresh: true });
  t("statuses reported after outage", /✅ deepseek-v4\.1-flash-free · \d+ms/.test(s6 || ""), s6);
  t("no fake recovery push after net", pushes.length === 1, JSON.stringify(pushes));

  console.log(process.exitCode ? "FAILED" : "ALL PASS");
  restore();
  process.exit(process.exitCode || 0);
})().catch((e) => { restore(); console.error(e); process.exit(1); });
