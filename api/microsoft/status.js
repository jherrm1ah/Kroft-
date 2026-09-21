import { getAuthedUser, supabaseAdmin, jsonResponse } from "../_lib/supabaseAdmin.js";
import { getStoredMicrosoftTokens } from "../_lib/microsoft.js";

// Mirrors api/google/status.js exactly. mail/calendar are both true together in practice today
// (Microsoft's Mail.Read/Mail.Send/Calendars.ReadWrite scopes are requested as one bundle in
// buildMicrosoftAuthUrl, unlike Google's system which can end up with only one of two scopes
// granted) but are still reported separately for symmetry with Google's status shape and in
// case that ever changes.
export const config = { runtime: "edge" };

export default async function handler(req) {
  if (req.method !== "GET") return jsonResponse({ error: "Method not allowed" }, 405);

  const user = await getAuthedUser(req);
  if (!user) return jsonResponse({ error: "Not authenticated" }, 401);

  const tokens = await getStoredMicrosoftTokens(supabaseAdmin(), user.id);
  const scope = tokens?.scope || "";

  return jsonResponse({
    connected: !!tokens,
    mail: scope.includes("Mail"),
    calendar: scope.includes("Calendars"),
  });
}
