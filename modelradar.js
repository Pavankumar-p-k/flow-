/* Free-model radar (Tony pack #1) — the daily "is there something better
   than what I'm running?" check:
     1. diff OpenCode's LOCAL model list (GET /api/model) against the last
        run — free tiers only (opencode/* and openrouter *:free);
     2. scan HN for fresh open-weights / free-LLM stories from the last 7
        days (r/LocalLLaMA's RSS is IP-blocked, HN is the web source).
   Feeds the 09:00 digest; pushes to chat ONLY when a brand-new FREE model
   shows up locally — web hits stay in the paper.
   State: modelradar-state.json — first run is a silent baseline (the
   ghwatch pattern), a restart never re-announces old models. */
const fs = require("fs");
const path = require("path");
const os = require("os");

const STATE_FILE = path.join(__dirname, "modelradar-state.json");
const SERVICE_FILE = path.join(os.homedir(), ".local", "state", "opencode", "service.json");
const UA = "agent-notch/1.0";
const TTL_MS = 30 * 60 * 1000;   // digest + a manual "digest" reuse one build
const QUERIES = ["open weights", "free LLM"];

let sendFn = null;
let logFn = () => {};
let state = null;
let cache = { at: 0, text: null };

function load() {
  try {
    const s = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
    return s && typeof s === "object" ? s : null;
  } catch { return null; }
}
function save() {
  try { fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2)); }
  catch (e) { logFn("modelradar save err " + e.message); }
}

function service() {
  try {
    const svc = JSON.parse(fs.readFileSync(SERVICE_FILE, "utf8"));
    if (svc && svc.url) return svc;
  } catch {}
  return null;
}
function authHeader(svc) {
  if (!svc || !svc.password) return null;
  return "Basic " + Buffer.from("opencode:" + svc.password).toString("base64");
}

async function getJson(url, ms, headers) {
  const ctl = typeof AbortController !== "undefined" ? new AbortController() : null;
  const timer = ctl ? setTimeout(() => { try { ctl.abort(); } catch {} }, ms) : null;
  try {
    const r = await fetch(url, {
      headers: { "User-Agent": UA, ...(headers || {}) },
      ...(ctl ? { signal: ctl.signal } : {}),
    });
    if (r.status === 429) { // transient burst limit — one retry (weather pattern)
      await new Promise((res) => setTimeout(res, 3000));
      const r2 = await fetch(url, {
        headers: { "User-Agent": UA, ...(headers || {}) },
        ...(ctl ? { signal: ctl.signal } : {}),
      });
      if (!r2.ok) throw new Error("HTTP " + r2.status);
      return await r2.json();
    }
    if (!r.ok) throw new Error("HTTP " + r.status);
    return await r.json();
  } finally { if (timer) clearTimeout(timer); }
}

/* Local free tiers: { "opencode/mimo-v2.6-flash-free": "MiMo-V2.6-Flash Free" } */
async function localModels() {
  const svc = service();
  if (!svc) throw new Error("opencode service unavailable");
  const j = await getJson(svc.url.replace(/\/+$/, "") + "/api/model", 8000,
    { Authorization: authHeader(svc) });
  const arr = j && Array.isArray(j.data) ? j.data : null;
  if (!arr) throw new Error("unexpected /api/model payload");
  const out = {};
  for (const m of arr) {
    if (!m || !m.modelID) continue;
    const free = m.providerID === "opencode" ||
      (m.providerID === "openrouter" && /:free$/.test(m.modelID));
    if (free) out[m.providerID + "/" + m.modelID] = m.name || m.modelID;
  }
  return out;
}

/* Algolia ORs the query terms, so this strict filter is what keeps "3D
   modelers" and "model-free RL" out of the radar. */
function worthy(title) {
  const F = /(free|open[- ]?(source|weights)|no[- ]?cost)/i;
  const M = /(llm|model|gpt|llama|qwen|deepseek|mistral|glm|inference|weights|checkpoint|tts)/i;
  const X = /(model[- ]?free|3d|modeling|dataset|reinforcement|world model|course)/i;
  return F.test(title) && M.test(title) && !X.test(title);
}

async function webHits() {
  const since = Math.floor(Date.now() / 1000) - 7 * 86400;
  const out = [];
  await Promise.all(QUERIES.map(async (q) => {
    try {
      const u = "https://hn.algolia.com/api/v1/search?query=" + encodeURIComponent(q) +
        "&tags=story&numericFilters=points%3E40%2Ccreated_at_i%3E" + since + "&hitsPerPage=10";
      const j = await getJson(u, 8000);
      for (const h of (Array.isArray(j.hits) ? j.hits : [])) {
        if (!h || !h.title || !worthy(h.title)) continue;
        out.push({
          title: h.title,
          points: h.points || 0,
          url: h.url || ("https://news.ycombinator.com/item?id=" + h.objectID),
        });
      }
    } catch (e) { logFn("modelradar HN err (" + q + "): " + e.message); }
  }));
  // same story via both queries -> one entry, highest score wins
  const byUrl = new Map();
  for (const h of out) {
    const prev = byUrl.get(h.url);
    if (!prev || h.points > prev.points) byUrl.set(h.url, h);
  }
  return [...byUrl.values()];
}

/* Build the digest section (and fire the one urgent push we allow). */
async function section(opts) {
  if (!state) state = load() || { models: null, seen: [], pushed: [], baselined: false };
  if (!opts || !opts.fresh) {
    if (cache.text !== null && Date.now() - cache.at < TTL_MS) return cache.text;
  }

  const [models, hits] = await Promise.all([
    localModels().catch((e) => { logFn("modelradar local err " + e.message); return null; }),
    webHits().catch((e) => { logFn("modelradar web err " + e.message); return []; }),
  ]);

  const added = [], removed = [];
  if (models) {
    const prev = state.models;
    if (prev) {
      for (const id of Object.keys(models)) if (!(id in prev)) added.push(id);
      for (const id of Object.keys(prev)) if (!(id in models)) removed.push(id);
    }
    state.models = models;
  }

  // web hits: only stories the paper has not already carried
  const seen = new Set(state.seen || []);
  const fresh = [];
  for (const h of hits) {
    const k = h.url || h.title;
    if (!seen.has(k)) { fresh.push(h); seen.add(k); }
  }
  state.seen = [...seen].slice(-300);

  // urgent: a brand-new FREE tier locally = one chat push, once ever
  for (const id of added) {
    if (!/free/i.test(id)) continue;
    if ((state.pushed || []).includes(id)) continue;
    state.pushed = (state.pushed || []).concat(id);
    logFn("modelradar push " + id);
    try {
      if (sendFn) await sendFn("🤖 RADAR: new free model in OpenCode — " + id +
        " (" + (models[id] || "") + ")\nwant it in MODEL_CHAIN? say the word");
    } catch (e) { logFn("modelradar push err " + e.message); }
  }
  state.lastRun = Date.now();
  save();

  if (!models && !fresh.length) { cache = { at: Date.now(), text: null }; return null; }

  const lines = ["🤖 MODEL RADAR"];
  if (models) {
    if (!state.baselined) {
      lines.push("baselined " + Object.keys(models).length + " local free models");
      state.baselined = true;
      save();
    } else {
      lines.push("local free tiers: " + Object.keys(models).length +
        (added.length || removed.length ? "" : " (no change)"));
      for (const id of added) lines.push("  🆕 " + id + " — " + (models[id] || ""));
      for (const id of removed) lines.push("  ❌ gone: " + id);
    }
  } else {
    lines.push("⚠ local model list unavailable");
  }
  const top = fresh.sort((a, b) => b.points - a.points).slice(0, 3);
  for (const h of top) lines.push("🌐 " + h.title + " (" + h.points + ") " + h.url);

  const text = lines.join("\n");
  cache = { at: Date.now(), text };
  return text;
}

function start(deps) {
  sendFn = (deps && deps.send) || null;
  logFn = (deps && deps.log) || (() => {});
  state = load();
  cache = { at: 0, text: null };
}

module.exports = { start, section, localModels, webHits, worthy, _state: () => state };
