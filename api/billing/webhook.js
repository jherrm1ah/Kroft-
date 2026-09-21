import { supabaseAdmin, jsonResponse } from "../_lib/supabaseAdmin.js";
import { verifyStripeWebhookSignature, applyStripeEvent } from "../_lib/stripe.js";

// The only place "subscribed" is ever allowed to become true. Stripe calls this directly (no
// Supabase JWT — see verifyStripeWebhookSignature for how this request is actually
// authenticated instead) whenever a checkout completes or a subscription's status changes.
// The actual per-event-type logic lives in api/_lib/stripe.js's applyStripeEvent, factored out
// so it can be unit-tested with a fake admin client instead of a live Supabase project.
export const config = { runtime: "edge" };

export default async function handler(req) {
  if (req.method !== "POST") return jsonResponse({ error: "Method not allowed" }, 405);

  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  const secretKey = process.env.STRIPE_SECRET_KEY;
  if (!webhookSecret || !secretKey) return jsonResponse({ error: "Billing isn't configured on the server yet." }, 501);

  const rawBody = await req.text();
  const signatureValid = await verifyStripeWebhookSignature(rawBody, req.headers.get("stripe-signature"), webhookSecret);
  if (!signatureValid) return jsonResponse({ error: "Invalid signature" }, 400);

  let event;
  try {
    event = JSON.parse(rawBody);
  } catch {
    return jsonResponse({ error: "Invalid payload" }, 400);
  }

  await applyStripeEvent(supabaseAdmin(), secretKey, event);

  // Stripe expects a fast 2xx ack regardless of what the event needed done, else it retries
  // (and eventually gives up and flags the endpoint as failing in the Stripe dashboard).
  return jsonResponse({ received: true });
}
