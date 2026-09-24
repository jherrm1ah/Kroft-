// Vercel Edge Function: reconciles a whole category of scheduled push notifications for the
// signed-in user in one call, rather than tracking add/edit/delete separately per item. The
// client sends the complete current set of items under a given key prefix (e.g. every upcoming
// appointment reminder, prefix "appt:"); this replaces exactly that prefix's rows with exactly
// that set — anything previously scheduled that isn't in the new list (rescheduled away, marked
// done, or deleted) is removed, so a stale row can never fire after its source no longer calls
// for it. That makes this self-healing: if a client ever falls out of sync, the next full resync
// (fired whenever the underlying data changes — see the effect in Kroft.jsx) corrects it, rather
// than requiring every mutation call site to remember to also cancel/reschedule a push.
export const config = { runtime: "edge" };

import { getAuthedUser, supabaseAdmin, jsonResponse } from "../_lib/supabaseAdmin.js";

export default async function handler(req) {
  if (req.method !== "POST") return jsonResponse({ error: "Method not allowed" }, 405);
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    return jsonResponse({ error: "Push isn't available without Supabase configured." }, 501);
  }
  const user = await getAuthedUser(req);
  if (!user) return jsonResponse({ error: "Not authenticated" }, 401);

  let body;
  try { body = await req.json(); } catch { return jsonResponse({ error: "Invalid request body" }, 400); }
  const prefix = typeof body?.prefix === "string" ? body.prefix.trim() : "";
  const items = Array.isArray(body?.items) ? body.items : null;
  if (!prefix || !items) return jsonResponse({ error: "Missing prefix/items" }, 400);

  // Every write is validated locally rather than trusted, same principle as applyAiAction on the
  // client — a malformed item (missing fields, an unparseable date, a key that doesn't actually
  // belong to this prefix) is dropped rather than stored.
  const clean = [];
  for (const it of items) {
    const clientKey = typeof it?.clientKey === "string" ? it.clientKey.trim() : "";
    const firesAt = it?.firesAt;
    const title = typeof it?.title === "string" ? it.title.trim() : "";
    if (!clientKey || !clientKey.startsWith(prefix) || !firesAt || isNaN(new Date(firesAt).getTime()) || !title) continue;
    clean.push({
      user_id: user.id,
      client_key: clientKey,
      fires_at: new Date(firesAt).toISOString(),
      title,
      body: typeof it.body === "string" ? it.body.trim() : "",
      tag: typeof it.tag === "string" && it.tag ? it.tag : "kroft:reminder",
      sent: false,
    });
  }

  const admin = supabaseAdmin();
  const { data: existing, error: readError } = await admin
    .from("scheduled_notifications")
    .select("client_key")
    .eq("user_id", user.id)
    .like("client_key", `${prefix}%`);
  if (readError) return jsonResponse({ error: "Couldn't read current schedule" }, 500);

  const keepKeys = new Set(clean.map(c => c.client_key));
  const staleKeys = (existing || []).map(r => r.client_key).filter(k => !keepKeys.has(k));

  if (staleKeys.length) {
    const { error: delError } = await admin.from("scheduled_notifications").delete().eq("user_id", user.id).in("client_key", staleKeys);
    if (delError) return jsonResponse({ error: "Couldn't clear stale schedule entries" }, 500);
  }
  if (clean.length) {
    const { error: upError } = await admin.from("scheduled_notifications").upsert(clean, { onConflict: "user_id,client_key" });
    if (upError) return jsonResponse({ error: "Couldn't schedule notifications" }, 500);
  }
  return jsonResponse({ ok: true, scheduled: clean.length, removed: staleKeys.length });
}
