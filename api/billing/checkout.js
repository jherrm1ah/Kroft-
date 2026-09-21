import { getAuthedUser, jsonResponse } from "../_lib/supabaseAdmin.js";
import { initializeCheckout } from "../_lib/flutterwave.js";

// Starts a real Flutterwave Checkout for KROFT Plus. Nothing here marks the user as
// subscribed — that only happens once api/billing/callback.js (the redirect back) or
// api/billing/webhook.js (ongoing renewals) confirm an actual successful charge. This
// endpoint just gets the user to Flutterwave's hosted, PCI-compliant checkout page; KROFT
// never sees or handles card details itself.
export const config = { runtime: "edge" };

export default async function handler(req) {
  if (req.method !== "POST") return jsonResponse({ error: "Method not allowed" }, 405);

  const secretKey = process.env.FLUTTERWAVE_SECRET_KEY;
  const planId = process.env.FLUTTERWAVE_PLAN_ID;
  if (!secretKey || !planId) {
    return jsonResponse({ error: "Billing isn't configured on the server yet." }, 501);
  }

  const user = await getAuthedUser(req);
  if (!user) return jsonResponse({ error: "Not authenticated" }, 401);

  const origin = new URL(req.url).origin;
  const result = await initializeCheckout(secretKey, {
    planId,
    email: user.email,
    name: user.user_metadata?.name || user.email,
    userId: user.id,
    redirectUrl: `${origin}/api/billing/callback`,
  });
  if (!result.ok) return jsonResponse({ error: "Could not start checkout.", detail: result.detail }, 502);

  return jsonResponse({ url: result.url });
}
