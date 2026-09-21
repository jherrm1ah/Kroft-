import { getAuthedUser, supabaseAdmin, jsonResponse } from "../_lib/supabaseAdmin.js";
import { stripeRequest } from "../_lib/stripe.js";

// Opens Stripe's hosted Customer Portal — the real place to update a payment method, view past
// invoices, or cancel. KROFT never implements any of that logic itself; whatever the user does
// there flows back through api/billing/webhook.js to update their real status here.
export const config = { runtime: "edge" };

export default async function handler(req) {
  if (req.method !== "POST") return jsonResponse({ error: "Method not allowed" }, 405);

  const secretKey = process.env.STRIPE_SECRET_KEY;
  if (!secretKey) return jsonResponse({ error: "Billing isn't configured on the server yet." }, 501);

  const user = await getAuthedUser(req);
  if (!user) return jsonResponse({ error: "Not authenticated" }, 401);

  const { data } = await supabaseAdmin()
    .from("subscriptions")
    .select("stripe_customer_id")
    .eq("user_id", user.id)
    .maybeSingle();
  if (!data?.stripe_customer_id) {
    // No Stripe customer yet means they've never even started checkout — nothing to manage.
    return jsonResponse({ error: "No billing account yet. Upgrade to KROFT Plus first." }, 409);
  }

  const origin = new URL(req.url).origin;
  const { ok, data: session, status } = await stripeRequest(secretKey, "POST", "billing_portal/sessions", {
    customer: data.stripe_customer_id,
    return_url: `${origin}/?billing=portal_return`,
  });
  if (!ok) return jsonResponse({ error: "Could not open the billing portal.", detail: session }, status);

  return jsonResponse({ url: session.url });
}
