import { getAuthedUser, supabaseAdmin, jsonResponse } from "../_lib/supabaseAdmin.js";
import { cancelSubscription } from "../_lib/flutterwave.js";

// Cancels KROFT Plus directly — Flutterwave has no hosted self-serve portal the way Stripe
// does, so this is the app itself calling Flutterwave's cancel-subscription API on the user's
// behalf, confirmed by them first in the UI (see Kroft.jsx's onManageBilling), not a redirect
// to a page Flutterwave hosts.
export const config = { runtime: "edge" };

export default async function handler(req) {
  if (req.method !== "POST") return jsonResponse({ error: "Method not allowed" }, 405);

  const secretKey = process.env.FLUTTERWAVE_SECRET_KEY;
  if (!secretKey) return jsonResponse({ error: "Billing isn't configured on the server yet." }, 501);

  const user = await getAuthedUser(req);
  if (!user) return jsonResponse({ error: "Not authenticated" }, 401);

  const admin = supabaseAdmin();
  const { data } = await admin.from("subscriptions").select("provider_subscription_id").eq("user_id", user.id).maybeSingle();
  if (!data?.provider_subscription_id) {
    return jsonResponse({ error: "No active subscription to cancel." }, 409);
  }

  const result = await cancelSubscription(secretKey, data.provider_subscription_id);
  if (!result.ok) return jsonResponse({ error: "Could not cancel with Flutterwave.", detail: result.detail }, 502);

  // Update immediately rather than waiting on the subscription.cancelled webhook — the user is
  // sitting on this exact screen waiting for confirmation, and the webhook (best-effort,
  // eventually consistent) will simply confirm the same state again shortly after.
  await admin.from("subscriptions").update({ status: "canceled" }).eq("user_id", user.id);

  return jsonResponse({ ok: true });
}
