/* News pack (#4 HN top-5 + #5 company headlines):
   - HN top-5 sorted by points, always full in every paper
   - giants page: RSS (OpenAI/DeepMind/Microsoft) + HN-by-name fallback
     (Anthropic/DeepSeek have no usable RSS), deduped across runs
   - `news` command: bare / hn / <company> / bad name usage hint
   - the daily digest carries the newspaper
   - A3: the headline page persists to news-state.json — brief() still
     works after the cache is wiped, links() falls back to it offline,
     and the `news` command warms the brief/links cache
   news-state.json, digest-state.json, config.json and queue-pending.json
   are shared with the live app -> snapshotted and restored. */
const fs = require("fs");
const path = require("path");

const NS = path.join(__dirname, "..", "news-state.json");
const DS = path.join(__dirname, "..", "digest-state.json");
const CFG = path.join(__dirname, "..", "config.json");
const PEND = path.join(__dirname, "..", "queue-pending.json");
// fmtDigest also builds the radar/probe sections -> they write state too
const MR = path.join(__dirname, "..", "modelradar-state.json");
const MP = path.join(__dirname, "..", "modelprobe-state.json");
function snap(f) { try { return fs.readFileSync(f, "utf8"); } catch { return null; } }
const orig = { ns: snap(NS), ds: snap(DS), cfg: snap(CFG), pend: snap(PEND), mr: snap(MR), mp: snap(MP) };
function restoreAll() {
  const put = (f, v) => {
    try {
      if (v != null) fs.writeFileSync(f, v);
      else if (fs.existsSync(f)) fs.unlinkSync(f);
    } catch {}
  };
  put(NS, orig.ns); put(DS, orig.ds); put(CFG, orig.cfg); put(PEND, orig.pend);
  put(MR, orig.mr); put(MP, orig.mp);
}
try { if (fs.existsSync(NS)) fs.unlinkSync(NS); } catch {}
// suppress the boot catch-up digest pump (same trick as test-weather)
try { fs.writeFileSync(DS, JSON.stringify({ day: null, hour: 24, minute: 0 })); } catch {}

/* ---- fakes ---- */
const feedXml = (brand) => `<?xml version="1.0"?><rss><channel>
<item><title>${brand} ships the big thing</title><link>https://ex/${brand}-1</link><pubDate>Wed, 19 Nov 2026 10:00:00 GMT</pubDate></item>
<item><title>${brand} opens the other thing</title><link>https://ex/${brand}-2</link><pubDate>Tue, 18 Nov 2026 10:00:00 GMT</pubDate></item>
</channel></rss>`;
const FRONT = [
  { title: "T-hundred", points: 100, url: "https://ex/hn5", objectID: "5" },
  { title: "T-five-hundred", points: 500, url: "https://ex/hn1", objectID: "1" },
  { title: "T-three-hundred", points: 300, url: "https://ex/hn3", objectID: "3" },
  { title: "T-two-hundred", points: 200, url: "https://ex/hn4", objectID: "4" },
  { title: "T-four-hundred", points: 400, url: "https://ex/hn2", objectID: "2" },
];
const COMPANY = {
  Anthropic: [{ title: "Anthropic acquires Bun", points: 2192, url: "https://ex/anth", objectID: "a1" }],
  DeepSeek: [{ title: "DeepSeek v4 released", points: 2091, url: "https://ex/ds", objectID: "d1" }],
};

globalThis.fetch = async (url) => {
  const u = String(url);
  const okText = (s) => ({ ok: true, status: 200, text: async () => s, json: async () => ({}) });
  const okJson = (j) => ({ ok: true, status: 200, json: async () => j, text: async () => JSON.stringify(j) });
  if (u.includes("hn.algolia.com")) {
    if (u.includes("front_page")) return okJson({ hits: FRONT });
    const q = decodeURIComponent((u.match(/query=([^&]*)/) || [, ""])[1]);
    return okJson({ hits: COMPANY[q] || [] });
  }
  if (u.includes("openai.com")) return okText(feedXml("OpenAI"));
  if (u.includes("deepmind.google")) return okText(feedXml("DeepMind"));
  if (u.includes("blogs.microsoft.com")) return okText(feedXml("Microsoft"));
  return okJson({ ok: true, data: {} });
};

const news = require("../news");

function t(label, cond, extra) {
  console.log((cond ? "PASS " : "FAIL ") + label + (cond ? "" : "  << " + (extra || "")));
  if (!cond) process.exitCode = 1;
}

(async () => {
  const sent = [];
  news.start({ send: async (x) => sent.push(String(x)), log: () => {} });

  /* ---- 1. first paper: HN sorted by points + every company ---- */
  const s1 = await news.section({ fresh: true });
  t("HN header", /📰 HACKER NEWS top 5/.test(s1 || ""), s1);
  t("HN sorted by points", /1\. T-five-hundred \(500\)/.test(s1 || "") && /5\. T-hundred \(100\)/.test(s1 || ""), s1);
  t("five HN stories", (s1 || "").split("\n").filter((l) => /^\d+\. /.test(l)).length === 5, s1);
  t("RSS companies present", /• OpenAI:/.test(s1) && /• DeepMind:/.test(s1) && /• Microsoft:/.test(s1), s1);
  t("HN-fallback companies present", /• Anthropic:/.test(s1) && /• DeepSeek:/.test(s1), s1);
  t("giants deduped to 10 max", (s1 || "").split("• ").length - 1 <= 10, s1);

  /* ---- 2. second paper: giants deduped, HN still full ---- */
  const s2 = await news.section({ fresh: true });
  t("HN always full top-5", /1\. T-five-hundred/.test(s2 || ""), s2);
  t("already-seen giants dropped", !/🏢 GIANTS/.test(s2 || ""), s2);

  /* ---- 3. on-demand command ---- */
  await news.handle("hn");
  t("news hn sends only HN", sent.length === 1 && /📰 HACKER NEWS top 5/.test(sent[0]) && !/🏢 GIANTS/.test(sent[0]),
    JSON.stringify(sent));

  await news.handle("openai");
  t("news openai filters the company",
    sent.length === 2 && /📰 OPENAI/.test(sent[1]) && /ships the big thing/.test(sent[1]) && !/HACKER NEWS/.test(sent[1]),
    JSON.stringify(sent[1] || ""));

  await news.handle("anthropic");
  t("news anthropic uses the HN fallback",
    sent.length === 3 && /📰 ANTHROPIC/.test(sent[2]) && /acquires Bun/.test(sent[2]),
    JSON.stringify(sent[2] || ""));

  await news.handle("nonsense");
  t("bad feed name -> usage hint", sent.length === 4 && /no feed for/.test(sent[3]), JSON.stringify(sent[3] || ""));

  /* ---- 4. the daily digest carries the newspaper ---- */
  const bridge = require("../bridge");
  const digests = [];
  const fakeWa = { send: async (x) => digests.push(String(x)), sendFile: async () => {} };
  const state = { online: true, sessions: [], active: {}, stats: null };
  await bridge.start({ whatsapp: fakeWa, getState: () => state, onEvent: () => {} });
  await bridge.handleIncoming("digest");
  const t0 = Date.now();
  let paper = "";
  while (Date.now() - t0 < 30000) {
    paper = digests.filter((d) => /DAILY DIGEST/.test(d)).join("\n");
    if (/📰 HACKER NEWS top 5/.test(paper)) break;
    await new Promise((r) => setTimeout(r, 200));
  }
  t("digest carries the newspaper", /📰 HACKER NEWS top 5/.test(paper), paper.slice(0, 500));
  t("digest still has the basics", /sessions:/.test(paper) && /📁 repos:/.test(paper), paper.slice(0, 500));

  /* ---- 5. A3: persisted headline page survives a cache wipe ---- */
  const realFetch = globalThis.fetch;
  news.start({ send: async (x) => sent.push(String(x)), log: () => {} }); // wipes the cache
  const b1 = news.brief();
  t("brief falls back to persisted news after cache wipe",
    /HN #1: T-five-hundred \(500\)/.test(b1 || ""), String(b1));
  t("persisted brief carries the giants line",
    /🏢 \d+ company headlines/.test(b1 || ""), String(b1));

  /* the `news` command warms the cache again — links then need NO network */
  await news.handle("hn");
  let fetchCalls = 0;
  globalThis.fetch = async () => { fetchCalls++; throw new Error("offline"); };
  const lk1 = await news.links();
  t("links use the warm cache without network", fetchCalls === 0 && lk1.length === 13,
    fetchCalls + " calls, " + lk1.length + " links");

  /* wipe the cache while offline -> links fall back to the persisted page */
  news.start({ send: async () => {}, log: () => {} });
  const lk2 = await news.links();
  t("links fall back to persisted page when offline",
    fetchCalls > 0 && lk2.length === 13 && lk2.some((x) => x.title === "T-five-hundred"),
    fetchCalls + " calls, " + lk2.length + " links: " + JSON.stringify(lk2.slice(0, 2)));

  /* an offline section must NOT clobber the persisted page with empties
     (the 06:18 boot-before-network case), and brief/links must treat an
     empty cache as "nothing here" -> persisted fallback again */
  const s3 = await news.section({ fresh: true });
  t("offline section returns no paper", s3 === null, String(s3));
  t("offline section keeps the persisted page",
    /HN #1: T-five-hundred \(500\)/.test(news.brief() || ""), String(news.brief()));
  const lk3 = await news.links();
  t("links survive an empty cached collect",
    lk3.length === 13 && lk3.some((x) => x.title === "T-five-hundred"), String(lk3.length));
  globalThis.fetch = realFetch;

  console.log(process.exitCode ? "FAILED" : "ALL PASS");
  restoreAll();
  process.exit(process.exitCode || 0);
})().catch((e) => { restoreAll(); console.error(e); process.exit(1); });
