// Tests for src/cloudVoice.js with a fake device voice, a fake server and a fake audio player:
// Ben's lines play the real voice in order, everything else and every failure falls back to the
// device's voice, nothing talks over anything else, and cancel stops it all. Run with: npm test
import { createCloudSynth } from "./cloudVoice.js";
import { voiceFor, cleanTtsText, MAX_TTS_CHARS } from "../api/_lib/elevenlabs.js";

let fail = 0;
const eq = (name, got, want) => { if (JSON.stringify(got) !== JSON.stringify(want)) { fail++; console.log("FAIL", name, "\n  got ", JSON.stringify(got), "\n  want", JSON.stringify(want)); } else console.log("ok  ", name); };
const tick = (ms = 0) => new Promise(r => setTimeout(r, ms));
globalThis.URL.createObjectURL = b => `blob:${b.text}`;
globalThis.URL.revokeObjectURL = () => {};

const log = [];
function fakeBase() {
  let cur = null;
  return {
    speaking: false, pending: false, paused: false,
    getVoices: () => [{ name: "Device" }],
    speak(u) { log.push(`device:${u.text}`); cur = u; this.speaking = true; setTimeout(() => { if (cur !== u) return; cur = null; this.speaking = false; u.onend?.({}); }, 5); },
    cancel() { const u = cur; cur = null; this.speaking = false; if (u) u.onerror?.({ error: "interrupted" }); },
  };
}
class FakeAudio {
  constructor(url) { this.url = url; this.playbackRate = 1; FakeAudio.made.push(this); }
  play() { log.push(`voice:${this.url.slice(5)}@${this.playbackRate}`); this.t = setTimeout(() => this.onended?.(), 5); return Promise.resolve(); }
  pause() { clearTimeout(this.t); log.push(`pause:${this.url.slice(5)}`); }
}
FakeAudio.made = [];
const utter = (text, persona = "ben", rate = 1) => ({ text, kroftPersona: persona, rate, events: [], onstart() { this.events.push("start"); }, onend() { this.events.push("end"); }, onerror(e) { this.events.push(`error:${e.error}`); } });

function server(status = () => 200) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push({ url, auth: init.headers.Authorization, ...body });
    const s = status(body);
    return { ok: s === 200, status: s, blob: async () => ({ text: body.text }) };
  };
  return { calls, fetchImpl };
}

// Ben speaks with the real voice, in order, at his speed; the server gets the line and persona.
{
  log.length = 0;
  const srv = server();
  const synth = createCloudSynth(fakeBase(), { getToken: async () => "tok", fetchImpl: srv.fetchImpl, AudioImpl: FakeAudio });
  const a = utter("Good morning.", "ben", 1.1), b = utter("You have one invoice due.");
  synth.speak(a); synth.speak(b);
  eq("speaking straight away, before the audio arrives", synth.speaking, true);
  await tick(40);
  eq("both lines play the real voice, in order, at Ben's speed", log, ["voice:Good morning.@1.1", "voice:You have one invoice due.@1"]);
  eq("each line asked for once, signed in, as Ben", srv.calls.map(c => [c.url, c.auth, c.voice, c.text]), [["/api/tts", "Bearer tok", "ben", "Good morning."], ["/api/tts", "Bearer tok", "ben", "You have one invoice due."]]);
  eq("start and end reported for each line", [a.events, b.events], [["start", "end"], ["start", "end"]]);
  eq("quiet once done", synth.speaking, false);
}

// Other personas, and untagged lines, use the device's voice without asking the server.
{
  log.length = 0;
  const srv = server();
  const synth = createCloudSynth(fakeBase(), { getToken: async () => "tok", fetchImpl: srv.fetchImpl, AudioImpl: FakeAudio });
  synth.speak(utter("Hi from Mira.", "mira")); await tick(10);
  synth.speak({ text: "No persona." }); await tick(10);
  eq("device voice for Mira and for untagged lines", log, ["device:Hi from Mira.", "device:No persona."]);
  eq("server never asked", srv.calls.length, 0);
}

// Not set up (503): that line and every later one use the device's voice, without asking again.
{
  log.length = 0;
  const srv = server(() => 503);
  const synth = createCloudSynth(fakeBase(), { getToken: async () => "tok", fetchImpl: srv.fetchImpl, AudioImpl: FakeAudio });
  const a = utter("One."), b = utter("Two.");
  synth.speak(a); synth.speak(b); await tick(40);
  synth.speak(utter("Three.")); await tick(20);
  eq("falls back to the device, one line at a time, in order", log, ["device:One.", "device:Two.", "device:Three."]);
  eq("the server isn't asked again after saying it isn't set up", srv.calls.map(c => c.text), ["One.", "Two."]);
  eq("the fallen-back lines still report their end", [a.events, b.events], [["end"], ["end"]]);
}

// One bad line (502) is spoken by the device; the next line tries the real voice again.
{
  log.length = 0;
  const srv = server(b => (b.text === "Bad." ? 502 : 200));
  const synth = createCloudSynth(fakeBase(), { getToken: async () => "tok", fetchImpl: srv.fetchImpl, AudioImpl: FakeAudio });
  synth.speak(utter("Bad.")); synth.speak(utter("Good."));
  await tick(40);
  eq("one failed line falls back, the next uses the real voice, never overlapping", log, ["device:Bad.", "voice:Good.@1"]);
}

// Signed out: the device's voice, without calling the server; signing in brings the real voice back.
{
  log.length = 0;
  let token = null;
  const srv = server();
  const synth = createCloudSynth(fakeBase(), { getToken: async () => token, fetchImpl: srv.fetchImpl, AudioImpl: FakeAudio });
  synth.speak(utter("Signed out.")); await tick(20);
  token = "tok";
  synth.speak(utter("Signed in.")); await tick(20);
  eq("signed out uses the device; after sign-in the real voice", log, ["device:Signed out.", "voice:Signed in.@1"]);
  eq("server only asked once signed in", srv.calls.map(c => c.text), ["Signed in."]);
}

// Cancel stops the line playing and drops the rest.
{
  log.length = 0;
  const srv = server();
  const synth = createCloudSynth(fakeBase(), { getToken: async () => "tok", fetchImpl: srv.fetchImpl, AudioImpl: FakeAudio });
  const a = utter("First."), b = utter("Second.");
  synth.speak(a); synth.speak(b);
  await tick(1);
  synth.cancel();
  await tick(30);
  eq("cancel pauses the current line and nothing else plays", log, ["voice:First.@1", "pause:First."]);
  eq("the stopped line reports it was interrupted; the dropped one says nothing", [a.events, b.events], [["start", "error:interrupted"], []]);
  eq("quiet after cancel", synth.speaking, false);
}

// Server helpers.
eq("Ben has the ElevenLabs voice; others don't", [!!voiceFor("ben"), voiceFor("mira"), voiceFor(undefined)], [true, null, null]);
eq("text is tidied", cleanTtsText("  Hello \n  there  "), { text: "Hello there" });
eq("empty and oversized text refused", [cleanTtsText("   ").error, cleanTtsText("a".repeat(MAX_TTS_CHARS + 1)).error], ["empty", "too_long"]);

if (fail) { console.log(`\n${fail} failing`); process.exit(1); }
console.log("\nall cloud voice tests passed");
