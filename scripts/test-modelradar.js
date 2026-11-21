/* Free-model radar (Tony pack #1):
   - first run is a silent baseline (no "new" noise on a fresh state)
   - diff of the LOCAL free-tier list -> 🆕 line + ONE urgent push, once ever
   - HN scan keeps worthy titles only (Algolia ORs the query terms)
   - total failure -> no section at all (the digest never dies)
   modelradar-state.json is shared with the live app -> snapshotted,
   deleted for the baseline test, restored at the end. */
const fs = require("fs");
const path = require("path");

const STATE = path.join(__dirname, "..", "modelradar-state.json");
function snap(f) { try { return fs.readFileSync(f, "utf8"); } catch { return null; } }
const orig = snap(STATE);
function restore() {
  try {
    if (orig != null) fs.writeFileSync(STATE, orig);
    else if (fs.existsSync(STATE)) fs.unlinkSync(STATE);
  } catch {}
}
try { if (fs.existsSync(STATE)) fs.unlinkSync(STATE); } catch {}

/* ---- fakes ---- */
let MODELS = [
  { providerID: "opencode", modelID: "mimo-v2.6-flash-free", name: "MiMo-V2.6-Flash Free" },
  { providerID: "opencode", modelID: "deepseek-v4.1-flash-free", name: "DeepSeek V4.1 Flash Free" },
  { providerID: "opencode", modelID: "hy4-flash-free", name: "Hy4 flash Free" },
  { providerID: "openrouter", modelID: "some/big-model", name: "Not free" }, // must be ignored
];
let UP = true;
const HITS = [
  { title: "GLM-5.2 is the new leading open weights model", points: 916, url: "https://ex/glm", objectID: "1" },
  { title: "Google VR Blocks: A Free 3D Modeling Tool for Vive", points: 275, url: "https://ex/3d", objectID: "2" },
  { title: "Gemma 4 12B: encoder-free multimodal model", points: 1062, url: "https://ex/gemma", objectID: "3" },
];

globalThis.fetch = async (url, opts) => {
  const u = String(url);
  const ok = (j) => ({ ok: true, status: 200, json: async () => j, text: async () => JSON.stringify(j) });
  if (u.includes("/api/model")) {
    if (!UP) throw new Error("ECONNREFUSED 127.0.0.1:28894");
    if (!opts || !opts.headers || !opts.headers.Authorization) throw new Error("missing auth");
    return ok({ data: MODELS });
  }
  if (u.includes("hn.algolia.com")) {
    if (!UP) throw new Error("HTTP 503");
    return ok({ hits: HITS });
  }
  return ok({ ok: true, data: {} });
};

const radar = require("../modelradar");

function t(label, cond, extra) {
  console.log((cond ? "PASS " : "FAIL ") + label + (cond ? "" : "  << " + (extra || "")));
  if (!cond) process.exitCode = 1;
}

(async () => {
  const pushes = [];
  radar.start({ send: async (x) => pushes.push(String(x)), log: () => {} });

  /* ---- 1. first run = baseline, no "new" chatter ---- */
  const s1 = await radar.section({ fresh: true });
  t("baseline section", /baselined 3 local free models/.test(s1 || ""), s1);
  t("non-free model excluded", !/some\/big-model/.test(s1 || ""), s1);
  t("no push on baseline", pushes.length === 0, JSON.stringify(pushes));

  /* ---- 2. HN filter: worthy kept, 3D-modeler dropped ---- */
  t("worthy title kept", /GLM-5.2/.test(s1) && /Gemma 4/.test(s1), s1);
  t("3D-modeler filtered out", !/VR Blocks/.test(s1), s1);

  /* ---- 3. a NEW free model -> 🆕 line + exactly one push ---- */
  MODELS.push({ providerID: "opencode", modelID: "kimi-k3-free", name: "Kimi K3 Free" });
  const s2 = await radar.section({ fresh: true });
  t("new model listed", /🆕 opencode\/kimi-k3-free — Kimi K3 Free/.test(s2 || ""), s2);
  t("count updated", /local free tiers: 4/.test(s2 || ""), s2);
  t("urgent push fired once", pushes.length === 1 && /RADAR: new free model/.test(pushes[0]), JSON.stringify(pushes));

  /* ---- 4. steady state: no churn, no second push ---- */
  const s3 = await radar.section({ fresh: true });
  t("no change on re-run", /local free tiers: 4 \(no change\)/.test(s3 || ""), s3);
  t("still only one push", pushes.length === 1, JSON.stringify(pushes));

  /* ---- 5. total failure -> no section (digest stays alive) ---- */
  UP = false;
  HITS.length = 0;
  const s4 = await radar.section({ fresh: true });
  t("total failure omits section", s4 === null, JSON.stringify(s4));

  console.log(process.exitCode ? "FAILED" : "ALL PASS");
  restore();
  process.exit(process.exitCode || 0);
})().catch((e) => { restore(); console.error(e); process.exit(1); });
