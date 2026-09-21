import { getAuthedUser, getValidGoogleAccessToken, supabaseAdmin, jsonResponse } from "../_lib/google.js";
import { extractPlainTextBody } from "../_lib/gmailMime.js";

// Returns the most recent inbox messages, shaped to match Kroft.jsx's existing local `emails`
// state ({ id, from, subject, tag, time, read, body }) so the frontend can drop real data
// straight into the UI that already renders the mock seed data, with no shape changes needed
// there.
export const config = { runtime: "edge" };

const MAX_RESULTS = 15;

export default async function handler(req) {
  if (req.method !== "GET") return jsonResponse({ error: "Method not allowed" }, 405);

  const user = await getAuthedUser(req);
  if (!user) return jsonResponse({ error: "Not authenticated" }, 401);

  const admin = supabaseAdmin();
  const accessToken = await getValidGoogleAccessToken(admin, user.id);
  if (!accessToken) return jsonResponse({ error: "Gmail is not connected" }, 409);

  const listRes = await fetch(
    `https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=${MAX_RESULTS}&labelIds=INBOX`,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );
  if (!listRes.ok) return jsonResponse({ error: "Failed to list Gmail messages" }, listRes.status);
  const { messages = [] } = await listRes.json();

  // Gmail's API only returns ids from the list endpoint — each message's actual content needs
  // a separate fetch. Done in parallel since these are independent, read-only GETs.
  const details = await Promise.all(
    messages.map(async (m) => {
      const r = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${m.id}?format=full`, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      if (!r.ok) return null;
      const msg = await r.json();
      const headers = Object.fromEntries((msg.payload?.headers || []).map((h) => [h.name.toLowerCase(), h.value]));
      const body = extractPlainTextBody(msg.payload) || msg.snippet || "";
      return {
        id: msg.id,
        from: headers.from || "(unknown sender)",
        subject: headers.subject || "(no subject)",
        tag: "",
        time: headers.date || "",
        read: !(msg.labelIds || []).includes("UNREAD"),
        body,
      };
    })
  );

  return jsonResponse({ messages: details.filter(Boolean) });
}
