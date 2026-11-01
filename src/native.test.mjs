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

// ── Location ──
{
  let perm = "prompt", asked = 0, fix = { coords: { latitude: 6.5, longitude: 3.4, accuracy: 20 }, timestamp: 1 }, failWith = null;
  const Geo = {
    checkPermissions: async () => ({ location: perm, coarseLocation: perm }),
    requestPermissions: async () => { asked++; return { location: perm, coarseLocation: perm }; },
    getCurrentPosition: async o => { if (failWith) throw new Error(failWith); Geo.lastOpts = o; return fix; },
    watchPosition: async () => "w1", clearWatch: async () => {},
  };
  _internals.installGeolocation(Geo);
  const get = o => new Promise(r => navigator.geolocation.getCurrentPosition(p => r({ ok: p }), e => r({ err: e }), o));
  perm = "denied";
  let r = await get();
  eq("denied asks Android, then reports PERMISSION_DENIED", [asked, r.err?.code, r.err?.code === r.err?.PERMISSION_DENIED], [1, 1, true]);
  perm = "granted";
  r = await get({ enableHighAccuracy: true, timeout: 5000 });
  eq("granted returns the native fix, with fallback on", [r.ok?.coords.latitude, Geo.lastOpts.enableHighAccuracy, Geo.lastOpts.enableLocationFallback], [6.5, true, true]);
  failWith = "Location services are not enabled";
  r = await get();
  eq("location switched off maps to POSITION_UNAVAILABLE", [r.err?.code, r.err?.message], [2, "Location is turned off"]);
  failWith = "Timeout reached";
  r = await get();
  eq("timeout maps to TIMEOUT", r.err?.code, 3);

  _internals.installPermissionsQuery({ Geolocation: Geo, SpeechRecognition: { checkPermissions: async () => ({ speechRecognition: "prompt" }) } });
  eq("permissions.query answers from Android", [(await navigator.permissions.query({ name: "geolocation" })).state, (await navigator.permissions.query({ name: "microphone" })).state], ["granted", "prompt"]);
}

// ── Mic fallback (phones with no speech recognizer) ──
{
  const { createRecorderRecognition, encodeWav } = await import("./voiceRecorder.js");
  const wav = encodeWav(new Float32Array(48000).fill(0.5), 48000);
  const dv = new DataView(wav.buffer);
  eq("WAV is 16 kHz mono PCM", [String.fromCharCode(...wav.slice(0, 4)), dv.getUint32(24, true), dv.getUint16(22, true), wav.length], ["RIFF", 16000, 1, 44 + 16000 * 2]);

  let node = null, tracksStopped = 0;
  Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: { getUserMedia: async () => ({ getTracks: () => [{ stop: () => tracksStopped++ }] }) } });
  window.AudioContext = class { constructor() { this.sampleRate = 48000; this.state = "running"; this.destination = {}; }
    createMediaStreamSource() { return { connect() {}, disconnect() {} }; }
    createScriptProcessor() { node = { connect() {}, disconnect() {} }; return node; }
    close() { return Promise.resolve(); } };
  const frame = level => node.onaudioprocess({ inputBuffer: { getChannelData: () => new Float32Array(4096).fill(level) } });

  let sent = null, allow = true;
  const Rec = createRecorderRecognition({ ensurePermission: async () => allow, transcribe: async (b64, lang) => { sent = { bytes: atob(b64).length, lang }; return "Remind me to call mum"; } });
  const log = [];
  const r = new Rec(); r.lang = "en-NG";
  r.onstart = () => log.push("start"); r.onresult = e => log.push(`${e.results[0].isFinal ? "final" : "interim"}:${e.results[0][0].transcript}`);
  r.onerror = e => log.push(`error:${e.error}`); r.onend = () => log.push("end");
  await r.start();
  frame(0.2); frame(0.2); frame(0);
  await r.stop(); await tick();
  eq("records, transcribes, then gives a final result", [log, sent?.lang, sent?.bytes > 44, tracksStopped], [["start", "final:Remind me to call mum", "end"], "en-NG", true, 1]);

  const log2 = []; const r2 = new Rec();
  r2.onerror = e => log2.push(`error:${e.error}`); r2.onend = () => log2.push("end");
  await r2.start(); frame(0.001); await r2.stop(); await tick();
  eq("silence ends with no-speech, nothing sent", log2, ["error:no-speech", "end"]);

  allow = false;
  const log3 = []; const r3 = new Rec();
  r3.onerror = e => log3.push(`error:${e.error}`); r3.onend = () => log3.push("end");
  await r3.start();
  eq("mic not allowed reports not-allowed", log3, ["error:not-allowed", "end"]);
}

eq("ids are stable and positive", [_internals.idFor("appt:1") === _internals.idFor("appt:1"), _internals.idFor("appt:1") > 0], [true, true]);

console.log(fail ? `\n${fail} FAILED` : "\nALL PASSED");
if (fail) process.exit(1);
