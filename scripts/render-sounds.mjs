// Writes KROFT's sounds (src/sounds/defs.js) to WAV files, using the same notes, tone and envelope
// as the app's player (src/sounds/player.js):
//   node scripts/render-sounds.mjs                 → android/app/src/main/res/raw/kroft_notify.wav
//   node scripts/render-sounds.mjs <folder>        → also every sound as <name>.wav in <folder>
// The Android notification sound has to be a file inside the app, so it's generated here and
// committed; re-run this after changing the signature in defs.js.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SOUNDS, ATTACK, POP_DROP, POP_TIME, OVERTONE, duration } from "../src/sounds/defs.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const RATE = 44100;

export function render(name) {
  const total = Math.ceil((duration(name) + 0.05) * RATE);
  const out = new Float32Array(total);
  for (const n of SOUNDS[name]) {
    const parts = n.wood ? [[n.f, 1]] : [[n.f, 1], [n.f * 2, OVERTONE]];
    for (const [f, level] of parts) {
      const peak = Math.max(0.0002, n.gain * level);
      const s0 = Math.floor(n.at * RATE), len = Math.floor(n.len * RATE);
      let phase = 0;
      for (let i = 0; i < len && s0 + i < total; i++) {
        const t = i / RATE;
        // Pitch: starts sharp and falls to the note (the "pop"), then glides if asked.
        let freq = t < POP_TIME ? f * Math.pow(POP_DROP, 1 - t / POP_TIME) : f;
        if (n.glideTo && t >= POP_TIME) freq = f * Math.pow(n.glideTo / n.f, Math.min(1, (t - POP_TIME) / (n.len * 0.8 - POP_TIME)));
        phase += 2 * Math.PI * freq / RATE;
        const env = t < ATTACK ? 0.0001 * Math.pow(peak / 0.0001, t / ATTACK) : peak * Math.pow(0.0001 / peak, (t - ATTACK) / (n.len - ATTACK));
        const wave = n.wood ? (2 / Math.PI) * Math.asin(Math.sin(phase)) : Math.sin(phase);
        out[s0 + i] += env * wave;
      }
    }
  }
  return out;
}

export function wav(samples) {
  const buf = Buffer.alloc(44 + samples.length * 2);
  buf.write("RIFF", 0); buf.writeUInt32LE(36 + samples.length * 2, 4); buf.write("WAVE", 8);
  buf.write("fmt ", 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(RATE, 24); buf.writeUInt32LE(RATE * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34);
  buf.write("data", 36); buf.writeUInt32LE(samples.length * 2, 40);
  for (let i = 0; i < samples.length; i++) buf.writeInt16LE(Math.round(Math.max(-1, Math.min(1, samples[i])) * 32767), 44 + i * 2);
  return buf;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const raw = path.join(ROOT, "android/app/src/main/res/raw");
  fs.mkdirSync(raw, { recursive: true });
  // A notification plays at the phone's notification volume, next to other apps' sounds, so the
  // file is brought up to a normal level (peak 85%) rather than the app's quieter in-page level.
  const sig = render("signature");
  const peak = sig.reduce((m, v) => Math.max(m, Math.abs(v)), 0);
  fs.writeFileSync(path.join(raw, "kroft_notify.wav"), wav(sig.map(v => v * (0.85 / peak))));
  console.log("wrote android/app/src/main/res/raw/kroft_notify.wav");
  const dir = process.argv[2];
  if (dir) {
    fs.mkdirSync(dir, { recursive: true });
    for (const name of Object.keys(SOUNDS)) fs.writeFileSync(path.join(dir, `${name}.wav`), wav(render(name)));
    console.log(`wrote ${Object.keys(SOUNDS).length} samples to ${dir}`);
  }
}
