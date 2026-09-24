// Thin wrapper around the web-push library, configured once with this project's VAPID keys. Only
// the cron delivery endpoint imports this — it's the one place that actually sends a push, and
// the reason that one endpoint (unlike every other api/*.js in this project) can't run on the
// Edge runtime: web-push depends on Node's crypto/https modules for VAPID JWT signing and payload
// encryption, neither of which exists in the Edge runtime's Web-standard-only environment.
import webpush from "web-push";

let configured = false;
function ensureConfigured() {
  if (configured) return;
  webpush.setVapidDetails(process.env.VAPID_SUBJECT, process.env.VITE_VAPID_PUBLIC_KEY, process.env.VAPID_PRIVATE_KEY);
  configured = true;
}

export async function sendPush(subscription, payload) {
  ensureConfigured();
  const sub = { endpoint: subscription.endpoint, keys: { p256dh: subscription.p256dh, auth: subscription.auth_key } };
  try {
    await webpush.sendNotification(sub, JSON.stringify(payload));
    return { ok: true };
  } catch (err) {
    // A 404/410 means the browser unsubscribed or the subscription expired — the caller uses
    // this to know it's safe to delete the row rather than let it fail the same way forever.
    return { ok: false, gone: err.statusCode === 404 || err.statusCode === 410, error: err.message };
  }
}
