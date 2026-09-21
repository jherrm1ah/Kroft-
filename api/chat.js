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
import { getAuthedUser } from "./_lib/supabaseAdmin.js";

export default async function handler(req) {
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405,
      headers: { "Content-Type": "application/json" },
    });
  }

  // Without this, /api/chat is a public, unauthenticated, unlimited proxy to the server's own
  // paid Gemini/Anthropic key — callable directly (curl, a script) by anyone who finds the URL,
  // with no signup and no rate limit, regardless of what the frontend's own UI gates behind
  // sign-in (every call site in Kroft.jsx used a bare fetch() with no Authorization header at
  // all). Only enforced when Supabase is actually configured server-side — local-only mode (no
  // Supabase at all) has no accounts to check a token against, and already documents itself as
  // having no real authentication anywhere (see supabaseClient.js's console.warn), so AI chat is
  // left working there rather than breaking that deployment shape entirely.
  if (process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY) {
    const user = await getAuthedUser(req);
    if (!user) {
      return new Response(JSON.stringify({ error: "Not authenticated" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      });
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
