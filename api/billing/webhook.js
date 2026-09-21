import { supabaseAdmin, jsonResponse } from "../_lib/supabaseAdmin.js";
import { verifyFlutterwaveWebhookSignature, applyFlutterwaveEvent } from "../_lib/flutterwave.js";

// The durable path for keeping subscription status in sync — covers renewals, which happen via
// Flutterwave's tokenized recurring billing with no browser present at all (unlike the first
// payment, which also gets an immediate check in api/billing/callback.js right after the
// redirect back). Flutterwave calls this directly, authenticated via a static shared secret in
// the verif-hash header (see verifyFlutterwaveWebhookSignature) rather than a Supabase JWT.
export const config = { runtime: "edge" };

export default async function handler(req) {
  if (req.method !== "POST") return jsonResponse({ error: "Method not allowed" }, 405);

  const secretHash = process.env.FLUTTERWAVE_WEBHOOK_SECRET_HASH;
  if (!secretHash) return jsonResponse({ error: "Billing isn't configured on the server yet." }, 501);

  const signatureValid = verifyFlutterwaveWebhookSignature(req.headers.get("verif-hash"), secretHash);
  if (!signatureValid) return jsonResponse({ error: "Invalid signature" }, 401);

  let event;
  try {
    event = JSON.parse(await req.text());
  } catch {
    return jsonResponse({ error: "Invalid payload" }, 400);
  }

  await applyFlutterwaveEvent(supabaseAdmin(), event);

  // Flutterwave expects a fast 2xx ack regardless of what the event needed done, else it
  // retries delivery.
  return jsonResponse({ received: true });
}
