/* Daily self-audit (Tony pack #3) — Tony reads his own debug.log.
   Lines from the last 24h are classified: anything carrying an error token
   (error/fail/429/HTTP 4xx5xx/timeout/ENOENT…) is a real error UNLESS it is
   a known self-healing message; errors are grouped by signature and mapped
   to known fixes, anything unknown is flagged "needs review" — PROPOSED in
   the digest, never applied on its own. Feeds the 09:00 digest.
   audit(lines) is a pure function, exported for tests. */
const fs = require("fs");
const path = require("path");

const LOG_FILE = path.join(__dirname, "debug.log");
const WINDOW_MS = 24 * 60 * 60 * 1000;
const TTL_MS = 10 * 60 * 1000;
let cache = { at: 0, text: null };

// error-looking lines that are actually us healing ourselves — never report
const SELF_HEALED = [
  /gone .*— recreating/i,          // session expired -> recreated on the spot
  /model fallback:/i,              // our own chain-stepping info line
  /recovered/i,
  /"error"\s*:\s*""/,              // status blobs where error is EMPTY (WA_STATUS…)
];

// anything error-ish survived the exceptions above = a real finding
const ERRY = /(error|failed|\bfail|os error|\b429\b|HTTP 40[234]|HTTP 5\d\d|timeout|timed out|ECONN|ENOSPC|EPERM|ENOENT|EACCES|refused|aborted|unavailable|killed|crash|denied|LOAD_FAIL|err=)/i;

// known signature -> the fix that is (or will be) in place
const KNOWN = [
  { re: /os error 5|access is denied/i, fix: "spawn denied — auto-retry already wired" },
  { re: /\b429\b|rate.?limit|FreeUsageLimit/i, fix: "rate/usage limit — retry-once + custom UA already wired" },
  { re: /stream (error|ended)/i, fix: "opencode stream drop — auto-reconnect already wired" },
  { re: /spawn (error|throw)/i, fix: "process spawn failed — retry-once already wired" },
  { re: /HTTP 40[234]|quota|credit|model.*not.*found/i, fix: "provider refused — MODEL_CHAIN auto-advances" },
  { re: /LOAD_FAIL/i, fix: "window failed to load — watching for a pattern" },
  { re: /timed out|timeout/i, fix: "timeout — transient, retry/backoff where wired" },
  { re: /ENOSPC|EPERM|ENOENT|EACCES/i, fix: "filesystem problem — needs review" },
  { re: /POLL_ERR|POLL online=false/i, fix: "opencode unreachable — the poll retries until it's back" },
];

function stripTs(line) {
  return String(line).replace(/^\S+Z?\s+/, "").trim();
}

/* Grouping key: same shape of error, whatever the ids/numbers were. */
function sig(line) {
  return stripTs(line)
    .replace(/https?:\S+/g, "URL")
    .replace(/\b[0-9a-f]{8,}\b/gi, "#")
    .replace(/\b\d+\b/g, "#")
    .slice(0, 90);
}

function fixFor(sample) {
  for (const k of KNOWN) if (k.re.test(sample)) return k.fix;
  return null;
}

/* Pure classifier: { errors: [{n, label, fix}], benign } */
function audit(lines) {
  const groups = new Map();
  let benign = 0;
  for (const raw of lines) {
    const line = String(raw).replace(/\r$/, "");
    if (!line.trim()) continue;
    if (SELF_HEALED.some((re) => re.test(line))) { benign++; continue; }
    if (!ERRY.test(line)) { benign++; continue; }
    const key = sig(line);
    const g = groups.get(key);
    if (g) g.n++;
    else groups.set(key, { n: 1, sample: line, label: stripTs(line).slice(0, 70) });
  }
  const errors = [...groups.values()].sort((a, b) => b.n - a.n);
  for (const g of errors) g.fix = fixFor(g.sample);
  return { errors, benign };
}

async function section(opts) {
  if (!opts || !opts.fresh) {
    if (cache.text !== null && Date.now() - cache.at < TTL_MS) return cache.text;
  }
  let raw;
  try { raw = fs.readFileSync(LOG_FILE, "utf8"); } catch { return null; }
  const cut = Date.now() - WINDOW_MS;
  const lines = raw.split("\n").filter((l) => {
    const ts = Date.parse(l.slice(0, 24));
    return Number.isFinite(ts) && ts >= cut;
  });
  const a = audit(lines);
  const out = ["🔧 SELF-AUDIT (24h)"];
  if (!a.errors.length) {
    out.push("clean — no errors · " + a.benign + " benign lines");
  } else {
    for (const g of a.errors.slice(0, 5)) {
      out.push("⚠ " + g.n + "× " + g.label +
        (g.fix ? " → " + g.fix : " → needs review, I'll propose a fix"));
    }
    out.push(a.benign + " benign diagnostic lines ignored");
  }
  const text = out.join("\n");
  cache = { at: Date.now(), text };
  return text;
}

function start() { cache = { at: 0, text: null }; }

module.exports = { start, section, audit, LOG_FILE };
