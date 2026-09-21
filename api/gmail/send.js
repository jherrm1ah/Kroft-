import { getAuthedUser, getValidGoogleAccessToken, supabaseAdmin, jsonResponse, sendGmailMessage } from "../_lib/google.js";

// Gmail-only send, kept as its own route for direct testing/debugging. The frontend calls the
// merged api/mail/send.js instead, which picks Gmail or Outlook depending on which is
// connected (or which the message being replied to came from) — the actual send logic lives
// in api/_lib/google.js's sendGmailMessage so both routes share one implementation.
export const config = { runtime: "edge" };

export default async function handler(req) {
  if (req.method !== "POST") return jsonResponse({ error: "Method not allowed" }, 405);

  const user = await getAuthedUser(req);
  if (!user) return jsonResponse({ error: "Not authenticated" }, 401);

  let payload;
  try {
    payload = await req.json();
  } catch {
    return jsonResponse({ error: "Invalid request body" }, 400);
  }
  const { to, subject, body } = payload || {};
  if (!to || !subject || typeof body !== "string") {
    return jsonResponse({ error: "to, subject and body are required" }, 400);
  }

  const accessToken = await getValidGoogleAccessToken(supabaseAdmin(), user.id);
  if (!accessToken) return jsonResponse({ error: "Gmail is not connected" }, 409);

  const result = await sendGmailMessage(accessToken, { to, subject, body });
  if (!result.ok) return jsonResponse({ error: "Gmail rejected the message", detail: result.detail }, 502);

  return jsonResponse({ ok: true });
}
