// Tests for src/realtime.js (live voice) and api/_lib/realtime.js (its session settings), with a
// fake server, a fake OpenAI and a fake WebRTC connection. Run with: npm test
import { startLiveSession, LiveUnavailable } from "./realtime.js";
import { liveSessionConfig, liveInstructions, KROFT_ACTION_TOOL, LIVE_LIMITS, MAX_INSTRUCTION_CHARS } from "../api/_lib/realtime.js";

let fail = 0;
const eq = (name, got, want) => { if (JSON.stringify(got) !== JSON.stringify(want)) { fail++; console.log("FAIL", name, "\n  got ", JSON.stringify(got), "\n  want", JSON.stringify(want)); } else console.log("ok  ", name); };
const tick = (ms = 0) => new Promise(r => setTimeout(r, ms));

function fakeWorld({ keyStatus = 200, keyBody = { value: "ek_test", expiresAt: 1, model: "gpt-realtime", maxMinutes: 3 }, callOk = true, micOk = true } = {}) {
  const w = { requests: [], sent: [], pc: null, stoppedTracks: 0 };
  w.fetch = async (url, init) => {
    w.requests.push({ url, method: init.method, headers: init.headers, body: init.body });
    if (url === "/api/realtime") return { ok: keyStatus === 200, status: keyStatus, json: async () => (keyStatus === 200 ? keyBody : { error: keyBody.error || "x" }) };
    if (url === "https://api.openai.com/v1/realtime/calls") return { ok: callOk, status: callOk ? 201 : 500, text: async () => "answer-sdp" };
    throw new Error("unexpected " + url);
  };
  const track = { stop() { w.stoppedTracks++; } };
  w.getUserMedia = async () => { if (!micOk) throw new Error("denied"); return { getTracks: () => [track] }; };
  w.RTCPeerConnection = class {
    constructor() { w.pc = this; this.connectionState = "new"; this.closed = false; }
    addTrack() {}
    createDataChannel(name) { this.dc = { name, readyState: "open", send: m => w.sent.push(JSON.parse(m)), close() { this.readyState = "closed"; } }; return this.dc; }
    async createOffer() { return { type: "offer", sdp: "offer-sdp" }; }
    async setLocalDescription(d) { this.local = d; }
    async setRemoteDescription(d) { this.remote = d; }
    close() { this.closed = true; }
  };
  w.audioElement = {};
  w.emit = ev => w.pc.dc.onmessage({ data: JSON.stringify(ev) });
  return w;
}
const deps = w => ({ fetch: w.fetch, getUserMedia: w.getUserMedia, RTCPeerConnection: w.RTCPeerConnection, audioElement: w.audioElement });

// Connecting: key from Kroft's server, signed in, then the offer to OpenAI with that key.
{
  const w = fakeWorld();
  const states = [];
  const s = await startLiveSession({ instructions: "You are Kroft.", authHeaders: async () => ({ Authorization: "Bearer user-token" }), onState: x => states.push(x), deps: deps(w) });
  eq("asks Kroft's server first, signed in, with the instructions", [w.requests[0].url, w.requests[0].headers.Authorization, JSON.parse(w.requests[0].body)], ["/api/realtime", "Bearer user-token", { instructions: "You are Kroft." }]);
  eq("sends the offer to OpenAI with the short-lived key, as SDP", [w.requests[1].url, w.requests[1].headers.Authorization, w.requests[1].headers["Content-Type"], w.requests[1].body], ["https://api.openai.com/v1/realtime/calls", "Bearer ek_test", "application/sdp", "offer-sdp"]);
  eq("uses OpenAI's answer and the oai-events channel", [w.pc.remote, w.pc.dc.name], [{ type: "answer", sdp: "answer-sdp" }, "oai-events"]);
  eq("listening once connected, with the plan's time limit", [states.at(-1), s.maxMinutes], ["listening", 3]);
  s.stop();
}

// Conversation events and an action.
{
  const w = fakeWorld();
  const seen = { states: [], user: [], assistant: [], done: [], tools: [] };
  const live = await startLiveSession({
    deps: deps(w),
    onState: x => seen.states.push(x), onUserText: t => seen.user.push(t), onAssistantText: t => seen.assistant.push(t), onAssistantDone: t => seen.done.push(t),
    onToolCall: async (name, args) => { seen.tools.push([name, args]); return { result: "Expense added: Fuel" }; },
  });
  seen.states.length = 0;
  w.emit({ type: "input_audio_buffer.speech_started" });
  w.emit({ type: "input_audio_buffer.speech_stopped" });
  w.emit({ type: "conversation.item.input_audio_transcription.completed", transcript: " Log 5000 for fuel " });
  w.emit({ type: "response.output_audio_transcript.delta", delta: "Done, " });
  w.emit({ type: "response.output_audio_transcript.delta", delta: "logged it." });
  w.emit({ type: "response.output_audio_transcript.done", transcript: "Done, logged it." });
  w.emit({ type: "response.done" });
  eq("states follow the conversation", seen.states, ["listening", "thinking", "speaking", "speaking", "listening"]);
  eq("what the person said", seen.user, ["Log 5000 for fuel"]);
  eq("Kroft's words as they're spoken, then in full", [seen.assistant, seen.done], [["Done, ", "Done, logged it."], ["Done, logged it."]]);
  w.emit({ type: "response.function_call_arguments.done", name: "kroft_action", call_id: "call_1", arguments: JSON.stringify({ action: { type: "add_expense", label: "Fuel", amount: 5000, cat: "Transport" } }) });
  await tick(5);
  eq("the action reaches the app", seen.tools, [["kroft_action", { action: { type: "add_expense", label: "Fuel", amount: 5000, cat: "Transport" } }]]);
  eq("the result goes back to OpenAI, then Kroft carries on", w.sent, [
    { type: "conversation.item.create", item: { type: "function_call_output", call_id: "call_1", output: JSON.stringify({ result: "Expense added: Fuel" }) } },
    { type: "response.create" },
  ]);
  live.stop();
}

// Ending: by hand, at the time limit, and when the connection drops; each cleans up once.
{
  const w = fakeWorld({ keyBody: { value: "ek", maxMinutes: 0.0005 } });
  const ends = [];
  const s = await startLiveSession({ deps: deps(w), onEnd: r => ends.push(r) });
  await tick(60);
  eq("ends itself at the time limit, closing the connection and the mic", [ends, w.pc.closed, w.stoppedTracks], [["time_limit"], true, 1]);
  s.stop();
  eq("stopping again does nothing", ends, ["time_limit"]);
  const w2 = fakeWorld();
  const ends2 = [];
  const s2 = await startLiveSession({ deps: deps(w2), onEnd: r => ends2.push(r) });
  w2.pc.connectionState = "failed"; w2.pc.onconnectionstatechange();
  eq("a dropped connection ends it", ends2, ["disconnected"]);
}

// Not starting: the reason comes back so the app can fall back to standard voice mode.
{
  const reasons = [];
  for (const opts of [{ keyStatus: 429, keyBody: { error: "daily_limit" } }, { keyStatus: 503, keyBody: { error: "not_configured" } }, { micOk: false }, { callOk: false }]) {
    const w = fakeWorld(opts);
    try { await startLiveSession({ deps: deps(w) }); reasons.push("started"); }
    catch (e) { reasons.push(e instanceof LiveUnavailable ? e.code : "other"); }
  }
  eq("daily limit, not set up, no mic, OpenAI refusing: each reported", reasons, ["daily_limit", "not_configured", "mic_denied", "connect_failed"]);
}

// Session settings sent when the key is made.
{
  const c = liveSessionConfig({ instructions: "You are Kroft." });
  eq("a realtime session with Kroft's voice, transcription and natural turn-taking", [c.type, c.model, c.audio.output.voice, c.audio.input.transcription.model, c.audio.input.turn_detection.type, c.audio.input.turn_detection.interrupt_response], ["realtime", "gpt-realtime", "cedar", "gpt-4o-mini-transcribe", "semantic_vad", true]);
  eq("one tool: kroft_action", [c.tools.length, c.tools[0].name, c.tools[0].type, KROFT_ACTION_TOOL.parameters.required], [1, "kroft_action", "function", ["action"]]);
  eq("instructions keep Kroft's own and add the live rules", [c.instructions.startsWith("You are Kroft."), /call the kroft_action function/.test(c.instructions), /Never call it for delete_\* or send_email/.test(c.instructions)], [true, true, true]);
  eq("oversized instructions are cut", liveInstructions("x".repeat(MAX_INSTRUCTION_CHARS + 500)).startsWith("x".repeat(MAX_INSTRUCTION_CHARS) + "\n"), true);
  eq("limits: free is short, paid is generous", [LIVE_LIMITS.free.perDay < LIVE_LIMITS.paid.perDay, LIVE_LIMITS.free.maxMinutes < LIVE_LIMITS.paid.maxMinutes], [true, true]);
}

if (fail) { console.log(`\n${fail} failing`); process.exit(1); }
console.log("\nall live voice tests passed");
process.exit(0);
