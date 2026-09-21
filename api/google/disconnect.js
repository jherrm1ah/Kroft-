import { getAuthedUser, getStoredGoogleTokens, supabaseAdmin, jsonResponse } from "../_lib/google.js";

// Unlinks Google: revokes the token with Google itself (so it can't be used even if this
// deletion somehow failed to remove every copy) and deletes our stored copy. Revocation is
// best-effort — if Google's revoke endpoint is unreachable, the local row is still deleted,
// which is what actually matters for this app's own access; the user can also revoke access
// directly from their Google Account's third-party access settings regardless.
export const config = { runtime: "edge" };

export default async function handler(req) {
  if (req.method !== "POST") return jsonResponse({ error: "Method not allowed" }, 405);

  const user = await getAuthedUser(req);
  if (!user) return jsonResponse({ error: "Not authenticated" }, 401);

  const admin = supabaseAdmin();
  const tokens = await getStoredGoogleTokens(admin, user.id);

  if (tokens) {
    const tokenToRevoke = tokens.refresh_token || tokens.access_token;
    try {
      await fetch("https://oauth2.googleapis.com/revoke", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ token: tokenToRevoke }),
      });
    } catch {
      // Best-effort — see comment above.
    }
  }

  await admin.from("oauth_tokens").delete().eq("user_id", user.id).eq("provider", "google");

  return jsonResponse({ ok: true });
}
