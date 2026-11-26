// Vercel Edge Function: speaks a line of Kroft's reply with a real voice (ElevenLabs), returning
// an MP3. The app (src/cloudVoice.js) uses it for personas that have an ElevenLabs voice and
// falls back to the device's own voice on any non-200 reply, so this can fail safely.
//
// Signed-in only. Each spoken line is logged in ai_request_log (usage_type "voice", characters
// in system_chars, never the text) and capped per day so one account can't run up the bill:
// free accounts get a short daily allowance, paying accounts a generous one.
export const config = { runtime: "edge" };

import { getAuthedUser, supabaseAdmin, jsonResponse } from "./_lib/supabaseAdmin.js";
import { voiceFor, cleanTtsText, synthesize, DEFAULT_TTS_MODEL } from "./_lib/elevenlabs.js";

const DAILY_LINES = { free: 40, paid: 400 };

export default async function handler(req, ctx) {
  if (req.method !== "POST") return jsonResponse({ error: "Method not allowed" }, 405);
  const apiKey = process.env.ELEVENLABS_API_KEY;
  if (!apiKey) return jsonResponse({ error: "not_configured" }, 503);
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) return jsonResponse({ error: "not_configured" }, 503);

  const user = await getAuthedUser(req);
  if (!user) return jsonResponse({ error: "Not authenticated" }, 401);

  let body;
  try { body = await req.json(); } catch { return jsonResponse({ error: "Invalid request body" }, 400); }
  const voiceId = voiceFor(body?.voice);
  if (!voiceId) return jsonResponse({ error: "no_cloud_voice" }, 404);
  const { text, error } = cleanTtsText(body?.text);
  if (error) return jsonResponse({ error }, 400);

  const admin = supabaseAdmin();
  const { data: sub } = await admin.from("subscriptions").select("status").eq("user_id", user.id).maybeSingle();
  const plan = sub?.status === "active" ? "paid" : "free";
  const dayStart = new Date().toISOString().slice(0, 10) + "T00:00:00Z";
  const { count } = await admin.from("ai_request_log").select("id", { count: "exact", head: true })
    .eq("user_id", user.id).eq("usage_type", "voice").gte("created_at", dayStart);
  if ((count || 0) >= DAILY_LINES[plan]) return jsonResponse({ error: "daily_limit" }, 429);

  const model = process.env.ELEVENLABS_MODEL || DEFAULT_TTS_MODEL;
  const startedAt = Date.now();
  let upstream;
  try {
    upstream = await synthesize({ text, voiceId, apiKey, model });
  } catch {
    upstream = null;
  }
  const status = upstream?.status || 504;
  const log = Promise.resolve(admin.from("ai_request_log").insert({
    user_id: user.id, plan: plan === "paid" ? "plus" : "free", usage_type: "voice", model, streamed: true,
    latency_ms: Date.now() - startedAt, status: upstream?.ok ? 200 : status,
    error: upstream?.ok ? null : `tts_${status}`, system_chars: text.length,
    client: (req.headers.get("x-kroft-client") || "").slice(0, 200) || null,
  })).catch(() => {});
  if (ctx?.waitUntil) ctx.waitUntil(log);

  if (!upstream?.ok) {
    // ElevenLabs' own codes (401 bad key, 429 out of credits/busy) pass through as a plain
    // failure; the app only needs to know to use the device's voice instead.
    return jsonResponse({ error: "tts_failed" }, upstream ? 502 : 504);
  }
  return new Response(upstream.body, {
    status: 200,
    headers: { "Content-Type": "audio/mpeg", "Cache-Control": "private, max-age=3600" },
  });
}
