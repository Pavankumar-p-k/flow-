/* Full-screen auto-dim (#fs): the PS classifier self-test plus a live run of
   fullscreen-watch.ps1 proving it emits valid JSON state lines. */
const { spawn, spawnSync } = require("child_process");
const path = require("path");

const SCRIPT = path.join(__dirname, "..", "scripts", "fullscreen-watch.ps1");
const PS = ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", SCRIPT];

let pass = 0, fail = 0;
function t(name, cond, extra) {
  console.log((cond ? "PASS " : "FAIL ") + name + (cond ? "" : "  << " + (extra || "")));
  if (cond) pass++; else fail++;
}

function selfTest() {
  return new Promise((resolve) => {
    const r = spawnSync("powershell.exe", [...PS, "-SelfTest"], { encoding: "utf8", windowsHide: true, timeout: 60000 });
    const out = (r.stdout || "") + (r.stderr || "");
    t("selftest exit 0", r.status === 0, "status=" + r.status + " out=" + out.slice(0, 400));
    t("selftest ran 5 cases", (out.match(/SELFTEST PASS/g) || []).length === 5, out.replace(/\r/g, ""));
    t("selftest no failures", !/SELFTEST FAIL/.test(out), out.slice(0, 400));
    resolve();
  });
}

function liveRun() {
  return new Promise((resolve) => {
    const child = spawn("powershell.exe", PS, { windowsHide: true, stdio: ["ignore", "pipe", "ignore"] });
    let buf = "";
    let done = false;
    const finish = () => { if (done) return; done = true; try { child.kill(); } catch {} resolve(); };
    const timer = setTimeout(finish, 15000);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (d) => {
      buf += d;
      const nl = buf.indexOf("\n");
      if (nl < 0) return;
      const line = buf.slice(0, nl).trim();
      clearTimeout(timer);
      let j = null;
      try { j = JSON.parse(line); } catch {}
      t("live line is JSON", !!j, line);
      if (j) {
        t("live line has boolean on", typeof j.on === "boolean", line);
        t("live line has string app", typeof j.app === "string", line);
      }
      finish();
    });
    child.on("error", (e) => { clearTimeout(timer); t("watcher spawns", false, e.message); finish(); });
  });
}

(async () => {
  console.log("fullscreen:");
  await selfTest();
  await liveRun();
  console.log("\n" + pass + " passed, " + fail + " failed");
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
