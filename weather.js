/* weather.js — keyless weather (Open-Meteo) for the notch pill + digest.
   City preference lives in config.json as `weatherCity`; with no city set we
   locate by IP (ipapi.co) so the pill works out of the box. One geocode +
   one forecast call, ~200ms, no API key, no account. */
const fs = require("fs");
const path = require("path");

const CONFIG_FILE = path.join(__dirname, "config.json");

// WMO weather codes -> [text, emoji]
const CODES = {
  0: ["Clear", "☀️"], 1: ["Mainly clear", "🌤"], 2: ["Partly cloudy", "⛅"], 3: ["Overcast", "☁️"],
  45: ["Fog", "🌫"], 48: ["Rime fog", "🌫"],
  51: ["Light drizzle", "🌦"], 53: ["Drizzle", "🌦"], 55: ["Dense drizzle", "🌦"],
  56: ["Freezing drizzle", "🌦"], 57: ["Freezing drizzle", "🌦"],
  61: ["Light rain", "🌧"], 63: ["Rain", "🌧"], 65: ["Heavy rain", "🌧"],
  66: ["Freezing rain", "🌧"], 67: ["Freezing rain", "🌧"],
  71: ["Light snow", "❄️"], 73: ["Snow", "❄️"], 75: ["Heavy snow", "❄️"], 77: ["Snow grains", "❄️"],
  80: ["Rain showers", "🌦"], 81: ["Rain showers", "🌦"], 82: ["Violent showers", "🌦"],
  85: ["Snow showers", "❄️"], 86: ["Snow showers", "❄️"],
  95: ["Thunderstorm", "⛈"], 96: ["Storm + hail", "⛈"], 99: ["Storm + hail", "⛈"],
};

function cityCfg() {
  try {
    const c = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));
    return c && typeof c.weatherCity === "string" ? c.weatherCity : "";
  } catch { return ""; }
}

function setCity(city) {
  let c = {};
  try { c = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8")) || {}; } catch {}
  c.weatherCity = String(city || "").trim();
  try { fs.writeFileSync(CONFIG_FILE, JSON.stringify(c, null, 2)); }
  catch (e) { throw new Error("config write failed: " + e.message); }
}

function readCfg() {
  try { return JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8")) || {}; } catch { return {}; }
}
function saveCfgPatch(patch) {
  const c = readCfg();
  Object.assign(c, patch);
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(c, null, 2));
}

async function getJson(url, ms = 8000, retries = 1) {
  const ctl = typeof AbortController !== "undefined" ? new AbortController() : null;
  const timer = ctl ? setTimeout(() => { try { ctl.abort(); } catch {} }, ms) : null;
  try {
    // ipapi.co burst-limits requests carrying Node's default "undici" UA —
    // a plain UA sails through (verified: no-UA 429, custom UA 200).
    const r = await fetch(url, { headers: { "User-Agent": "agent-notch/1.0" }, ...(ctl ? { signal: ctl.signal } : {}) });
    if (r.status === 429 && retries > 0) {          // transient burst limit
      await new Promise((res) => setTimeout(res, 3000));
      return getJson(url, ms, retries - 1);
    }
    if (!r.ok) throw new Error("HTTP " + r.status);
    return await r.json();
  } finally { if (timer) clearTimeout(timer); }
}

async function resolveLocation(city) {
  if (city) {
    const g = await getJson("https://geocoding-api.open-meteo.com/v1/search?count=1&language=en&format=json&name=" + encodeURIComponent(city));
    const r = g && g.results && g.results[0];
    if (!r) throw new Error("unknown city \"" + city + "\"");
    return { lat: r.latitude, lon: r.longitude, name: [r.name, r.admin1, r.country].filter(Boolean).slice(0, 2).join(", ") };
  }
  // no city: use the coords resolved once before (ipapi.co burst-limits, so
  // never hit it twice) and only fall back to a live IP lookup on first run.
  const cached = readCfg().weatherLoc;
  if (cached && cached.lat != null && cached.lon != null) {
    return { lat: cached.lat, lon: cached.lon, name: cached.name || "nearby" };
  }
  const ip = await getJson("https://ipapi.co/json/");
  if (!ip || ip.latitude == null) throw new Error("IP location failed");
  const name = [ip.city, ip.region].filter(Boolean).join(", ");
  try { saveCfgPatch({ weatherLoc: { lat: ip.latitude, lon: ip.longitude, name } }); } catch {}
  return { lat: ip.latitude, lon: ip.longitude, name };
}

/* Current conditions + 4-day outlook. city: explicit -> config -> IP. */
async function get(city) {
  const loc = await resolveLocation(city != null ? city : cityCfg());
  const q = "latitude=" + loc.lat + "&longitude=" + loc.lon +
    "&current=temperature_2m,apparent_temperature,relative_humidity_2m,weather_code,wind_speed_10m" +
    "&daily=weather_code,temperature_2m_max,temperature_2m_min&timezone=auto&forecast_days=4";
  const w = await getJson("https://api.open-meteo.com/v1/forecast?" + q);
  const c = (w && w.current) || {};
  const cur = CODES[c.weather_code] || ["", ""];
  const d = (w && w.daily) || {};
  const days = [];
  for (let i = 0; i < Math.min(4, (d.time || []).length); i++) {
    const dc = CODES[d.weather_code && d.weather_code[i]] || ["", ""];
    days.push({
      date: d.time[i],
      min: Math.round((d.temperature_2m_min || [])[i]),
      max: Math.round((d.temperature_2m_max || [])[i]),
      text: dc[0], emoji: dc[1],
    });
  }
  if (c.temperature_2m == null) throw new Error("no current weather in response");
  return {
    ok: true,
    city: loc.name,
    temp: Math.round(c.temperature_2m),
    feels: Math.round(c.apparent_temperature != null ? c.apparent_temperature : c.temperature_2m),
    text: cur[0], emoji: cur[1],
    humidity: Math.round(c.relative_humidity_2m != null ? c.relative_humidity_2m : 0),
    wind: Math.round(c.wind_speed_10m != null ? c.wind_speed_10m : 0),
    days,
  };
}

/* one-liner for the digest */
function fmtLine(w) {
  const d0 = w.days && w.days[0];
  return w.emoji + " " + w.city + " · " + w.temp + "° " + w.text +
    (d0 ? " (H " + d0.max + "° · L " + d0.min + "°)" : "");
}

/* full reply for the `weather` command */
function fmtFull(w, extra) {
  const lines = [
    w.emoji + " " + w.city + " · " + w.temp + "°C (feels " + w.feels + "°) · " + w.text,
    "💧 " + w.humidity + "% · 💨 " + w.wind + " km/h",
  ];
  if (w.days && w.days.length) {
    lines.push(w.days.map((x) => x.date.slice(5) + " " + x.min + "/" + x.max + "° " + x.emoji).join(" · "));
  }
  if (extra) lines.push(extra);
  return lines.join("\n");
}

module.exports = { get, setCity, cityCfg, fmtLine, fmtFull };
