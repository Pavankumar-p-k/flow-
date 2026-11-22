/* First-open digest + brief/links/open (#8 rework + #11):
   - default mode is FIRST-OPEN: the quiet floor blocks 00:00-05:00, the
     first pump of a new day sends exactly once, later pumps stay quiet
   - "digest auto" clears an explicit schedule back to first-open
   - "digest at HH:MM" keeps the old scheduled behavior (hour gating)
   - `brief` (aliases summary/tldr/short) composes an ~8-line summary from
     last-run module data: weather, status, radar, chain, audit, news,
     ghwatch, reminders, repos
   - `links` lists the paper's URLs numbered; `open <n|hn|giants|all>`
     opens them as browser tabs (openUrl injected by this test)
   - "open notepad" must NOT be captured (still reaches the assistant)
   All network is faked (weather/news/radar/probe) -> deterministic + fast.
   Shared state files are snapshotted and restored. */
const fs = require("fs");
const path = require("path");

const FILES = ["config.json", "digest-state.json", "queue-pending.json",
  "news-state.json", "modelradar-state.json", "modelprobe-state.json", "ghwatch-state.json"];
function snap(f) { try { return fs.readFileSync(path.join(__dirname, "..", f), "utf8"); } catch { return null; } }
const orig = FILES.map(snap);
function restoreAll() {
  FILES.forEach((f, i) => {
    const p = path.join(__dirname, "..", f);
    try {
      if (orig[i] != null) fs.writeFileSync(p, orig[i]);
      else if (fs.existsSync(p)) fs.unlinkSync(p);
    } catch {}
  });
}

/* ---- shared files, set BEFORE bridge is required ---- */
// suppress the boot catch-up pump (mode "at" hour 24) until `digest auto`
try { fs.writeFileSync(path.join(__dirname, "..", "digest-state.json"), JSON.stringify({ day: null, hour: 24, minute: 0 })); } catch {}
// config WITHOUT a digest key -> first-open is the effective default
try {
  const cp = path.join(__dirname, "..", "config.json");
  const c = JSON.parse(fs.readFileSync(cp, "utf8") || "{}") || {};
  delete c.digest;
  fs.writeFileSync(cp, JSON.stringify(c, null, 2));
} catch {}
// last-run data for the brief's module one-liners
try { fs.writeFileSync(path.join(__dirname, "..", "modelradar-state.json"), JSON.stringify({
  models: { "opencode/a-free": "A Free", "opencode/b-free": "B Free", "openrouter/x:free": "X (free)" },
  seen: [], pushed: [], baselined: true, lastRun: Date.now(),
})); } catch {}
try { fs.writeFileSync(path.join(__dirname, "..", "modelprobe-state.json"), JSON.stringify({
  prev: {
    "opencode/mimo-v2.6-flash-free": "ok",
    "opencode/deepseek-v4.1-flash-free": "limit",
    "opencode/hy4-flash-free": "fail",
  },
  lastRun: Date.now(),
})); } catch {}
try { fs.writeFileSync(path.join(__dirname, "..", "ghwatch-state.json"), JSON.stringify({
  repo: "owner/repo", issues: { 1: "title" }, prs: { 2: "pr" }, lastRunId: 5, lastRunFail: true,
})); } catch {}

/* ---- fakes: every network call the digest/brief can make ---- */
const HN5 = [
  { title: "T-five-hundred", points: 500, url: "https://ex/hn1", objectID: "1" },
  { title: "T-four-hundred", points: 400, url: "https://ex/hn2", objectID: "2" },
  { title: "T-three-hundred", points: 300, url: "https://ex/hn3", objectID: "3" },
  { title: "T-two-hundred", points: 200, url: "https://ex/hn4", objectID: "4" },
  { title: "T-hundred", points: 100, url: "https://ex/hn5", objectID: "5" },
];
const feedXml = (brand) => `<?xml version="1.0"?><rss><channel>
<item><title>${brand} ships the big thing</title><link>https://ex/${brand}-1</link><pubDate>Wed, 19 Nov 2026 10:00:00 GMT</pubDate></item>
<item><title>${brand} opens the other thing</title><link>https://ex/${brand}-2</link><pubDate>Tue, 18 Nov 2026 10:00:00 GMT</pubDate></item>
</channel></rss>`;

globalThis.fetch = async (url, opts) => {
  const u = String(url);
  const hdrs = { get: () => null };
  const okJson = (j) => ({ ok: true, status: 200, headers: hdrs, json: async () => j, text: async () => JSON.stringify(j) });
  const okText = (s) => ({ ok: true, status: 200, headers: hdrs, text: async () => s, json: async () => ({}) });
  if (u.includes("geocoding-api.open-meteo.com")) {
    return okJson({ results: [{ latitude: 17.73, longitude: 83.33, name: "Tadepalli", admin1: "Andhra Pradesh", country: "India" }] });
  }
  if (u.includes("api.open-meteo.com")) {
    return okJson({
      current: { temperature_2m: 30, apparent_temperature: 32, relative_humidity_2m: 60, weather_code: 0, wind_speed_10m: 10 },
      daily: {
        time: ["2026-11-22", "2026-11-23", "2026-11-24", "2026-11-25"],
        weather_code: [0, 1, 2, 3],
        temperature_2m_max: [31, 32, 30, 29],
        temperature_2m_min: [22, 23, 21, 20],
      },
    });
  }
  if (u.includes("hn.algolia.com")) {
    if (u.includes("front_page")) return okJson({ hits: HN5 });
    return okJson({ hits: [] }); // radar queries + company searches stay quiet
  }
  if (u.includes("openai.com")) return okText(feedXml("OpenAI"));
  if (u.includes("deepmind.google")) return okText(feedXml("DeepMind"));
  if (u.includes("blogs.microsoft.com")) return okText(feedXml("Microsoft"));
  if (u.includes("/api/model")) {
    if (!opts || !opts.headers || !opts.headers.Authorization) throw new Error("missing auth");
    return okJson({ data: [
      { providerID: "opencode", modelID: "a-free", name: "A Free" },
      { providerID: "opencode", modelID: "b-free", name: "B Free" },
      { providerID: "openrouter", modelID: "x:free", name: "X (free)" },
    ] });
  }
  if (u.includes("/api/provider")) {
    return okJson({ data: [{ id: "opencode", settings: { baseURL: "https://opencode.ai/inference/openai/v1", apiKey: "public" } }] });
  }
  if (u.includes("/chat/completions")) {
    const body = opts && opts.body ? JSON.parse(opts.body) : {};
    if (body.model === "deepseek-v4.1-flash-free") {
      return { ok: false, status: 429, headers: hdrs, json: async () => ({ type: "error", error: { type: "FreeUsageLimitError" } }) };
    }
    if (body.model === "hy4-flash-free") {
      return { ok: false, status: 500, headers: hdrs, json: async () => ({ error: "boom" }) };
    }
    return okJson({ choices: [{ message: { content: "" }, finish_reason: "stop" }] });
  }
  return okJson({ ok: true, data: {} });
};

const bridge = require("../bridge");
const news = require("../news");

function t(label, cond, extra) {
  console.log((cond ? "PASS " : "FAIL ") + label + (cond ? "" : "  << " + (extra || "")));
  if (!cond) process.exitCode = 1;
}

const sent = [];
const opened = [];
const fakeWa = {
  send: async (text) => { sent.push(String(text)); console.log("  WA< " + String(text).replace(/\n/g, " | ").slice(0, 140)); },
  sendFile: async () => {},
};
const state = {
  online: true,
  sessions: [{ id: "ses_1", title: "Alpha" }, { id: "ses_2", title: "Beta" }],
  active: { ses_1: true },
  stats: { tokens: { input: 120000, output: 40000 }, tools: { totals: { calls: 10, succeeded: 9, failed: 1 } } },
};

const digests = () => sent.filter((s) => s.includes("DAILY DIGEST"));
const briefs = () => sent.filter((s) => s.includes("DAILY BRIEF"));

async function waitFor(fn, ms) {
  const end = Date.now() + (ms || 20000);
  while (Date.now() < end) {
    if (fn()) return true;
    await new Promise((r) => setTimeout(r, 150));
  }
  return fn();
}

(async () => {
  await bridge.start({
    whatsapp: fakeWa, getState: () => state, onEvent: () => {},
    openUrl: (u) => { opened.push(String(u)); },
  });
  bridge.stop(); // kill the every-minute pump + ghwatch timer: deterministic test

  /* ---- 1. modes ---- */
  t("suppress state starts in scheduled mode", bridge.digestCfg().mode === "at" && bridge.digestCfg().hour === 24,
    JSON.stringify(bridge.digestCfg()));

  await bridge.handleIncoming("digest auto");
  await waitFor(() => sent.some((s) => s.includes("FIRST OPEN")));
  t("digest auto confirms first-open", sent.some((s) => s.includes("FIRST OPEN")), sent.join(" || "));
  t("digest auto switches mode", bridge.digestCfg().mode === "open", JSON.stringify(bridge.digestCfg()));
  try {
    const c = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "config.json"), "utf8"));
    t("digest auto clears config schedule", c.digest == null, JSON.stringify(c.digest));
  } catch (e) { t("digest auto clears config schedule", false, e.message); }
  try {
    const ds = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "digest-state.json"), "utf8"));
    t("state override cleared", ds.hour == null, JSON.stringify(ds));
  } catch (e) { t("state override cleared", false, e.message); }

  /* ---- 2. first-open gating ---- */
  bridge.pumpDigest(new Date(2026, 10, 21, 3, 0)); // 03:00 — under the floor
  await new Promise((r) => setTimeout(r, 500));
  t("quiet floor blocks 03:00", digests().length === 0, String(digests().length));

  bridge.pumpDigest(new Date(2026, 10, 21, 8, 30)); // first open of the day
  await waitFor(() => digests().length >= 1, 30000);
  t("first open sends the paper", digests().length === 1, String(digests().length));

  bridge.pumpDigest(new Date(2026, 10, 21, 9, 0));
  await new Promise((r) => setTimeout(r, 400));
  t("same day never twice", digests().length === 1, String(digests().length));

  /* ---- 3. explicit schedule still works ---- */
  await bridge.handleIncoming("digest at 18:00");
  await waitFor(() => sent.some((s) => s.includes("rescheduled to 18:00")));
  t("digest at schedules", bridge.digestCfg().mode === "at" && bridge.digestCfg().hour === 18,
    JSON.stringify(bridge.digestCfg()));

  bridge.pumpDigest(new Date(2026, 10, 20, 17, 59));
  await new Promise((r) => setTimeout(r, 400));
  t("no send before the hour", digests().length === 1, String(digests().length));

  bridge.pumpDigest(new Date(2026, 10, 20, 18, 0));
  await waitFor(() => digests().length >= 2, 30000);
  t("scheduled send fires", digests().length === 2, String(digests().length));

  await bridge.handleIncoming("digest whenever you like");
  await waitFor(() => sent.some((s) => s.includes("usage: digest")));
  t("usage mentions digest auto", sent.some((s) => /usage: digest .*digest auto/.test(s)), sent.join(" || "));

  /* ---- 4. brief ---- */
  await bridge.handleIncoming("brief");
  await waitFor(() => briefs().length >= 1, 20000);
  const brief = briefs()[0] || "";
  t("brief header", /⚡ DAILY BRIEF — /.test(brief), brief);
  t("brief has weather", /☀️ Tadepalli, Andhra Pradesh · 30° Clear \(H 31° · L 22°\)/.test(brief), brief);
  t("brief has status + tokens", /opencode: online · sessions: 2 · active: 1/.test(brief) && /tokens 24h: 160.0k/.test(brief), brief);
  t("brief radar line", /🤖 radar: 3 local free models · checked \d\d:\d\d/.test(brief), brief);
  t("brief chain line", /🩺 chain: mimo ✅ \(now\) · deepseek ⚠️ · hy4 ❌/.test(brief), brief);
  t("brief audit line", /🔧 audit: (\d+ finding\(s\)|clean)/.test(brief), brief);
  t("brief news line", /news: 📰 HN #1: T-five-hundred \(500\)/.test(brief), brief);
  t("brief ghwatch line", /👀 ghwatch: owner\/repo · last CI: FAILED/.test(brief), brief);
  t("brief repos line", /📁 repos: \d+ · \d+ dirty/.test(brief), brief);
  t("brief footer hints", /full paper: `digest` · links: `links`/.test(brief), brief);

  await bridge.handleIncoming("tldr");
  await waitFor(() => briefs().length >= 2, 20000);
  t("tldr alias works", briefs().length >= 2, String(briefs().length));

  /* ---- 5. links + open tabs ---- */
  const list = await news.links();
  t("links list built", list.length === 11, String(list.length));

  await bridge.handleIncoming("links");
  await waitFor(() => sent.some((s) => s.includes("paper links")));
  const linksMsg = sent.find((s) => s.includes("paper links")) || "";
  t("links numbered", linksMsg.includes("paper links (11):") && linksMsg.includes("1. T-five-hundred"), linksMsg);
  t("links usage footer", linksMsg.includes("open <n> · open hn · open giants · open all"), linksMsg);

  await bridge.handleIncoming("open 1");
  await waitFor(() => opened.length >= 1);
  t("open 1 opens the first link", opened.length === 1 && opened[0] === list[0].url, JSON.stringify(opened));
  t("open 1 confirms", sent.some((s) => s.includes("opened 1 tab — T-five-hundred")), sent.slice(-1)[0]);

  await bridge.handleIncoming("open hn");
  await waitFor(() => opened.length >= 6);
  t("open hn opens the 5 HN links", opened.length === 6 && opened.slice(1).every((u, i) => u === list[i].url),
    JSON.stringify(opened));

  await bridge.handleIncoming("open all");
  await waitFor(() => opened.length >= 17);
  t("open all opens everything", opened.length === 17, String(opened.length));
  t("open all confirms count", sent.some((s) => s.includes("opened 11 tabs in your browser")), sent.slice(-1)[0]);

  await bridge.handleIncoming("open 99");
  await waitFor(() => sent.some((s) => s.includes("no link #99")));
  t("out-of-range link hinted", sent.some((s) => s.includes("no link #99")), sent.slice(-1)[0]);

  /* ---- 6. help carries the new commands ---- */
  await bridge.handleIncoming("help");
  await waitFor(() => sent.some((s) => s.includes("NOTCH COMMANDS")));
  const help = sent.find((s) => s.includes("NOTCH COMMANDS")) || "";
  t("help has first-open digest", help.includes("first laptop open of the day"), help);
  t("help has brief", help.includes("brief — 8-line short summary"), help);
  t("help has open tabs", help.includes("open <n> | hn | giants | all"), help);

  /* ---- 7. NL fallthrough: "open notepad" must reach the ASSISTANT ----
     (no fast-path reply may appear; we exit without waiting for the model) */
  const before = sent.length;
  await bridge.handleIncoming("open notepad");
  await new Promise((r) => setTimeout(r, 2500));
  t("open notepad not captured", sent.slice(before).every((s) => !/opened \d+ tab|paper links/.test(s)),
    JSON.stringify(sent.slice(before)));

  bridge.stop();
  restoreAll();
  console.log(process.exitCode ? "TEST FAILED" : "ALL PASS");
  process.exit(process.exitCode || 0);
})().catch((e) => { restoreAll(); console.error("ERR", e); process.exit(1); });
