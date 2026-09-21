import { extractPlainTextBody, toBase64Url } from "./gmailMime.js";

// Shared server-side helpers for the Google OAuth integration (api/google/*, api/gmail/*,
// api/calendar/*, api/mail/*). Everything here runs on Vercel's Edge runtime, so only
// Web-standard APIs (fetch, Web Crypto, TextEncoder) are used — no Node-only modules.
//
// jsonResponse/supabaseAdmin/getAuthedUser used to be defined here directly; they moved to
// supabaseAdmin.js once billing needed them too (they were never Google-specific), and are
// re-exported below so every existing `import { getAuthedUser, ... } from "../_lib/google.js"`
// across api/google/*, api/gmail/*, api/calendar/* keeps working unchanged.
export { jsonResponse, supabaseAdmin, getAuthedUser } from "./supabaseAdmin.js";
// Likewise signState/verifyState moved to oauthState.js once Microsoft's OAuth flow needed the
// exact same CSRF-safe state mechanism (it was never Google-specific either).
export { signState, verifyState } from "./oauthState.js";

export const GOOGLE_SCOPES = [
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/gmail.send",
  "https://www.googleapis.com/auth/calendar.readonly",
  "https://www.googleapis.com/auth/calendar.events",
].join(" ");

// ---- Token storage + refresh ----

export async function getStoredGoogleTokens(admin, userId) {
  const { data } = await admin
    .from("oauth_tokens")
    .select("access_token, refresh_token, expires_at, scope")
    .eq("user_id", userId)
    .eq("provider", "google")
    .maybeSingle();
  return data || null;
}

async function refreshAccessToken(refreshToken) {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: process.env.GOOGLE_CLIENT_ID,
      client_secret: process.env.GOOGLE_CLIENT_SECRET,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }),
  });
  if (!res.ok) throw new Error(`refresh_failed:${res.status}`);
  return res.json(); // { access_token, expires_in, scope, token_type }
}

// Returns a valid (non-expired) Google access token for this user, refreshing it first if
// it's expired or about to be (a 60s buffer avoids a request failing mid-flight because the
// token expired between this check and the actual Gmail/Calendar API call). Returns null if
// the user has never connected Google, or if the refresh itself fails (e.g. they revoked
// access on Google's side) — callers should treat null as "not connected" and prompt
// reconnection, not retry.
export async function getValidGoogleAccessToken(admin, userId) {
  const tokens = await getStoredGoogleTokens(admin, userId);
  if (!tokens) return null;
  const expiresAt = new Date(tokens.expires_at).getTime();
  if (Date.now() < expiresAt - 60_000) return tokens.access_token;
  if (!tokens.refresh_token) return null;
  try {
    const refreshed = await refreshAccessToken(tokens.refresh_token);
    const newExpiresAt = new Date(Date.now() + refreshed.expires_in * 1000).toISOString();
    await admin
      .from("oauth_tokens")
      .update({ access_token: refreshed.access_token, expires_at: newExpiresAt })
      .eq("user_id", userId)
      .eq("provider", "google");
    return refreshed.access_token;
  } catch {
    return null;
  }
}

// ---- Mail (shared by api/gmail/messages.js and the merged api/mail/messages.js) ----

const GMAIL_MAX_RESULTS = 15;

export async function fetchGmailMessages(accessToken) {
  const listRes = await fetch(
    `https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=${GMAIL_MAX_RESULTS}&labelIds=INBOX`,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );
  if (!listRes.ok) return null;
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
        id: `gmail:${msg.id}`,
        from: headers.from || "(unknown sender)",
        subject: headers.subject || "(no subject)",
        tag: "",
        time: headers.date || "",
        read: !(msg.labelIds || []).includes("UNREAD"),
        body,
        source: "gmail",
        sortDate: headers.date ? new Date(headers.date) : new Date(0),
      };
    })
  );
  return details.filter(Boolean);
}

export async function sendGmailMessage(accessToken, { to, subject, body }) {
  const mimeMessage = [`To: ${to}`, `Subject: ${subject}`, "Content-Type: text/plain; charset=utf-8", "", body].join("\r\n");
  const res = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/messages/send", {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ raw: toBase64Url(mimeMessage) }),
  });
  if (!res.ok) return { ok: false, detail: await res.text().catch(() => "") };
  return { ok: true };
}

// ---- Calendar (shared by api/calendar/events.js) ----

const GOOGLE_CALENDAR_URL = "https://www.googleapis.com/calendar/v3/calendars/primary/events";

export async function fetchGoogleCalendarEvents(accessToken) {
  const params = new URLSearchParams({
    timeMin: new Date().toISOString(),
    maxResults: "20",
    singleEvents: "true",
    orderBy: "startTime",
  });
  const res = await fetch(`${GOOGLE_CALENDAR_URL}?${params}`, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!res.ok) return null;
  const { items = [] } = await res.json();

  return items.map((item) => {
    // An all-day event has start.date ("2026-09-21"); a timed event has start.dateTime
    // ("2026-09-21T14:00:00-07:00") — only the latter has a meaningful clock time to show.
    const isAllDay = !!item.start?.date;
    const startIso = item.start?.dateTime || item.start?.date;
    return {
      id: `google:${item.id}`,
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
}

export async function createGoogleCalendarEvent(accessToken, { title, date, time, location, notes }) {
  // A bare date + a free-text time string (Kroft.jsx's <Inp placeholder="Time e.g. 4:00 PM">
  // takes any text, not a structured time) doesn't reliably parse into an exact instant, so a
  // specified time still creates a timed event defaulting to local midnight rather than
  // silently dropping it — an imprecise time beats losing it, and the notes field carries the
  // original text through either way. No time given creates a real all-day event.
  const event = {
    summary: title,
    location: location || undefined,
    description: [notes, time ? `Time noted in Kroft: ${time}` : null].filter(Boolean).join("\n") || undefined,
    ...(time
      ? { start: { dateTime: `${date}T00:00:00`, timeZone: "UTC" }, end: { dateTime: `${date}T01:00:00`, timeZone: "UTC" } }
      : { start: { date }, end: { date } }),
  };
  const res = await fetch(GOOGLE_CALENDAR_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify(event),
  });
  if (!res.ok) return { ok: false, detail: await res.text().catch(() => "") };
  const created = await res.json();
  return { ok: true, id: created.id };
}
