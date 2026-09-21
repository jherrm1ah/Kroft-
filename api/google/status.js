import { getAuthedUser, getStoredGoogleTokens, supabaseAdmin, jsonResponse } from "../_lib/google.js";

// Tells the frontend which Google-backed features are actually connected, without ever
// exposing the underlying tokens. gmail/calendar are derived from the OAuth scopes actually
// granted (not just "any Google connection exists") — Google lets a user approve some scopes
// and decline others on the consent screen, so having a row here doesn't guarantee every
// scope the app asked for was granted.
export const config = { runtime: "edge" };

export default async function handler(req) {
  if (req.method !== "GET") return jsonResponse({ error: "Method not allowed" }, 405);

  const user = await getAuthedUser(req);
  if (!user) return jsonResponse({ error: "Not authenticated" }, 401);

  const tokens = await getStoredGoogleTokens(supabaseAdmin(), user.id);
  const scope = tokens?.scope || "";

  return jsonResponse({
    connected: !!tokens,
    gmail: scope.includes("gmail"),
    calendar: scope.includes("calendar"),
  });
}
