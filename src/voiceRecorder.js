// Speech-to-text for phones and browsers that have no built-in speech recognizer: some Android
// phones (Huawei and others sold without Google services) have no speech service at all, and
// Firefox has no SpeechRecognition. This records the microphone, notices when the person stops
// talking, and has KROFT's AI backend (/api/chat) transcribe the clip.
//
// It exposes the same small slice of the Web Speech API that Kroft.jsx already uses (lang,
// continuous, interimResults, start/stop/abort, onstart/onresult/onerror/onend), so every mic
// button works with it unchanged. The difference people notice: words appear once they stop
// talking rather than while they speak.

const TARGET_RATE = 16000;   // plenty for speech, and keeps a 30s clip around 1 MB
const MAX_SECONDS = 60;      // hard cap on a single clip
const SPEECH_LEVEL = 0.018;  // RMS above this counts as talking
const NO_SPEECH_MS = 8000;   // nothing said at all: end like a browser recognizer would
const END_SILENCE_MS = 1300; // pause after speaking that ends a phrase (non-continuous mode)

// Mono Float32 samples at `rate` -> 16-bit PCM WAV bytes at TARGET_RATE.
export function encodeWav(samples, rate) {
  const ratio = rate / TARGET_RATE;
  const outLen = ratio > 1 ? Math.floor(samples.length / ratio) : samples.length;
  const outRate = ratio > 1 ? TARGET_RATE : rate;
  const buf = new ArrayBuffer(44 + outLen * 2);
  const v = new DataView(buf);
  const str = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  str(0, "RIFF"); v.setUint32(4, 36 + outLen * 2, true); str(8, "WAVE");
  str(12, "fmt "); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, outRate, true); v.setUint32(28, outRate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  str(36, "data"); v.setUint32(40, outLen * 2, true);
  for (let i = 0; i < outLen; i++) {
    // Averages the source samples that fall into each output sample (a simple low-pass), so
    // downsampling doesn't alias.
    let s;
    if (ratio > 1) {
      const a = Math.floor(i * ratio), b = Math.min(samples.length, Math.floor((i + 1) * ratio));
      let sum = 0; for (let j = a; j < b; j++) sum += samples[j];
      s = b > a ? sum / (b - a) : 0;
    } else s = samples[i];
    s = Math.max(-1, Math.min(1, s));
    v.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return new Uint8Array(buf);
}

export function bytesToBase64(bytes) {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

// Sends the clip to /api/chat (Gemini understands audio) and returns the words, or "" if nothing
// was said. Uses the signed-in session like every other AI call.
export async function transcribeClip(base64Wav, lang) {
  const headers = { "Content-Type": "application/json", "x-kroft-usage-type": "transcribe" };
  const { supabase, isSupabaseConfigured } = await import("./supabaseClient.js");
  if (isSupabaseConfigured) {
    const { data: { session } = {} } = await supabase.auth.getSession();
    if (!session) throw Object.assign(new Error("Not signed in"), { code: "not-allowed" });
    headers.Authorization = `Bearer ${session.access_token}`;
  }
  const res = await fetch("/api/chat", {
    method: "POST",
    headers,
    body: JSON.stringify({
      max_tokens: 1024,
      system: "You are a speech-to-text engine. Write down exactly what is said in the audio, in the language it is spoken"
        + (lang ? ` (most likely ${lang})` : "")
        + ". Reply with the transcript only: no quotes, labels, timestamps or commentary. If nobody speaks, reply with nothing.",
      messages: [{ role: "user", content: [
        { type: "audio", source: { type: "base64", media_type: "audio/wav", data: base64Wav } },
        { type: "text", text: "Transcribe this." },
      ] }],
    }),
  });
  if (!res.ok) throw new Error(`transcribe ${res.status}`);
  const data = await res.json();
  const text = (data.content || []).map(b => b.text || "").join("").trim();
  // The model sometimes describes silence instead of returning nothing.
  return /^\(?\[?(no speech|silence|inaudible)[\].)]*$/i.test(text) ? "" : text;
}

// ensurePermission: optional async () => boolean, used in the app to ask Android for the
// microphone first. transcribe: injectable for tests.
export function createRecorderRecognition({ ensurePermission, transcribe = transcribeClip } = {}) {
  let active = null;

  return class RecorderRecognition {
    constructor() {
      Object.assign(this, { lang: "", continuous: false, interimResults: false, maxAlternatives: 1, onstart: null, onresult: null, onerror: null, onend: null });
      this._done = true;
    }

    _emit(text, isFinal) {
      const result = Object.assign([{ transcript: text, confidence: isFinal ? 0.9 : 0.5 }], { isFinal, length: 1 });
      this.onresult?.({ resultIndex: 0, results: [result] });
    }

    _release() {
      clearInterval(this._tick);
      try { this._node?.disconnect(); this._src?.disconnect(); } catch { /* already gone */ }
      this._stream?.getTracks().forEach(t => t.stop());
      this._ctx?.close?.().catch?.(() => {});
      this._node = this._src = this._stream = this._ctx = null;
    }

    _finish(error) {
      if (this._done) return;
      this._done = true;
      this._release();
      if (active === this) active = null;
      if (error) this.onerror?.({ error });
      this.onend?.({});
    }

    async start() {
      if (active && active !== this) active.abort();
      active = this;
      Object.assign(this, { _done: false, _aborted: false, _chunks: [], _heard: false, _lastLoud: 0, _stopping: false });
      try {
        if (ensurePermission && !(await ensurePermission())) return this._finish("not-allowed");
        if (!navigator.mediaDevices?.getUserMedia) return this._finish("audio-capture");
        const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, channelCount: 1 } });
        if (this._done) { stream.getTracks().forEach(t => t.stop()); return; }
        const Ctx = window.AudioContext || window.webkitAudioContext;
        const ctx = new Ctx();
        if (ctx.state === "suspended") await ctx.resume().catch(() => {});
        const src = ctx.createMediaStreamSource(stream);
        const node = ctx.createScriptProcessor(4096, 1, 1);
        node.onaudioprocess = e => {
          if (this._done || this._stopping) return;
          const data = e.inputBuffer.getChannelData(0);
          this._chunks.push(new Float32Array(data));
          let sum = 0; for (let i = 0; i < data.length; i++) sum += data[i] * data[i];
          if (Math.sqrt(sum / data.length) > SPEECH_LEVEL) { this._heard = true; this._lastLoud = Date.now(); }
        };
        src.connect(node); node.connect(ctx.destination);
        Object.assign(this, { _stream: stream, _ctx: ctx, _src: src, _node: node, _rate: ctx.sampleRate, _startedAt: Date.now() });
        this.onstart?.({});
        this._tick = setInterval(() => {
          const now = Date.now();
          if (now - this._startedAt > MAX_SECONDS * 1000) return this.stop();
          if (this.continuous) return; // voice memos: only stop() ends it
          if (!this._heard && now - this._startedAt > NO_SPEECH_MS) return this._finish("no-speech");
          if (this._heard && now - this._lastLoud > END_SILENCE_MS) this.stop();
        }, 200);
      } catch (err) {
        const name = err?.name || "";
        this._finish(name === "NotAllowedError" || name === "SecurityError" ? "not-allowed" : name === "NotFoundError" ? "audio-capture" : "network");
      }
    }

    async stop() {
      if (this._done || this._stopping) return;
      this._stopping = true;
      clearInterval(this._tick);
      const chunks = this._chunks, rate = this._rate, heard = this._heard;
      this._release();
      if (!heard || !chunks.length) return this._finish(this.continuous ? null : "no-speech");
      const total = chunks.reduce((n, c) => n + c.length, 0);
      const all = new Float32Array(total);
      let off = 0; for (const c of chunks) { all.set(c, off); off += c.length; }
      try {
        const text = await transcribe(bytesToBase64(encodeWav(all, rate)), this.lang);
        if (this._done || this._aborted) return;
        if (!text) return this._finish(this.continuous ? null : "no-speech");
        this._emit(text, true);
        this._finish(null);
      } catch (err) {
        this._finish(err?.code === "not-allowed" ? "not-allowed" : "network");
      }
    }

    abort() {
      if (this._done) return;
      this._aborted = true;
      this._finish(null);
    }
  };
}
