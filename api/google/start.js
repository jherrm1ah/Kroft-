import { getAuthedUser, signState, jsonResponse, GOOGLE_SCOPES } from "../_lib/google.js";

// Returns the Google OAuth consent URL for the signed-in user to be redirected to (a full
// top-level navigation, not a fetch — Google's consent screen refuses to render inside an
// iframe or an XHR response). The frontend calls this first, authenticated via the user's
// Supabase access token, then does window.location.href = url itself.
export const config = { runtime: "edge" };

export default async function handler(req) {
  if (req.method !== "GET") return jsonResponse({ error: "Method not allowed" }, 405);

  const user = await getAuthedUser(req);
  if (!user) return jsonResponse({ error: "Not authenticated" }, 401);

  // 10-minute window to complete the consent flow — long enough for a real person clicking
  // through Google's screens, short enough that an intercepted/logged URL is useless soon
  // after.
  const state = await signState({ uid: user.id, exp: Date.now() + 10 * 60 * 1000 });

  const redirectUri = `${new URL(req.url).origin}/api/google/callback`;
  const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  url.searchParams.set("client_id", process.env.GOOGLE_CLIENT_ID);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("response_type", "code");
  // offline + consent together guarantee a refresh_token comes back every time, including on
  // a reconnect — without "consent", Google skips the screen (and the refresh_token) for a
  // user who already granted these scopes once.
  url.searchParams.set("access_type", "offline");
  url.searchParams.set("prompt", "consent");
  url.searchParams.set("scope", GOOGLE_SCOPES);
  url.searchParams.set("state", state);

  return jsonResponse({ url: url.toString() });
}
