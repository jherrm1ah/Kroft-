// Tests the Android stand-ins in native.js against fake plugins. Run with: npm test
globalThis.window = globalThis.window || { location: { origin: "https://kroft-pied.vercel.app" } };
const { _internals } = await import("./native.js");
let fail = 0;
const eq = (name, got, want) => { const g = JSON.stringify(got), w = JSON.stringify(want); if (g !== w) { fail++; console.log("FAIL", name, "\n  got ", g, "\n  want", w); } else console.log("ok  ", name); };
const tick = (ms = 0) => new Promise(r => setTimeout(r, ms));

// ── Text to speech ──
{
  const spoken = []; let resolveCurrent;
  const TTS = {
    speak: o => { spoken.push(o); return new Promise(r => { resolveCurrent = r; }); },
    stop: async () => { resolveCurrent = null; },
    getSupportedVoices: async () => ({ voices: [{ name: "en-us-x-sfg", lang: "en-US", voiceURI: "a", default: true }, { name: "en-gb-x-rjs", lang: "en-GB", voiceURI: "b" }] }),
  };
  _internals.installSpeechSynthesis(TTS);
  let changed = 0; window.speechSynthesis.addEventListener("voiceschanged", () => changed++);
  await tick();
  eq("voices load and fire voiceschanged", [window.speechSynthesis.getVoices().length, changed], [2, 1]);
  const events = [];
  const u1 = new window.SpeechSynthesisUtterance("Hello there.");
  u1.voice = window.speechSynthesis.getVoices()[1]; u1.rate = 1.1;
  u1.onstart = () => events.push("start1"); u1.onend = () => events.push("end1");
  const u2 = new window.SpeechSynthesisUtterance("Second.");
  u2.onend = () => events.push("end2");
  window.speechSynthesis.speak(u1); window.speechSynthesis.speak(u2);
  eq("speaks one at a time, with voice index and lang", [spoken.length, spoken[0].voice, spoken[0].lang, window.speechSynthesis.speaking], [1, 1, "en-GB", true]);
  resolveCurrent(); await tick();
  eq("queue advances after end", [events, spoken.length, spoken[1].text], [["start1", "end1"], 2, "Second."]);
  const errs = []; u2.onerror = e => errs.push(e.error);
  window.speechSynthesis.cancel(); await tick();
  eq("cancel interrupts current and clears", [errs, window.speechSynthesis.speaking, events.includes("end2")], [["interrupted"], false, false]);
}

// ── Speech recognition ──
{
  const listeners = {}; let started = null, stopped = 0, perm = "granted";
  const SR = {
    checkPermissions: async () => ({ speechRecognition: perm }),
    requestPermissions: async () => ({ speechRecognition: perm }),
    addListener: async (ev, fn) => { listeners[ev] = fn; return { remove: () => { delete listeners[ev]; } }; },
    start: async o => { started = o; },
    stop: async () => { stopped++; },
  };
  _internals.installSpeechRecognition(SR);
  const r = new window.SpeechRecognition();
  r.lang = "en-NG"; r.interimResults = true;
  const log = [];
  r.onstart = () => log.push("start");
  r.onresult = e => log.push(`${Array.from(e.results).map(x => x[0].transcript).join("")}${e.results[0].isFinal ? " (final)" : ""}`);
  r.onend = () => log.push("end");
  r.onerror = e => log.push(`error:${e.error}`);
  await r.start();
  eq("starts with language and partial results", [started.language, started.partialResults, log], ["en-NG", true, ["start"]]);
  listeners.partialResults({ matches: ["log five"] });
  listeners.partialResults({ matches: ["log five thousand"] });
  listeners.listeningState({ status: "stopped" });
  listeners.partialResults({ matches: ["log five thousand naira"] });
  await tick(800);
  eq("partials then a final result, then end", log, ["start", "log five", "log five thousand", "log five thousand naira", "log five thousand naira (final)", "end"]);
  eq("listeners removed afterwards", Object.keys(listeners).length, 0);

  const r2 = new window.SpeechRecognition(); const log2 = [];
  r2.onresult = e => log2.push(e.results[0][0].transcript); r2.onend = () => log2.push("end"); r2.onerror = e => log2.push(`error:${e.error}`);
  await r2.start(); listeners.partialResults({ matches: ["half"] }); r2.abort();
  eq("abort ends without a final result", log2, ["half", "end"]);

  perm = "denied";
  const r3 = new window.SpeechRecognition(); const log3 = [];
  r3.onerror = e => log3.push(`error:${e.error}`); r3.onend = () => log3.push("end");
  await r3.start();
  eq("permission denied reports not-allowed", log3, ["error:not-allowed", "end"]);
}

// ── Notifications ──
{
  const scheduled = []; let delivered = [];
  const LN = {
    checkPermissions: async () => ({ display: "granted" }),
    requestPermissions: async () => ({ display: "granted" }),
    schedule: async ({ notifications }) => { scheduled.push(...notifications); },
    cancel: async () => {},
    getDeliveredNotifications: async () => ({ notifications: delivered }),
  };
  await _internals.installNotifications(LN);
  eq("permission known before first render", window.Notification.permission, "granted");
  new window.Notification("Reminder", { body: "Call the bank", tag: "kroft:reminder" });
  await tick();
  eq("shows a local notification", scheduled.map(n => [n.title, n.body]), [["Reminder", "Call the bank"]]);
  delivered = [{ title: "Reminder", body: "Call the bank" }];
  new window.Notification("Reminder", { body: "Call the bank" });
  await tick();
  eq("same one already showing is not repeated", scheduled.length, 1);
}

eq("ids are stable and positive", [_internals.idFor("appt:1") === _internals.idFor("appt:1"), _internals.idFor("appt:1") > 0], [true, true]);

console.log(fail ? `\n${fail} FAILED` : "\nALL PASSED");
if (fail) process.exit(1);
