/* GitHub watcher (#feature 2):
   - ghwatch <owner/repo> baselines silently (no announcements of old items)
   - a new issue / new PR / failed CI run -> one WhatsApp line each + one
     notch flash event (type "gh"); a quiet tick announces nothing
   - CI recovery (fail -> success) announces "green again"
   - ghwatch (status) and ghwatch off work; off stops the polling
   - natural-language "watch my github" must go to the ASSISTANT (command
     is slash/keyword-only like screenshots)
   globalThis.fetch is patched: GitHub URLs serve a fake repo, OpenCode
   message polls return an idle marker so any turn drains. queue-pending.json
   and ghwatch-state.json are snapshotted/restored (both live-app state). */
const fs = require("fs");
const path = require("path");

const PENDING = path.join(__dirname, "..", "queue-pending.json");
const GHSTATE = path.join(__dirname, "..", "ghwatch-state.json");
function snap(f) { try { return fs.readFileSync(f, "utf8"); } catch { return null; } }
const origPending = snap(PENDING);
const origGh = snap(GHSTATE);
function restoreAll() {
  try {
    if (origPending != null) fs.writeFileSync(PENDING, origPending);
    else if (fs.existsSync(PENDING)) fs.unlinkSync(PENDING);
    if (origGh != null) fs.writeFileSync(GHSTATE, origGh);
    else if (fs.existsSync(GHSTATE)) fs.unlinkSync(GHSTATE);
  } catch {}
}
// start from a clean watcher state so bridge.start can't resume a live poll
try { if (fs.existsSync(GHSTATE)) fs.unlinkSync(GHSTATE); } catch {}

/* ---- fake GitHub ---- */
const gh = { issues: [], prs: [], runs: [] };
const issue = (n, title) => ({ number: n, title, user: { login: "alice" }, html_url: "https://github.com/o/r/issues/" + n });
const pr = (n, title) => ({ number: n, title, head: { ref: "feat-x" }, base: { ref: "main" }, html_url: "https://github.com/o/r/pull/" + n });
const run = (id, name, conclusion) => ({ id, name, conclusion, head_branch: "main", html_url: "https://github.com/o/r/actions/runs/" + id });

const calls = [];
globalThis.fetch = async (url, opts) => {
  const u = String(url);
  calls.push({ url: u, method: opts && opts.method, body: opts && opts.body ? JSON.parse(opts.body) : null });
  const base = { ok: true, status: 200, headers: { get: () => "application/json" }, text: async () => "{}" };
  if (/api\.github\.com/.test(u)) {
    let data = {};
    if (/\/actions\/runs/.test(u)) data = { workflow_runs: gh.runs };
    else if (/\/pulls\?/.test(u)) data = gh.prs;
    else if (/\/issues\?/.test(u)) data = gh.issues;
    return { ...base, json: async () => data };
  }
  if (/\/message\?/.test(u)) {
    return { ...base, json: async () => ({ ok: true, data: [{ type: "idle", time: { created: Date.now() }, outcome: "success" }] }) };
  }
  return { ...base, json: async () => ({ ok: true, data: { time: { created: Date.now() } } }) };
};

const bridge = require("../bridge");
const ghwatch = require("../ghwatch");

function t(label, cond, extra) {
  console.log((cond ? "PASS " : "FAIL ") + label + (cond ? "" : "  << " + (extra || "")));
  if (!cond) process.exitCode = 1;
}

const sent = [];
const flashes = [];
const fakeWa = { send: async (text) => { sent.push(String(text)); }, sendFile: async () => {} };
const state = { online: true, sessions: [], active: {}, stats: null };
const prompts = () => calls.filter((c) => c.method === "POST" && /\/prompt$/.test(c.url));
async function waitFor(fn, ms = 5000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (fn()) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return fn();
}

(async () => {
  await bridge.start({
    whatsapp: fakeWa, getState: () => state,
    onEvent: (e) => { if (e && e.type === "gh") flashes.push(e); },
  });

  /* ---- 1. baseline is silent ---- */
  gh.issues = [issue(1, "old bug"), issue(2, "another old one")];
  gh.prs = [pr(3, "old pr")];
  gh.runs = [run(100, "ci", "success")];
  await bridge.handleIncoming("ghwatch o/r");
  t("baseline ack sent", await waitFor(() => sent.some((s) => /now watching o\/r/.test(s))), JSON.stringify(sent));
  t("baseline did not announce old items", !sent.some((s) => /new issue #|new PR #|CI FAILED|green again/.test(s)), JSON.stringify(sent));
  t("baseline counted issues+prs", /2 issues · 1 PRs/.test(sent.join("\n")), JSON.stringify(sent));

  /* ---- 2. new issue + new PR + failed CI -> 3 lines + flash ---- */
  gh.issues = [issue(4, "fresh bug"), ...gh.issues];
  gh.prs = [pr(5, "fresh pr"), ...gh.prs];
  gh.runs = [run(101, "build", "failure"), ...gh.runs];
  const n = await ghwatch.tick();
  t("tick announced 3 findings", n === 3, "n=" + n);
  t("new issue line", sent.some((s) => /new issue #4 · fresh bug/.test(s)), JSON.stringify(sent));
  t("new PR line", sent.some((s) => /new PR #5 · fresh pr \(feat-x → main\)/.test(s)), JSON.stringify(sent));
  t("CI failure line", sent.some((s) => /CI FAILED · build \(main\)/.test(s)), JSON.stringify(sent));
  t("notch flashed", flashes.length >= 1, "flashes=" + flashes.length);

  /* ---- 3. quiet tick announces nothing ---- */
  const before = sent.length;
  const n2 = await ghwatch.tick();
  t("quiet tick is silent", n2 === 0 && sent.length === before, "n=" + n2 + " sent=" + (sent.length - before));

  /* ---- 4. CI recovery announces green ---- */
  gh.runs = [run(102, "build", "success"), ...gh.runs];
  const n3 = await ghwatch.tick();
  t("recovery announced", n3 === 1 && sent.some((s) => /CI green again · build/.test(s)), JSON.stringify(sent.slice(before)));

  /* ---- 5. status + off ---- */
  await bridge.handleIncoming("ghwatch");
  t("status shows the repo", await waitFor(() => sent.some((s) => /GH WATCH: o\/r/.test(s))), JSON.stringify(sent.slice(-3)));
  await bridge.handleIncoming("ghwatch off");
  t("off confirms", await waitFor(() => sent.some((s) => /stopped watching o\/r/.test(s))), JSON.stringify(sent.slice(-3)));
  t("state cleared", (ghwatch._state() || {}).repo === null, JSON.stringify(ghwatch._state()));
  const n4 = await ghwatch.tick();
  t("tick after off is a no-op", n4 === 0, "n=" + n4);

  /* ---- 6. bad repo format -> usage ---- */
  await bridge.handleIncoming("ghwatch nonsense");
  t("bad repo gets usage", await waitFor(() => sent.some((s) => /usage: ghwatch <owner>\/<repo>/.test(s))), JSON.stringify(sent.slice(-3)));

  /* ---- 7. natural language -> assistant (command stays keyword-only) ---- */
  const pBefore = prompts().length;
  await bridge.handleIncoming("watch my github repo for new issues");
  t("natural phrasing reaches the assistant", await waitFor(() => prompts().length > pBefore),
    "prompts " + pBefore + " -> " + prompts().length);

  console.log(process.exitCode ? "FAILED" : "ALL PASS");
  restoreAll();
  process.exit(process.exitCode || 0);
})().catch((e) => { restoreAll(); console.error(e); process.exit(1); });
