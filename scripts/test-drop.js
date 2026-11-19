/* Drag-drop validation test (#9): caps, dedupe, bad paths, directories. */
const fs = require("fs");
const os = require("os");
const path = require("path");

const { validateDrop, MAX_FILES, MAX_BYTES } = require("../dropfiles");

function t(label, cond, extra) {
  console.log((cond ? "PASS " : "FAIL ") + label + (cond ? "" : "  << " + (extra || "")));
  if (!cond) process.exitCode = 1;
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "drop-"));
function mk(name, size) {
  const p = path.join(tmp, name);
  fs.writeFileSync(p, Buffer.alloc(size || 10));
  return p;
}

const small1 = mk("a.png");
const small2 = mk("b.zip");
const big = mk("big.bin", MAX_BYTES + 1);

// happy path
let r = validateDrop([small1, small2]);
t("two files accepted", r.ok.length === 2 && r.rejected.length === 0, JSON.stringify(r));

// dedupe (case-insensitive path)
r = validateDrop([small1, small1.toUpperCase().replace(/\\/g, "\\")]);
t("duplicate collapsed to one", r.ok.length === 1, JSON.stringify(r));

// oversize
r = validateDrop([big]);
t("oversize rejected", r.ok.length === 0 && r.rejected[0].reason.includes("64MB"), JSON.stringify(r));

// missing
r = validateDrop([path.join(tmp, "ghost.txt")]);
t("missing rejected", r.rejected[0].reason === "missing", JSON.stringify(r));

// directory
r = validateDrop([tmp]);
t("directory rejected", r.rejected[0].reason === "not a file", JSON.stringify(r));

// relative path
r = validateDrop(["relative/file.txt"]);
t("relative rejected", r.rejected[0].reason === "bad path", JSON.stringify(r));

// non-string garbage
r = validateDrop([null, 42, {}]);
t("garbage rejected", r.ok.length === 0 && r.rejected.length === 3, JSON.stringify(r));

// empty / non-array
t("empty -> no files", validateDrop([]).rejected[0].reason === "no files");
t("null -> no files", validateDrop(null).rejected[0].reason === "no files");

// file cap (override for a fast test — cap logic is the same)
const many = [];
for (let i = 0; i < 5; i++) many.push(mk("f" + i + ".txt"));
r = validateDrop(many, { maxFiles: 3 });
t("cap keeps 3", r.ok.length === 3, JSON.stringify(r.ok));
t("cap rejects rest", r.rejected.length === 2 && r.rejected[0].reason.includes("cap"), JSON.stringify(r.rejected));

// cap counts BEFORE dedupe extras? order: cap applies after dedupe, so
// duplicates never eat the budget
r = validateDrop([small1, small1, small1, small2], { maxFiles: 2 });
t("dedupe does not eat cap", r.ok.length === 2 && r.rejected.length === 0, JSON.stringify(r));

// size override
r = validateDrop([small1], { maxBytes: 5 });
t("size override works", r.rejected[0].reason.includes("1MB") === false && r.ok.length === 0, JSON.stringify(r));

fs.rmSync(tmp, { recursive: true, force: true });

// --- preload contract: mock electron, assert the API the renderer calls ---
const Module = require("module");
const sentChans = [];
const listeners = {};
const mockElectron = {
  contextBridge: { exposeInMainWorld: (name, api) => { mockElectron.__api = api; } },
  ipcRenderer: {
    send: (ch, ...a) => sentChans.push([ch, a]),
    invoke: async () => null,
    on: (ch, cb) => { listeners[ch] = cb; },
  },
  webUtils: { getPathForFile: (f) => "C:\\resolved\\" + (f && f.name) },
};
const origLoad = Module._load;
Module._load = function (request, ...rest) {
  if (request === "electron") return mockElectron;
  return origLoad.call(this, request, ...rest);
};
delete require.cache[require.resolve("../preload")];
require("../preload");
Module._load = origLoad;

const api = mockElectron.__api;
t("preload exposes drop API", !!api && typeof api.getPathForFile === "function" &&
  typeof api.filesDropped === "function" && typeof api.onDropStatus === "function");
t("getPathForFile resolves via webUtils", api && api.getPathForFile({ name: "x.png" }) === "C:\\resolved\\x.png");
api.filesDropped(["C:\\a.png", "C:\\b.png"]);
t("filesDropped -> ipc files-dropped", sentChans.some(([c, a]) => c === "files-dropped" && a[0].length === 2),
  JSON.stringify(sentChans));
let got = null;
api.onDropStatus((d) => { got = d; });
listeners["drop-status"]({}, { sent: 1, rejected: [] });
t("drop-status listener wired", got && got.sent === 1, JSON.stringify(got));

console.log(process.exitCode ? "TEST FAILED" : "ALL PASS");
process.exit(process.exitCode || 0);
