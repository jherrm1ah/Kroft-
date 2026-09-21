import { supabaseAdmin } from "../_lib/supabaseAdmin.js";
import { verifyTransaction, applyChargeCompleted } from "../_lib/flutterwave.js";

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

  const result = await verifyTransaction(secretKey, transactionId);
  if (!result.ok) return redirectTo(origin, "error", "verification_failed");

  const transaction = result.transaction;
  // Belt-and-suspenders on top of the verify call itself: confirm Flutterwave's own record
  // agrees the charge succeeded, not just that the API call to check it succeeded.
  if (transaction.status !== "successful") return redirectTo(origin, "error", "payment_not_successful");

  await applyChargeCompleted(supabaseAdmin(), transaction);

  return redirectTo(origin, "success");
}

function redirectTo(origin, status, detail) {
  const dest = new URL(origin);
  dest.searchParams.set("billing", status);
  if (detail) dest.searchParams.set("billing_error", detail);
  return new Response(null, { status: 302, headers: { Location: dest.toString() } });
}
