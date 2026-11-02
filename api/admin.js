// The owner's admin page (Profile › Admin): people, activity, AI health and cost, feedback,
// errors, alerts and backups in one place. Only for the emails in ADMIN_EMAILS (api/_lib/ops.js);
// everyone else gets 404, as if it didn't exist.
//   GET              → { admin: true, ...summary }
//   POST { action: "feedbackDone", id, done }   → marks a piece of feedback dealt with
export const config = { runtime: "edge" };

import { getAuthedUser, supabaseAdmin, jsonResponse } from "./_lib/supabaseAdmin.js";
import { isAdminEmail, proUserIds, prioritiseFeedback } from "./_lib/ops.js";

const ago = days => new Date(Date.now() - days * 86400000).toISOString();
const rows = r => (r?.error ? [] : r?.data || []);

// Counts from a list of { created_at, last_sign_in_at } (pure, tested).
export function peopleCounts(users, now = Date.now()) {
  const within = (iso, days) => iso && now - new Date(iso).getTime() < days * 86400000;
  return { total: users.length, new7: users.filter(u => within(u.created_at, 7)).length, new1: users.filter(u => within(u.created_at, 1)).length };
}
export function activeCounts(kvRows, now = Date.now()) {
  const users = days => new Set(kvRows.filter(r => now - new Date(r.updated_at).getTime() < days * 86400000).map(r => r.user_id)).size;
  return { today: users(1), week: users(7) };
}
export function aiSummary(log, costDays) {
  const failed = log.filter(r => r.status !== 200);
  const byDay = new Map();
  for (const d of costDays) {
    const e = byDay.get(d.day) || { day: d.day, requests: 0, failed: 0, cost: 0 };
    e.requests += Number(d.requests) || 0; e.failed += Number(d.failed) || 0; e.cost += Number(d.est_cost_usd) || 0;
    byDay.set(d.day, e);
  }
  return {
    last24: { requests: log.length, failed: failed.length, lastError: failed[0]?.error || null },
    days: [...byDay.values()].sort((a, b) => b.day.localeCompare(a.day)).map(d => ({ ...d, cost: Math.round(d.cost * 10000) / 10000 })),
  };
}

export default async function handler(req) {
  const user = await getAuthedUser(req).catch(() => null);
  if (!user || !isAdminEmail(user.email)) return jsonResponse({ error: "Not found" }, 404);
  const admin = supabaseAdmin();

  if (req.method === "POST") {
    const body = await req.json().catch(() => ({}));
    if (body?.action === "feedbackDone" && Number.isFinite(Number(body.id))) {
      const { error } = await admin.from("user_feedback").update({ done: body.done !== false }).eq("id", Number(body.id));
      return jsonResponse({ ok: !error }, error ? 500 : 200);
    }
    return jsonResponse({ error: "Unknown action" }, 400);
  }
  if (req.method !== "GET") return jsonResponse({ error: "Method not allowed" }, 405);

  const [usersRes, kv, log, cost, feedback, errors, alerts, backups] = await Promise.all([
    admin.auth.admin.listUsers({ page: 1, perPage: 1000 }),
    admin.from("kv_store").select("user_id, updated_at").gt("updated_at", ago(7)).limit(5000),
    admin.from("ai_request_log").select("status, error, created_at").gt("created_at", ago(1)).order("created_at", { ascending: false }).limit(2000),
    admin.from("ai_cost_daily").select("day, requests, failed, est_cost_usd").gte("day", ago(7).slice(0, 10)),
    admin.from("user_feedback").select("id, created_at, kind, message, screen, email, done, user_id").order("done").order("created_at", { ascending: false }).limit(30),
    admin.from("client_errors_recent").select("*").limit(10),
    admin.from("alert_events").select("created_at, title, body, delivered").order("created_at", { ascending: false }).limit(10),
    admin.from("kv_store_backups").select("day").order("day", { ascending: false }).limit(1),
  ]);
  // Priority support: Pro customers' feedback goes to the top. Without a plan column yet, nobody is Pro.
  const ids = [...new Set(rows(feedback).map(f => f.user_id).filter(Boolean))];
  const subs = ids.length ? await admin.from("subscriptions").select("user_id, status, plan").in("user_id", ids) : null;
  const pro = proUserIds(rows(subs));
  return jsonResponse({
    admin: true,
    people: peopleCounts(usersRes?.data?.users || []),
    active: activeCounts(rows(kv)),
    ai: aiSummary(rows(log), rows(cost)),
    feedback: prioritiseFeedback(rows(feedback), pro),
    errors: rows(errors),
    alerts: rows(alerts),
    lastBackup: rows(backups)[0]?.day || null,
  });
}
