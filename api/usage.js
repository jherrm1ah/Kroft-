// Vercel Edge Function: reports the signed-in user's current AI usage against their plan's
// configured limits, read straight from plan_limits (see supabase/schema.sql) rather than any
// hardcoded value — this is what lets Kroft.jsx show accurate "X of Y left" UI (today, just for
// voice) without the frontend hardcoding a number that would go stale the moment an admin
// changes the limit in the database.
export const config = { runtime: "edge" };

import { getAuthedUser, supabaseAdmin, jsonResponse } from "./_lib/supabaseAdmin.js";

function currentPeriod(period) {
  const iso = new Date().toISOString();
  return period === "month" ? iso.slice(0, 7) : iso.slice(0, 10);
}

export default async function handler(req) {
  if (req.method !== "GET") return jsonResponse({ error: "Method not allowed" }, 405);

  // Mirrors api/chat.js: with no Supabase configured server-side, there are no accounts and
  // nothing is metered, so there's nothing meaningful to report either.
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    return jsonResponse({ subscribed: false, limits: {} });
  }

  const user = await getAuthedUser(req);
  if (!user) return jsonResponse({ error: "Not authenticated" }, 401);

  const admin = supabaseAdmin();
  const { data: subscription } = await admin.from("subscriptions").select("status").eq("user_id", user.id).maybeSingle();
  if (subscription?.status === "active") return jsonResponse({ subscribed: true, limits: {} });

  const { data: configs } = await admin.from("plan_limits").select("usage_type, period, limit_count, label").eq("plan", "free");

  const limits = {};
  for (const cfg of configs || []) {
    if (cfg.limit_count == null) continue;
    const period = currentPeriod(cfg.period);
    const { data: usage } = await admin.from("ai_usage").select("count").eq("user_id", user.id).eq("usage_type", cfg.usage_type).eq("period", period).maybeSingle();
    limits[cfg.usage_type] = { used: usage?.count || 0, limit: cfg.limit_count, period: cfg.period, label: cfg.label };
  }

  return jsonResponse({ subscribed: false, limits });
}
