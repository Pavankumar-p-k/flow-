/* Model health probe (Tony pack #2) — every morning, ping each link in the
   assistant's MODEL_CHAIN with a 1-token completion against the OpenCode
   inference endpoint (the same one the assistant uses), verify it is still
   listed locally, and auto-advance the chain when the CURRENT model is
   genuinely dead (HTTP 402/403/404/5xx, timeout, connection refused).
   A 429 FreeUsageLimit is transient — it gets its own "limit" status and
   never advances the chain.
   Pushes only on state CHANGES (down / recovered / advanced), never daily.
   State: modelprobe-state.json (first run = silent baseline). */
const fs = require("fs");
const path = require("path");
const os = require("os");
const assistant = require("./assistant");

const STATE_FILE = path.join(__dirname, "modelprobe-state.json");
const SERVICE_FILE = path.join(os.homedir(), ".local", "state", "opencode", "service.json");
const FALLBACK_BASE = "https://opencode.ai/inference/openai/v1";
const FALLBACK_KEY = "public";
const PING_TIMEOUT_MS = 12000;
const STAGGER_MS = 500;          // 3 at once looks like a burst to a free tier
const TTL_MS = 30 * 60 * 1000;

let sendFn = null;
let logFn = () => {};
let state = null;
let endpoint = null;             // { base, key } resolved once per process
let cache = { at: 0, text: null };

function load() {
  try {
    const s = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
    return s && typeof s === "object" ? s : null;
  } catch { return null; }
}
function save() {
  try { fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2)); }
  catch (e) { logFn("modelprobe save err " + e.message); }
}
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function service() {
  try {
    const svc = JSON.parse(fs.readFileSync(SERVICE_FILE, "utf8"));
    if (svc && svc.url) return svc;
  } catch {}
  return null;
}

/* Where do the free models actually live? Ask the local provider registry
   (it carries baseURL + apiKey from opencode config); fall back to the
   known-good inference endpoint if that lookup fails. */
async function resolveEndpoint() {
  if (endpoint) return endpoint;
  endpoint = { base: FALLBACK_BASE, key: FALLBACK_KEY };
  const svc = service();
  if (svc && svc.url) {
    try {
      const auth = "Basic " + Buffer.from("opencode:" + svc.password).toString("base64");
      const r = await fetch(svc.url.replace(/\/+$/, "") + "/api/provider",
        { headers: { Authorization: auth, "User-Agent": "agent-notch/1.0" } });
      if (r.ok) {
        const j = await r.json();
        const p = (Array.isArray(j.data) ? j.data : []).find((x) => x && x.id === "opencode");
        if (p && p.settings && p.settings.baseURL) {
          endpoint = {
            base: String(p.settings.baseURL).replace(/\/+$/, ""),
            key: p.settings.apiKey || FALLBACK_KEY,
          };
        }
      }
    } catch (e) { logFn("modelprobe provider lookup err " + e.message); }
  }
  return endpoint;
}

/* Which chain models still exist in the local list? */
async function localIds() {
  const svc = service();
  if (!svc) return null;
  try {
    const auth = "Basic " + Buffer.from("opencode:" + svc.password).toString("base64");
    const r = await fetch(svc.url.replace(/\/+$/, "") + "/api/model",
      { headers: { Authorization: auth, "User-Agent": "agent-notch/1.0" } });
    if (!r.ok) return null;
    const j = await r.json();
    if (!j || !Array.isArray(j.data)) return null;
    return new Set(j.data.filter((m) => m && m.providerID && m.modelID)
      .map((m) => m.providerID + "/" + m.modelID));
  } catch { return null; }
}

/* One 1-token completion. Statuses:
     ok     — answered
     fail   — genuinely dead (402/403/404/5xx/timeout/refused)
     limit  — 429 FreeUsageLimit: transient, recovers on its own
     unknown— proxy/test payload we cannot judge (never pushes, never advances) */
async function ping(base, key, model) {
  const t0 = Date.now();
  const ctl = typeof AbortController !== "undefined" ? new AbortController() : null;
  const timer = ctl ? setTimeout(() => { try { ctl.abort(); } catch {} }, PING_TIMEOUT_MS) : null;
  try {
    const r = await fetch(base + "/chat/completions", {
      method: "POST",
      headers: { Authorization: "Bearer " + key, "Content-Type": "application/json" },
      body: JSON.stringify({ model, messages: [{ role: "user", content: "ping" }], max_tokens: 1 }),
      ...(ctl ? { signal: ctl.signal } : {}),
    });
    const ms = Date.now() - t0;
    if (r.status === 429) return { status: "limit", ms, note: "free usage limit" };
    if (!r.ok) return { status: "fail", ms, note: "HTTP " + r.status };
    let j = null;
    try { j = await r.json(); } catch { j = null; }
    if (!j || !Array.isArray(j.choices)) return { status: "unknown", ms, note: "unexpected payload" };
    return { status: "ok", ms };
  } catch (e) {
    return {
      status: "fail",
      ms: Date.now() - t0,
      note: (e && e.name === "AbortError") ? "timeout" : String((e && e.message) || e),
    };
  } finally { if (timer) clearTimeout(timer); }
}

async function push(text) {
  try { if (sendFn) await sendFn(text); } catch (e) { logFn("modelprobe push err " + e.message); }
}

/* One full probe: staggered pings across the chain. */
async function probeOnce() {
  const chain = assistant.chain();
  const cur = assistant.currentModel();
  const ep = await resolveEndpoint();
  const listed = await localIds();
  const results = await Promise.all(chain.map(async (m, i) => {
    await sleep(i * STAGGER_MS);
    const r = await ping(ep.base, ep.key, m.id);
    return {
      key: m.providerID + "/" + m.id,
      id: m.id,
      current: m.providerID === cur.providerID && m.id === cur.id,
      listed: listed ? listed.has(m.providerID + "/" + m.id) : null,
      ...r,
    };
  }));
  return { results, currentKey: cur.providerID + "/" + cur.id };
}

async function section(opts) {
  if (!state) state = load() || { prev: null, lastRun: null };
  if (!opts || !opts.fresh) {
    if (cache.text !== null && Date.now() - cache.at < TTL_MS) return cache.text;
  }

  const { results, currentKey } = await probeOnce();

  // auto-advance when the CURRENT model is genuinely dead (429 limit never
  // advances — it recovers, and stepping the chain over it would be wrong)
  let advanced = null;
  const cur = results.find((r) => r.key === currentKey);
  if (cur && cur.status === "fail") {
    if (assistant.advanceModel("daily probe: " + cur.note)) {
      advanced = assistant.currentModel();
      logFn("modelprobe advanced -> " + advanced.providerID + "/" + advanced.id);
    }
  }

  // pushes only on change vs the previous run (first run = baseline)
  const prev = state.prev;
  if (prev) {
    for (const r of results) {
      const was = prev[r.key];
      if (was === r.status) continue;
      if (r.status === "ok" && was) await push("🟢 model recovered: " + r.id);
      else if (r.status === "fail") await push("🔴 model down: " + r.id + " (" + r.note + ")");
      else if (r.status === "limit" && was === "ok") {
        await push("⚠️ free usage limit: " + r.id + " — recovers on its own");
      }
    }
    if (advanced) await push("🔁 chain auto-advanced: " + advanced.id + " (was down)");
  }

  state.prev = {};
  for (const r of results) state.prev[r.key] = r.status;
  state.lastRun = Date.now();
  save();

  // nothing judgeable (test doubles / weird proxy) -> say nothing
  if (results.every((r) => r.status === "unknown")) {
    cache = { at: Date.now(), text: null };
    return null;
  }

  const icon = { ok: "✅", fail: "❌", limit: "⚠️", unknown: "❔" };
  const lines = ["🩺 CHAIN HEALTH"];
  for (const r of results) {
    lines.push(icon[r.status] + " " + r.id + " · " +
      (r.status === "ok" ? r.ms + "ms" : r.note) +
      (r.current ? " ← current" : "") +
      (r.listed === false ? " · not in local list" : ""));
  }
  if (advanced) lines.push("🔁 auto-advanced → " + advanced.id);
  const text = lines.join("\n");
  cache = { at: Date.now(), text };
  return text;
}

function start(deps) {
  sendFn = (deps && deps.send) || null;
  logFn = (deps && deps.log) || (() => {});
  state = load();
  endpoint = null; // re-resolve on every app boot
  cache = { at: 0, text: null };
}

module.exports = { start, section, probeOnce, ping, _state: () => state };
