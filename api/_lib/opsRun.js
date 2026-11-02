// The checks api/cron/deliver-notifications.js runs every 5 minutes (Node runtime, since sending
// a push needs it): raise alerts (src: api/_lib/ops.js), send new ones to the admins' phones and
// browsers, and once a day take the backup copy. Each part is independent and never stops the
// reminders the cron is there for; before the ops tables exist, the parts that need them skip.
import { aiAlert, errorAlerts, feedbackAlerts, newAlerts, adminEmails } from "./ops.js";
import { sendPush } from "./webpush.js";

const ago = minutes => new Date(Date.now() - minutes * 60000).toISOString();

export async function raiseAlerts(admin) {
  const [ai, errs, fb, recent] = await Promise.all([
    admin.from("ai_request_log").select("status, error").gt("created_at", ago(15)),
    admin.from("client_error_log").select("kind, message, count, user_id, ip_hash").gt("created_at", ago(60)),
    admin.from("user_feedback").select("id, kind, message, screen").gt("created_at", ago(60)),
    admin.from("alert_events").select("key, created_at").gt("created_at", ago(7 * 24 * 60)),
  ]);
  if (recent.error) return 0;   // no alert_events table yet
  const candidates = [aiAlert(ai.data || []), ...errorAlerts(errs.data || []), ...feedbackAlerts(fb.data || [])].filter(Boolean);
  const fresh = newAlerts(candidates, recent.data || []);
  if (fresh.length) await admin.from("alert_events").insert(fresh.map(({ key, title, body }) => ({ key, title, body })));
  return fresh.length;
}

export async function deliverAlerts(admin) {
  const { data: pending, error } = await admin.from("alert_events").select("id, title, body").eq("delivered", 0).gt("created_at", ago(120));
  if (error || !pending?.length) return 0;
  const emails = adminEmails();
  let ids = [];
  if (emails.length) {
    const { data } = await admin.auth.admin.listUsers({ page: 1, perPage: 1000 });
    ids = (data?.users || []).filter(u => emails.includes(String(u.email || "").toLowerCase())).map(u => u.id);
  }
  const { data: subs } = ids.length ? await admin.from("push_subscriptions").select("id, endpoint, p256dh, auth_key").in("user_id", ids) : { data: [] };
  for (const a of pending) {
    let n = 0;
    for (const sub of subs || []) {
      const r = await sendPush(sub, { title: a.title, body: a.body, tag: `kroft-alert-${a.id}` });
      if (r.ok) n++;
      else if (r.gone) await admin.from("push_subscriptions").delete().eq("id", sub.id);
    }
    // -1: nowhere to send it (no admin with notifications on); it still shows on the admin page.
    await admin.from("alert_events").update({ delivered: n || -1 }).eq("id", a.id);
  }
  return pending.length;
}

export async function backupOncePerDay(admin) {
  const today = new Date().toISOString().slice(0, 10);
  const { data, error } = await admin.from("kv_store_backups").select("day").order("day", { ascending: false }).limit(1);
  if (error || data?.[0]?.day === today) return null;
  const { data: copied, error: rpcError } = await admin.rpc("backup_kv_store");
  return rpcError ? null : copied;
}

export async function runOps(admin) {
  const out = {};
  for (const [name, fn] of [["alerts", raiseAlerts], ["sent", deliverAlerts], ["backup", backupOncePerDay]]) {
    try { out[name] = await fn(admin); } catch (e) { out[name] = `failed: ${String(e?.message || e).slice(0, 80)}`; }
  }
  return out;
}
