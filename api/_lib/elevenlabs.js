// Kroft's spoken voice: ElevenLabs text-to-speech. api/tts.js turns one sentence or short
// passage into an MP3 the app plays (src/cloudVoice.js); when this isn't set up, or fails, the
// app falls back to the phone's own built-in voice, so speech never stops working.
//
// Set ELEVENLABS_API_KEY in Vercel (Secret, server only). Optional overrides:
//   ELEVENLABS_MODEL       default "eleven_flash_v2_5" (fast and low-cost, made for live replies)
//   ELEVENLABS_VOICE_BEN   default "Eric – Smooth, Trustworthy"
// https://elevenlabs.io/docs/api-reference/text-to-speech/convert

const API = "https://api.elevenlabs.io/v1";
export const DEFAULT_TTS_MODEL = "eleven_flash_v2_5";

// Kroft persona → ElevenLabs voice. Only personas listed here speak with ElevenLabs; the others
// keep using the device's voice.
export const PERSONA_VOICES = {
  ben: () => process.env.ELEVENLABS_VOICE_BEN || "cjVigY5qzO86Huf0OWal", // Eric – Smooth, Trustworthy
};

// One request speaks at most this much: the app sends a sentence or two at a time.
export const MAX_TTS_CHARS = 800;

export function voiceFor(persona) {
  const pick = PERSONA_VOICES[String(persona || "")];
  return pick ? pick() : null;
}

// Trims and collapses whitespace; refuses empty or oversized text.
export function cleanTtsText(text) {
  const t = String(text ?? "").replace(/\s+/g, " ").trim();
  if (!t) return { error: "empty" };
  if (t.length > MAX_TTS_CHARS) return { error: "too_long" };
  return { text: t };
}

// Returns the upstream Response (audio/mpeg body on success). 15s budget: a voice line that
// hasn't started by then is better spoken by the device's own voice.
export async function synthesize({ text, voiceId, apiKey, model }) {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), 15000);
  try {
    return await fetch(`${API}/text-to-speech/${encodeURIComponent(voiceId)}?output_format=mp3_44100_64`, {
      method: "POST",
      signal: abort.signal,
      headers: { "xi-api-key": apiKey, "Content-Type": "application/json", Accept: "audio/mpeg" },
      body: JSON.stringify({ text, model_id: model || DEFAULT_TTS_MODEL }),
    });
  } finally {
    clearTimeout(timer);
  }
}
