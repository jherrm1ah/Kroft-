import { getAuthedUser, supabaseAdmin, jsonResponse } from "../_lib/supabaseAdmin.js";
import { getValidGoogleAccessToken, sendGmailMessage } from "../_lib/google.js";
import { getValidMicrosoftAccessToken, sendOutlookMessage } from "../_lib/microsoft.js";

// Sends through whichever provider the frontend specifies (a reply passes the source of the
// message it's replying to — see the `source` field from api/mail/messages.js — so the reply
// goes out from the same account the original arrived on), or picks Gmail first, then Outlook,
// for a fresh compose with no provider specified.
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
  const { to, subject, body, provider } = payload || {};
  if (!to || !subject || typeof body !== "string") {
    return jsonResponse({ error: "to, subject and body are required" }, 400);
  }
  if (provider && provider !== "gmail" && provider !== "outlook") {
    return jsonResponse({ error: "provider must be \"gmail\" or \"outlook\" if given" }, 400);
  }

  const admin = supabaseAdmin();
  const [gmailToken, outlookToken] = await Promise.all([
    getValidGoogleAccessToken(admin, user.id),
    getValidMicrosoftAccessToken(admin, user.id),
  ]);

  const useProvider = provider || (gmailToken ? "gmail" : outlookToken ? "outlook" : null);
  if (useProvider === "gmail" && !gmailToken) return jsonResponse({ error: "Gmail is not connected" }, 409);
  if (useProvider === "outlook" && !outlookToken) return jsonResponse({ error: "Outlook is not connected" }, 409);
  if (!useProvider) return jsonResponse({ error: "No email account is connected" }, 409);

  const result =
    useProvider === "gmail"
      ? await sendGmailMessage(gmailToken, { to, subject, body })
      : await sendOutlookMessage(outlookToken, { to, subject, body });

  if (!result.ok) return jsonResponse({ error: `${useProvider === "gmail" ? "Gmail" : "Outlook"} rejected the message`, detail: result.detail }, 502);

  return jsonResponse({ ok: true, provider: useProvider });
}
