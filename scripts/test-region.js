/* Region screenshot + OCR (#feature 1):
   - scripts/crop.ps1 crops a generated PNG to a rectangle (size checked)
   - scripts/ocr.ps1 reads text off it via Windows.Media.Ocr (text checked)
   - bridge routing: /screenshot region -> region hook mode "shot" (PNG sent),
     /ocr -> mode "ocr" (text sent), /ocr full -> mode "ocrfull",
     none of them may reach the assistant (no prompt POSTs).
   globalThis.fetch is patched so any stray assistant turn goes idle at once;
   queue-pending.json is snapshotted/restored (shared with the live app). */
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");

// queue-pending.json is shared with the running app — snapshotted and
// restored here so the live queue is never disturbed.
const PENDING = path.join(__dirname, "..", "queue-pending.json");
let original = null, had = false;
try { original = fs.readFileSync(PENDING, "utf8"); had = true; } catch {}
function restorePending() {
  try {
    if (had) fs.writeFileSync(PENDING, original);
    else if (fs.existsSync(PENDING)) fs.unlinkSync(PENDING);
  } catch {}
}

const calls = [];
globalThis.fetch = async (url, opts) => {
  const u = String(url);
  calls.push({ url: u, method: opts && opts.method, body: opts && opts.body ? JSON.parse(opts.body) : null });
  const base = {
    ok: true, status: 200,
    headers: { get: () => "application/json" },
    text: async () => "{}",
  };
  if (/\/message\?/.test(u)) {
    return { ...base, json: async () => ({ ok: true, data: [{ type: "idle", time: { created: Date.now() }, outcome: "success" }] }) };
  }
  return { ...base, json: async () => ({ ok: true, data: { time: { created: Date.now() } } }) };
};

const bridge = require("../bridge");

function t(label, cond, extra) {
  console.log((cond ? "PASS " : "FAIL ") + label + (cond ? "" : "  << " + (extra || "")));
  if (!cond) process.exitCode = 1;
}

const sent = [];
const filesSent = [];
const fakeWa = {
  send: async (text) => { sent.push(String(text)); },
  sendFile: async (f) => { filesSent.push(String(f)); },
};
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

/* ---- PS helpers (spawn error 5 on this PC -> retry) ---- */
function runPs(script, args, timeoutMs = 60000) {
  return new Promise((resolve) => {
    let tries = 0;
    const go = () => {
      tries++;
      let out = "", err = "";
      let c;
      try {
        c = spawn("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script, ...args],
          { windowsHide: true });
      } catch (e) {
        if (tries < 3) return setTimeout(go, 800);
        return resolve({ code: -1, out: "", err: e.message });
      }
      const killer = setTimeout(() => { try { c.kill(); } catch {} }, timeoutMs);
      c.stdout.on("data", (d) => { out += d; });
      c.stderr.on("data", (d) => { err += d; });
      c.on("error", (e) => {
        clearTimeout(killer);
        if (tries < 3) setTimeout(go, 800);
        else resolve({ code: -1, out, err: e.message });
      });
      c.on("close", (code) => {
        clearTimeout(killer);
        if (code !== 0 && tries < 3 && /Access is denied|os error/i.test(err)) return setTimeout(go, 800);
        resolve({ code, out: out.trim(), err: err.trim() });
      });
    };
    go();
  });
}
/* run a one-liner: spawn powershell -Command (same retry-on-error-5) */
function runPsInline(script) {
  return new Promise((resolve) => {
    let tries = 0;
    const go = () => {
      tries++;
      let out = "", err = "";
      let c;
      try {
        c = spawn("powershell.exe", ["-NoProfile", "-Command", script], { windowsHide: true });
      } catch (e) { if (tries < 3) return setTimeout(go, 800); return resolve({ code: -1, out: "", err: e.message }); }
      const killer = setTimeout(() => { try { c.kill(); } catch {} }, 30000);
      c.stdout.on("data", (d) => { out += d; });
      c.stderr.on("data", (d) => { err += d; });
      c.on("error", (e) => { clearTimeout(killer); if (tries < 3) setTimeout(go, 800); else resolve({ code: -1, out, err: e.message }); });
      c.on("close", (code) => { clearTimeout(killer); if (code !== 0 && tries < 3) return setTimeout(go, 800); resolve({ code, out: out.trim(), err: err.trim() }); });
    };
    go();
  });
}

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "notch-region-"));
const TEXT_PNG = path.join(TMP, "text.png");
const CROP_PNG = path.join(TMP, "crop.png");

(async () => {
  /* ---- 1. crop.ps1 ---- */
  const genR = await new Promise((resolve) => {
    const script = [
      "Add-Type -AssemblyName System.Drawing",
      "$b = New-Object System.Drawing.Bitmap 600, 120",
      "$g = [System.Drawing.Graphics]::FromImage($b)",
      "$g.Clear([System.Drawing.Color]::White)",
      "$f = New-Object System.Drawing.Font('Arial', 36, [System.Drawing.FontStyle]::Bold)",
      "$g.DrawString('NOTCH OCR 4242', $f, [System.Drawing.Brushes]::Black, 10, 30)",
      "$g.Dispose()",
      "$b.Save('" + TEXT_PNG.replace(/'/g, "''") + "', [System.Drawing.Imaging.ImageFormat]::Png)",
      "$b.Dispose()",
      "Write-Output 'ok'",
    ].join("; ");
    let tries = 0;
    const go = () => {
      tries++;
      let out = "", err = "";
      let c;
      try {
        c = spawn("powershell.exe", ["-NoProfile", "-Command", script], { windowsHide: true });
      } catch (e) { if (tries < 3) return setTimeout(go, 800); return resolve({ ok: false, err: e.message }); }
      const killer = setTimeout(() => { try { c.kill(); } catch {} }, 30000);
      c.stdout.on("data", (d) => { out += d; });
      c.stderr.on("data", (d) => { err += d; });
      c.on("error", (e) => { clearTimeout(killer); if (tries < 3) setTimeout(go, 800); else resolve({ ok: false, err: e.message }); });
      c.on("close", (code) => { clearTimeout(killer); if (code !== 0 && tries < 3) return setTimeout(go, 800); resolve({ ok: code === 0, out: out.trim(), err: err.trim() }); });
    };
    go();
  });
  t("test image generated", genR.ok && fs.existsSync(TEXT_PNG), genR.err);

  const crop = await runPs(path.join(__dirname, "crop.ps1"),
    ["-In", TEXT_PNG, "-X", "10", "-Y", "30", "-W", "300", "-H", "60", "-Out", CROP_PNG]);
  t("crop.ps1 produced a file", crop.code === 0 && fs.existsSync(CROP_PNG), crop.err || crop.out);
  const dimR = await runPsInline(
    "Add-Type -AssemblyName System.Drawing; $i = [System.Drawing.Image]::FromFile('" + CROP_PNG + "'); " +
    "Write-Output ($i.Width.ToString() + 'x' + $i.Height.ToString()); $i.Dispose()");
  t("crop is 300x60", dimR.out === "300x60", dimR.out + " " + dimR.err);

  /* ---- 2. ocr.ps1 ---- */
  const ocr = await runPs(path.join(__dirname, "ocr.ps1"), ["-Img", TEXT_PNG]);
  let oj = null;
  try { oj = JSON.parse(ocr.out.split(/\r?\n/).filter(Boolean).pop()); } catch {}
  t("ocr.ps1 returned JSON", !!oj, ocr.out + " " + ocr.err);
  t("ocr read the full text", !!(oj && /NOTCH OCR 4242/.test(oj.text)), JSON.stringify(oj));

  /* ---- 3. bridge routing via a fake region hook ---- */
  const regionCalls = [];
  let shotCalls = 0;
  const regionHook = (mode, cb) => {
    regionCalls.push(mode);
    if (mode === "shot" && ++shotCalls === 2) {   // 2nd shot = user hit Esc
      setTimeout(() => cb("cancelled"), 50);
      return;
    }
    setTimeout(() => {
      if (mode === "shot") cb(null, { kind: "shot", path: CROP_PNG });
      else if (mode === "ocr") cb(null, { kind: "ocr", text: "hello from ocr", lang: "English (United States)" });
      else cb(null, { kind: "ocr", text: "whole screen text", lang: "English (United States)" });
    }, 50);
  };
  await bridge.start({
    whatsapp: fakeWa, getState: () => state, onEvent: () => {}, region: regionHook,
  });

  const before = prompts().length;
  bridge.handleIncoming("/screenshot region").catch(() => {});
  t("region shot routed to the hook",
    await waitFor(() => regionCalls.includes("shot")), "calls=" + JSON.stringify(regionCalls));
  t("region shot sent the PNG",
    await waitFor(() => filesSent.some((f) => f === CROP_PNG)), "files=" + JSON.stringify(filesSent));

  bridge.handleIncoming("/ocr").catch(() => {});
  t("/ocr routed to the hook",
    await waitFor(() => regionCalls.includes("ocr")), "calls=" + JSON.stringify(regionCalls));
  t("/ocr sent the recognized text",
    await waitFor(() => sent.some((s) => /hello from ocr/.test(s))), JSON.stringify(sent));

  bridge.handleIncoming("/ocr full").catch(() => {});
  t("/ocr full routed as ocrfull",
    await waitFor(() => regionCalls.includes("ocrfull")), "calls=" + JSON.stringify(regionCalls));
  t("/ocr full sent the text",
    await waitFor(() => sent.some((s) => /whole screen text/.test(s))), JSON.stringify(sent));

  // natural-language OCR must NOT trigger a capture (assistant path only)
  await new Promise((r) => setTimeout(r, 800));
  t("no assistant prompts were used", prompts().length === before,
    "prompts " + before + " -> " + prompts().length);
  t("three region modes total", regionCalls.length === 3, JSON.stringify(regionCalls));

  // cancellation path: 2nd /screenshot region hits Esc in the fake hook
  bridge.handleIncoming("/screenshot region").catch(() => {});
  t("cancelled selection replies cleanly",
    await waitFor(() => sent.some((s) => /selection cancelled/.test(s))), JSON.stringify(sent));

  console.log(process.exitCode ? "FAILED" : "ALL PASS");
  restorePending();
  process.exit(process.exitCode || 0);
})().catch((e) => { restorePending(); console.error(e); process.exit(1); });
