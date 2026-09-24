// Vercel Edge Function: proxies Kroft's AI calls to whichever provider is configured.
//
// Kroft.jsx was originally built to run inside a sandbox host that intercepts
// fetch("https://api.anthropic.com/v1/messages", ...) calls and injects real credentials
// transparently, the same way it injects window.storage. Outside that host those calls can't
// work at all: the API requires a key the client never sends, and even with one, browsers
// can't call api.anthropic.com directly (CORS). This endpoint is what the frontend calls
// instead — same-origin, so no CORS issue — with the real key added server-side, never
// shipped to the browser.
//
// Kroft.jsx's six call sites and its SSE stream reader all speak Anthropic's Messages API
// shape (model/max_tokens/system/messages/stream in, content[]/content_block_delta out) —
// that's just the request/response contract this endpoint expects the client to use, not a
// claim about which provider answers it. Only GEMINI_API_KEY is used right now (Anthropic
// support is deliberately not wired in yet — see api/_lib/gemini.js for the shape translation).
//
// Runs on the Edge runtime (not the default Node serverless runtime) specifically so the
// response can be streamed straight through: Kroft's main chat sends { stream: true } and
// reads the raw server-sent-events off the response body itself. Buffering that in a standard
// Node function would break streaming and delay the whole reply until it's fully generated.
export const config = { runtime: "edge" };

import { callGemini } from "./_lib/gemini.js";
import { getAuthedUser, supabaseAdmin } from "./_lib/supabaseAdmin.js";

// Every AI usage limit is read from the plan_limits table (see supabase/schema.sql) instead of
// being hardcoded here — that's what lets an allowance change, or a brand-new metered feature
// turn on, without a code deploy. A usage_type with no row for the caller's plan is unlimited by
// construction: that's how normal text usage (chat, extra, report) stays genuinely uncapped on
// every plan, per KROFT's product principle that ordinary text is never the thing being rationed.
async function getLimitConfig(admin, usageType) {
  const { data } = await admin.from("plan_limits").select("period, limit_count, label").eq("plan", "free").eq("usage_type", usageType).maybeSingle();
  return data && data.limit_count != null ? data : null;
}

// Daily limits reset by UTC calendar day, monthly ones by UTC calendar month — a deliberate
// simplification versus the client's local-timezone reset (todayISO()/toDateString()), since the
// server has no reliable notion of the caller's timezone. Worst case this is off by at most the
// caller's UTC offset from their own local midnight, which only ever affects exactly when a
// pool refills, never whether the enforced limit itself is correct.
function currentPeriod(period) {
  const iso = new Date().toISOString();
  return period === "month" ? iso.slice(0, 7) : iso.slice(0, 10);
}

function jsonError(body, status) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

export default async function handler(req) {
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405,
      headers: { "Content-Type": "application/json" },
    });
  }

  // Without the auth check below, /api/chat is a public, unauthenticated, unlimited proxy to the
  // server's own paid Gemini/Anthropic key — callable directly (curl, a script) by anyone who
  // finds the URL, with no signup and no rate limit, regardless of what the frontend's own UI
  // gates behind sign-in (every call site in Kroft.jsx used a bare fetch() with no Authorization
  // header at all). Only enforced when Supabase is actually configured server-side — local-only
  // mode (no Supabase at all) has no accounts to check a token against, and already documents
  // itself as having no real authentication anywhere (see supabaseClient.js's console.warn), so
  // AI chat is left working there — and unmetered, for the same reason — rather than breaking
  // that deployment shape entirely.
  if (process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY) {
    const user = await getAuthedUser(req);
    if (!user) return jsonError({ error: "Not authenticated" }, 401);

    const admin = supabaseAdmin();
    const { data: subscription } = await admin.from("subscriptions").select("status").eq("user_id", user.id).maybeSingle();
    const isSubscribed = subscription?.status === "active";

    if (!isSubscribed) {
      // Kroft.jsx tags each call site with which pool it draws from via this header (see
      // runKroftCompletion, searchNearby). Anything missing, or naming a usage_type with no
      // configured limit (including "chat"/"extra"/"report", which have none by design), is
      // simply unlimited — there's nothing to count or check.
      const usageType = req.headers.get("x-kroft-usage-type") || "chat";
      const limit = await getLimitConfig(admin, usageType);

      if (limit) {
        const period = currentPeriod(limit.period);
        const { data: newCount, error: quotaError } = await admin.rpc("increment_ai_usage", {
          p_user_id: user.id,
          p_usage_type: usageType,
          p_period: period,
        });
        // A genuine DB error checking quota must not be treated as "under limit" — that would let
        // exactly the abuse this exists to stop through on every transient hiccup. Fails closed.
        if (quotaError) return jsonError({ error: "quota_check_failed", message: "Couldn't verify your usage limit right now. Try again in a moment." }, 500);
        if (newCount > limit.limit_count) {
          const periodLabel = limit.period === "month" ? "this month" : "today";
          // Always names the specific feature and reassures the rest of KROFT — especially
          // normal text chat — still works, so hitting one limit never reads as the whole
          // account breaking.
          const message = `You've reached your free ${limit.label} limit for ${periodLabel}. You can keep chatting with KROFT normally — this limit only applies to ${limit.label}.`;
          return jsonError({ error: "quota_exceeded", usageType, limit: limit.limit_count, message }, 429);
        }
      }
    }
  }

  const geminiKey = process.env.GEMINI_API_KEY;
  if (!geminiKey) {
    // Missing config, not a bad request — mirrors friendlyError()'s 401/403 branch in
    // Kroft.jsx ("I couldn't authenticate with the AI service.") rather than surfacing a
    // generic network failure.
    return new Response(
      JSON.stringify({ error: "Server is not configured with a GEMINI_API_KEY." }),
      { status: 401, headers: { "Content-Type": "application/json" } }
    );
  }

  let rawBody;
  try {
    rawBody = await req.text();
  } catch {
    return new Response(JSON.stringify({ error: "Invalid request body" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  return callGemini(rawBody, geminiKey);
}
