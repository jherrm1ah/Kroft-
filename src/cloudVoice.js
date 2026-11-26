// Real voices for Kroft. Wraps window.speechSynthesis with a stand-in that has the same shape
// (speak/cancel/speaking/getVoices/voiceschanged), so every existing speak path in Kroft.jsx
// keeps working unchanged. An utterance tagged with a persona that has a cloud voice
// (u.kroftPersona, see CLOUD_PERSONAS) is spoken by fetching an MP3 from api/tts.js and playing
// it; everything else, and any line the server can't voice (not set up, signed out, daily limit,
// offline, an error), goes to the device's own speech engine exactly as before.
//
// Lines are fetched as soon as they're queued, so the next sentence is usually ready by the time
// the current one finishes, with no gap between them.

export const CLOUD_PERSONAS = new Set(["ben"]);

const clampRate = r => Math.min(2, Math.max(0.5, Number(r) || 1));

export function createCloudSynth(base, { getToken, getClient, fetchImpl, AudioImpl, endpoint = "/api/tts" } = {}) {
  const doFetch = fetchImpl || ((...a) => fetch(...a));
  const Audio = AudioImpl || (typeof window !== "undefined" ? window.Audio : null);
  // Once the server says it can't voice anything (not configured, signed out, over the daily
  // limit), stop asking for the rest of this session and use the device's voice.
  let cloudOff = !Audio;
  let queue = [];        // { u, audio: Promise<string|null>, abort }
  let current = null;    // { u, player, url }
  let gen = 0;           // bumped by cancel(); stale callbacks check it

  const synth = {
    get speaking() { return !!current || queue.length > 0 || base.speaking; },
    get pending() { return queue.length > 0 || base.pending; },
    get paused() { return base.paused; },
    getVoices: () => base.getVoices(),
    addEventListener: (...a) => base.addEventListener?.(...a),
    removeEventListener: (...a) => base.removeEventListener?.(...a),
    get onvoiceschanged() { return base.onvoiceschanged; },
    set onvoiceschanged(fn) { base.onvoiceschanged = fn; },
    pause: () => { current?.player?.pause(); base.pause?.(); },
    resume: () => { current?.player?.play?.().catch?.(() => {}); base.resume?.(); },

    speak(u) {
      if (cloudOff || !u?.kroftPersona || !CLOUD_PERSONAS.has(u.kroftPersona) || !String(u.text || "").trim()) {
        base.speak(u);
        return;
      }
      const abort = new AbortController();
      queue.push({ u, abort, audio: fetchAudio(u, abort.signal) });
      drain();
    },

    cancel() {
      gen++;
      const was = current;
      const dropped = queue;
      queue = []; current = null;
      dropped.forEach(q => q.abort.abort());
      if (was?.player) { try { was.player.pause(); } catch { /* already stopped */ } release(was.url); }
      base.cancel();
      // A line the device was speaking gets its error from base.cancel() itself.
      if (was && !was.viaBase) was.u.onerror?.({ error: "interrupted", utterance: was.u });
    },
  };

  async function fetchAudio(u, signal) {
    try {
      const token = await getToken?.();
      if (!token) return null; // signed out right now: the device's voice, until they sign in
      const res = await doFetch(endpoint, {
        method: "POST", signal,
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}`, ...(getClient ? { "X-Kroft-Client": getClient() } : {}) },
        body: JSON.stringify({ text: String(u.text), voice: u.kroftPersona }),
      });
      if (!res.ok) {
        // 503 not set up, 429 daily limit, 404 no voice: nothing will change this session.
        // 401 (an expired sign-in) and a 5xx are one bad line; the next one tries again.
        if ([404, 429, 503].includes(res.status)) cloudOff = true;
        return null;
      }
      const blob = await res.blob();
      return URL.createObjectURL(blob);
    } catch {
      return null;
    }
  }

  function release(url) { if (url) try { URL.revokeObjectURL(url); } catch { /* fine */ } }

  // Speaks one queued line with the device's voice (the cloud couldn't voice it), keeping it as
  // the current line until it ends so the next one never talks over it.
  function viaDevice(u, myGen) {
    const onend = u.onend, onerror = u.onerror;
    const restore = () => { u.onend = onend; u.onerror = onerror; };
    current = { u, player: null, url: null, viaBase: true };
    const done = (handler, e) => {
      restore();
      if (myGen !== gen) { handler?.call(u, e); return; }
      current = null;
      handler?.call(u, e);
      drain();
    };
    u.onend = e => done(onend, e);
    u.onerror = e => done(onerror, e);
    base.speak(u);
  }

  function drain() {
    if (current || !queue.length) return;
    const item = queue.shift();
    const myGen = gen;
    current = { u: item.u, player: null, url: null };
    item.audio.then(url => {
      if (myGen !== gen) { release(url); return; }
      if (!url) { viaDevice(item.u, myGen); return; }
      const player = new Audio(url);
      current.player = player; current.url = url;
      player.playbackRate = clampRate(item.u.rate);
      player.onended = () => {
        if (myGen !== gen) return;
        current = null; release(url);
        item.u.onend?.({ utterance: item.u });
        drain();
      };
      player.onerror = () => {
        if (myGen !== gen) return;
        current = null; release(url);
        item.u.onerror?.({ error: "audio-failed", utterance: item.u });
        drain();
      };
      item.u.onstart?.({ utterance: item.u });
      const played = player.play();
      // Autoplay refused (no tap on the page yet): say it with the device's voice instead.
      if (played?.catch) played.catch(() => { if (myGen === gen) { release(url); viaDevice(item.u, myGen); } });
    });
  }

  return synth;
}

// Swaps window.speechSynthesis for the cloud-aware stand-in. Safe to call once at start-up,
// after any native shim (src/native.js) has installed its own speechSynthesis.
export function installCloudVoice(opts) {
  if (typeof window === "undefined" || !window.speechSynthesis || window.__kroftCloudVoice) return;
  const synth = createCloudSynth(window.speechSynthesis, opts);
  window.__kroftCloudVoice = true;
  try { Object.defineProperty(window, "speechSynthesis", { value: synth, configurable: true }); }
  catch { try { window.speechSynthesis = synth; } catch { return; } }
}
