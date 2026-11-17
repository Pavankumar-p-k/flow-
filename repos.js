/* git repo discovery + status for the WhatsApp bridge */
const fs = require("fs");
const path = require("path");
const os = require("os");
const { execFile } = require("child_process");

const SKIP = new Set([
  "node_modules", ".git", "AppData", "scoop", ".scoop", "tools", ".cache",
  ".local", ".npm", ".nuget", ".cargo", ".rustup", ".android", ".vs",
  ".vscode", ".java", ".gradle", ".dotnet", ".gem", ".pyenv", ".conda",
  "__pycache__", ".venv", "venv", "dist", "build", ".next", ".turbo",
  ".nuxt", "vendor", ".bundle", ".m2", ".docker", ".ssh", ".config",
  ".rustup", ".java", ".electron", ".yarn", ".pnpm-store", ".terraform",
]);

function roots() {
  const home = os.homedir();
  return [
    { dir: home, depth: 4 },
    { dir: path.join(home, "AppData", "Local", "Temp", "opencode"), depth: 2 },
    { dir: "C:\\Projects", depth: 3 },
    { dir: "C:\\dev", depth: 3 },
    { dir: "C:\\code", depth: 3 },
  ];
}

async function scan() {
  const found = [];
  const seen = new Set();

  async function walk(dir, depth) {
    if (depth < 0 || seen.has(dir)) return;
    seen.add(dir);
    let entries;
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    if (entries.some((e) => e.isDirectory() && e.name === ".git")) {
      found.push(dir);
      return; // a repo root — no need to descend into it
    }
    for (const e of entries) {
      if (!e.isDirectory() || SKIP.has(e.name)) continue;
      await walk(path.join(dir, e.name), depth - 1);
    }
  }

  for (const r of roots()) {
    if (!fs.existsSync(r.dir)) continue;
    await walk(r.dir, r.depth);
  }
  return found.sort((a, b) => a.localeCompare(b));
}

function git(dir, args) {
  return new Promise((resolve) => {
    execFile(
      "git",
      ["-C", dir, ...args],
      { windowsHide: true, timeout: 8000, maxBuffer: 1024 * 1024 },
      (err, stdout) => resolve(err ? "" : String(stdout))
    );
  });
}

async function statusOf(dir) {
  const name = path.basename(dir);
  const branchOut = await git(dir, ["status", "--porcelain=v1", "-b"]);
  if (!branchOut) return { dir, name, branch: "?", dirty: 0, ahead: 0, behind: 0, ok: false };
  const lines = branchOut.split("\n").filter(Boolean);
  const head = lines[0] || "";
  const branch = (head.match(/^##\s+([^\s.]+)/) || [, "?"])[1];
  const ahead = Number((head.match(/ahead\s+(\d+)/) || [, 0])[1]);
  const behind = Number((head.match(/behind\s+(\d+)/) || [, 0])[1]);
  const dirty = Math.max(0, lines.length - 1);
  const logOut = await git(dir, ["log", "-1", "--format=%ct%x09%s"]);
  const [tsStr, ...msgParts] = logOut.trim().split("\t");
  const ts = Number(tsStr) || 0;
  return {
    dir,
    name,
    branch,
    dirty,
    ahead,
    behind,
    ok: true,
    lastCommit: msgParts.join("\t").slice(0, 70),
    lastAge: ts ? ageText(Date.now() / 1000 - ts) : "",
  };
}

function ageText(sec) {
  if (sec < 60) return "just now";
  if (sec < 3600) return Math.floor(sec / 60) + "m ago";
  if (sec < 86400) return Math.floor(sec / 3600) + "h ago";
  return Math.floor(sec / 86400) + "d ago";
}

let cache = { list: [], at: 0 };

async function list(force) {
  if (!force && cache.list.length && Date.now() - cache.at < 10 * 60 * 1000) return cache.list;
  const dirs = await scan();
  const list = [];
  for (const d of dirs) list.push(await statusOf(d));
  cache = { list, at: Date.now() };
  return list;
}

module.exports = { scan, list, statusOf };
