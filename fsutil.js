/* Small file helpers shared by the state-file writers (A2/A5 hardening):
   - writeAtomic: temp file + rename, so a crash mid-write can never leave a
     corrupt baseline behind (rename replaces atomically on NTFS; falls back
     to a direct write if the destination is locked)
   - readTail: read only the last maxBytes of a possibly huge file, dropping
     the partial first line (keeps debug.log audits fast and bounded) */
const fs = require("fs");

function writeAtomic(file, str) {
  const tmp = file + ".tmp";
  try {
    fs.writeFileSync(tmp, str);
    fs.renameSync(tmp, file);
  } catch (e) {
    try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch {}
    fs.writeFileSync(file, str); // fallback: plain write, caller's catch handles real failures
  }
}

function readTail(file, maxBytes) {
  try {
    const st = fs.statSync(file);
    if (st.size <= maxBytes) return fs.readFileSync(file, "utf8");
    const fd = fs.openSync(file, "r");
    try {
      const buf = Buffer.alloc(maxBytes);
      fs.readSync(fd, buf, 0, maxBytes, st.size - maxBytes);
      let raw = buf.toString("utf8");
      const nl = raw.indexOf("\n"); // drop the partial first line of the slice
      if (nl >= 0) raw = raw.slice(nl + 1);
      return raw;
    } finally { fs.closeSync(fd); }
  } catch { return null; }
}

module.exports = { writeAtomic, readTail };
