// Sounds for the Quick Reset countdown, so it can be followed without looking at the screen: a
// wooden tick each second (brighter for the last three) and the KROFT chime when it's over. The
// sounds themselves are KROFT's shared set (src/sounds/defs.js); this adds the Quick Reset's own
// on/off switch, which works alongside the app-wide Sounds switch.

import { play, unlockSounds } from "./sounds/player.js";

export const unlockAudio = unlockSounds;

// The person's choice for Quick Reset, remembered on this device. On unless they turned it off.
const KEY = "kroft-reset-sound";
export const resetSoundOn = () => { try { return localStorage.getItem(KEY) !== "off"; } catch { return true; } };
export const setResetSoundOn = on => { try { localStorage.setItem(KEY, on ? "on" : "off"); } catch { /* stays for this session */ } };

export const playTick = (finalSeconds = false) => play(finalSeconds ? "tickFinal" : "tick");
export const playDone = () => play("resetDone");

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
