import { createClient } from "@supabase/supabase-js";

// Shared server-side helpers for the Google OAuth integration (api/google/*, api/gmail/*,
// api/calendar/*). Everything here runs on Vercel's Edge runtime, so only Web-standard APIs
// (fetch, Web Crypto, TextEncoder) are used — no Node-only modules.

export const GOOGLE_SCOPES = [
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/gmail.send",
  "https://www.googleapis.com/auth/calendar.readonly",
  "https://www.googleapis.com/auth/calendar.events",
].join(" ");

export function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

// A server-only Supabase client using the service_role key, which bypasses RLS entirely.
// This is the ONLY thing in this codebase that's allowed to read/write oauth_tokens — never
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

// ---- Signed OAuth state (CSRF protection + carries which user is connecting) ----
//
// The OAuth callback (api/google/callback.js) is a top-level browser redirect from Google, so
// it has no Authorization header to identify the user by. The state parameter we hand Google
// at the start of the flow carries the user's id instead, signed with HMAC-SHA256 so it can't
// be forged into attaching stolen tokens to someone else's account, and time-boxed so an old
// state can't be replayed later.
async function hmacKey(secret) {
  return crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}
function toBase64Url(bytes) {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function fromBase64Url(str) {
  const padded = str.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (str.length % 4)) % 4);
  return atob(padded);
}

export async function signState(payload) {
  const body = toBase64Url(new TextEncoder().encode(JSON.stringify(payload)));
  const key = await hmacKey(process.env.OAUTH_STATE_SECRET);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
  return `${body}.${toBase64Url(new Uint8Array(sig))}`;
}

export async function verifyState(token) {
  if (!token || !token.includes(".")) return null;
  const [body, sig] = token.split(".");
  const key = await hmacKey(process.env.OAUTH_STATE_SECRET);
  const expectedSigBytes = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body)));
  const givenSigBytes = Uint8Array.from(fromBase64Url(sig), (c) => c.charCodeAt(0));
  if (expectedSigBytes.length !== givenSigBytes.length) return null;
  // Constant-time compare — a plain === on the decoded signature would leak timing
  // information about how many leading bytes matched, letting an attacker forge a valid
  // signature byte-by-byte over many requests.
  let diff = 0;
  for (let i = 0; i < expectedSigBytes.length; i++) diff |= expectedSigBytes[i] ^ givenSigBytes[i];
  if (diff !== 0) return null;
  try {
    const payload = JSON.parse(fromBase64Url(body));
    if (typeof payload.exp !== "number" || Date.now() > payload.exp) return null;
    return payload;
  } catch {
    return null;
  }
}

// ---- Token storage + refresh ----

export async function getStoredGoogleTokens(admin, userId) {
  const { data } = await admin
    .from("oauth_tokens")
    .select("access_token, refresh_token, expires_at, scope")
    .eq("user_id", userId)
    .eq("provider", "google")
    .maybeSingle();
  return data || null;
}

async function refreshAccessToken(refreshToken) {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: process.env.GOOGLE_CLIENT_ID,
      client_secret: process.env.GOOGLE_CLIENT_SECRET,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }),
  });
  if (!res.ok) throw new Error(`refresh_failed:${res.status}`);
  return res.json(); // { access_token, expires_in, scope, token_type }
}

// Returns a valid (non-expired) Google access token for this user, refreshing it first if
// it's expired or about to be (a 60s buffer avoids a request failing mid-flight because the
// token expired between this check and the actual Gmail/Calendar API call). Returns null if
// the user has never connected Google, or if the refresh itself fails (e.g. they revoked
// access on Google's side) — callers should treat null as "not connected" and prompt
// reconnection, not retry.
export async function getValidGoogleAccessToken(admin, userId) {
  const tokens = await getStoredGoogleTokens(admin, userId);
  if (!tokens) return null;
  const expiresAt = new Date(tokens.expires_at).getTime();
  if (Date.now() < expiresAt - 60_000) return tokens.access_token;
  if (!tokens.refresh_token) return null;
  try {
    const refreshed = await refreshAccessToken(tokens.refresh_token);
    const newExpiresAt = new Date(Date.now() + refreshed.expires_in * 1000).toISOString();
    await admin
      .from("oauth_tokens")
      .update({ access_token: refreshed.access_token, expires_at: newExpiresAt })
      .eq("user_id", userId)
      .eq("provider", "google");
    return refreshed.access_token;
  } catch {
    return null;
  }
}
