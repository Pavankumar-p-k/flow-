/* Session control test (#6): numbered sessions snapshot, run/stop routing.
   global.fetch is patched — no real prompts are sent to any session. */
const calls = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, opts) => {
  calls.push({ url: String(url), method: opts.method, body: opts.body ? JSON.parse(opts.body) : null });
  return {
    ok: true,
    status: 200,
    headers: { get: () => "application/json" },
    json: async () => ({ ok: true }),
    text: async () => "{}",
  };
};

const bridge = require("../bridge");

function t(label, cond, extra) {
  console.log((cond ? "PASS " : "FAIL ") + label + (cond ? "" : "  << " + (extra || "")));
  if (!cond) process.exitCode = 1;
}

const sent = [];
const fakeWa = {
  send: async (text) => { sent.push(String(text)); console.log("  WA< " + String(text).replace(/\n/g, " | ").slice(0, 140)); },
  sendFile: async () => {},
};

// live state whose session ORDER changes after the snapshot is taken
const state = {
  online: true,
  sessions: [
    { id: "ses_ALPHA", title: "Alpha builder" },
    { id: "ses_BETA", title: "Beta writer" },
  ],
  active: { ses_ALPHA: true },
  stats: null,
};

(async () => {
  await bridge.start({ whatsapp: fakeWa, getState: () => state, onEvent: () => {} });

  await bridge.handleIncoming("sessions");
  await new Promise((r) => setTimeout(r, 300));
  const listing = sent[sent.length - 1] || "";
  t("numbered list", listing.includes("1 ▶ Alpha builder") && listing.includes("2 · Beta writer"), listing);
  t("list hints run/stop", /run <n> <prompt>/.test(listing), listing);

  // reorder the live list — resolution must still use the snapshot the user saw
  state.sessions.reverse();

  await bridge.handleIncoming("run 2 write a haiku about the sea");
  await new Promise((r) => setTimeout(r, 300));
  const runCall = calls.find((c) => c.method === "POST" && /\/prompt$/.test(c.url));
  t("run posts to snapshot session #2 (ses_BETA)", runCall && runCall.url.includes("ses_BETA"), JSON.stringify(calls));
  t("run body carries the prompt", runCall && runCall.body && runCall.body.text === "write a haiku about the sea", JSON.stringify(runCall && runCall.body));
  t("run confirms in chat", sent.some((s) => s.includes("▶ sent to [2] Beta writer")), sent.join(" || "));

  await bridge.handleIncoming("stop 1");
  await new Promise((r) => setTimeout(r, 300));
  const stopCall = calls.find((c) => c.method === "POST" && /\/interrupt$/.test(c.url));
  t("stop posts interrupt to snapshot #1 (ses_ALPHA)", stopCall && stopCall.url.includes("ses_ALPHA"), JSON.stringify(calls));
  t("stop confirms in chat", sent.some((s) => s.includes("⏹ interrupted [1] Alpha builder")), sent.join(" || "));

  await bridge.handleIncoming("run 9 do something");
  await new Promise((r) => setTimeout(r, 300));
  t("out-of-range number rejected", sent.some((s) => s.includes("no session #9")), sent.join(" || "));

  // a rejected lookup must not renumber: #2 is still ses_BETA (live order is
  // reversed, so a rebuilt snapshot would wrongly resolve to ses_ALPHA)
  await bridge.handleIncoming("stop 2");
  await new Promise((r) => setTimeout(r, 300));
  const stop2 = calls.filter((c) => /\/interrupt$/.test(c.url)).pop();
  t("snapshot survives a bad number", stop2 && stop2.url.includes("ses_BETA"), JSON.stringify(calls));

  // error path: fetch rejects
  globalThis.fetch = async () => { throw new Error("HTTP 500 boom"); };
  await bridge.handleIncoming("run 1 say hi");
  await new Promise((r) => setTimeout(r, 300));
  t("api failure reported", sent.some((s) => s.includes("run failed") && s.includes("boom")), sent.join(" || "));

  globalThis.fetch = realFetch;
  bridge.stop();
  console.log(process.exitCode ? "TEST FAILED" : "ALL PASS");
  process.exit(process.exitCode || 0);
})().catch((e) => { console.error("ERR", e); process.exit(1); });
