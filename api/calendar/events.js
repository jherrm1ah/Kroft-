import { getAuthedUser, supabaseAdmin, jsonResponse } from "../_lib/supabaseAdmin.js";
import { getValidGoogleAccessToken, fetchGoogleCalendarEvents, createGoogleCalendarEvent } from "../_lib/google.js";
import { getValidMicrosoftAccessToken, fetchOutlookCalendarEvents, createOutlookCalendarEvent } from "../_lib/microsoft.js";

// GET: lists upcoming events from whichever calendar(s) are connected (Google, Outlook, or
// both — merged and sorted), shaped close to Kroft.jsx's local `appts` entries so they render
// through the existing appointment UI. Each carries which provider it came from (source).
// POST: creates a real event on every connected calendar, called alongside (not instead of)
// Kroft.jsx's own local setAppts(...) — the app keeps its local appointment list as its source
// of truth for what it displays, and this best-effort mirrors a new one onto whichever real
// calendar(s) are connected, so a meeting created in Kroft actually shows up there too.
export const config = { runtime: "edge" };

export default async function handler(req) {
  const user = await getAuthedUser(req);
  if (!user) return jsonResponse({ error: "Not authenticated" }, 401);

  const admin = supabaseAdmin();
  const [googleToken, outlookToken] = await Promise.all([
    getValidGoogleAccessToken(admin, user.id),
    getValidMicrosoftAccessToken(admin, user.id),
  ]);

  if (!googleToken && !outlookToken) return jsonResponse({ error: "No calendar is connected" }, 409);

  if (req.method === "GET") {
    const [googleAppts, outlookAppts] = await Promise.all([
      googleToken ? fetchGoogleCalendarEvents(googleToken) : Promise.resolve([]),
      outlookToken ? fetchOutlookCalendarEvents(outlookToken) : Promise.resolve([]),
    ]);
    const appts = [...(googleAppts || []), ...(outlookAppts || [])].sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time));
    return jsonResponse({ appts, connected: { google: !!googleToken, outlook: !!outlookToken } });
  }

  if (req.method === "POST") {
    let payload;
    try {
      payload = await req.json();
    } catch {
      return jsonResponse({ error: "Invalid request body" }, 400);
    }
    const { title, date, time, location, notes } = payload || {};
    if (!title || !date) return jsonResponse({ error: "title and date are required" }, 400);

    // Mirror to every connected calendar, not just one — the point of "connect your accounts"
    // is that a meeting created in Kroft shows up wherever the user actually looks for it.
    const [googleResult, outlookResult] = await Promise.all([
      googleToken ? createGoogleCalendarEvent(googleToken, { title, date, time, location, notes }) : null,
      outlookToken ? createOutlookCalendarEvent(outlookToken, { title, date, time, location, notes }) : null,
    ]);
    const succeeded = [googleResult, outlookResult].filter((r) => r?.ok);
    if (succeeded.length === 0) {
      return jsonResponse({ error: "Failed to create the event on any connected calendar", google: googleResult, outlook: outlookResult }, 502);
    }
    return jsonResponse({ ok: true, google: googleResult, outlook: outlookResult });
  }

  return jsonResponse({ error: "Method not allowed" }, 405);
}
