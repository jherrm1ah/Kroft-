// Shared server-side helpers for Stripe billing (api/billing/*). Uses raw fetch against
// Stripe's REST API rather than the `stripe` npm package — Stripe's API is plain form-encoded
// HTTP, and calling it directly keeps this consistent with the rest of the codebase's
// Edge-runtime-only, no-heavy-SDK style (see api/_lib/google.js), with nothing to worry about
// re: Node-vs-Edge SDK compatibility.

const STRIPE_API_VERSION = "2024-06-20"; // pinned so Stripe's own default-version changes over
// time can't silently alter this integration's behavior underneath it.

// Stripe's API takes nested params as bracket-notated form fields, e.g.
// line_items[0][price]=price_xxx or subscription_data[metadata][supabase_user_id]=<uid> — this
// flattens a plain nested JS object into that shape.
function flattenParams(obj, prefix, params) {
  for (const [key, value] of Object.entries(obj)) {
    if (value === undefined || value === null) continue;
    const paramKey = prefix ? `${prefix}[${key}]` : key;
    if (Array.isArray(value)) {
      value.forEach((item, i) => {
        const arrKey = `${paramKey}[${i}]`;
        if (item !== null && typeof item === "object") flattenParams(item, arrKey, params);
        else params.append(arrKey, String(item));
      });
    } else if (typeof value === "object") {
      flattenParams(value, paramKey, params);
    } else {
      params.append(paramKey, String(value));
    }
  }
}

export async function stripeRequest(secretKey, method, path, body) {
  const init = {
    method,
    headers: {
      Authorization: `Bearer ${secretKey}`,
      "Stripe-Version": STRIPE_API_VERSION,
    },
  };
  if (body) {
    const params = new URLSearchParams();
    flattenParams(body, "", params);
    init.headers["Content-Type"] = "application/x-www-form-urlencoded";
    init.body = params.toString();
  }
  const res = await fetch(`https://api.stripe.com/v1/${path}`, init);
  const data = await res.json().catch(() => null);
  return { ok: res.ok, status: res.status, data };
}

// Verifies Stripe's webhook signature per their documented scheme
// (https://docs.stripe.com/webhooks#verify-manually): the Stripe-Signature header carries
// t=<unix timestamp>,v1=<hex hmac>[,v0=...]; the signed payload is "<timestamp>.<raw body>",
// HMAC-SHA256'd with the webhook's signing secret. This is the only thing standing between
// "a real payment happened" and "anyone who finds this URL can POST a fake
// subscription-activated event" — there's no Supabase JWT on this request to check instead,
// since Stripe (not our own frontend) is the caller.
export async function verifyStripeWebhookSignature(rawBody, sigHeader, secret) {
  if (!sigHeader) return false;
  const parts = Object.fromEntries(
    sigHeader.split(",").map((p) => {
      const idx = p.indexOf("=");
      return [p.slice(0, idx), p.slice(idx + 1)];
    })
  );
  const timestamp = parts.t;
  const v1 = parts.v1;
  if (!timestamp || !v1) return false;

  // Reject a signature outside a 5-minute window — without this, a captured/logged webhook
  // payload could be replayed indefinitely to re-trigger e.g. a "subscription activated" event.
  const age = Date.now() / 1000 - Number(timestamp);
  if (!Number.isFinite(age) || age > 300 || age < -60) return false;

  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sigBytes = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${timestamp}.${rawBody}`))
  );
  const expectedHex = Array.from(sigBytes).map((b) => b.toString(16).padStart(2, "0")).join("");

  if (expectedHex.length !== v1.length) return false;
  // Constant-time compare, same reasoning as the OAuth state signature in api/_lib/google.js —
  // a plain === would leak timing information an attacker could use to forge a valid signature
  // byte by byte.
  let diff = 0;
  for (let i = 0; i < expectedHex.length; i++) diff |= expectedHex.charCodeAt(i) ^ v1.charCodeAt(i);
  return diff === 0;
}

// ---- Subscription sync (used by api/billing/webhook.js) ----
//
// Factored out here, taking `admin` as a parameter rather than constructing it internally, so
// this business logic can be unit-tested directly with a fake admin object standing in for
// Supabase — the same approach used for Google's token-refresh logic in api/_lib/google.js.

// checkout.session.completed only carries a subscription ID, not its current status/period —
// fetching the real subscription object is what actually confirms payment succeeded, rather
// than trusting the mere existence of a completed checkout session.
export async function upsertFromSubscriptionId(admin, secretKey, userId, customerId, subscriptionId) {
  const { ok, data: sub } = await stripeRequest(secretKey, "GET", `subscriptions/${subscriptionId}`);
  await admin.from("subscriptions").upsert(
    {
      user_id: userId,
      stripe_customer_id: customerId,
      stripe_subscription_id: subscriptionId,
      status: ok ? sub.status : "active", // fall back to "active" — the checkout itself completed even if this lookup failed
      current_period_end: ok && sub.current_period_end ? new Date(sub.current_period_end * 1000).toISOString() : null,
    },
    { onConflict: "user_id" }
  );
}

// subscription_data.metadata (set at checkout time in api/billing/checkout.js) is the reliable
// path to the Supabase user id. Falling back to matching our own stored stripe_customer_id
// covers a subscription that somehow lacks that metadata (e.g. one created directly in the
// Stripe dashboard rather than through our checkout).
export async function resolveUserId(admin, subscriptionObject) {
  if (subscriptionObject.metadata?.supabase_user_id) return subscriptionObject.metadata.supabase_user_id;
  const { data } = await admin
    .from("subscriptions")
    .select("user_id")
    .eq("stripe_customer_id", subscriptionObject.customer)
    .maybeSingle();
  return data?.user_id || null;
}

export async function applySubscriptionUpdate(admin, userId, subscriptionObject) {
  await admin.from("subscriptions").upsert(
    {
      user_id: userId,
      stripe_customer_id: subscriptionObject.customer,
      stripe_subscription_id: subscriptionObject.id,
      status: subscriptionObject.status,
      current_period_end: subscriptionObject.current_period_end
        ? new Date(subscriptionObject.current_period_end * 1000).toISOString()
        : null,
    },
    { onConflict: "user_id" }
  );
}

export async function applySubscriptionCancellation(admin, userId) {
  await admin.from("subscriptions").update({ status: "canceled" }).eq("user_id", userId);
}

// Routes one Stripe event to the right sync function. Returns nothing meaningful for event
// types this app doesn't track (invoice.*, payment_intent.*, etc.) — those are acknowledged by
// the caller regardless, per Stripe's own requirement for a fast 2xx on every event received.
export async function applyStripeEvent(admin, secretKey, event) {
  const obj = event.data?.object;
  switch (event.type) {
    case "checkout.session.completed":
      // client_reference_id was set to the Supabase user id in api/billing/checkout.js — the
      // most direct link back to who this checkout belongs to, no metadata lookup needed.
      if (obj.client_reference_id && obj.subscription) {
        await upsertFromSubscriptionId(admin, secretKey, obj.client_reference_id, obj.customer, obj.subscription);
      }
      return;
    case "customer.subscription.created":
    case "customer.subscription.updated": {
      const userId = await resolveUserId(admin, obj);
      if (userId) await applySubscriptionUpdate(admin, userId, obj);
      return;
    }
    case "customer.subscription.deleted": {
      const userId = await resolveUserId(admin, obj);
      if (userId) await applySubscriptionCancellation(admin, userId);
      return;
    }
    default:
      return;
  }
}
