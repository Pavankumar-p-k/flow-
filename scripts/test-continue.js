/* Simulates the bridge's askAssistant flow: ask, run actions, follow cont. */
const assistant = require("../assistant");
const bridge = require("../bridge");

(async () => {
  let text = "Open paint draw a circle in blue clr";
  for (let depth = 0; depth < 3; depth++) {
    console.log("\n== turn " + depth + ": " + text.slice(0, 80));
    const t0 = Date.now();
    const res = await assistant.ask(text);
    console.log("[" + ((Date.now() - t0) / 1000).toFixed(1) + "s] reply:", JSON.stringify(res.reply).slice(0, 300));
    console.log("actions:", JSON.stringify(res.actions));
    console.log("cont:", res.cont ? JSON.stringify(res.cont).slice(0, 200) : null);
    for (const a of res.actions) console.log("runAction", a.type + ":" + a.value, "->", bridge.runAction(a));
    if (!res.cont) break;
    text = res.cont;
    await new Promise((r) => setTimeout(r, 3500));
  }
  console.log("\nDONE");
  process.exit(0);
})().catch((e) => { console.error("ERROR", e); process.exit(1); });
