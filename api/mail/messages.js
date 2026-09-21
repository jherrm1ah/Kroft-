import { getAuthedUser, supabaseAdmin, jsonResponse } from "../_lib/supabaseAdmin.js";
import { getValidGoogleAccessToken, fetchGmailMessages } from "../_lib/google.js";
import { getValidMicrosoftAccessToken, fetchOutlookMessages } from "../_lib/microsoft.js";

// One inbox regardless of which email provider(s) are connected — Kroft.jsx's Email screen
// always showed a single list, so "Connect Gmail or Outlook" means read from whichever is
// actually connected (or both, merged and sorted together) rather than needing two separate
// inbox views. Each message carries which provider it came from (source: "gmail"|"outlook")
// so a reply can be sent back through the same account (see api/mail/send.js).
export const config = { runtime: "edge" };

export default async function handler(req) {
  if (req.method !== "GET") return jsonResponse({ error: "Method not allowed" }, 405);

  const user = await getAuthedUser(req);
  if (!user) return jsonResponse({ error: "Not authenticated" }, 401);

  const admin = supabaseAdmin();
  const [gmailToken, outlookToken] = await Promise.all([
    getValidGoogleAccessToken(admin, user.id),
    getValidMicrosoftAccessToken(admin, user.id),
  ]);

  if (!gmailToken && !outlookToken) return jsonResponse({ error: "No email account is connected" }, 409);

  const [gmailMessages, outlookMessages] = await Promise.all([
    gmailToken ? fetchGmailMessages(gmailToken) : Promise.resolve([]),
    outlookToken ? fetchOutlookMessages(outlookToken) : Promise.resolve([]),
  ]);

  const merged = [...(gmailMessages || []), ...(outlookMessages || [])].sort((a, b) => b.sortDate - a.sortDate);
  // sortDate is an internal merge key, not part of the shape Kroft.jsx's `emails` state expects.
  const messages = merged.map(({ sortDate, ...m }) => m);

  return jsonResponse({ messages, connected: { gmail: !!gmailToken, outlook: !!outlookToken } });
}
