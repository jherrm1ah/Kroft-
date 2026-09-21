import { getAuthedUser, getValidGoogleAccessToken, supabaseAdmin, jsonResponse } from "../_lib/google.js";

// GET: lists upcoming events from the user's primary Google Calendar, shaped close to
// Kroft.jsx's local `appts` entries ({ title, date, time, location, notes }) so they render
// through the existing appointment UI.
// POST: creates a real Google Calendar event, called alongside (not instead of) the existing
// local setAppts(...) — Kroft.jsx keeps its own local appointment list as the app's source of
// truth for what it displays, and this call best-effort mirrors a new one onto the user's real
// calendar too, so meetings created in Kroft actually show up in Google Calendar.
export const config = { runtime: "edge" };

const CALENDAR_URL = "https://www.googleapis.com/calendar/v3/calendars/primary/events";

export default async function handler(req) {
  const user = await getAuthedUser(req);
  if (!user) return jsonResponse({ error: "Not authenticated" }, 401);

  const admin = supabaseAdmin();
  const accessToken = await getValidGoogleAccessToken(admin, user.id);
  if (!accessToken) return jsonResponse({ error: "Google Calendar is not connected" }, 409);

  if (req.method === "GET") {
    const params = new URLSearchParams({
      timeMin: new Date().toISOString(),
      maxResults: "20",
      singleEvents: "true",
      orderBy: "startTime",
    });
    const res = await fetch(`${CALENDAR_URL}?${params}`, { headers: { Authorization: `Bearer ${accessToken}` } });
    if (!res.ok) return jsonResponse({ error: "Failed to list calendar events" }, res.status);
    const { items = [] } = await res.json();

    const appts = items.map((item) => {
      // An all-day event has start.date ("2026-09-21"); a timed event has start.dateTime
      // ("2026-09-21T14:00:00-07:00") — only the latter has a meaningful clock time to show.
      const isAllDay = !!item.start?.date;
      const startIso = item.start?.dateTime || item.start?.date;
      return {
        id: item.id,
        title: item.summary || "(untitled event)",
        date: (startIso || "").slice(0, 10),
        time: isAllDay ? "" : new Date(startIso).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" }),
        location: item.location || "",
        notes: item.description || "",
        urgent: false,
        repeat: "none",
        contactId: null,
        source: "google",
      };
    });
    return jsonResponse({ appts });
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

    // A bare date + a free-text time string (Kroft.jsx's <Inp placeholder="Time e.g. 4:00 PM">
    // takes any text, not a structured time) doesn't reliably parse into an exact instant, so
    // a specified time still creates a timed event defaulting to local midnight rather than
    // silently dropping it — an imprecise time beats losing it, and the notes field carries
    // the original text through either way. No time given creates a real all-day event.
    const event = {
      summary: title,
      location: location || undefined,
      description: [notes, time ? `Time noted in Kroft: ${time}` : null].filter(Boolean).join("\n") || undefined,
      ...(time
        ? { start: { dateTime: `${date}T00:00:00`, timeZone: "UTC" }, end: { dateTime: `${date}T01:00:00`, timeZone: "UTC" } }
        : { start: { date }, end: { date } }),
    };

    const res = await fetch(CALENDAR_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify(event),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      return jsonResponse({ error: "Failed to create calendar event", detail }, res.status);
    }
    const created = await res.json();
    return jsonResponse({ ok: true, id: created.id });
  }

  return jsonResponse({ error: "Method not allowed" }, 405);
}
