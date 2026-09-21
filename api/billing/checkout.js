import { getAuthedUser, supabaseAdmin, jsonResponse } from "../_lib/supabaseAdmin.js";
import { stripeRequest } from "../_lib/stripe.js";

// Starts a real Stripe Checkout session for KROFT Plus. Nothing here marks the user as
// subscribed — that only ever happens in api/billing/webhook.js once Stripe confirms an actual
// payment. This endpoint just gets them to Stripe's hosted, PCI-compliant checkout page; KROFT
// never sees or handles card details itself.
export const config = { runtime: "edge" };

export default async function handler(req) {
  if (req.method !== "POST") return jsonResponse({ error: "Method not allowed" }, 405);

  const secretKey = process.env.STRIPE_SECRET_KEY;
  const priceId = process.env.STRIPE_PRICE_ID;
  if (!secretKey || !priceId) {
    return jsonResponse({ error: "Billing isn't configured on the server yet." }, 501);
  }

  const user = await getAuthedUser(req);
  if (!user) return jsonResponse({ error: "Not authenticated" }, 401);

  const admin = supabaseAdmin();
  const { data: existing } = await admin
    .from("subscriptions")
    .select("stripe_customer_id")
    .eq("user_id", user.id)
    .maybeSingle();

  let customerId = existing?.stripe_customer_id;
  if (!customerId) {
    // First time this user has ever started checkout — create their Stripe Customer now so
    // the webhook has somewhere to attach the subscription to, and so a repeat checkout (e.g.
    // they cancel then resubscribe later) reuses the same customer instead of creating a new
    // one every time.
    const { ok, data, status } = await stripeRequest(secretKey, "POST", "customers", {
      email: user.email,
      metadata: { supabase_user_id: user.id },
    });
    if (!ok) return jsonResponse({ error: "Could not create a Stripe customer.", detail: data }, status);
    customerId = data.id;
    await admin.from("subscriptions").upsert(
      { user_id: user.id, stripe_customer_id: customerId },
      { onConflict: "user_id" }
    );
  }

  const origin = new URL(req.url).origin;
  const { ok, data, status } = await stripeRequest(secretKey, "POST", "checkout/sessions", {
    mode: "subscription",
    customer: customerId,
    client_reference_id: user.id,
    line_items: [{ price: priceId, quantity: 1 }],
    subscription_data: { metadata: { supabase_user_id: user.id } },
    success_url: `${origin}/?billing=success`,
    cancel_url: `${origin}/?billing=cancelled`,
  });
  if (!ok) return jsonResponse({ error: "Could not start checkout.", detail: data }, status);

  return jsonResponse({ url: data.url });
}
