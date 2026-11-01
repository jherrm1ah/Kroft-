// Sounds for the Quick Reset countdown, so it can be followed without looking at the screen: a
// soft tick each second (a little brighter for the last three) and a gentle three-note chime when
// it's over. Made with the Web Audio API, so there are no sound files to download.
//
// Browsers only allow sound after the person has tapped something, so unlockAudio() is called
// from the tap that starts a reset.

let ctx = null;

function audio() {
  if (typeof window === "undefined") return null;
  const Ctx = window.AudioContext || window.webkitAudioContext;
  if (!Ctx) return null;
  if (!ctx) { try { ctx = new Ctx(); } catch { return null; } }
  if (ctx.state === "suspended") ctx.resume().catch(() => {});
  return ctx;
}

export const unlockAudio = () => { audio(); };

// The person's choice, remembered on this device. On unless they turned it off.
const KEY = "kroft-reset-sound";
export const resetSoundOn = () => { try { return localStorage.getItem(KEY) !== "off"; } catch { return true; } };
export const setResetSoundOn = on => { try { localStorage.setItem(KEY, on ? "on" : "off"); } catch { /* stays for this session */ } };

// One short note: a sine with a fast attack and an exponential fade.
function note(ac, { freq, start, length, peak, type = "sine" }) {
  const osc = ac.createOscillator();
  const gain = ac.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, start);
  gain.gain.setValueAtTime(0.0001, start);
  gain.gain.exponentialRampToValueAtTime(peak, start + 0.008);
  gain.gain.exponentialRampToValueAtTime(0.0001, start + length);
  osc.connect(gain).connect(ac.destination);
  osc.start(start);
  osc.stop(start + length + 0.02);
}

// A soft wood-block-like tick. finalSeconds = the last three: higher and a bit louder.
export function playTick(finalSeconds = false) {
  const ac = audio();
  if (!ac) return;
  const t = ac.currentTime;
  note(ac, { freq: finalSeconds ? 1320 : 990, start: t, length: 0.06, peak: finalSeconds ? 0.22 : 0.12, type: "triangle" });
}

// "It's over": a rising three-note chime (C6, E6, G6) with a soft overtone, about two seconds.
export function playDone() {
  const ac = audio();
  if (!ac) return;
  const t = ac.currentTime + 0.02;
  [1046.5, 1318.5, 1568].forEach((freq, i) => {
    note(ac, { freq, start: t + i * 0.18, length: 1.6, peak: 0.28 });
    note(ac, { freq: freq * 2, start: t + i * 0.18, length: 0.9, peak: 0.05 });
  });
}

// Keeps the screen on while the countdown runs (a phone that locks itself would pause the timer
// and the final sound). Returns a function that lets it turn off again. Not every browser has it.
export async function keepScreenOn() {
  try {
    const lock = await navigator.wakeLock?.request("screen");
    return () => { lock?.release?.().catch?.(() => {}); };
  } catch {
    return () => {};
  }
}
