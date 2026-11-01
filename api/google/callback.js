import { verifyState, supabaseAdmin } from "../_lib/google.js";

// Google redirects the user's browser here after they approve (or deny) consent. There's no
// Authorization header on this request — it's a top-level navigation from Google, not an
// authenticated call from our own frontend — so the signed `state` param (see
// api/_lib/google.js) is what tells us which of our users this belongs to.
export const config = { runtime: "edge" };

export default async function handler(req) {
  const url = new URL(req.url);
  const origin = url.origin;
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const oauthError = url.searchParams.get("error"); // e.g. "access_denied" if they clicked Cancel
  // Started from the Android app (see ../google/start.js)? Then every outcome, including a cancel,
  // returns to the app through its deep link rather than to the website. Read from the signed
  // state, so a forged flag is ignored.
  const fromApp = state ? (await verifyState(state))?.app === true : false;
  const dest = fromApp ? "com.orynthra.kroft://oauth-return" : origin;

  if (oauthError) return redirectTo(dest, "error", oauthError);
  if (!code || !state) return redirectTo(dest, "error", "missing_code_or_state");

  const payload = await verifyState(state);
  if (!payload?.uid) return redirectTo(dest, "error", "invalid_or_expired_state");

  const redirectUri = `${origin}/api/google/callback`; // must exactly match the one used in start.js
  let tokens;
  try {
    const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: process.env.GOOGLE_CLIENT_ID,
        client_secret: process.env.GOOGLE_CLIENT_SECRET,
        code,
        grant_type: "authorization_code",
        redirect_uri: redirectUri,
      }),
    });
    if (!tokenRes.ok) return redirectTo(dest, "error", "token_exchange_failed");
    tokens = await tokenRes.json(); // { access_token, refresh_token?, expires_in, scope, token_type }
  } catch {
    return redirectTo(dest, "error", "token_exchange_failed");
  }

  const admin = supabaseAdmin();
  const expiresAt = new Date(Date.now() + tokens.expires_in * 1000).toISOString();

  // Google only sends a refresh_token on first consent, or when prompt=consent forces
  // re-consent (which start.js always requests) — but if it's ever missing on a reconnect
  // anyway, keep whatever refresh_token is already on file rather than overwriting it with
  // null and silently breaking future token refreshes for this user.
  let refreshToken = tokens.refresh_token;
  if (!refreshToken) {
    const { data: existing } = await admin
      .from("oauth_tokens")
      .select("refresh_token")
      .eq("user_id", payload.uid)
      .eq("provider", "google")
      .maybeSingle();
    refreshToken = existing?.refresh_token || null;
  }

  const { error: upsertError } = await admin.from("oauth_tokens").upsert(
    {
      user_id: payload.uid,
      provider: "google",
      access_token: tokens.access_token,
      refresh_token: refreshToken,
      expires_at: expiresAt,
      scope: tokens.scope,
    },
    { onConflict: "user_id,provider" }
  );
  if (upsertError) return redirectTo(dest, "error", "storage_failed");

  return redirectTo(dest, "success", "google");
}

function redirectTo(origin, status, detail) {
  const dest = new URL(origin);
  dest.searchParams.set("oauth", status);
  dest.searchParams.set("oauth_provider", "google");
  if (status === "error") dest.searchParams.set("oauth_error", detail);
  return new Response(null, { status: 302, headers: { Location: dest.toString() } });
}
