// Vercel Edge Function: registers (POST) or removes (DELETE) this browser's Web Push
// subscription, so the cron delivery endpoint can reach it later — including while the app
// itself is fully closed. Called once the client's service worker successfully subscribes via
// pushManager.subscribe(), and again on unsubscribe (notifications turned off).
export const config = { runtime: "edge" };

import { getAuthedUser, supabaseAdmin, jsonResponse } from "../_lib/supabaseAdmin.js";

export default async function handler(req) {
  if (req.method !== "POST" && req.method !== "DELETE") return jsonResponse({ error: "Method not allowed" }, 405);
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    return jsonResponse({ error: "Push isn't available without Supabase configured." }, 501);
  }
  const user = await getAuthedUser(req);
  if (!user) return jsonResponse({ error: "Not authenticated" }, 401);

  let body;
  try { body = await req.json(); } catch { return jsonResponse({ error: "Invalid request body" }, 400); }
  const endpoint = typeof body?.endpoint === "string" ? body.endpoint.trim() : "";
  if (!endpoint) return jsonResponse({ error: "Missing subscription endpoint" }, 400);

  const admin = supabaseAdmin();

  if (req.method === "DELETE") {
    await admin.from("push_subscriptions").delete().eq("user_id", user.id).eq("endpoint", endpoint);
    return jsonResponse({ ok: true });
  }

  const p256dh = body?.keys?.p256dh, auth = body?.keys?.auth;
  if (!p256dh || !auth) return jsonResponse({ error: "Missing subscription keys" }, 400);

  const { error } = await admin.from("push_subscriptions").upsert(
    { user_id: user.id, endpoint, p256dh, auth_key: auth },
    { onConflict: "user_id,endpoint" }
  );
  if (error) return jsonResponse({ error: "Couldn't save subscription" }, 500);
  return jsonResponse({ ok: true });
}
