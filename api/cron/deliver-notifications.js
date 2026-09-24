// Node.js serverless function — deliberately NOT `runtime: "edge"` like the rest of api/*.js,
// because web-push (see api/_lib/webpush.js) needs Node's crypto/https modules, unavailable on
// Edge. Delivers any scheduled_notifications rows that are due.
//
// Triggered by a GitHub Actions scheduled workflow every 5 minutes (see
// .github/workflows/deliver-notifications.yml) — not Vercel's own Cron Jobs product, because this
// project is on the Hobby plan, where Vercel Cron is limited to once a day and can't deliver a
// reminder anywhere near its real time. The once-daily entry in vercel.json's `crons` still
// exists as a free, redundant safety net in case the GitHub Actions trigger is ever delayed,
// rate-limited, or disabled — either trigger hits this same endpoint, and a notification already
// marked `sent` is simply skipped, so there's no double-delivery risk from having both.
import { supabaseAdmin } from "../_lib/supabaseAdmin.js";
import { sendPush } from "../_lib/webpush.js";

export default async function handler(req, res) {
  const auth = req.headers.authorization || "";
  if (auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    return res.status(200).json({ delivered: 0, note: "Supabase not configured" });
  }

  const admin = supabaseAdmin();
  const nowIso = new Date().toISOString();
  const { data: due, error } = await admin
    .from("scheduled_notifications")
    .select("id, user_id, title, body, tag")
    .eq("sent", false)
    .lte("fires_at", nowIso)
    .limit(200);
  if (error) return res.status(500).json({ error: "Couldn't read due notifications" });
  if (!due?.length) return res.status(200).json({ delivered: 0 });

  let delivered = 0, failed = 0;
  for (const notif of due) {
    const { data: subs } = await admin
      .from("push_subscriptions")
      .select("id, endpoint, p256dh, auth_key")
      .eq("user_id", notif.user_id);

    if (!subs?.length) {
      // Nobody to push to (never subscribed, or every subscription since expired) — mark it sent
      // anyway so this row isn't retried forever with nowhere to deliver it.
      await admin.from("scheduled_notifications").update({ sent: true }).eq("id", notif.id);
      continue;
    }

    let anySent = false;
    for (const sub of subs) {
      const result = await sendPush(sub, { title: notif.title, body: notif.body, tag: notif.tag });
      if (result.ok) anySent = true;
      else if (result.gone) await admin.from("push_subscriptions").delete().eq("id", sub.id);
    }
    await admin.from("scheduled_notifications").update({ sent: true }).eq("id", notif.id);
    if (anySent) delivered++; else failed++;
  }

  return res.status(200).json({ delivered, failed, checked: due.length });
}
