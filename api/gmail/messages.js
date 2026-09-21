import { getAuthedUser, getValidGoogleAccessToken, supabaseAdmin, jsonResponse, fetchGmailMessages } from "../_lib/google.js";

// Gmail-only inbox fetch, kept as its own route for direct testing/debugging. The frontend
// calls the merged api/mail/messages.js instead, which combines this with Outlook when both
// are connected — the actual fetch/parse logic lives in api/_lib/google.js's
// fetchGmailMessages so both routes share one implementation.
export const config = { runtime: "edge" };

export default async function handler(req) {
  if (req.method !== "GET") return jsonResponse({ error: "Method not allowed" }, 405);

  const user = await getAuthedUser(req);
  if (!user) return jsonResponse({ error: "Not authenticated" }, 401);

  const accessToken = await getValidGoogleAccessToken(supabaseAdmin(), user.id);
  if (!accessToken) return jsonResponse({ error: "Gmail is not connected" }, 409);

  const messages = await fetchGmailMessages(accessToken);
  if (messages === null) return jsonResponse({ error: "Failed to list Gmail messages" }, 502);

  return jsonResponse({ messages });
}
