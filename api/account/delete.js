import { getAuthedUser, supabaseAdmin, jsonResponse } from "../_lib/supabaseAdmin.js";
import { getStoredGoogleTokens } from "../_lib/google.js";
import { cancelSubscription } from "../_lib/flutterwave.js";

// Permanently deletes the caller's account. Deleting the auth.users row is what removes their
// data: every table in supabase/schema.sql references auth.users with ON DELETE CASCADE (or SET
// NULL for the payment ledger, which keeps no personal data), so kv_store, oauth_tokens,
// subscriptions, ai_usage, push_subscriptions and scheduled_notifications all go with it.
//
// Before that, two things outside our database are cleaned up:
//   - A live KROFT Plus subscription is cancelled with Flutterwave. If that fails, the account is
//     NOT deleted: deleting it would leave a card being charged with no account left to cancel
//     from. The user is told to try again.
//   - Google access is revoked with Google (best-effort, as in api/google/disconnect.js).
//     Microsoft has no server-side revoke, so deleting our stored token is all that can be done.
export const config = { runtime: "edge" };

export default async function handler(req) {
  if (req.method !== "POST") return jsonResponse({ error: "Method not allowed" }, 405);

  const user = await getAuthedUser(req);
  if (!user) return jsonResponse({ error: "Not authenticated" }, 401);

  const admin = supabaseAdmin();

  const { data: sub } = await admin.from("subscriptions")
    .select("status, provider_subscription_id").eq("user_id", user.id).maybeSingle();
  if (sub?.provider_subscription_id && sub.status !== "canceled") {
    const secretKey = process.env.FLUTTERWAVE_SECRET_KEY;
    const result = secretKey ? await cancelSubscription(secretKey, sub.provider_subscription_id) : { ok: false };
    if (!result.ok) {
      return jsonResponse({ error: "subscription_cancel_failed", detail: result.detail }, 502);
    }
  }

  const google = await getStoredGoogleTokens(admin, user.id).catch(() => null);
  if (google) {
    try {
      await fetch("https://oauth2.googleapis.com/revoke", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ token: google.refresh_token || google.access_token }),
      });
    } catch {
      // Best-effort: our copy is deleted with the account either way.
    }
  }

  const { error } = await admin.auth.admin.deleteUser(user.id);
  if (error) {
    console.error("api/account/delete: deleteUser failed", error);
    return jsonResponse({ error: "delete_failed" }, 500);
  }
  return jsonResponse({ ok: true });
}
