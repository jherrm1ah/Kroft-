// Plays KROFT's sounds (src/sounds/defs.js) with the Web Audio API: no sound files to download.
// One switch turns every sound off (Profile › Appearance › Sounds), remembered on the device.
// Browsers only allow sound after the person has tapped something on the page; until then
// play() quietly does nothing.

import { SOUNDS, ATTACK, POP_DROP, POP_TIME, OVERTONE } from "./defs.js";

let ctx = null;

function audio() {
  if (typeof window === "undefined") return null;
  const Ctx = window.AudioContext || window.webkitAudioContext;
  if (!Ctx) return null;
  if (!ctx) { try { ctx = new Ctx(); } catch { return null; } }
  if (ctx.state === "suspended") ctx.resume().catch(() => {});
  return ctx;
}

// Call from a tap so later sounds (a countdown's end, an alarm) are allowed to play.
export const unlockSounds = () => { audio(); };

const KEY = "kroft-sounds";
export const soundsOn = () => { try { return localStorage.getItem(KEY) !== "off"; } catch { return true; } };
export const setSoundsOn = on => { try { localStorage.setItem(KEY, on ? "on" : "off"); } catch { /* this session only */ } };

function tone(ac, n, t0) {
  const start = t0 + n.at;
  const parts = n.wood ? [[n.f, 1]] : [[n.f, 1], [n.f * 2, OVERTONE]];
  for (const [f, level] of parts) {
    const osc = ac.createOscillator();
    const gain = ac.createGain();
    osc.type = n.wood ? "triangle" : "sine";
    osc.frequency.setValueAtTime(f * POP_DROP, start);
    osc.frequency.exponentialRampToValueAtTime(f, start + POP_TIME);
    if (n.glideTo) osc.frequency.exponentialRampToValueAtTime(n.glideTo * (f / n.f), start + n.len * 0.8);
    const peak = Math.max(0.0002, n.gain * level);
    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.exponentialRampToValueAtTime(peak, start + ATTACK);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + n.len);
    osc.connect(gain).connect(ac.destination);
    osc.start(start);
    osc.stop(start + n.len + 0.02);
  }
}

// Plays a sound by name ("signature", "payment", "sent", "done", "alarm", "tick", …) unless sounds
// are switched off.
export function play(name) {
  if (!soundsOn()) return;
  const notes = SOUNDS[name];
  const ac = notes && audio();
  if (!ac) return;
  const t0 = ac.currentTime + 0.01;
  for (const n of notes) tone(ac, n, t0);
}
