/* Run a PowerShell script and resolve its trimmed stdout.
   Retries once on spawn failure (this PC intermittently returns os error 5)
   and gives up with "" on timeout so a hung script never blocks the bridge. */
const { spawn } = require("child_process");

function runPs(script, args = [], opts = {}) {
  const timeoutMs = opts.timeoutMs || 15000;
  const tries = opts.tries || 2;
  return new Promise((resolve) => {
    const attempt = (n) => {
      let c;
      try {
        c = spawn("powershell.exe",
          ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script, ...args],
          { windowsHide: true });
      } catch (e) {
        if (n > 1) return setTimeout(() => attempt(n - 1), 800);
        return resolve("");
      }
      let out = "";
      let dead = false;
      const timer = setTimeout(() => {
        if (dead) return;
        dead = true;
        try { c.kill(); } catch {}
        resolve("");
      }, timeoutMs);
      c.stdout.on("data", (d) => { out += d; });
      c.on("error", () => {
        if (dead) return;
        dead = true;
        clearTimeout(timer);
        if (n > 1) setTimeout(() => attempt(n - 1), 800);
        else resolve("");
      });
      c.on("close", () => {
        if (dead) return;
        dead = true;
        clearTimeout(timer);
        resolve(out.trim());
      });
    };
    attempt(tries);
  });
}

module.exports = { runPs };
