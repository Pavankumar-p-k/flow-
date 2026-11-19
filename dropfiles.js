/* Validation for files dropped onto the notch (#9 tier-3 drag-drop → WhatsApp).
   Pure node — no Electron — so it unit-tests without a display.
   Caps: 10 files per drop, 64MB per file (bigger files belong in a share link). */
const fs = require("fs");
const path = require("path");

const MAX_FILES = 10;
const MAX_BYTES = 64 * 1024 * 1024;

function validateDrop(list, opts) {
  const maxFiles = (opts && opts.maxFiles) || MAX_FILES;
  const maxBytes = (opts && opts.maxBytes) || MAX_BYTES;
  const ok = [];
  const rejected = [];
  if (!Array.isArray(list) || !list.length) {
    return { ok, rejected: [{ name: "", reason: "no files" }] };
  }
  const seen = new Set();
  for (const p of list) {
    if (typeof p !== "string" || !p || !path.isAbsolute(p)) {
      rejected.push({ name: String(p || "?").slice(0, 60), reason: "bad path" });
      continue;
    }
    let st;
    try { st = fs.statSync(p); } catch {
      rejected.push({ name: path.basename(p), reason: "missing" });
      continue;
    }
    if (!st.isFile()) {
      rejected.push({ name: path.basename(p), reason: "not a file" });
      continue;
    }
    if (st.size > maxBytes) {
      rejected.push({ name: path.basename(p), reason: "over " + Math.round(maxBytes / 1048576) + "MB" });
      continue;
    }
    const key = p.toLowerCase();
    if (seen.has(key)) continue; // same file dragged twice -> send once
    seen.add(key);
    if (ok.length >= maxFiles) {
      rejected.push({ name: path.basename(p), reason: "over " + maxFiles + "-file cap" });
      continue;
    }
    ok.push(p);
  }
  return { ok, rejected };
}

module.exports = { validateDrop, MAX_FILES, MAX_BYTES };
