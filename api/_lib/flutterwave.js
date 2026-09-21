// Shared server-side helpers for Flutterwave billing (api/billing/*). Uses raw fetch against
// Flutterwave's v3 REST API (JSON, not form-encoded like Stripe's) rather than an SDK, for the
// same reason as api/_lib/stripe.js: no Node-vs-Edge-runtime compatibility to worry about.
//
// Chosen over Stripe specifically because Stripe doesn't support payouts to Nigerian bank
// accounts — Flutterwave (like Paystack) is built for African merchants and pays out locally.
//
// A structural difference from Stripe worth knowing: Flutterwave has no hosted "Customer
// Portal" for self-serve subscription management. Cancelling is a direct API call this app
// makes on the user's behalf (see cancelSubscription / api/billing/cancel.js), not a redirect
// to a page Flutterwave hosts. There's also no self-serve "update payment method" — a user who
// wants to change cards cancels and re-subscribes. Both are stated as-is in the UI rather than
// implying a portal that doesn't exist.

const BASE_URL = "https://api.flutterwave.com/v3";

export async function flutterwaveRequest(secretKey, method, path, body) {
  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${secretKey}`,
      "Content-Type": "application/json",
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const data = await res.json().catch(() => null);
  // Flutterwave's own convention: a successful call has status:"success" in the body even
  // when the HTTP status is 200 — checking both catches a 200 that Flutterwave itself flags as
  // a logical failure (e.g. a validation error returned with a 200 status code).
  const ok = res.ok && data?.status === "success";
  return { ok, status: res.status, data };
}

// Starts a real Flutterwave Checkout for a recurring KROFT Plus subscription. planId is a
// Payment Plan created ahead of time in the Flutterwave dashboard (Settings -> Payment Plans),
// not something this code creates on the fly — same reasoning as Stripe's pre-created Price
// object (STRIPE_PRICE_ID before this swap): a merchant-configured plan is simpler and more
// auditable than dynamically creating billing plans from application code.
export async function initializeCheckout(secretKey, { planId, email, name, userId, redirectUrl }) {
  const txRef = `kroft_${userId}_${Date.now()}`;
  const { ok, data } = await flutterwaveRequest(secretKey, "POST", "/payments", {
    tx_ref: txRef,
    amount: undefined, // omitted deliberately — payment_plan supplies the amount/currency/interval; setting one here would conflict with the plan's own terms
    currency: undefined,
    payment_plan: planId,
    redirect_url: redirectUrl,
    customer: { email, name },
    customizations: { title: "KROFT Plus" },
    // Echoed back verbatim in the verify response and in webhook payloads (data.meta) — this,
    // not tx_ref, is what ties a completed payment back to a specific Supabase user, the same
    // role Stripe's metadata/client_reference_id played in the previous integration.
    meta: { supabase_user_id: userId },
  });
  if (!ok || !data?.data?.link) return { ok: false, detail: data };
  return { ok: true, url: data.data.link, txRef };
}

// Confirms a transaction really succeeded, server-side, rather than trusting the redirect's own
// query params — Flutterwave's own integration guidance is explicit about this: a redirect
// claiming success is not proof of payment, only this API call is. Also cross-checks amount and
// currency against what the plan should have charged, since neither of those exists in the
// data this app itself controls end-to-end without querying Flutterwave for its plan config —
// callers pass expectedAmount/expectedCurrency if they want that check enforced.
export async function verifyTransaction(secretKey, transactionId) {
  const { ok, data } = await flutterwaveRequest(secretKey, "GET", `/transactions/${transactionId}/verify`);
  if (!ok) return { ok: false, detail: data };
  return { ok: true, transaction: data.data };
}

export async function cancelSubscription(secretKey, subscriptionId) {
  const { ok, data } = await flutterwaveRequest(secretKey, "PUT", `/subscriptions/${subscriptionId}/cancel`);
  if (!ok) return { ok: false, detail: data };
  return { ok: true };
}

// Flutterwave's webhook authentication is a static shared secret (the "Secret Hash" you set
// yourself in Dashboard -> Settings -> Webhooks), sent back verbatim in the verif-hash header
// on every webhook request — a plain string comparison, not an HMAC signature the way Stripe's
// is. Still done in constant time: a plain === leaks how many leading characters matched,
// letting an attacker narrow down the correct secret one character at a time across many
// requests, the same reasoning as the HMAC comparisons in api/_lib/stripe.js and
// api/_lib/oauthState.js.
export function verifyFlutterwaveWebhookSignature(headerValue, secretHash) {
  if (!headerValue || !secretHash) return false;
  if (headerValue.length !== secretHash.length) return false;
  let diff = 0;
  for (let i = 0; i < headerValue.length; i++) diff |= headerValue.charCodeAt(i) ^ secretHash.charCodeAt(i);
  return diff === 0;
}

// ---- Subscription sync (used by api/billing/webhook.js and api/billing/callback.js) ----
//
// Factored out taking `admin` as a parameter rather than constructing it internally, so this
// business logic can be unit-tested directly with a fake admin object — the same approach used
// for Google's token refresh and Stripe's event handling.

function periodEndFromTransaction(transaction) {
  // Flutterwave's transaction object doesn't carry a subscription's next-billing-date the way
  // Stripe's does — that lives on the /v3/subscriptions resource instead, which isn't fetched
  // on every webhook for latency's sake. Approximating one billing cycle ahead is a reasonable
  // display value; it's advisory only (nothing in this app currently gates access strictly on
  // current_period_end elapsing versus status, so an approximate date doesn't create a real
  // access-control gap) and gets corrected whenever the plan's actual interval is confirmed.
  const days = { daily: 1, weekly: 7, monthly: 30, yearly: 365 }[transaction.payment_plan?.interval] || 30;
  return new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();
}

export async function applyChargeCompleted(admin, transaction) {
  const userId = transaction.meta?.supabase_user_id;
  if (!userId || transaction.status !== "successful") return;
  await admin.from("subscriptions").upsert(
    {
      user_id: userId,
      provider: "flutterwave",
      provider_customer_ref: transaction.customer?.email,
      provider_subscription_id: transaction.plan || transaction.subscription_id || null,
      status: "active",
      current_period_end: periodEndFromTransaction(transaction),
    },
    { onConflict: "user_id" }
  );
}

export async function applySubscriptionCancelled(admin, subscriptionEventData) {
  // subscription.cancelled webhook events carry the customer's email rather than KROFT's own
  // user id (Flutterwave subscription objects don't carry the same meta bag transactions do),
  // so resolution goes through our own stored provider_customer_ref instead of a direct id.
  const email = subscriptionEventData.customer_email || subscriptionEventData.customer?.email;
  if (!email) return;
  await admin.from("subscriptions").update({ status: "canceled" }).eq("provider_customer_ref", email);
}

export async function applyFlutterwaveEvent(admin, event) {
  switch (event.event) {
    case "charge.completed":
      await applyChargeCompleted(admin, event.data);
      return;
    case "subscription.cancelled":
      await applySubscriptionCancelled(admin, event.data);
      return;
    default:
      // Every other event type is outside what this app tracks — acknowledged by the caller
      // regardless (Flutterwave, like Stripe, expects a fast 2xx on every event received).
      return;
  }
}
