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
// shape (model/max_tokens/system/messages/stream in, content[]/content_block_delta out) — that
// contract is fixed at this endpoint regardless of which provider actually answers it.
// GEMINI_API_KEY is checked first (Anthropic can cost money per request; Gemini currently has
// a usable free tier, which is why this order exists — see api/_lib/gemini.js and
// api/_lib/anthropic.js). Switching providers is a Vercel environment-variable change, not a
// code change: set/unset whichever key, nothing here needs editing.
//
// Runs on the Edge runtime (not the default Node serverless runtime) specifically so the
// response can be streamed straight through: Kroft's main chat sends { stream: true } and
// reads the raw server-sent-events off the response body itself. Buffering that in a standard
// Node function would break streaming and delay the whole reply until it's fully generated.
export const config = { runtime: "edge" };

import { callGemini } from "./_lib/gemini.js";
import { callAnthropic } from "./_lib/anthropic.js";
import { getAuthedUser, supabaseAdmin } from "./_lib/supabaseAdmin.js";

// Mirrors Kroft.jsx's FREE_DAILY_MESSAGE_LIMIT / FREE_DAILY_EXTRAS_LIMIT / FREE_DAILY_VOICE_LIMIT
// / FREE_MONTHLY_REPORT_LIMIT — those client-side counters live in kv_store, which the account
// owner can write directly via RLS (see supabase/schema.sql), so they're display-only now. This
// is the real, unspoofable enforcement: independently counted server-side via the ai_usage table
// / increment_ai_usage() function, keyed by which of these four pools a request draws from.
const FREE_LIMITS = { chat: 15, extra: 5, voice: 10, report: 1 };
const QUOTA_MESSAGES = {
  chat: "You've used today's free messages. Upgrade to KROFT Plus for unlimited access, or try again once it resets.",
  extra: "You've used today's free AI drafts and suggestions. Upgrade to KROFT Plus for unlimited access, or try again once it resets.",
  voice: "You've used today's free voice turns. Upgrade to KROFT Plus for unlimited access, or try again once it resets.",
  report: "You've used this month's free report. Upgrade to KROFT Plus for unlimited access, or try again next month.",
};

// Daily pools reset by UTC calendar day, monthly by UTC calendar month — a deliberate
// simplification versus the client's local-timezone reset (todayISO()/toDateString()), since the
// server has no reliable notion of the caller's timezone. Worst case this is off by at most the
// caller's UTC offset from their own local midnight, which only ever affects exactly when a
// pool refills, never whether the enforced limit itself is correct.
function currentPeriod(usageType) {
  const iso = new Date().toISOString();
  return usageType === "report" ? iso.slice(0, 7) : iso.slice(0, 10);
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
      // runKroftCompletion, aiDraftReply, suggestSmartReminder, generateMonthlyReport). Anything
      // missing or unrecognized defaults to the main "chat" pool rather than skipping enforcement
      // — a call this endpoint doesn't recognize should never mean "untracked, unlimited".
      const requestedType = req.headers.get("x-kroft-usage-type");
      const usageType = Object.prototype.hasOwnProperty.call(FREE_LIMITS, requestedType) ? requestedType : "chat";
      const period = currentPeriod(usageType);

      const { data: newCount, error: quotaError } = await admin.rpc("increment_ai_usage", {
        p_user_id: user.id,
        p_usage_type: usageType,
        p_period: period,
      });
      // A genuine DB error checking quota must not be treated as "under limit" — that would let
      // exactly the abuse this exists to stop through on every transient hiccup. Fails closed.
      if (quotaError) return jsonError({ error: "quota_check_failed", message: "Couldn't verify your usage limit right now. Try again in a moment." }, 500);
      if (newCount > FREE_LIMITS[usageType]) {
        return jsonError({ error: "quota_exceeded", usageType, limit: FREE_LIMITS[usageType], message: QUOTA_MESSAGES[usageType] }, 429);
      }
    }
  }

  const geminiKey = process.env.GEMINI_API_KEY;
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  if (!geminiKey && !anthropicKey) {
    // Missing config, not a bad request — mirrors friendlyError()'s 401/403 branch in
    // Kroft.jsx ("I couldn't authenticate with the AI service.") rather than surfacing a
    // generic network failure.
    return new Response(
      JSON.stringify({ error: "Server is not configured with a GEMINI_API_KEY or ANTHROPIC_API_KEY." }),
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

  return geminiKey ? callGemini(rawBody, geminiKey) : callAnthropic(rawBody, anthropicKey);
}
