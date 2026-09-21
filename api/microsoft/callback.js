import { verifyState } from "../_lib/oauthState.js";
import { supabaseAdmin } from "../_lib/supabaseAdmin.js";
import { exchangeMicrosoftCode } from "../_lib/microsoft.js";

// Mirrors api/google/callback.js exactly, against Microsoft's token endpoint instead — see
// that file's comments for the reasoning behind resolving the user via signed state rather
// than an Authorization header (Microsoft's redirect back here carries neither).
export const config = { runtime: "edge" };

export default async function handler(req) {
  const url = new URL(req.url);
  const origin = url.origin;
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const oauthError = url.searchParams.get("error"); // e.g. "access_denied"

  if (oauthError) return redirectTo(origin, "error", oauthError);
  if (!code || !state) return redirectTo(origin, "error", "missing_code_or_state");

  const payload = await verifyState(state);
  if (!payload?.uid) return redirectTo(origin, "error", "invalid_or_expired_state");

  const redirectUri = `${origin}/api/microsoft/callback`; // must exactly match the one used in start.js
  const tokens = await exchangeMicrosoftCode(code, redirectUri);
  if (!tokens) return redirectTo(origin, "error", "token_exchange_failed");

  const admin = supabaseAdmin();
  const expiresAt = new Date(Date.now() + tokens.expires_in * 1000).toISOString();

  // Unlike Google, Microsoft returns a refresh_token on every successful exchange when
  // offline_access is requested (no separate "consent" re-prompt needed to guarantee one), so
  // there's no equivalent fallback-to-existing-token branch needed here.
  const { error: upsertError } = await admin.from("oauth_tokens").upsert(
    {
      user_id: payload.uid,
      provider: "microsoft",
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token,
      expires_at: expiresAt,
      scope: tokens.scope,
    },
    { onConflict: "user_id,provider" }
  );
  if (upsertError) return redirectTo(origin, "error", "storage_failed");

  return redirectTo(origin, "success", "microsoft");
}

function redirectTo(origin, status, detail) {
  const dest = new URL(origin);
  dest.searchParams.set("oauth", status);
  dest.searchParams.set("oauth_provider", "microsoft");
  if (status === "error") dest.searchParams.set("oauth_error", detail);
  return new Response(null, { status: 302, headers: { Location: dest.toString() } });
}
