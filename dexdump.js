// Extract file list + text files from Dexter's app.asar (no npm deps)
const fs = require("fs");
const path = require("path");

const SRC = "C:\\Users\\peter\\AppData\\Local\\Programs\\Dexter\\resources\\app.asar";
const OUT_DIR = "C:\\Users\\peter\\appdex";
const LOG = "C:\\Users\\peter\\agent-notch\\dex-out.txt";

function log(s) { try { fs.appendFileSync(LOG, s + "\n"); } catch {} }

function findJsonEnd(b, start) {
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < b.length; i++) {
    const c = b[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === 92) esc = true;
      else if (c === 34) inStr = false;
      continue;
    }
    if (c === 34) inStr = true;
    else if (c === 123) depth++;
    else if (c === 125) { depth--; if (depth === 0) return i + 1; }
  }
  return -1;
}

try {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const b = fs.readFileSync(SRC);
  log("asar size=" + b.length + " p0=" + b.readUInt32LE(0) + " p4=" + b.readUInt32LE(4));

  const jsonStart = b.indexOf('{"files"');
  if (jsonStart < 0) throw new Error('header {"files" not found');
  const jsonEnd = findJsonEnd(b, jsonStart);
  if (jsonEnd < 0) throw new Error("json end not found");
  const header = JSON.parse(b.slice(jsonStart, jsonEnd).toString("utf8"));
  log("header json start=" + jsonStart + " end=" + jsonEnd);

  const files = [];
  (function walk(node, p) {
    if (node.files) {
      for (const k of Object.keys(node.files)) walk(node.files[k], p ? p + "/" + k : k);
    } else {
      files.push({ p, offset: Number(node.offset || 0), size: Number(node.size || 0), unpacked: !!node.unpacked });
    }
  })(header, "");
  log("file count=" + files.length);
  fs.writeFileSync(LOG.replace("dex-out.txt", "dex-files.txt"), files.map((f) => f.p + "  (" + f.size + ")").join("\n"));

  // Determine data base offset using package.json as a probe
  const align4 = (n) => Math.ceil(n / 4) * 4;
  const sz = b.readUInt32LE(4);
  const candidates = [...new Set([jsonEnd, align4(jsonEnd), 8 + sz, align4(8 + sz), 8 + align4(sz), align4(jsonEnd) + 4])];
  const probe = files.find((f) => f.p === "package.json");
  let base = -1;
  if (probe) {
    for (const c of candidates) {
      const s = b.slice(c + probe.offset, c + probe.offset + Math.min(probe.size, 4096)).toString("utf8");
      if (s.trimStart().startsWith("{")) { base = c; break; }
    }
  }
  if (base < 0) base = candidates[0];
  log("candidates=" + JSON.stringify(candidates) + " chosen base=" + base);

  // Extract text-ish files (html/css/js/json/svg/txt/yml) under 6 MB
  const exts = /\.(html?|css|js|json|svg|txt|md|yml|yaml)$/i;
  let n = 0;
  for (const f of files) {
    if (!exts.test(f.p) || f.size > 6 * 1024 * 1024 || f.unpacked) continue;
    try {
      const data = b.slice(base + f.offset, base + f.offset + f.size);
      const dest = path.join(OUT_DIR, f.p.replace(/[\\/]/g, "__"));
      fs.writeFileSync(dest, data);
      n++;
    } catch (e) { log("fail " + f.p + " " + e.message); }
  }
  log("extracted=" + n);

  // Phase 2: dump design tokens from the index bundle (exported color/font vars)
  try {
    const idx = files.find((f) => f.p === "dist/assets/index-BWbafmMq.js");
    if (idx) {
      const data = b.slice(base + idx.offset, base + idx.offset + idx.size).toString("utf8");
      const em = data.match(/export\{([\s\S]*?)\}\s*;?\s*$/);
      const want = ["T", "N", "F", "V", "O", "i", "L", "j", "k", "h", "Z", "q", "ae", "Pe", "Oe"];
      const out = [];
      if (em) {
        const map = {};
        for (const part of em[1].split(",")) {
          const bits = part.trim().split(/\s+as\s+/);
          if (bits.length === 2) map[bits[1]] = bits[0];
          else if (bits[0]) map[bits[0]] = bits[0];
        }
        for (const w of want) {
          const local = map[w];
          if (!local) { out.push(w + " -> (not found)"); continue; }
          const re = new RegExp("(?:const|let|var)\\s+" + local + "\\s*=\\s*(\"(?:[^\"\\\\]|\\\\.)*\"|'(?:[^'\\\\]|\\\\.)*'|`(?:[^`\\\\]|\\\\.)*`)");
          const dm = data.match(re);
          if (dm) { out.push(w + " (local " + local + ") = " + dm[1]); continue; }
          // fallback: context around "local=" assignment
          const i = data.indexOf(local + "=");
          if (i >= 0) out.push(w + " (local " + local + ") ctx: " + data.slice(Math.max(0, i - 60), i + 220).replace(/\n/g, " "));
          else out.push(w + " (local " + local + ") = (not found at all)");
        }
      } else {
        out.push("export statement not found");
      }
      fs.writeFileSync(LOG.replace("dex-out.txt", "dex-tokens.txt"), out.join("\n"));
      log("tokens dumped=" + out.length);
    }
  } catch (e) { log("token error " + e.message); }

  log("DONE");
} catch (e) {
  log("ERROR " + (e && e.stack ? e.stack : e));
}
