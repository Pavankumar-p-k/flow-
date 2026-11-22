/* A2 hardening: atomic state writes + corrupt-state tolerance.
   - writeAtomic: creates, overwrites, and never leaves a .tmp behind
   - readTail: whole small file; last-N-bytes slice with the partial first
     line dropped (the A5 audit-tail reader)
   - every state file truncated mid-JSON -> the app still boots: start(),
     pumpDigest() and the brief/digest commands run without throwing, and
     the next save rewrites a VALID JSON file with no .tmp beside it
   All state files are snapshotted and restored. */
const fs = require("fs");
const path = require("path");
const os = require("os");
const { writeAtomic, readTail } = require("../fsutil");

const FILES = ["config.json", "digest-state.json", "queue-pending.json",
  "reminders.json", "dnd.json", "news-state.json", "modelradar-state.json",
  "modelprobe-state.json", "ghwatch-state.json"];
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

function t(label, cond, extra) {
  console.log((cond ? "PASS " : "FAIL ") + label + (cond ? "" : "  << " + (extra || "")));
  if (!cond) process.exitCode = 1;
}

/* ---- fakes: never touch the real network or the real WhatsApp ---- */
globalThis.fetch = async () => {
  const hdrs = { get: () => null };
  return { ok: false, status: 500, headers: hdrs, json: async () => ({ error: "test" }), text: async () => "" };
};

(async () => {
  /* ---- 1. writeAtomic ---- */
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "fsutil-"));
  const f = path.join(tmpDir, "a.json");
  writeAtomic(f, '{"a":1}');
  t("writeAtomic creates", fs.readFileSync(f, "utf8") === '{"a":1}');
  t("writeAtomic leaves no tmp", !fs.existsSync(f + ".tmp"));
  writeAtomic(f, '{"a":2}');
  t("writeAtomic overwrites", fs.readFileSync(f, "utf8") === '{"a":2}' && !fs.existsSync(f + ".tmp"));

  /* ---- 2. readTail ---- */
  const big = path.join(tmpDir, "big.log");
  const lines = [];
  for (let i = 0; i < 1000; i++) lines.push("line-" + i);
  fs.writeFileSync(big, lines.join("\n") + "\n");
  t("readTail small file = whole", readTail(big, 10 * 1024 * 1024).includes("line-0"));
  const tail = readTail(big, 500); // slice starts mid-line
  t("readTail returns the tail", (tail || "").includes("line-999"), JSON.stringify((tail || "").slice(0, 60)));
  t("readTail drops the partial first line", /^line-\d+\n/.test(tail || ""), JSON.stringify((tail || "").slice(0, 60)));
  t("readTail missing file -> null", readTail(path.join(tmpDir, "nope.log"), 100) === null);

  /* ---- 3. truncate every state file mid-JSON ---- */
  const TRUNC = '{"day":"Sun Nov 22 2026","hour":1'; // cut off on purpose
  for (const fl of FILES) {
    const p = path.join(__dirname, "..", fl);
    if (fl === "config.json") {
      // config must stay a VALID object (it is user data), just without a
      // digest schedule so the boot pump cannot fire during the test
      try {
        const c = JSON.parse(fs.readFileSync(p, "utf8") || "{}") || {};
        c.digest = { mode: "at", hour: 24 }; // hour 24 never matches -> quiet
        fs.writeFileSync(p, JSON.stringify(c, null, 2));
      } catch { fs.writeFileSync(p, JSON.stringify({ digest: { mode: "at", hour: 24 } })); }
    } else {
      fs.writeFileSync(p, TRUNC);
    }
  }

  /* ---- 4. boot against the corrupt state: nothing may throw ---- */
  const bridge = require("../bridge");
  const news = require("../news");
  const sent = [];
  const fakeWa = { send: async (m) => { sent.push(String(m)); }, sendFile: async () => {} };
  let bootOk = true, bootErr = "";
  try {
    await bridge.start({
      whatsapp: fakeWa,
      getState: () => ({ online: true, sessions: [], active: {}, stats: {} }),
      onEvent: () => {},
      openUrl: () => {},
    });
  } catch (e) { bootOk = false; bootErr = e.message; }
  t("start survives corrupt state files", bootOk, bootErr);
  bridge.stop();

  /* pump with a time that can never send (mode at hour 24) */
  let pumpOk = true, pumpErr = "";
  try { bridge.pumpDigest(new Date(2000, 0, 1, 4, 0)); await new Promise((r) => setTimeout(r, 300)); }
  catch (e) { pumpOk = false; pumpErr = e.message; }
  t("pumpDigest survives corrupt digest-state", pumpOk, pumpErr);
  t("quiet when the schedule cannot match", sent.length === 0, JSON.stringify(sent));

  /* brief: every module loader fell back to defaults -> lines omitted, no throw */
  let briefOk = true, briefErr = "";
  try {
    await bridge.handleIncoming("brief");
    const end = Date.now() + 15000;
    while (Date.now() < end && !sent.some((s) => s.includes("DAILY BRIEF"))) {
      await new Promise((r) => setTimeout(r, 150));
    }
  } catch (e) { briefOk = false; briefErr = e.message; }
  t("brief survives corrupt state", briefOk && sent.some((s) => s.includes("DAILY BRIEF")), briefErr + " " + JSON.stringify(sent));
  t("corrupt modules omit their lines instead of crashing",
    !sent.some((s) => /radar:|chain:|ghwatch:/.test(s)), JSON.stringify(sent));

  /* news.start loaded the truncated file -> defaults, brief() is null not a throw */
  let newsOk = true, newsErr = "";
  try { if (typeof news.brief() !== "string" && news.brief() !== null) throw new Error("bad type"); }
  catch (e) { newsOk = false; newsErr = e.message; }
  t("news.brief survives corrupt news-state", newsOk, newsErr);

  /* ---- 5. a real save rewrites VALID json, no .tmp ---- */
  await bridge.handleIncoming("digest auto"); // clears schedule -> saveDigestState()
  await new Promise((r) => setTimeout(r, 500));
  let savedOk = false, savedRaw = "";
  try {
    savedRaw = fs.readFileSync(path.join(__dirname, "..", "digest-state.json"), "utf8");
    const ds = JSON.parse(savedRaw);
    savedOk = ds && typeof ds === "object";
  } catch (e) { savedOk = false; savedRaw = e.message; }
  t("digest auto rewrites valid digest-state", savedOk, savedRaw);
  t("no .tmp left in the app dir",
    !fs.readdirSync(path.join(__dirname, "..")).some((n) => n.endsWith(".json.tmp")),
    fs.readdirSync(path.join(__dirname, "..")).filter((n) => n.endsWith(".tmp")).join(","));

  bridge.stop();
  restoreAll();
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  console.log(process.exitCode ? "TEST FAILED" : "ALL PASS");
  process.exit(process.exitCode || 0);
})().catch((e) => { restoreAll(); console.error("ERR", e); process.exit(1); });
