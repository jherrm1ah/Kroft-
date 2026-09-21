import { stripHtml } from "./gmailMime.js";

// Shared server-side helpers for the Microsoft/Outlook integration (api/microsoft/*, folded
// into api/mail/* and api/calendar/* alongside Google — see those files). Mirrors
// api/_lib/google.js's structure closely; the two providers share the same oauth_tokens table
// (distinguished by the `provider` column) and the same signed-state/token-refresh shape, just
// against Microsoft's endpoints and scopes instead of Google's.

// The "common" tenant accepts both personal Microsoft accounts and work/school (Azure AD)
// accounts — the right default for a consumer-facing app that shouldn't have to know in
// advance which kind of account someone will sign in with.
const AUTHORIZE_URL = "https://login.microsoftonline.com/common/oauth2/v2.0/authorize";
const TOKEN_URL = "https://login.microsoftonline.com/common/oauth2/v2.0/token";

export const MICROSOFT_SCOPES = ["offline_access", "Mail.Read", "Mail.Send", "Calendars.ReadWrite", "User.Read"].join(" ");

export function buildMicrosoftAuthUrl(redirectUri, state) {
  const url = new URL(AUTHORIZE_URL);
  url.searchParams.set("client_id", process.env.MICROSOFT_CLIENT_ID);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("response_mode", "query");
  url.searchParams.set("scope", MICROSOFT_SCOPES);
  url.searchParams.set("state", state);
  return url.toString();
}

export async function exchangeMicrosoftCode(code, redirectUri) {
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: process.env.MICROSOFT_CLIENT_ID,
      client_secret: process.env.MICROSOFT_CLIENT_SECRET,
      code,
      grant_type: "authorization_code",
      redirect_uri: redirectUri,
      scope: MICROSOFT_SCOPES,
    }),
  });
  if (!res.ok) return null;
  return res.json(); // { access_token, refresh_token, expires_in, scope, token_type }
}

export async function getStoredMicrosoftTokens(admin, userId) {
  const { data } = await admin
    .from("oauth_tokens")
    .select("access_token, refresh_token, expires_at, scope")
    .eq("user_id", userId)
    .eq("provider", "microsoft")
    .maybeSingle();
  return data || null;
}

async function refreshMicrosoftAccessToken(refreshToken) {
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: process.env.MICROSOFT_CLIENT_ID,
      client_secret: process.env.MICROSOFT_CLIENT_SECRET,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
      scope: MICROSOFT_SCOPES,
    }),
  });
  if (!res.ok) throw new Error(`refresh_failed:${res.status}`);
  return res.json();
}

// Same expiry-buffer/refresh/null-on-failure shape as getValidGoogleAccessToken in
// api/_lib/google.js — see that function's comment for the reasoning, which applies here
// identically.
export async function getValidMicrosoftAccessToken(admin, userId) {
  const tokens = await getStoredMicrosoftTokens(admin, userId);
  if (!tokens) return null;
  const expiresAt = new Date(tokens.expires_at).getTime();
  if (Date.now() < expiresAt - 60_000) return tokens.access_token;
  if (!tokens.refresh_token) return null;
  try {
    const refreshed = await refreshMicrosoftAccessToken(tokens.refresh_token);
    const newExpiresAt = new Date(Date.now() + refreshed.expires_in * 1000).toISOString();
    await admin
      .from("oauth_tokens")
      .update({
        access_token: refreshed.access_token,
        expires_at: newExpiresAt,
        // Microsoft issues a new refresh_token on most refreshes (rotation) — persist it when
        // given one, since the old one may already be invalidated once rotated.
        ...(refreshed.refresh_token ? { refresh_token: refreshed.refresh_token } : {}),
      })
      .eq("user_id", userId)
      .eq("provider", "microsoft");
    return refreshed.access_token;
  } catch {
    return null;
  }
}

// ---- Mail ----

const GRAPH_MAIL_TOP = 15;

export async function fetchOutlookMessages(accessToken) {
  const params = new URLSearchParams({
    $top: String(GRAPH_MAIL_TOP),
    $select: "subject,from,receivedDateTime,isRead,body,bodyPreview",
    $orderby: "receivedDateTime desc",
  });
  const res = await fetch(`https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages?${params}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) return null;
  const { value = [] } = await res.json();

  // Graph returns the body directly as { contentType: "text"|"html", content }, unlike
  // Gmail's base64/MIME-part structure — no separate per-message fetch or decoding needed.
  return value.map((m) => {
    const rawBody = m.body?.content || "";
    const body = m.body?.contentType === "html" ? stripHtml(rawBody) : rawBody || m.bodyPreview || "";
    return {
      id: `outlook:${m.id}`,
      from: m.from?.emailAddress ? `${m.from.emailAddress.name || ""} <${m.from.emailAddress.address}>`.trim() : "(unknown sender)",
      subject: m.subject || "(no subject)",
      tag: "",
      time: m.receivedDateTime || "",
      read: !!m.isRead,
      body,
      source: "outlook",
      sortDate: m.receivedDateTime ? new Date(m.receivedDateTime) : new Date(0),
    };
  });
}

export async function sendOutlookMessage(accessToken, { to, subject, body }) {
  const res = await fetch("https://graph.microsoft.com/v1.0/me/sendMail", {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      message: {
        subject,
        body: { contentType: "Text", content: body },
        toRecipients: [{ emailAddress: { address: to } }],
      },
    }),
  });
  // sendMail returns 202 Accepted with no body on success.
  if (!res.ok) return { ok: false, detail: await res.text().catch(() => "") };
  return { ok: true };
}

// ---- Calendar ----

export async function fetchOutlookCalendarEvents(accessToken) {
  const params = new URLSearchParams({
    startDateTime: new Date().toISOString(),
    endDateTime: new Date(Date.now() + 90 * 24 * 60 * 60 * 1000).toISOString(), // next 90 days
    $orderby: "start/dateTime",
    $top: "20",
  });
  const res = await fetch(`https://graph.microsoft.com/v1.0/me/calendarView?${params}`, {
    headers: { Authorization: `Bearer ${accessToken}`, Prefer: 'outlook.timezone="UTC"' },
  });
  if (!res.ok) return null;
  const { value = [] } = await res.json();

  return value.map((item) => {
    const isAllDay = !!item.isAllDay;
    const startIso = item.start?.dateTime;
    return {
      id: `outlook:${item.id}`,
      title: item.subject || "(untitled event)",
      date: (startIso || "").slice(0, 10),
      time: isAllDay || !startIso ? "" : new Date(`${startIso}Z`).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" }),
      location: item.location?.displayName || "",
      notes: item.bodyPreview || "",
      urgent: false,
      repeat: "none",
      contactId: null,
      source: "outlook",
    };
  });
}

export async function createOutlookCalendarEvent(accessToken, { title, date, time, location, notes }) {
  // Same reasoning as createGoogleCalendarEvent in api/_lib/google.js: a specified free-text
  // time still creates a timed event (defaulting to UTC midnight) rather than silently
  // dropping it, with the original text preserved in the body either way.
  const event = {
    subject: title,
    location: location ? { displayName: location } : undefined,
    body: { contentType: "Text", content: [notes, time ? `Time noted in Kroft: ${time}` : null].filter(Boolean).join("\n") },
    isAllDay: !time,
    start: { dateTime: `${date}T00:00:00`, timeZone: "UTC" },
    end: { dateTime: time ? `${date}T01:00:00` : `${date}T00:00:00`, timeZone: "UTC" },
  };
  const res = await fetch("https://graph.microsoft.com/v1.0/me/events", {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify(event),
  });
  if (!res.ok) return { ok: false, detail: await res.text().catch(() => "") };
  const created = await res.json();
  return { ok: true, id: created.id };
}
