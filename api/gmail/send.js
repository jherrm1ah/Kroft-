import { getAuthedUser, getValidGoogleAccessToken, supabaseAdmin, jsonResponse } from "../_lib/google.js";
import { toBase64Url } from "../_lib/gmailMime.js";

// Sends a real email via the Gmail API on behalf of the signed-in user — wired to Kroft.jsx's
// existing ComposeModal (AI-drafted replies and manual composes both flow through the same
// onSend handler), which previously only simulated sending with a toast and a scripted fake
// reply.
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

  const admin = supabaseAdmin();
  const accessToken = await getValidGoogleAccessToken(admin, user.id);
  if (!accessToken) return jsonResponse({ error: "Gmail is not connected" }, 409);

  // Gmail's send endpoint takes a full RFC 2822 message, base64url-encoded as a single "raw"
  // field — there's no simpler structured "to/subject/body" request shape on their API.
  const mimeMessage = [`To: ${to}`, `Subject: ${subject}`, "Content-Type: text/plain; charset=utf-8", "", body].join(
    "\r\n"
  );

  const sendRes = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/messages/send", {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ raw: toBase64Url(mimeMessage) }),
  });
  if (!sendRes.ok) {
    const detail = await sendRes.text().catch(() => "");
    return jsonResponse({ error: "Gmail rejected the message", detail }, sendRes.status);
  }

  return jsonResponse({ ok: true });
}
