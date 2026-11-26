// Vercel Edge Function: starts a live voice conversation (OpenAI Realtime, speech to speech).
// Returns a short-lived client key the app uses to connect straight to OpenAI over WebRTC
// (src/realtime.js), so the real OPENAI_API_KEY never leaves the server. Everything about the
// session (Kroft's instructions with the person's own data, the voice, turn-taking, the one tool
// for saving things) is fixed here, when the key is made.
//
// Signed-in only, and capped: each started conversation is logged in ai_request_log
// (usage_type "live") and counted per day, and the app ends a conversation at maxMinutes.
// Request body: { instructions } — the same system prompt as typed chat (Kroft.jsx krofSysPrompt).
// Reply: { value, expiresAt, model, maxMinutes }.
// Shapes follow the openai npm package's realtime types (POST /v1/realtime/client_secrets).
export const config = { runtime: "edge" };

import { getAuthedUser, supabaseAdmin, jsonResponse } from "./_lib/supabaseAdmin.js";
import { liveSessionConfig, LIVE_LIMITS, DEFAULT_REALTIME_MODEL } from "./_lib/realtime.js";

export default async function handler(req, ctx) {
  if (req.method !== "POST") return jsonResponse({ error: "Method not allowed" }, 405);
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey || !process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) return jsonResponse({ error: "not_configured" }, 503);

  const user = await getAuthedUser(req);
  if (!user) return jsonResponse({ error: "Not authenticated" }, 401);

  let body;
  try { body = await req.json(); } catch { return jsonResponse({ error: "Invalid request body" }, 400); }

  const admin = supabaseAdmin();
  const { data: sub } = await admin.from("subscriptions").select("status").eq("user_id", user.id).maybeSingle();
  const plan = sub?.status === "active" ? "paid" : "free";
  const limits = LIVE_LIMITS[plan];
  const dayStart = new Date().toISOString().slice(0, 10) + "T00:00:00Z";
  const { count } = await admin.from("ai_request_log").select("id", { count: "exact", head: true })
    .eq("user_id", user.id).eq("usage_type", "live").gte("created_at", dayStart);
  if ((count || 0) >= limits.perDay) return jsonResponse({ error: "daily_limit", perDay: limits.perDay }, 429);

  const model = process.env.OPENAI_REALTIME_MODEL || DEFAULT_REALTIME_MODEL;
  const session = liveSessionConfig({ instructions: body?.instructions, model, voice: process.env.OPENAI_REALTIME_VOICE });
  const startedAt = Date.now();
  let res = null;
  try {
    res = await fetch("https://api.openai.com/v1/realtime/client_secrets", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      // The key only has to last until the app connects; the conversation itself continues after.
      body: JSON.stringify({ expires_after: { anchor: "created_at", seconds: 120 }, session }),
    });
  } catch { res = null; }
  const data = res?.ok ? await res.json().catch(() => null) : null;
  const ok = !!data?.value;

  const log = Promise.resolve(admin.from("ai_request_log").insert({
    user_id: user.id, plan: plan === "paid" ? "plus" : "free", usage_type: "live", model, streamed: true,
    latency_ms: Date.now() - startedAt, status: ok ? 200 : (res?.status || 504),
    error: ok ? null : `live_${res?.status || "unreachable"}`, system_chars: session.instructions.length,
    client: (req.headers.get("x-kroft-client") || "").slice(0, 200) || null,
  })).catch(() => {});
  if (ctx?.waitUntil) ctx.waitUntil(log);

  if (!ok) return jsonResponse({ error: "live_unavailable" }, 502);
  return jsonResponse({ value: data.value, expiresAt: data.expires_at, model, maxMinutes: limits.maxMinutes });
}
