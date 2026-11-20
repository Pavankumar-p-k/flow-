/* Weather + morning brief (#feature 3):
   - weather.js parses Open-Meteo geocode/forecast/ip-location (faked here)
   - `weather <city>` fetches, replies and SAVES the city as default;
     `weather` (bare) uses the saved city; `weather in <city>` strips "in"
   - the daily digest carries a weather line (morning brief)
   - natural-language weather asks go to the ASSISTANT (keyword-only)
   config.json, digest-state.json and queue-pending.json are all shared
   with the live app -> snapshotted and restored. */
const fs = require("fs");
const path = require("path");

const CFG = path.join(__dirname, "..", "config.json");
const DSTATE = path.join(__dirname, "..", "digest-state.json");
const PENDING = path.join(__dirname, "..", "queue-pending.json");
function snap(f) { try { return fs.readFileSync(f, "utf8"); } catch { return null; } }
const origCfg = snap(CFG), origD = snap(DSTATE), origP = snap(PENDING);
function restoreAll() {
  try {
    if (origCfg != null) fs.writeFileSync(CFG, origCfg); else if (fs.existsSync(CFG)) fs.unlinkSync(CFG);
    if (origD != null) fs.writeFileSync(DSTATE, origD); else if (fs.existsSync(DSTATE)) fs.unlinkSync(DSTATE);
    if (origP != null) fs.writeFileSync(PENDING, origP); else if (fs.existsSync(PENDING)) fs.unlinkSync(PENDING);
  } catch {}
}

// strip weatherCity + cached coords so the IP-fallback test sees
// "no city configured" (both restored at the end)
try {
  const c = origCfg != null ? JSON.parse(origCfg) : {};
  delete c.weatherCity;
  delete c.weatherLoc;
  fs.writeFileSync(CFG, JSON.stringify(c, null, 2));
} catch {}
// suppress the boot catch-up digest pump (same trick as test-digest)
try { fs.writeFileSync(DSTATE, JSON.stringify({ day: null, hour: 24, minute: 0 })); } catch {}

/* ---- fake weather services ---- */
const UNKNOWN = new Set(["nowhere", "xyzzy"]);
const FORECAST = {
  current: { temperature_2m: 28, apparent_temperature: 31, relative_humidity_2m: 64, weather_code: 2, wind_speed_10m: 12 },
  daily: {
    time: ["2026-11-20", "2026-11-21", "2026-11-22", "2026-11-23"],
    weather_code: [2, 1, 61, 0],
    temperature_2m_max: [30, 29, 27, 31],
    temperature_2m_min: [21, 20, 19, 22],
  },
};

const calls = [];
globalThis.fetch = async (url, opts) => {
  const u = String(url);
  calls.push({ url: u, method: opts && opts.method, body: opts && opts.body ? JSON.parse(opts.body) : null });
  const base = { ok: true, status: 200, headers: { get: () => "application/json" }, text: async () => "{}" };
  if (/geocoding-api\.open-meteo\.com/.test(u)) {
    const name = decodeURIComponent((u.match(/name=([^&]*)/) || [, ""])[1]);
    const results = UNKNOWN.has(name.toLowerCase()) ? [] :
      [{ latitude: 12.97, longitude: 77.59, name: name.replace(/^\w/, (ch) => ch.toUpperCase()), admin1: "Karnataka", country: "India" }];
    return { ...base, json: async () => ({ results }) };
  }
  if (/api\.open-meteo\.com\/v1\/forecast/.test(u)) {
    return { ...base, json: async () => FORECAST };
  }
  if (/ipapi\.co\/json/.test(u)) {
    return { ...base, json: async () => ({ latitude: 1, longitude: 2, city: "IPLand", region: "KA" }) };
  }
  if (/\/message\?/.test(u)) {
    return { ...base, json: async () => ({ ok: true, data: [{ type: "idle", time: { created: Date.now() }, outcome: "success" }] }) };
  }
  return { ...base, json: async () => ({ ok: true, data: { time: { created: Date.now() } } }) };
};

const bridge = require("../bridge");
const weather = require("../weather");

function t(label, cond, extra) {
  console.log((cond ? "PASS " : "FAIL ") + label + (cond ? "" : "  << " + (extra || "")));
  if (!cond) process.exitCode = 1;
}

const sent = [];
const fakeWa = { send: async (text) => { sent.push(String(text)); }, sendFile: async () => {} };
const state = { online: true, sessions: [], active: {}, stats: null };
const prompts = () => calls.filter((c) => c.method === "POST" && /\/prompt$/.test(c.url));
async function waitFor(fn, ms = 8000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (fn()) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return fn();
}

(async () => {
  /* ---- 1. parser: explicit city ---- */
  const w1 = await weather.get("Testville");
  t("geocoded city name", /Testville/.test(w1.city), JSON.stringify(w1));
  t("current temp parsed", w1.temp === 28 && w1.feels === 31, JSON.stringify(w1));
  t("condition mapped (code 2 -> ⛅)", w1.emoji === "⛅" && w1.text === "Partly cloudy", w1.emoji + " " + w1.text);
  t("4-day outlook", w1.days.length === 4 && w1.days[0].max === 30 && w1.days[2].emoji === "🌧",
    JSON.stringify(w1.days));

  /* ---- 2. IP fallback when no city is configured ---- */
  const w2 = await weather.get(null);
  t("IP fallback location", /^IPLand/.test(w2.city), w2.city);

  /* ---- 3. unknown city throws ---- */
  let threw = false;
  try { await weather.get("Nowhere"); } catch (e) { threw = /unknown city/.test(e.message); }
  t("unknown city rejected", threw);

  /* ---- 4. weather <city> replies + saves default ---- */
  await bridge.start({ whatsapp: fakeWa, getState: () => state, onEvent: () => {} });
  await bridge.handleIncoming("weather testville");
  t("weather reply has temp + days",
    await waitFor(() => sent.some((s) => /28°C \(feels 31°\)/.test(s) && /💧 64% · 💨 12 km\/h/.test(s))),
    JSON.stringify(sent));
  t("city saved as default",
    (() => { try { return JSON.parse(fs.readFileSync(CFG, "utf8")).weatherCity === "testville"; } catch { return false; } })(),
    "config=" + (() => { try { return fs.readFileSync(CFG, "utf8"); } catch { return "?"; } })());

  /* ---- 5. bare weather uses the saved city ---- */
  await bridge.handleIncoming("weather");
  t("bare weather answers from default city",
    await waitFor(() => sent.filter((s) => /28°C/.test(s)).length >= 2), JSON.stringify(sent.slice(-3)));

  /* ---- 6. weather in <city> strips the preposition ---- */
  await bridge.handleIncoming("weather in bangalore");
  t('"weather in X" works', await waitFor(() => sent.filter((s) => /city saved as default/.test(s)).length >= 2),
    JSON.stringify(sent.slice(-3)));

  /* ---- 7. morning brief: digest carries the weather line ---- */
  // pending is the live Map the digest reads — add a fake approval so the
  // "waiting for your reply" line is genuinely exercised, then remove it.
  bridge.pending.set("wx-test", { kind: "permission", __seq: 99, __when: Date.now(), title: "fake" });
  const mark = sent.length;
  await bridge.handleIncoming("digest");
  t("digest sent", await waitFor(() => sent.slice(mark).some((s) => /DAILY DIGEST/.test(s))), JSON.stringify(sent.slice(mark)));
  const digestAll = sent.slice(mark).join("\n");
  t("digest has the weather line", /· 28° Partly cloudy \(H 30° · L 21°\)/.test(digestAll), digestAll.slice(0, 400));
  t("digest still has status + approvals", /sessions:/.test(digestAll) && /prompt\(s\) waiting/.test(digestAll), digestAll.slice(0, 600));
  bridge.pending.delete("wx-test");

  /* ---- 8. natural language -> assistant ---- */
  const pBefore = prompts().length;
  await bridge.handleIncoming("how is the weather looking today");
  t("natural weather ask reaches the assistant", await waitFor(() => prompts().length > pBefore),
    "prompts " + pBefore + " -> " + prompts().length);

  console.log(process.exitCode ? "FAILED" : "ALL PASS");
  restoreAll();
  process.exit(process.exitCode || 0);
})().catch((e) => { restoreAll(); console.error(e); process.exit(1); });
