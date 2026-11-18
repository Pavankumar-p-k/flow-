/* One-shot verification: assistant.ask() returns actions, and runAction
   executes each type. Run: node scripts/test-actions.js */
const path = require("path");
const { spawnSync } = require("child_process");
const assistant = require("../assistant");
const bridge = require("../bridge");

function procAlive(name) {
  const r = spawnSync("tasklist", ["/FI", "IMAGENAME eq " + name], { encoding: "utf8" });
  return r.status === 0 && r.stdout.toLowerCase().includes(name.toLowerCase());
}

(async () => {
  console.log("== 1. assistant.ask('open notepad') ==");
  const res = await assistant.ask("open notepad");
  console.log("reply:", JSON.stringify(res.reply));
  console.log("actions:", JSON.stringify(res.actions));
  if (!res.actions || !res.actions.length) {
    console.log("FAIL: no actions returned");
    process.exit(1);
  }

  console.log("\n== 2. runAction on every returned action ==");
  for (const a of res.actions) {
    const ok = bridge.runAction(a);
    console.log("runAction", a.type + ":" + a.value, "->", ok);
    if (!ok) { console.log("FAIL"); process.exit(1); }
  }

  await new Promise((r) => setTimeout(r, 2500));
  console.log("\nnotepad running:", procAlive("notepad.exe"));

  console.log("\n== 3. direct type checks ==");
  const checks = [
    { type: "browser", value: "https://example.com" },
    { type: "media", value: "playpause" },
    { type: "focus", value: "Notchy" },
    { type: "file", value: path.join(__dirname, "..", "package.json") },
    { type: "app", value: "calc" },
  ];
  let allOk = true;
  for (const a of checks) {
    const ok = bridge.runAction(a);
    console.log("runAction", a.type + ":" + a.value, "->", ok);
    if (!ok) allOk = false;
  }
  await new Promise((r) => setTimeout(r, 2500));
  console.log("calc running:", procAlive("CalculatorApp.exe") || procAlive("calc.exe"));
  console.log(allOk ? "\nALL ACTION TYPES OK" : "\nSOME FAILED");
  process.exit(allOk ? 0 : 1);
})().catch((e) => { console.error("ERROR", e); process.exit(1); });
