// KROFT's sounds, as notes. One file describes every sound, and two players use it: the app
// (src/sounds/player.js, Web Audio) and scripts/render-sounds.mjs, which writes the same notes to
// WAV files (the Android notification sound, and samples to listen to). So what plays in the app
// and what plays as a notification are the same sound.
//
// They're meant to sound like one family: the same soft "pop" tone everywhere (a sine with a
// quiet octave above it, a quick attack and a short pitch drop at the start), and the same few
// notes of G major. The signature (G5 → D6 → B5: up, then settling) is KROFT's own sound; the
// others are built from its notes.
//
// A note: { f: Hz, at: start (s), len: length (s), gain: 0–1, glideTo?: Hz, wood?: true }
//   glideTo slides the pitch over the note (the "sent" swoosh); wood drops the octave overtone
//   and shortens the tone (Quick Reset ticks).

const G5 = 783.99, A5 = 880, B5 = 987.77, D6 = 1174.66, E6 = 1318.51, G6 = 1567.98;

export const NOTES = { G5, A5, B5, D6, E6, G6 };

const signature = [
  { f: G5, at: 0, len: 0.34, gain: 0.30 },
  { f: D6, at: 0.11, len: 0.34, gain: 0.30 },
  { f: B5, at: 0.22, len: 1.05, gain: 0.32 },
  { f: G6, at: 0.22, len: 0.8, gain: 0.05 },
];

export const SOUNDS = {
  // Notifications: the sound people learn to recognise as KROFT.
  signature,
  // A reminder alarm ringing: the signature, stronger (repeated by the alarm screen).
  alarm: signature.map(n => ({ ...n, gain: Math.min(0.45, n.gain * 1.35) })),
  // Money in: a bright step up.
  payment: [
    { f: D6, at: 0, len: 0.22, gain: 0.26 },
    { f: G6, at: 0.09, len: 0.7, gain: 0.28 },
  ],
  // Sent (invoice, quote): a soft rising swoosh landing on a light pop.
  sent: [
    { f: A5, glideTo: E6, at: 0, len: 0.2, gain: 0.12 },
    { f: G6, at: 0.16, len: 0.32, gain: 0.12 },
  ],
  // Something ticked off.
  done: [{ f: G6, at: 0, len: 0.22, gain: 0.2 }],
  // Quick Reset: a wooden tick each second, brighter for the last three…
  tick: [{ f: D6, at: 0, len: 0.05, gain: 0.12, wood: true }],
  tickFinal: [{ f: G6, at: 0, len: 0.06, gain: 0.2, wood: true }],
  // …and the signature, resolving up to G6, when it's over.
  resetDone: [...signature, { f: G6, at: 0.42, len: 1.4, gain: 0.26 }],
};

export const ATTACK = 0.006;       // seconds to full volume
export const POP_DROP = 1.03;      // each note starts 3% sharp…
export const POP_TIME = 0.025;     // …and falls to pitch over 25 ms: the "pop"
export const OVERTONE = 0.18;      // octave above, relative volume (not on wood ticks)

// How long a sound lasts, in seconds.
export const duration = name => Math.max(...SOUNDS[name].map(n => n.at + n.len));
