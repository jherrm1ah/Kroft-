import { createClient } from "@supabase/supabase-js";

// Generic server-side helpers shared by every backend integration (Google OAuth, billing) —
// not specific to any one provider. Runs on Vercel's Edge runtime, so only Web-standard APIs
// are used, no Node-only modules.

export function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

// A server-only Supabase client using the service_role key, which bypasses RLS entirely. This
// is the only thing in this codebase allowed to write oauth_tokens or subscriptions — never
// expose SUPABASE_SERVICE_ROLE_KEY to the client, and never import this file from client code.
export function supabaseAdmin() {
  return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

// Verifies the Supabase access token the frontend sends in Authorization: Bearer <jwt> and
// returns the authenticated user, or null. Delegates verification to Supabase's own Auth
// server rather than checking the JWT signature locally, trading a small amount of latency
// for not having to handle key rotation ourselves.
export async function getAuthedUser(req) {
  const authHeader = req.headers.get("authorization") || "";
  const jwt = authHeader.replace(/^Bearer\s+/i, "").trim();
  if (!jwt) return null;
  const { data, error } = await supabaseAdmin().auth.getUser(jwt);
  if (error || !data?.user) return null;
  return data.user;
}
