// Live voice conversations with Kroft: OpenAI Realtime, speech to speech, over WebRTC.
//
// 1. Ask Kroft's server (api/realtime.js) for a short-lived key. The server fixes the session:
//    instructions with the person's data, voice, turn-taking and the kroft_action tool.
// 2. Open a peer connection with the microphone, send the offer to OpenAI with that key, and
//    play the voice that comes back. Turn-taking and interruptions happen on OpenAI's side.
// 3. Events arrive on the "oai-events" data channel: what the person said, what Kroft is saying,
//    and tool calls, which the app runs (onToolCall) and answers so Kroft can carry on.
//
// Event and field names follow the openai npm package's realtime types.

const CALLS_URL = "https://api.openai.com/v1/realtime/calls";

export class LiveUnavailable extends Error {
  constructor(code, status) { super(code); this.code = code; this.status = status; }
}

export async function startLiveSession({
  instructions, authHeaders, endpoint = "/api/realtime",
  onState, onUserText, onAssistantText, onAssistantDone, onToolCall, onError, onEnd,
  deps = {},
} = {}) {
  const fetchImpl = deps.fetch || ((...a) => fetch(...a));
  const PC = deps.RTCPeerConnection || window.RTCPeerConnection;
  const getMic = deps.getUserMedia || (c => navigator.mediaDevices.getUserMedia(c));
  if (!PC) throw new LiveUnavailable("no_webrtc");

  // 1. Key from Kroft's server.
  const keyRes = await fetchImpl(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(await authHeaders?.()) },
    body: JSON.stringify({ instructions }),
  }).catch(() => null);
  if (!keyRes) throw new LiveUnavailable("unreachable");
  if (!keyRes.ok) {
    const body = await keyRes.json().catch(() => ({}));
    throw new LiveUnavailable(body.error || "live_unavailable", keyRes.status);
  }
  const { value: key, maxMinutes } = await keyRes.json();

  // 2. Microphone and connection.
  let mic;
  try {
    mic = await getMic({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
  } catch {
    throw new LiveUnavailable("mic_denied");
  }
  const pc = new PC();
  const player = deps.audioElement || Object.assign(document.createElement("audio"), { autoplay: true });
  pc.ontrack = e => { player.srcObject = e.streams[0]; };
  mic.getTracks().forEach(t => pc.addTrack(t, mic));
  const dc = pc.createDataChannel("oai-events");

  let ended = false;
  let timer = null;
  const send = ev => { if (dc.readyState === "open") dc.send(JSON.stringify(ev)); };
  const stop = (reason = "stopped") => {
    if (ended) return;
    ended = true;
    clearTimeout(timer);
    try { dc.close(); } catch { /* closed */ }
    try { pc.close(); } catch { /* closed */ }
    mic.getTracks().forEach(t => t.stop());
    try { player.srcObject = null; } catch { /* gone */ }
    onEnd?.(reason);
  };

  let reply = "";
  dc.onmessage = async msg => {
    let ev; try { ev = JSON.parse(msg.data); } catch { return; }
    switch (ev.type) {
      case "input_audio_buffer.speech_started": reply = ""; onState?.("listening"); break;
      case "input_audio_buffer.speech_stopped": onState?.("thinking"); break;
      case "conversation.item.input_audio_transcription.completed": if (ev.transcript?.trim()) onUserText?.(ev.transcript.trim()); break;
      case "response.output_audio_transcript.delta": reply += ev.delta || ""; onState?.("speaking"); onAssistantText?.(reply); break;
      case "response.output_audio_transcript.done": reply = ev.transcript || reply; onAssistantDone?.(reply); break;
      case "response.done": onState?.("listening"); break;
      case "response.function_call_arguments.done": {
        let args = {}; try { args = JSON.parse(ev.arguments || "{}"); } catch { /* bad JSON: empty */ }
        let output;
        try { output = await onToolCall?.(ev.name, args); } catch { output = { result: "That didn't work." }; }
        send({ type: "conversation.item.create", item: { type: "function_call_output", call_id: ev.call_id, output: JSON.stringify(output ?? { result: "Done." }) } });
        send({ type: "response.create" });
        break;
      }
      case "error": onError?.(ev.error?.message || "Live voice hit a problem."); break;
      default: break;
    }
  };
  pc.onconnectionstatechange = () => { if (["failed", "closed", "disconnected"].includes(pc.connectionState)) stop("disconnected"); };

  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  let answer = null;
  try {
    const r = await fetchImpl(CALLS_URL, { method: "POST", headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/sdp" }, body: offer.sdp });
    if (r.ok) answer = await r.text();
  } catch { /* handled below */ }
  if (!answer) { stop("connect_failed"); throw new LiveUnavailable("connect_failed"); }
  await pc.setRemoteDescription({ type: "answer", sdp: answer });

  onState?.("listening");
  // Ends on its own at the plan's limit, so nobody leaves a conversation running by accident.
  if (maxMinutes) timer = setTimeout(() => stop("time_limit"), maxMinutes * 60000);
  return { stop, maxMinutes, mic, player };
}
