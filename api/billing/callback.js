import { supabaseAdmin } from "../_lib/supabaseAdmin.js";
import { verifyTransaction, applyChargeEvent } from "../_lib/flutterwave.js";

// Flutterwave redirects the user's browser here after checkout (the redirect_url passed to
// initializeCheckout in api/billing/checkout.js), with status/tx_ref/transaction_id as query
// params. Flutterwave's own integration guidance is explicit that this redirect is not proof
// of payment by itself — only a server-side verify call against transaction_id is — so that's
// what this does before ever marking anyone as subscribed. This is the fast path for "just
// paid, update the UI now"; api/billing/webhook.js is the durable path that also keeps status
// in sync for renewals that happen later with no browser present at all.
export const config = { runtime: "edge" };

export default async function handler(req) {
  const url = new URL(req.url);
  const origin = url.origin;
  const status = url.searchParams.get("status");
  const transactionId = url.searchParams.get("transaction_id");

  if (status !== "successful" || !transactionId) {
    return redirectTo(origin, "cancelled");
  }

  const secretKey = process.env.FLUTTERWAVE_SECRET_KEY;
  if (!secretKey) return redirectTo(origin, "error", "not_configured");

  const verifyResult = await verifyTransaction(secretKey, transactionId);
  if (!verifyResult.ok) return redirectTo(origin, "error", "verification_failed");

  const transaction = verifyResult.transaction;
  // Belt-and-suspenders on top of the verify call itself: confirm Flutterwave's own record
  // agrees the charge succeeded, not just that the API call to check it succeeded.
  if (transaction.status !== "successful") return redirectTo(origin, "error", "payment_not_successful");

  const admin = supabaseAdmin();
  const applyResult = await applyChargeEvent(admin, transaction, secretKey);
  if (applyResult.duplicateSubscriptionPrevented) {
    // The user just paid for a second subscription while an active one already existed on
    // file (the checkout-race writeSubscriptionState guards against) — logged so this is
    // actually visible rather than a silent no-op, since a real charge just happened.
    console.error("billing/callback: prevented a duplicate subscription and auto-cancelled it", { userId: applyResult.userId, transactionId: transaction.id });
  }
  if (!applyResult.ok) {
    // A real DB error while claiming this transaction for idempotent processing — NOT a normal
    // "payment failed". The charge itself is real (verified above); leave it for
    // api/billing/webhook.js's retried delivery to finish activating Plus rather than risk
    // double-applying it here, and tell the user honestly that confirmation is still pending.
    return redirectTo(origin, "error", "processing_delayed");
  }

  if (applyResult.duplicate && applyResult.userId) {
    // "duplicate" means another delivery (the webhook, most likely) holds or held the claim for
    // this transaction — not that its write is confirmed done (see applyChargeEvent's comment on
    // this race). Confirm the real subscriptions row before telling the user Plus is active,
    // rather than trusting a claim that could still be in flight or could have just failed.
    const { data } = await admin.from("subscriptions").select("status").eq("user_id", applyResult.userId).maybeSingle();
    if (data?.status !== "active") return redirectTo(origin, "error", "processing_delayed");
  }

  return redirectTo(origin, "success");
}

function redirectTo(origin, status, detail) {
  const dest = new URL(origin);
  dest.searchParams.set("billing", status);
  if (detail) dest.searchParams.set("billing_error", detail);
  return new Response(null, { status: 302, headers: { Location: dest.toString() } });
}
