/* GitHub watcher (#feature 2): polls ONE repo every 5 minutes for
   - newly opened issues
   - newly opened pull requests
   - CI workflow runs that just finished (failures always, greens only as
     recovery after a failure)
   Each finding = one WhatsApp line + a notch flash (onEvent type "gh").
   State lives in ghwatch-state.json, so a restart never re-announces old
   items (the first poll after (re)configuring is a silent baseline).

   3 requests per tick x 12 ticks/h = 36/h — under GitHub's unauthenticated
   60/h limit; GITHUB_TOKEN/GH_TOKEN in the env raises it to 5000/h. */
const fs = require("fs");
const path = require("path");

const STATE_FILE = path.join(__dirname, "ghwatch-state.json");
const INTERVAL_MS = 5 * 60 * 1000;

let sendFn = null;    // async (text) => void  (WhatsApp outbox)
let onEventFn = null; // (e) => void           (renderer notch flash)
let logFn = () => {};
let timer = null;
let state = null;     // { repo, issues:{n:title}, prs:{n:title}, lastRunId, lastRunFail }

function load() {
  try {
    const s = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
    return s && typeof s === "object" ? s : null;
  } catch { return null; }
}
function save() {
  try { fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2)); }
  catch (e) { logFn("ghwatch save err " + e.message); }
}

async function api(p) {
  const h = { "User-Agent": "agent-notch", "Accept": "application/vnd.github+json" };
  const tok = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  if (tok) h.Authorization = "Bearer " + tok;
  const r = await fetch("https://api.github.com" + p, { headers: h });
  if (!r.ok) throw new Error("HTTP " + r.status);
  return r.json();
}

function flash() {
  try { if (onEventFn) onEventFn({ type: "gh" }); } catch {}
}
async function announce(lines) {
  for (const l of lines) {
    try { if (sendFn) await sendFn(l); } catch (e) { logFn("ghwatch send err " + e.message); }
  }
  if (lines.length) flash();
}

/* One poll. Returns the number of announcements (0 = quiet). */
async function tick() {
  if (!state || !state.repo) return 0;
  const base = "/repos/" + state.repo;
  const [issues, prs, runs] = await Promise.all([
    api(base + "/issues?state=open&per_page=100&sort=created&direction=desc"),
    api(base + "/pulls?state=open&per_page=100&sort=created&direction=desc"),
    api(base + "/actions/runs?per_page=10").catch(() => null), // no Actions on repo
  ]);

  const out = [];
  const prevIssues = state.issues || {};
  const prevPrs = state.prs || {};

  // issues: /issues includes PRs -> drop anything with pull_request
  const issueMap = {};
  for (const i of issues) {
    if (i.pull_request) continue;
    issueMap[i.number] = i.title;
    if (!(i.number in prevIssues)) {
      out.push("🐙 " + state.repo + " new issue #" + i.number + " · " + i.title +
        "\nby " + (i.user && i.user.login || "?") + " · " + i.html_url);
    }
  }

  const prMap = {};
  for (const p of prs) {
    prMap[p.number] = p.title;
    if (!(p.number in prevPrs)) {
      out.push("🔀 " + state.repo + " new PR #" + p.number + " · " + p.title +
        " (" + ((p.head && p.head.ref) || "?") + " → " + ((p.base && p.base.ref) || "?") + ")" +
        "\n" + p.html_url);
    }
  }

  // CI: only a run NEWER than the last one we evaluated, and only once its
  // conclusion is final (null = still running).
  const runsList = (runs && (runs.workflow_runs || runs.value)) || [];
  const fresh = runsList
    .filter((r) => r.id > (state.lastRunId || 0) && r.conclusion)
    .sort((a, b) => a.id - b.id);
  let fail = !!state.lastRunFail;
  for (const r of fresh) {
    const bad = ["failure", "timed_out", "cancelled", "action_required"].includes(r.conclusion);
    const name = r.name || r.display_title || "run";
    const branch = (r.head_branch ? " (" + r.head_branch + ")" : "");
    if (bad) {
      out.push("❌ " + state.repo + " CI FAILED · " + name + branch + "\n" + r.html_url);
      fail = true;
    } else if (fail && r.conclusion === "success") {
      out.push("✅ " + state.repo + " CI green again · " + name + branch + "\n" + r.html_url);
      fail = false;
    } else if (r.conclusion === "success") {
      fail = false;
    }
    state.lastRunId = r.id;
    state.lastRunFail = fail;
  }

  state.issues = issueMap;
  state.prs = prMap;
  save();
  if (out.length) logFn("ghwatch " + out.length + " announcement(s) for " + state.repo);
  await announce(out);
  return out.length;
}

async function baseline() {
  const base = "/repos/" + state.repo;
  const [issues, prs, runs] = await Promise.all([
    api(base + "/issues?state=open&per_page=100&sort=created&direction=desc"),
    api(base + "/pulls?state=open&per_page=100&sort=created&direction=desc"),
    api(base + "/actions/runs?per_page=10").catch(() => null),
  ]);
  const im = {}, pm = {};
  for (const i of issues) if (!i.pull_request) im[i.number] = i.title;
  for (const p of prs) pm[p.number] = p.title;
  const runsList = (runs && (runs.workflow_runs || runs.value)) || [];
  const latest = runsList.filter((r) => r.conclusion).sort((a, b) => b.id - a.id)[0];
  state.issues = im;
  state.prs = pm;
  state.lastRunId = latest ? latest.id : 0;
  state.lastRunFail = latest ? ["failure", "timed_out", "cancelled", "action_required"].includes(latest.conclusion) : false;
  save();
  return { issues: Object.keys(im).length, prs: Object.keys(pm).length,
    ci: latest ? (latest.conclusion + " · " + (latest.name || "")) : "—" };
}

function startTimer() {
  stopTimer();
  timer = setInterval(() => { tick().catch((e) => logFn("ghwatch tick err " + e.message)); }, INTERVAL_MS);
}
function stopTimer() { if (timer) { clearInterval(timer); timer = null; } }

/* Chat command: "ghwatch" | "ghwatch off" | "ghwatch owner/repo" */
async function handle(arg) {
  const a = String(arg || "").trim();
  if (!state) state = load() || {};

  if (!a) {
    if (!state.repo) {
      return sendFn("👀 GH WATCH: off\nghwatch <owner>/<repo> — watch issues/PRs/CI");
    }
    const s = state;
    return sendFn("👀 GH WATCH: " + s.repo +
      "\npoll every 5 min · issues open: " + Object.keys(s.issues || {}).length +
      " · PRs open: " + Object.keys(s.prs || {}).length +
      " · last CI: " + (s.lastRunId ? (s.lastRunFail ? "FAILED" : "ok") : "—") +
      "\nghwatch off · ghwatch <owner>/<repo>");
  }

  if (/^(off|stop|none|disable)$/i.test(a)) {
    stopTimer();
    const was = state.repo;
    state.repo = null;
    save();
    return sendFn(was ? "👋 stopped watching " + was : "👀 GH WATCH was already off");
  }

  const rm = a.match(/^([\w.-]+)\/([\w.-]+)$/);
  if (!rm) {
    return sendFn("⚠️ usage: ghwatch <owner>/<repo> · ghwatch · ghwatch off");
  }

  const repo = rm[1] + "/" + rm[2];
  await sendFn("👀 watching " + repo + " — baselining…");
  state = { repo, issues: {}, prs: {}, lastRunId: 0, lastRunFail: false };
  try {
    const b = await baseline();
    startTimer();
    logFn("ghwatch watching " + repo + " issues=" + b.issues + " prs=" + b.prs);
    return sendFn("✅ now watching " + repo +
      "\nopen: " + b.issues + " issues · " + b.prs + " PRs · CI: " + b.ci +
      "\nnew issues/PRs and CI failures will land here (every 5 min)");
  } catch (e) {
    state.repo = null;
    save();
    return sendFn("⚠️ GitHub error for " + repo + ": " + e.message);
  }
}

function start(deps) {
  sendFn = deps.send || null;
  onEventFn = deps.onEvent || null;
  logFn = deps.log || (() => {});
  state = load();
  if (state && state.repo) { startTimer(); logFn("ghwatch resumed " + state.repo); }
}
function stop() { stopTimer(); }

module.exports = { start, stop, handle, tick, _state: () => state };
