/* Daily self-audit (Tony pack #3):
   - audit() classifies: error tokens -> grouped findings with known fixes,
     self-healing messages (session recreating) and plain diagnostics stay
     benign — including POLL lines that carry err= (those ARE findings)
   - unknown signatures get fix=null -> "needs review" in the paper
   - section() reads the real debug.log and never throws
   - A5: bounded tail read — only the last 2MB of a >2MB log is audited
     (an error older than the tail is not reported; the tail's own recent
     error is), so an audit can never scan an unbounded file
   audit() is pure, so no shared files are touched. */
const fs = require("fs");
const path = require("path");
const os = require("os");

const selfaudit = require("../selfaudit");

function t(label, cond, extra) {
  console.log((cond ? "PASS " : "FAIL ") + label + (cond ? "" : "  << " + (extra || "")));
  if (!cond) process.exitCode = 1;
}

(async () => {
  const lines = [
    // plain diagnostics — no error token anywhere
    "2026-11-20T10:00:00.000Z POLL online=true sessions=3 stats=true",
    "2026-11-20T10:00:01.000Z KEY code=KeyM key=m mod=C A--",
    "2026-11-20T10:00:02.000Z CONSOLE[1] PILL size 240x28 (was 193x28)",
    "2026-11-20T10:00:03.000Z NOTCH MODE shrunk",
    // self-healing: contains 404 but WE fixed it on the spot
    "2026-11-20T10:00:04.000Z ASSIST session ses_abc123 gone (HTTP 404 Not Found) — recreating",
    // real finding, repeated 3x (different ids -> same signature)
    "2026-11-20T10:01:00.000Z INTRO click-watch spawn error: spawn powershell ENOSPC os error 5",
    "2026-11-20T10:01:10.000Z INTRO click-watch spawn error: spawn powershell ENOSPC os error 5",
    "2026-11-20T10:01:20.000Z INTRO click-watch spawn error: spawn powershell ENOSPC os error 5",
    // real finding with a known fix
    "2026-11-20T10:02:00.000Z LOAD_FAIL -3 File not found",
    // real finding, NO known fix -> proposal
    "2026-11-20T10:03:00.000Z WEIRD subsystem failed spectacularly on run 7",
    // offline poll: err= makes it a finding (the inversion must hold)
    "2026-11-20T10:04:00.000Z POLL online=false sessions=0 err=ECONNREFUSED",
  ];

  const a = selfaudit.audit(lines);
  t("four distinct findings", a.errors.length === 4, JSON.stringify(a.errors, null, 1));

  const spawn = a.errors.find((g) => /spawn error/.test(g.label));
  t("repeats grouped (3x)", spawn && spawn.n === 3, JSON.stringify(a.errors));
  t("os error 5 has a known fix", spawn && /auto-retry already wired/.test(spawn.fix), spawn && spawn.fix);

  const load = a.errors.find((g) => /LOAD_FAIL/.test(g.label));
  t("LOAD_FAIL recognized", !!load, JSON.stringify(a.errors));
  t("LOAD_FAIL fix mapped", load && /watching for a pattern/.test(load.fix), load && load.fix);

  const weird = a.errors.find((g) => /WEIRD/.test(g.label));
  t("unknown signature flagged for review", weird && weird.fix === null, JSON.stringify(weird));
  t("findings sorted by count", a.errors[0].n >= a.errors[a.errors.length - 1].n, JSON.stringify(a.errors));

  t("self-healed 404 stays benign", a.benign === 5, String(a.benign));
  t("POLL with err= is a finding, not benign",
    a.errors.some((g) => /ECONNREFUSED/.test(g.sample)) &&
    !a.errors.some((g) => /POLL online=true/.test(g.sample)),
    JSON.stringify(a.errors));

  /* section() against the real debug.log — shape only */
  const s = await selfaudit.section({ fresh: true });
  if (fs.existsSync(selfaudit.LOG_FILE)) {
    t("section built from real log", /^🔧 SELF-AUDIT \(24h\)\n/.test(s || ""), s);
    t("section has findings or clean line",
      /clean — no errors|⚠ \d+×/.test(s || ""), s);
  } else {
    t("no log -> no section", s === null, JSON.stringify(s));
  }

  /* ---- A5: bounded tail — only the last 2MB of a >2MB log is audited ---- */
  const tmpLog = path.join(os.tmpdir(), "audit-tail-test.log");
  try {
    const hourAgo = new Date(Date.now() - 3600 * 1000).toISOString(); // inside 24h
    const head =
      hourAgo + " INTRO early spawn error: spawn notepad ENOSPC os error 5\n" + // recent, but >2MB from the end
      hourAgo + " POLL online=true sessions=3 stats=true\n";
    const filler = ("FILLER filler filler filler filler filler filler filler\n").repeat(39000); // ~2.2MB, no error tokens
    const tailLines =
      hourAgo + " LOAD_FAIL -3 File not found\n" + // recent AND inside the tail
      hourAgo + " POLL online=true sessions=1 stats=true\n";
    fs.writeFileSync(tmpLog, head + filler + tailLines);
    t("test log is bigger than the 2MB tail", fs.statSync(tmpLog).size > 2 * 1024 * 1024,
      String(fs.statSync(tmpLog).size));

    selfaudit._setLog(tmpLog);
    const s2 = await selfaudit.section({ fresh: true });
    t("tail section built", /^🔧 SELF-AUDIT \(24h\)\n/.test(s2 || ""), String(s2).slice(0, 200));
    t("recent error inside the tail is reported", /LOAD_FAIL/.test(s2 || ""), s2);
    t("recent error older than the tail is out of scope", !/spawn error/.test(s2 || ""), s2);
    const b2 = selfaudit.brief();
    t("brief audits the same tail", /LOAD_FAIL/.test(b2 || "") && !/spawn error/.test(b2 || ""), b2);
    const missing = path.join(os.tmpdir(), "audit-tail-missing.log");
    selfaudit._setLog(missing);
    t("missing log -> no section", await selfaudit.section({ fresh: true }) === null);
    t("missing log -> no brief line", selfaudit.brief() === null);
  } finally {
    selfaudit._setLog(null); // back to the real debug.log
    try { fs.unlinkSync(tmpLog); } catch {}
  }

  console.log(process.exitCode ? "FAILED" : "ALL PASS");
  process.exit(process.exitCode || 0);
})().catch((e) => { console.error(e); process.exit(1); });
