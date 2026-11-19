/* Reminder engine test (#3): parseWhen forms + full command->pump round trip
   against a fake WhatsApp (no real messages leave this process). */
const bridge = require("../bridge");

function t(label, cond) {
  console.log((cond ? "PASS " : "FAIL ") + label);
  if (!cond) process.exitCode = 1;
}

// --- parseWhen (pure) ---
const now = Date.now();
const a = bridge.parseWhen("in 2s unit test ping");
t("in 2s parses", a && a.rest === "unit test ping" && Math.abs(a.at - (now + 2000)) < 3000);
const b = bridge.parseWhen("in 45 minutes drink water");
t("in 45 minutes parses", b && b.rest === "drink water" && b.at - now > 44 * 60000 && b.at - now < 47 * 60000);
const c = bridge.parseWhen("at 23:59 stand up");
t("at 23:59 parses", c && c.rest === "stand up" && new Date(c.at).getHours() === 23 && new Date(c.at).getMinutes() === 59);
const d = bridge.parseWhen("tomorrow 9am call mom");
t("tomorrow 9am parses", d && d.rest === "call mom" && new Date(d.at).getHours() === 9);
const e = bridge.parseWhen("me to drink water when free");
t("nonsense time -> null", e === null);

// --- command -> confirmation -> pump fire ---
const sent = [];
const fakeWa = {
  send: async (text) => { sent.push(String(text)); console.log("  WA< " + String(text).replace(/\n/g, " | ").slice(0, 120)); },
  sendFile: async () => {},
};

(async () => {
  await bridge.start({ whatsapp: fakeWa, getState: () => null, onEvent: () => {} });
  await bridge.handleIncoming("remind in 2s unit test ping");
  await new Promise((r) => setTimeout(r, 500));
  t("confirmation sent", sent.some((s) => s.includes("reminder #") && s.includes("set for")));

  // pump runs every 10s; wait it out
  await new Promise((r) => setTimeout(r, 13000));
  t("reminder fired", sent.some((s) => s.includes("⏰ reminder: unit test ping")));

  await bridge.handleIncoming("reminders");
  await new Promise((r) => setTimeout(r, 500));
  t("list is empty after firing", sent.some((s) => s.includes("no pending reminders")));

  bridge.stop();
  console.log(process.exitCode ? "TEST FAILED" : "ALL PASS");
  process.exit(process.exitCode || 0);
})().catch((e) => { console.error("ERR", e); process.exit(1); });
