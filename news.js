/* Daily news (News pack #4/#5) — the paper's headline pages:
   · Hacker News top-5 from the front page (Algolia, keyless)
   · company headlines: RSS for OpenAI / Google DeepMind / Microsoft;
     Anthropic + DeepSeek publish no usable RSS (their /rss URLs 404 or
     serve HTML) → HN search by company name instead.
   State (news-state.json) dedupes the GIANTS page so the 09:00 digest
   only carries links not already seen; the `news` command always sends
   everything fresh. */
const fs = require("fs");
const path = require("path");
const { writeAtomic } = require("./fsutil");

const STATE_FILE = path.join(__dirname, "news-state.json");
const UA = "agent-notch/1.0";
const TTL_MS = 30 * 60 * 1000;

const RSS = [
  { company: "OpenAI", url: "https://openai.com/news/rss.xml" },
  { company: "DeepMind", url: "https://deepmind.google/blog/rss.xml" },
  { company: "Microsoft", url: "https://blogs.microsoft.com/feed/" },
];
const HN_ONLY = ["Anthropic", "DeepSeek"]; // no usable RSS — HN by name

let sendFn = null;
let logFn = () => {};
let state = null;
let cache = { at: 0, data: null };

function load() {
  try {
    const s = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
    return s && typeof s === "object" ? s : null;
  } catch { return null; }
}
function save() {
  try { writeAtomic(STATE_FILE, JSON.stringify(state, null, 2)); }
  catch (e) { logFn("news save err " + e.message); }
}

async function get(url, asJson, ms = 8000) {
  const ctl = typeof AbortController !== "undefined" ? new AbortController() : null;
  const timer = ctl ? setTimeout(() => { try { ctl.abort(); } catch {} }, ms) : null;
  try {
    const r = await fetch(url, { headers: { "User-Agent": UA }, ...(ctl ? { signal: ctl.signal } : {}) });
    if (r.status === 429) { // one retry after a burst limit (weather pattern)
      await new Promise((res) => setTimeout(res, 3000));
      const r2 = await fetch(url, { headers: { "User-Agent": UA }, ...(ctl ? { signal: ctl.signal } : {}) });
      if (!r2.ok) throw new Error("HTTP " + r2.status);
      return asJson ? await r2.json() : await r2.text();
    }
    if (!r.ok) throw new Error("HTTP " + r.status);
    return asJson ? await r.json() : await r.text();
  } finally { if (timer) clearTimeout(timer); }
}

function decode(s) {
  return String(s || "")
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#39;|&#x27;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .trim();
}

/* RSS <item> / Atom <entry> -> [{title, url, date}] newest first. */
function parseFeed(xml) {
  const blocks = String(xml || "").match(/<item[\s\S]*?<\/item>|<entry[\s\S]*?<\/entry>/gi) || [];
  const items = [];
  for (const b of blocks) {
    const t = b.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    let u = b.match(/<link[^>]*>([\s\S]*?)<\/link>/i);
    if (!u) {
      const href = b.match(/<link[^>]*href=["']([^"']+)["']/i);
      if (href) u = [, href[1]];
    }
    const d = b.match(/<(?:pubDate|updated|published)[^>]*>([\s\S]*?)<\//i);
    const title = decode(t && t[1]);
    const url = decode(u && u[1]);
    if (!title || !url) continue;
    const date = d ? Date.parse(decode(d[1])) : NaN;
    items.push({ title, url, date: Number.isFinite(date) ? date : 0 });
  }
  return items.sort((a, b) => b.date - a.date);
}

/* HN front page, top by points. */
async function hnTop() {
  const j = await get("https://hn.algolia.com/api/v1/search?tags=front_page&hitsPerPage=10", true);
  const hits = (Array.isArray(j.hits) ? j.hits : [])
    .filter((h) => h && h.title)
    .sort((a, b) => (b.points || 0) - (a.points || 0))
    .slice(0, 5)
    .map((h) => ({
      title: h.title,
      points: h.points || 0,
      url: h.url || ("https://news.ycombinator.com/item?id=" + h.objectID),
    }));
  return hits;
}

/* Company coverage where no RSS exists (Anthropic / DeepSeek). */
async function hnCompany(name) {
  const since = Math.floor(Date.now() / 1000) - 7 * 86400;
  const u = "https://hn.algolia.com/api/v1/search?query=" + encodeURIComponent(name) +
    "&tags=story&numericFilters=points%3E80%2Ccreated_at_i%3E" + since + "&hitsPerPage=5";
  const j = await get(u, true);
  return (Array.isArray(j.hits) ? j.hits : [])
    .filter((h) => h && h.title && new RegExp(name, "i").test(h.title))
    .slice(0, 2)
    .map((h) => ({
      title: h.title,
      points: h.points || 0,
      url: h.url || ("https://news.ycombinator.com/item?id=" + h.objectID),
    }));
}

async function collect() {
  const [hn, rssLists, hnLists] = await Promise.all([
    hnTop().catch((e) => { logFn("news HN err " + e.message); return []; }),
    Promise.all(RSS.map((f) =>
      get(f.url, false).then((xml) => ({ company: f.company, items: parseFeed(xml).slice(0, 2) }))
        .catch((e) => { logFn("news RSS err (" + f.company + "): " + e.message); return null; }))),
    Promise.all(HN_ONLY.map((c) =>
      hnCompany(c).then((items) => ({ company: c, items }))
        .catch((e) => { logFn("news HN-company err (" + c + "): " + e.message); return null; }))),
  ]);
  const giants = [];
  for (const l of rssLists) if (l) for (const it of l.items) giants.push({ company: l.company, ...it });
  for (const l of hnLists) if (l) for (const it of l.items) giants.push({ company: l.company, ...it });
  return { hn, giants };
}

function fmtHn(hn) {
  const lines = ["📰 HACKER NEWS top 5"];
  hn.forEach((h, i) => lines.push((i + 1) + ". " + h.title + " (" + h.points + ") " + h.url));
  return lines;
}

function build(data, opts) {
  const markSeen = !!(opts && opts.markSeen);
  const seen = new Set((state && state.seen) || []);
  const hn = data.hn || [];
  // HN: always the full top-5 (the paper's headline page).
  // Giants: the digest only carries links not already seen; the on-demand
  // `news` command shows everything (markSeen false = no filter either).
  let giants = (data.giants || []).slice(0, 10);
  if (markSeen) giants = giants.filter((g) => !seen.has(g.url));
  if (markSeen) {
    // mark everything COLLECTED (not just shown) — leftovers must not
    // crowd out tomorrow's paper
    for (const g of (data.giants || [])) seen.add(g.url);
    state.seen = [...seen].slice(-400);
    // persist the headline page itself (A3): after a reboot the brief and
    // `links` can still be built from disk, before any new collect
    state.lastHn = hn.slice(0, 5);
    state.lastGiants = (data.giants || []).slice(0, 10);
    save();
  }
  if (!hn.length && !giants.length) return null;
  const lines = [];
  if (hn.length) lines.push(...fmtHn(hn));
  if (giants.length) {
    if (lines.length) lines.push("");
    lines.push(opts && opts.giantsHead ? opts.giantsHead : "🏢 GIANTS");
    for (const g of giants) lines.push("• " + g.company + ": " + g.title + " " + g.url);
  }
  return lines.join("\n");
}

async function section(opts) {
  if (!state) state = load() || { seen: [] };
  if (!opts || !opts.fresh) {
    if (cache.data && Date.now() - cache.at < TTL_MS) return build(cache.data, { markSeen: true });
  }
  const data = await collect();
  cache = { at: Date.now(), data };
  return build(data, { markSeen: true });
}

/* on-demand command: news · news hn · news <company> */
async function handle(arg) {
  if (!state) state = load() || { seen: [] };
  const a = String(arg || "").trim().toLowerCase();
  const data = await collect();
  cache = { at: Date.now(), data }; // the command also warms the brief/links cache (A3)
  let hn = data.hn, giants = data.giants, giantsHead = null;
  if (a === "hn" || a === "hacker") {
    giants = [];
  } else if (a) {
    const hit = data.giants.filter((g) => g.company.toLowerCase().includes(a));
    if (!hit.length) {
      return sendFn("⚠️ no feed for \"" + arg + "\" — try: news · news hn · news openai | anthropic | deepmind | deepseek | microsoft");
    }
    hn = [];
    giants = hit;
    giantsHead = "📰 " + hit[0].company.toUpperCase();
  }
  const text = build({ hn, giants }, { markSeen: false, giantsHead });
  if (!text) return sendFn("📰 no headlines right now — the feeds came back empty.");
  try { if (sendFn) await sendFn(text); }
  catch (e) { logFn("news send err " + e.message); }
}

/* Last paper from disk — what brief/links fall back to when the
   in-process cache is empty (fresh process, cache wiped by start()). */
function persistedData() {
  if (!state) state = load();
  if (!state) return null;
  const hn = Array.isArray(state.lastHn) ? state.lastHn : [];
  const giants = Array.isArray(state.lastGiants) ? state.lastGiants : [];
  return (hn.length || giants.length) ? { hn, giants } : null;
}

/* The paper's links, numbered for `open <n>` — last-collected data if we
   have it (the digest/news command built it), fetched on demand otherwise;
   if the fetch fails or comes back empty, the persisted headline page. */
async function links() {
  if (!state) state = load() || { seen: [] };
  let data = cache.data;
  if (!data) {
    try {
      data = await collect();
      if (data && !((data.hn || []).length || (data.giants || []).length)) data = null; // offline: nothing fresh
    } catch (e) { logFn("news links collect err " + e.message); data = null; }
    if (data) cache = { at: Date.now(), data };
    else data = persistedData();
  }
  if (!data) return [];
  const out = [];
  for (const h of (data.hn || [])) out.push({ title: h.title, url: h.url, group: "hn" });
  for (const g of (data.giants || [])) out.push({ title: g.company + ": " + g.title, url: g.url, group: "giants" });
  return out;
}

/* One line for the daily brief — last-collected headlines, no network;
   falls back to the persisted page after a reboot (A3). */
function brief() {
  const data = cache.data || persistedData();
  if (!data) return null;
  const hn = (data.hn || [])[0];
  const giants = data.giants || [];
  const parts = [];
  if (hn) parts.push("📰 HN #1: " + hn.title + " (" + hn.points + ")");
  if (giants.length) parts.push("🏢 " + giants.length + " company headlines");
  return parts.length ? "news: " + parts.join(" · ") : null;
}

function start(deps) {
  sendFn = (deps && deps.send) || null;
  logFn = (deps && deps.log) || (() => {});
  state = load();
  cache = { at: 0, data: null };
}

module.exports = { start, section, handle, links, brief, parseFeed, collect, _state: () => state };
